import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "http";
import WebSocket from "ws";

const mockConfig = {
  server: { proxy_api_key: "proxy-secret" as string | null, trust_proxy: false },
  model: { default_reasoning_effort: null as string | null, default_service_tier: null as string | null },
};

const { handleProxyRequestMock } = vi.hoisted(() => ({
  handleProxyRequestMock: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/routes/shared/proxy-handler.js", () => ({
  handleProxyRequest: handleProxyRequestMock,
}));

vi.mock("@src/routes/shared/proxy-egress-log.js", () => ({
  recordProxyEgressLog: vi.fn(),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((model: string) => ({ modelId: model, serviceTier: null, reasoningEffort: null })),
  resolveModelId: vi.fn((model: string) => model),
  getModelInfo: vi.fn((model: string) => ({ id: model, name: model })),
  buildDisplayModelName: vi.fn((parsed: { modelId: string }) => parsed.modelId),
  isRecognizedModelName: vi.fn((model: string) => model.startsWith("gpt-")),
}));

const { installResponsesWsBridge } = await import("@src/routes/responses-ws.js");

function mockPool() {
  return {
    validateProxyApiKey: vi.fn((key: string) => key === "proxy-secret"),
    isAuthenticated: vi.fn(() => true),
    hasAvailableAccounts: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({ active: 1, rate_limited: 0, quota_exhausted: 0, expired: 0 })),
  } as any;
}

async function startBridge(pool = mockPool()): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  const bridge = installResponsesWsBridge(server, { accountPool: pool });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      await bridge.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: ${(event as any).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    ws.once("error", reject);
  });
}

