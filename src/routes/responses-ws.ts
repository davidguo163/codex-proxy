import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { getConfig } from "../config.js";
import { diagnoseInternalAccessToken, internalTokenStore } from "../auth/internal-token-store.js";
import { createResponsesRoutes } from "./responses.js";

interface BridgeDeps {
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  upstreamRouter?: UpstreamRouter;
  maxConnectionMs?: number;
}

export interface ResponsesWsBridgeHandle {
  close: () => Promise<void>;
}

const DEFAULT_MAX_CONNECTION_MS = 60 * 60 * 1000;
const SUPPORTED_WS_PATHS = new Set(["/openai/v1/responses", "/v1/responses", "/responses"]);

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function buildError(message: string, code: string, type = "invalid_request_error", param?: string) {
  return { type: "error", error: { type, code, message, ...(param ? { param } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n" +
    "\r\n",
  );
  socket.destroy();
}

function authScheme(authHeader: string | undefined): string {
  if (!authHeader) return "missing";
  const firstSpace = authHeader.indexOf(" ");
  return firstSpace === -1 ? "none" : authHeader.slice(0, firstSpace);
}

function diagnoseClientBearerToken(accountPool: AccountPool, token: string | undefined) {
  if (!token) return { valid: false, proxyKeyValid: false, internalValid: false };
  let proxyKeyValid = false;
  let proxyKeyError: string | undefined;
  try {
    proxyKeyValid = accountPool.validateProxyApiKey(token);
  } catch (error) {
    proxyKeyError = error instanceof Error ? error.message : String(error);
  }
  let internalValid = false;
  let internalError: string | undefined;
  try {
    internalValid = internalTokenStore.validateAccessToken(token);
  } catch (error) {
    internalError = error instanceof Error ? error.message : String(error);
  }
  return {
    valid: proxyKeyValid || internalValid,
    proxyKeyValid,
    proxyKeyError,
    internalValid,
    internalError,
    internal: diagnoseInternalAccessToken(token),
  };
}

function logRejectedUpgradeAuth(req: IncomingMessage, accountPool: AccountPool, authHeader: string | undefined, providedKey: string | undefined): void {
  const diagnostics = diagnoseClientBearerToken(accountPool, providedKey);
  console.warn(
    `[Auth] Reject websocket token path=${req.url ?? "unknown"} auth_present=${!!authHeader} ` +
      `auth_scheme=${authScheme(authHeader)} bearer_prefix=${authHeader?.startsWith("Bearer ") ?? false} ` +
      `provided=${!!providedKey} proxy_key_valid=${diagnostics.proxyKeyValid} ` +
      `internal_valid=${diagnostics.internalValid} token_hash=${diagnostics.internal?.tokenHash ?? "none"} ` +
      `token_len=${diagnostics.internal?.tokenLength ?? 0} token_prefix=${diagnostics.internal?.prefix ?? "none"} ` +
      `jwt_shape=${diagnostics.internal?.jwtShape ?? "none"} signature_valid=${diagnostics.internal?.signatureValid ?? false} ` +
      `typ=${diagnostics.internal?.typ ?? "none"} exp_delta_s=${diagnostics.internal?.expDeltaSeconds ?? "none"} ` +
      `iat_age_s=${diagnostics.internal?.iatAgeSeconds ?? "none"} expired=${diagnostics.internal?.expired ?? "none"} ` +
      `proxy_key_error=${diagnostics.proxyKeyError ?? "none"} internal_error=${diagnostics.internalError ?? "none"}`,
  );
}

function isAuthorizedUpgrade(req: IncomingMessage, accountPool: AccountPool): boolean {
  const config = getConfig();
  if (!config.server.proxy_api_key) return true;
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const providedKey = authHeader?.replace("Bearer ", "");
  const diagnostics = diagnoseClientBearerToken(accountPool, providedKey);
  if (!!providedKey && diagnostics.valid) return true;
  logRejectedUpgradeAuth(req, accountPool, authHeader, providedKey);
  return false;
}

function forwardedHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key.toLowerCase() === "upgrade" || key.toLowerCase() === "connection") continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  headers.set("content-type", "application/json");
  headers.set("x-codex-proxy-ws-bridge", "true");
  return headers;
}

