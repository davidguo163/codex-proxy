/**
 * WebSocket transport for the Codex Responses API.
 *
 * Opens a WebSocket to the backend, sends a `response.create` message,
 * and wraps incoming JSON messages into an SSE-formatted ReadableStream.
 * This lets parseStream() and all downstream consumers work identically
 * regardless of whether HTTP SSE or WebSocket was used.
 *
 * Used when `previous_response_id` is present — HTTP SSE does not support it.
 *
 * The `ws` package is loaded lazily via dynamic import so its heavy
 * CJS init (Receiver/Sender/PerMessageDeflate) is deferred until the
 * WS path is actually exercised. Note: esbuild still bundles ws into
 * the ESM server bundle; that bundling is what makes the
 * `createRequire` banner in packages/electron/electron/build.mjs
 * load-bearing — without it, ws's `require("events")` etc. throw
 * `Dynamic require of "X" is not supported` at runtime.
 */

import type { CodexInputItem } from "./codex-api.js";
import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { rewriteRateLimitsEventForPool } from "./rate-limit-headers.js";
import { parseRateLimitsEvent } from "./rate-limit-headers.js";
import { CodexApiError } from "./codex-types.js";
import type { AccountInfo } from "../auth/types.js";
import { getProxyUrl } from "../tls/proxy.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PersistentWs,
  WsReusedConnectionError,
  type PersistentWsHooks,
  type WsConnectionPool,
} from "./ws-pool.js";

/**
 * Map an upstream WS terminal error frame (`type: "error"` or
 * `type: "response.failed"`) to an HTTP-equivalent status so that the
 * proxy-handler's existing CodexApiError rotation flow can take over.
 *
 * Returns null for events we don't want to rotate on (genuine model
 * errors, validation errors, etc.) — those keep the SSE pass-through
 * behavior so the client sees the real reason.
 *
 * Why exact-match: a substring rule like `includes("rate_limit")` would
 * also match codes such as `soft_rate_limit_warning` and incorrectly
 * trigger account rotation. We allowlist concrete codes and fall through
 * for everything else (unknown codes stream as SSE — safer default).
 */
const ROTATABLE_ERROR_CODES: Readonly<Record<string, number>> = {
  // 429 — weekly/primary cap
  usage_limit_reached: 429,
  rate_limit_exceeded: 429,
  rate_limit_reached: 429,
  // 402 — plan/credit exhausted
  quota_exhausted: 402,
  payment_required: 402,
  // 401 — credential rejected upstream
  unauthorized: 401,
  token_invalid: 401,
  token_expired: 401,
  account_deactivated: 401,
  // 403 — account banned
  forbidden: 403,
  account_banned: 403,
  banned: 403,
  // 400 — stale previous_response_id (account doesn't recognise it; let
  // proxy-handler strip the ID and retry on the same account)
  previous_response_not_found: 400,
};

function classifyWsErrorEvent(msg: Record<string, unknown>): { status: number } | null {
  const type = typeof msg.type === "string" ? msg.type : "";
  if (type !== "error" && type !== "response.failed") return null;
  const errorObj = typeof msg.error === "object" && msg.error !== null
    ? (msg.error as Record<string, unknown>)
    : null;
  if (!errorObj) return null;
  const codeRaw =
    (typeof errorObj.code === "string" ? errorObj.code : null) ??
    (typeof errorObj.type === "string" ? errorObj.type : null) ??
    "";
  const status = ROTATABLE_ERROR_CODES[codeRaw.toLowerCase()];
  return status ? { status } : null;
}

function isTerminalWsEvent(type: string): boolean {
  return type === "response.completed" || type === "response.failed" || type === "error";
}

/** Cached ws module — loaded once on first use. */
let _WS: typeof import("ws").default | undefined;

/** Cached proxy agents keyed by URL — avoids creating a new TCP connection per request. */
const _agentCache = new Map<string, InstanceType<typeof import("https-proxy-agent").HttpsProxyAgent>>();

/** Lazily load the `ws` package. */
async function getWS(): Promise<typeof import("ws").default> {
  if (!_WS) {
    const mod = await import("ws");
    _WS = mod.default;
  }
  return _WS;
}

/**
 * Public alias of `getWS` — exposes the lazy ws loader so the Electron
 * bundle smoke test can force ws's CJS factory to run without spinning
 * up the full server. Re-exported via packages/electron/src/electron-entry.ts;
 * consumed by packages/electron/__tests__/build.test.ts.
 */
