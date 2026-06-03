import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLastTransportBody,
  getMockTransport,
  makeTransportResponse,
  resetTransportState,
  setTransportPost,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";
import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";

describe("E2E: responses encoded request bodies", () => {
  let accountPool: AccountPool;
  let cookieJar: CookieJar;
  let proxyPool: ProxyPool;
  let app: Hono;

  beforeEach(() => {
    resetTransportState();
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_zstd", "decoded")),
    );
    vi.mocked(getMockTransport().post).mockClear();

    loadStaticModels();
    accountPool = new AccountPool();
    cookieJar = new CookieJar();
    proxyPool = new ProxyPool();
    accountPool.addAccount(createValidJwt({
      accountId: "acct-zstd",
      email: "zstd@test.com",
      planType: "plus",
    }));

    app = new Hono();
    app.use("*", requestId);
    app.use("*", errorHandler);
    app.route("/", createResponsesRoutes(accountPool, cookieJar, proxyPool));
  });

  afterEach(() => {
    cookieJar.destroy();
    proxyPool.destroy();
    accountPool.destroy();
  });

  it.each([
    ["gzip", (body: Buffer) => gzipSync(body)],
    ["deflate", (body: Buffer) => deflateSync(body)],
    ["br", (body: Buffer) => brotliCompressSync(body)],
    ["zstd", (body: Buffer) => zstdCompressSync(body)],
  ] as const)("decodes Content-Encoding %s before parsing JSON", async (encoding, encode) => {
    const body = {
      instructions: "You are helpful",
      input: [{ role: "user", content: "Hello" }],
      model: "codex",
      stream: true,
    };
    const compressed = encode(Buffer.from(JSON.stringify(body), "utf8"));

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
      },
      body: compressed,
    });

    expect(res.status).toBe(200);
    const sentBody = JSON.parse(getLastTransportBody()!);
    expect(sentBody.input).toEqual([{ role: "user", content: "Hello" }]);
  });
});
