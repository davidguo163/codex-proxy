import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";
import { buildCodexApi } from "./shared/proxy-handler-utils.js";
import { parseModelName, buildDisplayModelName, isRecognizedModelName } from "../models/model-store.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { sanitizeClientMetadata } from "../proxy/openai-subagent.js";
import { recordProxyEgressLog } from "./shared/proxy-egress-log.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getConfig } from "../config.js";
import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { applyParsedRateLimits } from "./shared/proxy-rate-limit.js";
import { extractImageGenUsage, extractResponseUsage } from "./responses.js";
import { logProxyUsage } from "./shared/proxy-usage-log.js";
import { buildWsPoolContext } from "./shared/proxy-ws-context.js";
import { computeVariantHash } from "./shared/variant-hash.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";

interface BridgeDeps {
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  upstreamRouter?: UpstreamRouter;
}

export interface ResponsesWsBridgeHandle {
  close: () => Promise<void>;
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function buildError(message: string, code: string, type = "invalid_request_error") {
  return { type: "error", error: { type, code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function bearerToken(header: string | string[] | undefined): string | null {
  const value = firstHeaderValue(header);
  const prefix = "Bearer ";
  return value?.startsWith(prefix) ? value.slice(prefix.length) : null;
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

function isUpgradeAuthorized(req: IncomingMessage, accountPool: AccountPool): boolean {
  const config = getConfig();
  if (!config.server.proxy_api_key) return true;
  const token = bearerToken(req.headers.authorization);
  return !!token && accountPool.validateProxyApiKey(token);
}

function toCodexRequest(payload: Record<string, unknown>): CodexResponsesRequest {
  const clientMetadata = sanitizeClientMetadata(
    (payload.client_metadata && typeof payload.client_metadata === "object" ? payload.client_metadata : {}) as Record<string, unknown>,
  );
  return {
    model: buildDisplayModelName(parseModelName(String(payload.model))),
    instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
    input: Array.isArray(payload.input) ? (payload.input as any[]) : [],
    stream: true,
    store: false,
    reasoning: typeof payload.reasoning === "object" && payload.reasoning ? (payload.reasoning as any) : undefined,
    service_tier: typeof payload.service_tier === "string" ? payload.service_tier : undefined,
    tools: Array.isArray(payload.tools) ? payload.tools : undefined,
    tool_choice: typeof payload.tool_choice === "string" || (payload.tool_choice && typeof payload.tool_choice === "object") ? payload.tool_choice as any : undefined,
    parallel_tool_calls: typeof payload.parallel_tool_calls === "boolean" ? payload.parallel_tool_calls : undefined,
    text: payload.text && typeof payload.text === "object" ? payload.text as any : undefined,
    previous_response_id: typeof payload.previous_response_id === "string" ? payload.previous_response_id : undefined,
    prompt_cache_key: typeof payload.prompt_cache_key === "string"
      ? payload.prompt_cache_key
      : typeof clientMetadata["x-client-request-id"] === "string" ? clientMetadata["x-client-request-id"] : undefined,
    client_metadata: clientMetadata,
    include: Array.isArray(payload.include) ? payload.include.filter((x): x is string => typeof x === "string") : undefined,
    useWebSocket: true,
    turnMetadata: typeof clientMetadata["x-codex-turn-metadata"] === "string" ? clientMetadata["x-codex-turn-metadata"] : undefined,
    betaFeatures: typeof clientMetadata["x-codex-beta-features"] === "string" ? clientMetadata["x-codex-beta-features"] : undefined,
    includeTimingMetrics: typeof clientMetadata["x-responsesapi-include-timing-metrics"] === "string" ? clientMetadata["x-responsesapi-include-timing-metrics"] : undefined,
    parentThreadId: typeof clientMetadata["x-codex-parent-thread-id"] === "string" ? clientMetadata["x-codex-parent-thread-id"] : undefined,
    codexWindowId: typeof clientMetadata["x-codex-window-id"] === "string" ? clientMetadata["x-codex-window-id"] : undefined,
  };
}

interface ResponsesWsSessionState {
  conversationId: string;
  entryId?: string;
}

async function bridgeSingleRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
  req: IncomingMessage,
  deps: BridgeDeps,
  session: ResponsesWsSessionState,
) {
  const model = typeof payload.model === "string" ? payload.model : null;
  if (!model) {
    sendJson(ws, buildError("Missing model", "invalid_request"));
    return;
  }
  const routeMatch = deps.upstreamRouter?.resolveMatch(model) ?? (isRecognizedModelName(model)
    ? { kind: "codex" as const }
    : { kind: "not-found" as const });
  if (routeMatch.kind !== "codex") {
    sendJson(ws, buildError("WebSocket bridge only supports codex-routed models", "unsupported_model_route"));
    return;
  }

  const codexRequest = toCodexRequest(payload);
  const acquired = acquireAccount(deps.accountPool, codexRequest.model, undefined, "ResponsesWS", session.entryId);
  if (!acquired) {
    sendJson(ws, buildError("No available accounts. All accounts are expired or rate-limited.", "no_available_accounts", "server_error"));
    return;
  }
  if (session.entryId && acquired.entryId !== session.entryId) {
    deps.accountPool.releaseWithoutCounting(acquired.entryId);
    sendJson(ws, buildError("Pinned websocket session account is no longer available.", "session_account_unavailable", "server_error"));
    return;
  }
  session.entryId = acquired.entryId;

  const released = new Set<string>();
  let usageInfo: UsageInfo | undefined;
  const requestId = firstHeaderValue(req.headers["x-client-request-id"]) || randomUUID().slice(0, 8);
  const conversationId = codexRequest.prompt_cache_key ?? session.conversationId;
  enqueueLogEntry({
    requestId,
    direction: "ingress",
    method: "WS",
    path: req.url || "/openai/v1/responses",
    model,
    stream: true,
    request: summarizeRequestForLog("responses_ws", payload, {
      ip: req.socket.remoteAddress || null,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")])),
    }),
  });

  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  ws.once("close", abortUpstream);
  ws.once("error", abortUpstream);

  try {
    const api = buildCodexApi(acquired.token, acquired.accountId, deps.cookieJar, acquired.entryId, deps.proxyPool);
    const startMs = Date.now();
    const response = await api.createResponse(
      codexRequest,
      abortController.signal,
      (rateLimits) => applyParsedRateLimits({ accountPool: deps.accountPool, entryId: acquired.entryId, rateLimits }),
      buildWsPoolContext({
        useWebSocket: codexRequest.useWebSocket,
        conversationId,
        entryId: acquired.entryId,
        variantHash: computeVariantHash(codexRequest.instructions, codexRequest.tools, codexRequest.model),
        requestId,
        tag: "ResponsesWS",
      }),
    );
    recordProxyEgressLog({
      requestId,
      request: { codexRequest, model: codexRequest.model, isStreaming: true },
      status: response.status,
      startMs,
    });

    for await (const evt of api.parseStream(response)) {
      const body = evt.data;
      if (evt.event === "response.completed" && isRecord(body) && isRecord(body.response)) {
        const responseBody = body.response;
        if (isRecord(responseBody.usage)) {
          usageInfo = {
            ...extractResponseUsage(responseBody.usage),
            ...(extractImageGenUsage(responseBody) ?? {}),
          };
        }
      }
      if (body && typeof body === "object") {
        sendJson(ws, body);
      } else {
        sendJson(ws, { type: evt.event || "event", data: body });
      }
    }
    if (usageInfo) {
      logProxyUsage({ tag: "ResponsesWS", entryId: acquired.entryId, requestId, usage: usageInfo });
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ws, buildError(message, "upstream_error", "server_error"));
    }
  } finally {
    ws.off("close", abortUpstream);
    ws.off("error", abortUpstream);
    releaseAccount(deps.accountPool, acquired.entryId, usageInfo, released);
  }
}

function attachWsBridge(wss: WebSocketServer, deps: BridgeDeps): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const session: ResponsesWsSessionState = {
      conversationId: firstHeaderValue(req.headers["x-client-request-id"]) || randomUUID().slice(0, 8),
    };
    let queue = Promise.resolve();

    ws.on("message", (raw) => {
      queue = queue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          sendJson(ws, buildError("Malformed JSON websocket request body", "invalid_json"));
          return;
        }
        if (payload.type !== "response.create") {
          sendJson(ws, buildError("Only response.create is supported", "unsupported_type"));
          return;
        }
        await bridgeSingleRequest(ws, payload, req, deps, session);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, buildError(message, "bridge_queue_error", "server_error"));
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
    if (url.pathname !== "/openai/v1/responses") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isUpgradeAuthorized(req, deps.accountPool)) {
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