export const loadWebSocketModule = getWS;

/** Flat WebSocket message format expected by the Codex backend. */
export interface WsCreateRequest {
  type: "response.create";
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  previous_response_id?: string;
  reasoning?: { effort?: string; summary?: string };
  tools?: unknown[];
  tool_choice?: string | { type: string; name?: string };
  parallel_tool_calls?: boolean;
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  service_tier?: string;
  prompt_cache_key?: string;
  client_metadata?: Record<string, string>;
  include?: string[];
}

/** Optional pool routing context. When provided, `createWebSocketResponse`
 *  tries to reuse a pooled WS for `(entryId, poolKey)` before falling back
 *  to opening a fresh one-shot connection. */
export interface WsPoolContext {
  pool: WsConnectionPool;
  poolKey: string;
  entryId: string;
  /** Optional observer fired once with the pool's dispatch decision. Useful
   *  for logging without coupling the caller to the pool's internal state. */
  onDecision?: (decision: WsDispatchDecision) => void;
  getPoolAccounts?: () => AccountInfo[];
}

export type WsDispatchDecision =
  | { kind: "reuse"; wsId: string }
  | { kind: "new"; wsId: string }
  | { kind: "bypass"; reason: string }
  | { kind: "retry-after-stale-reuse"; wsId: string };

async function buildWsConstructorOpts(
  WS: typeof import("ws").default,
  headers: Record<string, string>,
  proxyUrl: string | null | undefined,
): Promise<ConstructorParameters<typeof WS>[2]> {
  const wsOpts: ConstructorParameters<typeof WS>[2] = { headers };
  // Mirror native transport proxy semantics:
  // undefined = global default, null = explicit direct, string = specific proxy.
  const effectiveProxyUrl =
    proxyUrl === undefined ? getProxyUrl() : proxyUrl;
  if (effectiveProxyUrl) {
    let agent = _agentCache.get(effectiveProxyUrl);
    if (!agent) {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new HttpsProxyAgent(effectiveProxyUrl);
      _agentCache.set(effectiveProxyUrl, agent);
    }
    wsOpts.agent = agent;
  }
  return wsOpts;
}

/** Factory used by the pool to construct a brand-new persistent connection.
 *  Connects + waits for OPEN before returning so callers can immediately
 *  send. The PersistentWs is constructed up-front so its `upgrade` listener
 *  catches the initial response headers (which carry rate-limit data). */
async function createPersistentWsConnection(opts: {
  wsUrl: string;
  headers: Record<string, string>;
  proxyUrl: string | null | undefined;
  entryId: string;
  poolKey: string;
  hooks: PersistentWsHooks;
}): Promise<PersistentWs> {
  const WS = await getWS();
  const wsOpts = await buildWsConstructorOpts(WS, opts.headers, opts.proxyUrl);
  const ws = new WS(opts.wsUrl, wsOpts);

  // Construct PersistentWs first so its upgrade/error/close handlers attach
  // before the WebSocket handshake completes.
  const persistent = new PersistentWs({
    ws,
    entryId: opts.entryId,
    poolKey: opts.poolKey,
    hooks: opts.hooks,
  });

  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === ws.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      try { ws.close(1000, "connect timeout"); } catch { /* already closing */ }
      reject(new Error(
        `WebSocket upstream connect timeout after ${DEFAULT_CONNECT_TIMEOUT_MS}ms` +
          ` entryId=${opts.entryId} poolKey=${opts.poolKey} wsId=${persistent.id}`,
      ));
    }, DEFAULT_CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onErr);
      ws.removeListener("close", onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onErr = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error("WebSocket closed before open")); };
    ws.once("open", onOpen);
    ws.once("error", onErr);
    ws.once("close", onClose);
  });

  return persistent;
}

/**
 * Open a WebSocket to the Codex backend, send `response.create`,
 * and return a Response whose body is an SSE-formatted ReadableStream.
 *
 * The SSE format matches what parseStream() expects:
 *   event: <type>\ndata: <json>\n\n
 *
 * When `poolCtx` is provided the call first tries to reuse a pooled WS for
 * `(entryId, poolKey)`; on a `WsReusedConnectionError` (stale-reuse failure)
 * it falls back to a fresh one-shot connection exactly once.
 */