function waitForMessages(
  ws: WebSocket,
  predicate: (message: Record<string, any>) => boolean,
  count: number,
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const matches: Record<string, any>[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      matches.push(message);
      if (matches.length === count) {
        ws.off("message", onMessage);
        ws.off("error", reject);
        resolve(matches);
      }
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function expectRejected(url: string, path: string, expectedStatus: number, headers?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${path}`, { headers });
    ws.once("open", () => {
      ws.close();
      reject(new Error("websocket unexpectedly opened"));
    });
    ws.once("unexpected-response", (_req, res) => {
      try {
        expect(res.statusCode).toBe(expectedStatus);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

describe("responses websocket bridge", () => {
  beforeEach(() => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    handleProxyRequestMock.mockReset();
    handleProxyRequestMock.mockImplementation(async () => sseResponse([
      { type: "response.completed", response: { id: "resp_default" } },
    ]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated websocket upgrades before opening", async () => {
    const bridge = await startBridge();
    try {
      await expectRejected(bridge.url, "/openai/v1/responses", 401);
    } finally {
      await bridge.close();
    }
  });

  it("rejects websocket upgrades on unrelated paths", async () => {
    const bridge = await startBridge();
    try {
      await expectRejected(bridge.url, "/openai/v1/other", 404, {
        Authorization: "Bearer proxy-secret",
      });
    } finally {
      await bridge.close();
    }
  });

  it("accepts authorized websocket upgrades", async () => {
    const bridge = await startBridge();
    try {
      const ws = new WebSocket(`${bridge.url}/openai/v1/responses`, {
        headers: { Authorization: "Bearer proxy-secret" },
      });
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "unsupported" }));
      const message = await waitForMessage(ws);
      expect(message).toMatchObject({
        type: "error",
        error: { code: "unsupported_type" },
      });
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("can be installed again after the first server closes", async () => {
    const first = await startBridge();
    await first.close();

    const second = await startBridge();
    try {
      const ws = new WebSocket(`${second.url}/openai/v1/responses`, {
        headers: { Authorization: "Bearer proxy-secret" },
      });
      await waitForOpen(ws);
      ws.close();
    } finally {
      await second.close();
    }
  });

  it("forwards response.create through the shared responses proxy handler", async () => {
    handleProxyRequestMock.mockImplementationOnce(async () => sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]));

    const bridge = await startBridge();
    try {
      const ws = new WebSocket(`${bridge.url}/openai/v1/responses`, {
        headers: { Authorization: "Bearer proxy-secret", "x-client-request-id": "rid-main" },
      });
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: "response.create",
        model: "gpt-5.3-codex",
        instructions: "system",
        prompt_cache_key: "top-level-prompt-cache",
        previous_response_id: "resp_previous",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }));
      const message = await waitForMessage(ws);
      expect(message).toMatchObject({ type: "response.created", response: { id: "resp_1" } });
      await vi.waitFor(() => expect(handleProxyRequestMock).toHaveBeenCalledTimes(1));
      const options = handleProxyRequestMock.mock.calls[0]![0];
      expect(options.fmt.tag).toBe("Responses");
      expect(options.req).toMatchObject({
        model: "gpt-5.3-codex",
        isStreaming: true,
        requirePreviousResponseAccount: true,
        codexRequest: {
          model: "gpt-5.3-codex",
          useWebSocket: true,
          prompt_cache_key: "top-level-prompt-cache",
          previous_response_id: "resp_previous",
        },
      });
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("serializes websocket messages while forwarding the shared handler stream", async () => {
    let releaseFirstResponse!: () => void;
    let firstReleased = false;
    const firstResponseCanFinish = new Promise<void>((resolve) => {
      releaseFirstResponse = () => {
        firstReleased = true;
        resolve();
      };
    });
    handleProxyRequestMock.mockImplementation(async () => {
      const callNumber = handleProxyRequestMock.mock.calls.length;
      if (callNumber === 1) {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
            ));
            await firstResponseCanFinish;
            controller.enqueue(new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })}\n\n`,
            ));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse([{ type: "response.completed", response: { id: "resp_2" } }]);
    });

    const bridge = await startBridge();
    try {
      const ws = new WebSocket(`${bridge.url}/openai/v1/responses`, {
        headers: { Authorization: "Bearer proxy-secret" },
      });
      await waitForOpen(ws);
      const firstCreated = waitForMessages(ws, (message) => message.type === "response.created", 1);
      const completions = waitForMessages(ws, (message) => message.type === "response.completed", 2);

      ws.send(JSON.stringify({
        type: "response.create",
        model: "gpt-5.3-codex",
        input: [{ role: "user", content: [{ type: "input_text", text: "run a tool" }] }],
      }));
      await expect(firstCreated).resolves.toHaveLength(1);
      expect(handleProxyRequestMock).toHaveBeenCalledTimes(1);

      ws.send(JSON.stringify({
        type: "response.create",
        model: "gpt-5.3-codex",
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_1", output: "tool ok" }],
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handleProxyRequestMock).toHaveBeenCalledTimes(1);
      expect(firstReleased).toBe(false);

      releaseFirstResponse();
      await expect(completions).resolves.toHaveLength(2);
      expect(handleProxyRequestMock).toHaveBeenCalledTimes(2);
      expect(handleProxyRequestMock.mock.calls[1]![0].req.codexRequest).toMatchObject({
        previous_response_id: "resp_1",
        useWebSocket: true,
      });
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("aborts the shared handler request when the websocket client closes", async () => {
    let capturedSignal: AbortSignal | null = null;
    handleProxyRequestMock.mockImplementationOnce(async (options: any) => {
      capturedSignal = options.c.req.raw.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
          ));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });

    const bridge = await startBridge();
    try {
      const ws = new WebSocket(`${bridge.url}/openai/v1/responses`, {
        headers: { Authorization: "Bearer proxy-secret" },
      });
      await waitForOpen(ws);
      ws.send(JSON.stringify({
        type: "response.create",
        model: "gpt-5.3-codex",
        instructions: "system",
        input: [],
      }));
      await waitForMessages(ws, (message) => message.type === "response.created", 1);
      expect(capturedSignal?.aborted).toBe(false);
      ws.close();
      await waitForClose(ws);
      await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    } finally {
      await bridge.close();
    }
  });

  it("closes active websocket clients when the bridge closes", async () => {
    const bridge = await startBridge();
    const ws = new WebSocket(`${bridge.url}/openai/v1/responses`, {
      headers: { Authorization: "Bearer proxy-secret" },
    });
    await waitForOpen(ws);

    await expect(bridge.close()).resolves.toBeUndefined();
    await waitForClose(ws);
  });
});
