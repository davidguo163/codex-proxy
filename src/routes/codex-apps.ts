import { Hono } from "hono";
import type { Context } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { getConfig } from "../config.js";
import { buildHeadersWithContentType } from "../fingerprint/manager.js";
import { getTransport } from "../tls/transport.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";

const CODEX_APPS_TAG = "CodexAppsMCP";
const DEFAULT_MODEL_FOR_ACCOUNT_SELECTION = "gpt-5.4";
const MCP_SESSION_ENTRY_TTL_MS = 60 * 60 * 1000;
const mcpSessionEntries = new Map<string, { entryId: string; lastSeenMs: number }>();
const NO_BODY_STATUSES = new Set([204, 304]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function bearerToken(authHeader: string | undefined): string | null {
  const prefix = "Bearer ";
  return authHeader?.startsWith(prefix) ? authHeader.slice(prefix.length) : null;
}

function authorize(c: Context, accountPool: AccountPool): Response | null {
  if (!accountPool.isAuthenticated()) {
    c.status(401);
    return c.json({ error: "Not authenticated. Please login first." });
  }
  const config = getConfig();
  if (!config.server.proxy_api_key) return null;
  const token = bearerToken(c.req.header("Authorization"));
  if (token && accountPool.validateProxyApiKey(token)) return null;
  c.status(401);
  return c.json({ error: "Invalid proxy API key" });
}

function upstreamAppsUrl(path: "/wham/apps" | "/api/codex/apps"): string {
  const baseUrl = getConfig().api.base_url.replace(/\/+$/, "");
  if (baseUrl.includes("/backend-api")) {
    return `${baseUrl}${path === "/api/codex/apps" ? "/wham/apps" : path}`;
  }
  return `${baseUrl}${path}`;
}

function buildForwardHeaders(c: Context, token: string, accountId: string | null, cookieJar: CookieJar | undefined, entryId: string): Record<string, string> {
  const headers = buildHeadersWithContentType(token, accountId);
  headers.Accept = c.req.header("Accept") ?? "application/json, text/event-stream";
  const protocolVersion = c.req.header("Mcp-Protocol-Version") ?? c.req.header("mcp-protocol-version");
  if (protocolVersion) headers["Mcp-Protocol-Version"] = protocolVersion;
  const sessionId = c.req.header("Mcp-Session-Id") ?? c.req.header("mcp-session-id");
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const cookie = cookieJar?.getCookieHeader(entryId);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function preferredEntryIdForSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const entry = mcpSessionEntries.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.lastSeenMs > MCP_SESSION_ENTRY_TTL_MS) {
    mcpSessionEntries.delete(sessionId);
    return undefined;
  }
  entry.lastSeenMs = Date.now();
  return entry.entryId;
}

function rememberSessionEntry(sessionId: string | null | undefined, entryId: string): void {
  if (!sessionId) return;
  mcpSessionEntries.set(sessionId, { entryId, lastSeenMs: Date.now() });
}

function releaseOnStreamClose(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (err) {
        releaseOnce();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseOnce();
      }
    },
  });
}

function responseHeadersFromUpstream(headers: Headers): Headers {
  const forwarded = new Headers();
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      forwarded.set(key, value);
    }
  });
  return forwarded;
}

export function createCodexAppsRoutes(accountPool: AccountPool, cookieJar?: CookieJar, proxyPool?: ProxyPool): Hono {
  const app = new Hono();

  async function proxyMcp(c: Context, path: "/wham/apps" | "/api/codex/apps") {
    const unauthorized = authorize(c, accountPool);
    if (unauthorized) return unauthorized;

    const body = await c.req.text();
    const sessionId = c.req.header("Mcp-Session-Id") ?? c.req.header("mcp-session-id") ?? undefined;
    const preferredEntryId = preferredEntryIdForSession(sessionId);
    if (sessionId && !preferredEntryId) {
      c.status(404);
      return c.json({ error: "Unknown MCP session. Reinitialize the Codex apps MCP session." });
    }
    const acquired = acquireAccount(accountPool, DEFAULT_MODEL_FOR_ACCOUNT_SELECTION, undefined, CODEX_APPS_TAG, preferredEntryId);
    if (!acquired) {
      c.status(503);
      return c.json({ error: "No available accounts. All accounts are expired or rate-limited." });
    }
    if (preferredEntryId && acquired.entryId !== preferredEntryId) {
      accountPool.releaseWithoutCounting(acquired.entryId);
      c.status(503);
      return c.json({ error: "Pinned MCP session account is no longer available." });
    }

    let shouldReleaseOnError = true;
    try {
      const transport = getTransport();
      const headers = buildForwardHeaders(c, acquired.token, acquired.accountId, cookieJar, acquired.entryId);
      const upstream = await transport.post(
        upstreamAppsUrl(path),
        headers,
        body,
        c.req.raw.signal,
        undefined,
        proxyPool?.resolveProxyUrl(acquired.entryId),
      );
      cookieJar?.captureRaw(acquired.entryId, upstream.setCookieHeaders);
      rememberSessionEntry(upstream.headers.get("Mcp-Session-Id") ?? upstream.headers.get("mcp-session-id") ?? sessionId, acquired.entryId);
      if (NO_BODY_STATUSES.has(upstream.status)) {
        releaseAccount(accountPool, acquired.entryId);
        shouldReleaseOnError = false;
        return new Response(null, {
          status: upstream.status,
          headers: responseHeadersFromUpstream(upstream.headers),
        });
      }
      const responseBody = releaseOnStreamClose(upstream.body, () => releaseAccount(accountPool, acquired.entryId));
      const response = new Response(responseBody, {
        status: upstream.status,
        headers: responseHeadersFromUpstream(upstream.headers),
      });
      shouldReleaseOnError = false;
      return response;
    } catch (err) {
      if (shouldReleaseOnError) releaseAccount(accountPool, acquired.entryId);
      c.status(502);
      return c.json({ error: "Codex apps MCP upstream request failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  app.post("/backend-api/wham/apps", (c) => proxyMcp(c, "/wham/apps"));
  app.post("/api/codex/apps", (c) => proxyMcp(c, "/api/codex/apps"));

  app.all("/backend-api/wham/apps", (c) => {
    c.status(405);
    return c.text("Method Not Allowed");
  });
  app.all("/api/codex/apps", (c) => {
    c.status(405);
    return c.text("Method Not Allowed");
  });

  return app;
}