export async function createWebSocketResponse(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal?: AbortSignal,
  proxyUrl?: string | null,
  onRateLimits?: (rl: ParsedRateLimit) => void,
  poolCtx?: WsPoolContext,
): Promise<Response> {
  if (poolCtx) {
    try {
      const acquired = await poolCtx.pool.acquire(
        poolCtx.entryId,
        poolCtx.poolKey,
        (deps) =>
          createPersistentWsConnection({
            wsUrl,
            headers,
            proxyUrl,
            entryId: deps.entryId,
            poolKey: deps.poolKey,
            hooks: deps.hooks,
          }),
      );
      if ("ws" in acquired) {
        poolCtx.onDecision?.({
          kind: acquired.reused ? "reuse" : "new",
          wsId: acquired.ws.id,
        });
        try {
          return await acquired.ws.send({ request, signal, onRateLimits, reused: acquired.reused, getPoolAccounts: poolCtx.getPoolAccounts });
        } catch (err) {
          if (err instanceof WsReusedConnectionError) {
            // Stale-reuse: open a fresh one-shot WS for this single request.
            // The pool's onDead hook has already evicted the dead entry.
            poolCtx.onDecision?.({ kind: "retry-after-stale-reuse", wsId: acquired.ws.id });
            return openOneShotWs(wsUrl, headers, request, signal, proxyUrl, onRateLimits, poolCtx?.getPoolAccounts);
          }
          throw err;
        }
      }
      // Bypass (busy / cap / dead / no_key / disabled) → fall through to one-shot.
      poolCtx.onDecision?.({ kind: "bypass", reason: acquired.bypass });
    } catch (err) {
      // Pool itself failed (e.g. factory could not connect). Don't punish the
      // caller — fall back to the legacy one-shot path. The error is still
      // visible in the one-shot path if the underlying issue persists.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ws-pool] acquire failed, using one-shot fallback: ${msg}`);
      poolCtx.onDecision?.({ kind: "bypass", reason: "factory_error" });
    }
  }

  return openOneShotWs(wsUrl, headers, request, signal, proxyUrl, onRateLimits, poolCtx?.getPoolAccounts);
}