async function forwardJsonResponse(ws: WebSocket, response: Response): Promise<void> {
  const text = await response.text();
  if (!text) return;
  try {
    sendJson(ws, JSON.parse(text));
  } catch {
    sendJson(ws, buildError(text, "upstream_error", response.status >= 500 ? "server_error" : "invalid_request_error"));
  }
}

function parseSseBlock(block: string): unknown | null {
  const dataLines: string[] = [];
  let eventType: string | undefined;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  try {
    return JSON.parse(data);
  } catch {
    return { type: eventType || "event", data };
  }
}

async function forwardSseResponse(ws: WebSocket, response: Response): Promise<void> {
  if (!response.body) {
    await forwardJsonResponse(ws, response);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index == null) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseSseBlock(block);
        if (parsed != null) sendJson(ws, parsed);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseSseBlock(tail);
      if (parsed != null) sendJson(ws, parsed);
    }
  } finally {
    reader.releaseLock();
  }
}

async function bridgeSingleRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
  req: IncomingMessage,
  app: ReturnType<typeof createResponsesRoutes>,
) {
  const model = typeof payload.model === "string" ? payload.model : null;
  if (!model) {
    sendJson(ws, buildError("Missing model", "invalid_request"));
    return;
  }

  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  ws.once("close", abortRequest);
  ws.once("error", abortRequest);

  try {
    const { type: _type, ...requestBody } = payload;
    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: forwardedHeaders(req),
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });
    const response = await app.fetch(request);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await forwardSseResponse(ws, response);
    } else {
      await forwardJsonResponse(ws, response);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ws, buildError(message, "upstream_error", "server_error"));
    }
  } finally {
    ws.off("close", abortRequest);
    ws.off("error", abortRequest);
  }
}

function parseWsCreateMessage(raw: WebSocket.RawData): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return parsed;
}

function attachWsBridge(wss: WebSocketServer, deps: BridgeDeps): void {
  const responsesApp = createResponsesRoutes(deps.accountPool, deps.cookieJar, deps.proxyPool, deps.upstreamRouter);
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let inFlight = false;
    const maxConnectionMs = deps.maxConnectionMs ?? DEFAULT_MAX_CONNECTION_MS;
    const lifetimeTimer = maxConnectionMs > 0
      ? setTimeout(() => {
          sendJson(ws, buildError(
            "Connection exceeded maximum duration",
            "websocket_connection_limit_reached",
            "invalid_request_error",
          ));
          ws.close(1000, "websocket_connection_limit_reached");
        }, maxConnectionMs)
      : null;
    lifetimeTimer?.unref?.();

    ws.once("close", () => {
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
    });

    ws.on("message", (raw) => {
      void (async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const payload = parseWsCreateMessage(raw);
        if (!payload) {
          sendJson(ws, buildError("Malformed JSON websocket request body", "invalid_json"));
          return;
        }
        if (payload.type !== "response.create") {
          sendJson(ws, buildError("Only response.create is supported", "unsupported_type", "invalid_request_error", "type"));
          return;
        }
        if (inFlight) {
          sendJson(ws, buildError("a response is already in progress on this connection", "invalid_request"));
          return;
        }
        inFlight = true;
        try {
          await bridgeSingleRequest(ws, payload, req, responsesApp);
        } finally {
          inFlight = false;
        }
      })().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, buildError(message, "bridge_error", "server_error"));
      });
    });
  });
}

export function installResponsesWsBridge(server: import("http").Server, deps: BridgeDeps): ResponsesWsBridgeHandle {
  const wss = new WebSocketServer({ noServer: true });
  attachWsBridge(wss, deps);
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    if (!SUPPORTED_WS_PATHS.has(url.pathname)) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isAuthorizedUpgrade(req, deps.accountPool)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };
  server.on("upgrade", onUpgrade);
  return {
    close: () => new Promise((resolve) => {
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => resolve());
    }),
  };
}


import { Hono } from "hono";

export function createResponsesWsRoutes(..._args: any[]): Hono {
  return new Hono();
}
