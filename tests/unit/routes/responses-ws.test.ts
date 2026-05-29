import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "http";
import WebSocket from "ws";
import type { CodexApi } from "@src/proxy/codex-api.js";

const mockConfig = {
  server: { proxy_api_key: "proxy-secret" as string | null },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/routes/shared/account-acquisition.js", () => ({
  acquireAccount: vi.fn(),
  releaseAccount: vi.fn(),
}));

vi.mock("@src/routes/shared/proxy-handler-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/routes/shared/proxy-handler-utils.js")>();
  return {
    ...actual,
    buildCodexApi: vi.fn(),
  };
});

vi.mock("@src/routes/shared/proxy-egress-log.js", () => ({
  recordProxyEgressLog: vi.fn(),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((model: string) => ({ modelId: model, serviceTier: null, reasoningEffort: null })),
  buildDisplayModelName: vi.fn((parsed: { modelId: string }) => parsed.modelId),
  isRecognizedModelName: vi.fn((model: string) => model.startsWith("gpt-")),
}));

const accountAcquisition = await import("@src/routes/shared/account-acquisition.js");
const proxyHandlerUtils = await import("@src/routes/shared/proxy-handler-utils.js");
const { installResponsesWsBridge } = await import("@src/routes/responses-ws.js");

const acquireAccountMock = vi.mocked(accountAcquisition.acquireAccount);
const releaseAccountMock = vi.mocked(accountAcquisition.releaseAccount);
const buildCodexApiMock = vi.mocked(proxyHandlerUtils.buildCodexApi);

function mockPool() {
  return {
    validateProxyApiKey: vi.fn((key: string) => key === "proxy-secret"),
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
    acquireAccountMock.mockReset();
    releaseAccountMock.mockReset();
    buildCodexApiMock.mockReset();
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

  it("passes response.create through the websocket upstream path and records usage on release", async () => {
    const createResponse = vi.fn<CodexApi["createResponse"]>(async () => new Response("ok", { status: 200 }));
    const parseStream = vi.fn(async function* () {
      yield {
        event: "response.completed",
        data: {
          response: {
            id: "resp_1",
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        },
      };
    });
    acquireAccountMock.mockReturnValue({
      entryId: "entry-1",
      token: "token-1",
      accountId: "acct-1",
      prevSlotMs: null,
    });
    buildCodexApiMock.mockReturnValue({ createResponse, parseStream } as unknown as CodexApi);

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
        previous_response_id: "resp_previous",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      }));
      const message = await waitForMessage(ws);
      expect(message).toMatchObject({ response: { id: "resp_1" } });
      await vi.waitFor(() => {
        expect(releaseAccountMock).toHaveBeenCalled();
      });
      const [request, signal] = createResponse.mock.calls[0]!;
      expect(request).toMatchObject({
        previous_response_id: "resp_previous",
        useWebSocket: true,
      });
      expect(signal.aborted).toBe(false);
      expect(releaseAccountMock).toHaveBeenCalledWith(
        expect.anything(),
        "entry-1",
        { input_tokens: 12, output_tokens: 3, cached_tokens: 4 },
        expect.any(Set),
      );
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("aborts the upstream request when the websocket client closes", async () => {
    let capturedSignal: AbortSignal | null = null;
    const createResponse = vi.fn<CodexApi["createResponse"]>((_request, signal) => {
      capturedSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const parseStream = vi.fn();
    acquireAccountMock.mockReturnValue({
      entryId: "entry-1",
      token: "token-1",
      accountId: "acct-1",
      prevSlotMs: null,
    });
    buildCodexApiMock.mockReturnValue({ createResponse, parseStream } as unknown as CodexApi);

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
      await vi.waitFor(() => {
        expect(createResponse).toHaveBeenCalled();
      });
      ws.close();
      await waitForClose(ws);
      await vi.waitFor(() => {
        expect(capturedSignal?.aborted).toBe(true);
      });
      await vi.waitFor(() => {
        expect(releaseAccountMock).toHaveBeenCalledWith(expect.anything(), "entry-1", undefined, expect.any(Set));
      });
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
