import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppsRoutes } from "@src/routes/codex-apps.js";

const mockConfig = {
  api: { base_url: "https://chatgpt.com/backend-api" },
  server: { proxy_api_key: "proxy-secret" as string | null },
  client: { originator: "Codex Desktop", app_version: "26.527.30818", platform: "darwin", arch: "arm64", chromium_version: "146" },
};

const postMock = vi.fn();

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version}",
    default_headers: {},
    header_order: [],
  })),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: postMock,
    isImpersonate: vi.fn(() => true),
  })),
}));

vi.mock("@src/routes/shared/account-acquisition.js", () => ({
  acquireAccount: vi.fn((pool, model, excludeIds, tag, preferredEntryId) => pool.acquire({ model, excludeIds, tag, preferredEntryId })),
  releaseAccount: vi.fn((pool, entryId) => pool.release(entryId)),
}));

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeSimplePool() {
  const pool: any = {
    acquired: [],
    released: [],
    forceDifferentPreferred: false,
    validateProxyApiKey: vi.fn((key: string) => key === "proxy-secret"),
    isAuthenticated: vi.fn(() => true),
    acquire: vi.fn((options: any) => {
      const entryId = options.preferredEntryId ? (pool.forceDifferentPreferred ? "entry-2" : options.preferredEntryId) : "entry-1";
      const acquired = { entryId, token: `token-${entryId}`, accountId: `acct-${entryId}`, prevSlotMs: null };
      pool.acquired.push({ options, acquired });
      return acquired;
    }),
    release: vi.fn((entryId: string) => pool.released.push(entryId)),
    releaseWithoutCounting: vi.fn(),
  };
  return pool;
}

describe("codex apps MCP routes", () => {
  beforeEach(() => {
    postMock.mockReset();
    mockConfig.api.base_url = "https://chatgpt.com/backend-api";
    mockConfig.server.proxy_api_key = "proxy-secret";
    postMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "Content-Type": "application/json", "Mcp-Session-Id": "mcp-session-1" }),
      body: streamFromText(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
      setCookieHeaders: [],
    });
  });

  it("requires a valid proxy API key", async () => {
    const app = createCodexAppsRoutes(makeSimplePool());

    const missing = await app.request("/backend-api/wham/apps", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);

    const wrong = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("proxies streamable HTTP JSON-RPC to ChatGPT wham apps", async () => {
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    const res = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: {
        Authorization: "Bearer proxy-secret",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-11-25",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(postMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/apps",
      expect.objectContaining({
        Authorization: "Bearer token-entry-1",
        "ChatGPT-Account-Id": "acct-entry-1",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-11-25",
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    expect(pool.released).toEqual(["entry-1"]);
  });

  it("maps the /api/codex/apps alias to the ChatGPT wham apps upstream", async () => {
    const app = createCodexAppsRoutes(makeSimplePool());

    const res = await app.request("/api/codex/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(postMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/apps",
      expect.any(Object),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
  });

  it("pins follow-up MCP session requests to the upstream session account", async () => {
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Mcp-Session-Id": "mcp-session-1", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(pool.acquired[1].options.preferredEntryId).toBe("entry-1");
    expect(postMock.mock.calls[1]![1]).toMatchObject({ "Mcp-Session-Id": "mcp-session-1" });
  });

  it("fails closed when a client sends an unknown MCP session id", async () => {
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    const res = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Mcp-Session-Id": "missing-session", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(res.status).toBe(404);
    expect(postMock).not.toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned MCP session account is unavailable", async () => {
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }).then((res) => res.text());
    pool.forceDifferentPreferred = true;

    const res = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Mcp-Session-Id": "mcp-session-1", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(res.status).toBe(503);
    expect(pool.releaseWithoutCounting).toHaveBeenCalledWith("entry-2");
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the account acquired until the upstream stream is consumed", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    postMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream", "Mcp-Session-Id": "mcp-session-stream" }),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(new TextEncoder().encode("event: message\n"));
        },
      }),
      setCookieHeaders: [],
    });
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    const res = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    const reader = res.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    expect(pool.released).toEqual([]);
    controller!.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(pool.released).toEqual(["entry-1"]);
  });

  it("proxies no-body MCP responses and releases the account immediately", async () => {
    postMock.mockResolvedValueOnce({
      status: 204,
      headers: new Headers({ "Mcp-Session-Id": "mcp-session-204" }),
      body: streamFromText(""),
      setCookieHeaders: [],
    });
    const pool = makeSimplePool();
    const app = createCodexAppsRoutes(pool);

    const res = await app.request("/backend-api/wham/apps", {
      method: "POST",
      headers: { Authorization: "Bearer proxy-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(pool.released).toEqual(["entry-1"]);
  });
});