async function openOneShotWs(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal: AbortSignal | undefined,
  proxyUrl: string | null | undefined,
  onRateLimits: ((rl: ParsedRateLimit) => void) | undefined,
  getPoolAccounts?: (() => AccountInfo[]) | undefined,
): Promise<Response> {
  const WS = await getWS();
  const wsOpts = await buildWsConstructorOpts(WS, headers, proxyUrl);

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before WebSocket connect"));
      return;
    }

    const ws = new WS(wsUrl, wsOpts);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    // Flips the first time we either resolve(Response) or reject(...).
    // Internal `codex.rate_limits` frames do NOT flip this — we keep waiting
    // for a real first frame so we can detect early upstream errors and
    // route them through the existing CodexApiError → rotation path.
    let earlyDecisionMade = false;
    let sawTerminalEvent = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null;

    function closeStream() {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    }

    function errorStream(err: Error) {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.error(err); } catch { /* already closed */ }
      }
    }

    function clearFirstEventTimer() {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = null;
      }
    }

    function clearConnectTimer() {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }

    function clearStreamIdleTimer() {
      if (streamIdleTimer) {
        clearTimeout(streamIdleTimer);
        streamIdleTimer = null;
      }
    }

    function clearTimers() {
      clearConnectTimer();
      clearFirstEventTimer();
      clearStreamIdleTimer();
    }

    function armStreamIdleTimeout() {
      if (DEFAULT_STREAM_IDLE_TIMEOUT_MS <= 0 || sawTerminalEvent || streamClosed) return;
      clearStreamIdleTimer();
      streamIdleTimer = setTimeout(() => {
        if (sawTerminalEvent || streamClosed) return;
        errorStream(new Error(`WebSocket upstream stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`));
        try { ws.close(1000, "stream idle timeout"); } catch { /* already closing */ }
      }, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      streamIdleTimer.unref?.();
    }

    // Abort signal handling
    const onAbort = () => {
      clearTimers();
      try { ws.close(1000, "aborted"); } catch { /* already closing */ }
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        reject(new Error("Aborted during WebSocket connect"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    connectTimer = setTimeout(() => {
      if (earlyDecisionMade || streamClosed) return;
      earlyDecisionMade = true;
      signal?.removeEventListener("abort", onAbort);
      try { ws.close(1000, "connect timeout"); } catch { /* already closing */ }
      reject(new Error(`WebSocket upstream connect timeout after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`));
    }, DEFAULT_CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        clearTimers();
        ws.close(1000, "stream cancelled");
      },
    });

    // Capture upgrade response headers (contains x-codex-* rate limit data)
    let upgradeHeaders: Record<string, string | string[]> = {};
    ws.on("upgrade", (response: { headers: Record<string, string | string[]> }) => {
      upgradeHeaders = response.headers;
    });

    function buildResponse(): Response {
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      for (const [key, value] of Object.entries(upgradeHeaders)) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v != null) responseHeaders.set(key, v);
      }
      return new Response(stream, { status: 200, headers: responseHeaders });
    }

    ws.on("open", () => {
      clearConnectTimer();
      ws.send(JSON.stringify(request));
      firstEventTimer = setTimeout(() => {
        if (earlyDecisionMade || streamClosed) return;
        earlyDecisionMade = true;
        reject(new Error(`WebSocket upstream first event timeout after ${DEFAULT_FIRST_EVENT_TIMEOUT_MS}ms`));
        try { ws.close(1000, "first event timeout"); } catch { /* already closing */ }
      }, DEFAULT_FIRST_EVENT_TIMEOUT_MS);
      firstEventTimer.unref?.();
      // resolve() is deferred until the first non-internal frame arrives in
      // ws.on("message"). This lets us classify early upstream errors (e.g.
      // usage_limit_reached) and reject with a CodexApiError so the
      // proxy-handler's existing rotation flow takes over instead of the
      // error being passed through mid-stream to the client.
    });

    ws.on("message", (data: Buffer | string) => {
      if (streamClosed) return;
      const raw = typeof data === "string" ? data : data.toString("utf-8");

      let msg: Record<string, unknown> | null = null;
      let type = "unknown";
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
        type = typeof msg.type === "string" ? msg.type : "unknown";
      } catch {
        // Non-JSON message — handled below as raw data.
      }

      // Internal rate-limit frames are observed via `onRateLimits` but not
      // streamed, and they don't flip the early-decision flag — we keep
      // waiting for a real frame so we can detect early upstream errors.
      // If no callback is provided (test-only path), fall through and
      // forward the frame as SSE like any other event.
      if (msg && type === "codex.rate_limits" && onRateLimits) {
        const rl = parseRateLimitsEvent(msg);
        if (rl) onRateLimits(rl);
        const rewritten = getPoolAccounts ? rewriteRateLimitsEventForPool(msg, getPoolAccounts()) : null;
        if (!rewritten) return;
        msg = rewritten;
        type = typeof msg.type === "string" ? msg.type : type;
      }

      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        clearFirstEventTimer();
        if (msg) {
          const classified = classifyWsErrorEvent(msg);
          if (classified) {
            reject(new CodexApiError(classified.status, JSON.stringify(msg)));
            try { ws.close(1000, "early upstream error"); } catch { /* already closing */ }
            return;
          }
        }
        resolve(buildResponse());
        // fall through to enqueue this first frame
      }

      if (msg) {
        // Re-encode as SSE: event: <type>\ndata: <full json>\n\n
        const payload = JSON.stringify(msg);
        const sse = `event: ${type}\ndata: ${payload}\n\n`;
        controller!.enqueue(encoder.encode(sse));

        // Close stream after response.completed, response.failed, or error
        if (isTerminalWsEvent(type)) {
          sawTerminalEvent = true;
          clearTimers();
          queueMicrotask(() => {
            closeStream();
            ws.close(1000);
          });
        } else {
          armStreamIdleTimeout();
        }
      } else {
        // Non-JSON message — emit as raw data
        const sse = `data: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));
        armStreamIdleTimeout();
      }
    });

    ws.on("error", (err: Error) => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        reject(err);
      } else {
        errorStream(err);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (!earlyDecisionMade) {
        earlyDecisionMade = true;
        const reasonStr = reason && reason.length ? reason.toString("utf-8") : "";
        reject(new Error(
          `WebSocket closed before any data: code=${code}` +
            (reasonStr ? ` reason=${reasonStr}` : ""),
        ));
        return;
      }
      if (earlyDecisionMade && !sawTerminalEvent) {
        const reasonStr = reason && reason.length ? reason.toString("utf-8") : "";
        errorStream(new Error(
          `WebSocket closed before terminal event: code=${code}` +
            (reasonStr ? ` reason=${reasonStr}` : ""),
        ));
        return;
      }
      closeStream();
    });
  });
}
