import type { WsPoolContext } from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-types.js";
import type { ParsedRateLimit } from "../../proxy/rate-limit-headers.js";
import { getConfig } from "../../config.js";
import { withRetry } from "../../utils/retry.js";
import { dumpProxyRequest } from "./proxy-debug-dump.js";
import { recordProxyEgressLog } from "./proxy-egress-log.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import {
  applyParsedRateLimits,
  applyRateLimitHeaders,
  type RateLimitAccountPool,
} from "./proxy-rate-limit.js";

export interface ProxyUpstreamAttemptApi {
  createResponse(
    request: CodexResponsesRequest,
    signal: AbortSignal,
    onRateLimits?: (rateLimits: ParsedRateLimit) => void,
    poolCtx?: WsPoolContext,
  ): Promise<Response>;
}

export interface SendProxyUpstreamAttemptOptions {
  accountPool: RateLimitAccountPool;
  api: ProxyUpstreamAttemptApi;
  request: ProxyRequest;
  entryId: string;
  abortSignal: AbortSignal;
  buildPoolCtx: () => WsPoolContext | undefined;
  requestId: string;
  tag: string;
  conversationId: string | null | undefined;
  implicitResumeActive: boolean;
  resumeReason: string | null | undefined;
  nowMs?: () => number;
  retryOptions?: {
    maxRetries?: number;
    baseDelayMs?: number;
  };
  hardTimeoutMs?: number;
  logWarn?: (line: string) => void;
}

export interface ProxyUpstreamAttemptResult {
  rawResponse: Response;
  upstreamTurnState: string | undefined;
}

const DEFAULT_UPSTREAM_CREATE_RESPONSE_TIMEOUT_MS = 600_000;

function defaultHardTimeoutMs(): number {
  try {
    return getConfig().api.timeout_seconds * 1000;
  } catch {
    return DEFAULT_UPSTREAM_CREATE_RESPONSE_TIMEOUT_MS;
  }
}

export async function sendProxyUpstreamAttempt(
  options: SendProxyUpstreamAttemptOptions,
): Promise<ProxyUpstreamAttemptResult> {
  const {
    accountPool,
    api,
    request,
    entryId,
    abortSignal,
    buildPoolCtx,
    requestId,
    tag,
    conversationId,
    implicitResumeActive,
    resumeReason,
    retryOptions,
  } = options;
  const nowMs = options.nowMs ?? Date.now;
  const hardTimeoutMs = options.hardTimeoutMs ?? defaultHardTimeoutMs();
  const logWarn = options.logWarn ?? ((line: string) => console.warn(line));

  const applyRateLimits = (rateLimits: ParsedRateLimit): void => {
    applyParsedRateLimits({ accountPool, entryId, rateLimits });
  };

  const startMs = nowMs();
  dumpProxyRequest({
    requestId,
    tag,
    entryId,
    conversationId,
    implicitResumeActive,
    resumeReason,
    payload: request.codexRequest,
  });
  const rawResponse = await withRetry(
    () => {
      const poolCtx = buildPoolCtx();
      return runCreateResponseWithHardTimeout({
        api,
        request: request.codexRequest,
        upstreamAbortSignal: abortSignal,
        applyRateLimits,
        poolCtx,
        hardTimeoutMs,
        logWarn,
        tag,
        requestId,
        entryId,
      });
    },
    { tag, ...retryOptions },
  );
  recordProxyEgressLog({
    requestId,
    request,
    status: rawResponse.status,
    startMs,
  });
  applyRateLimitHeaders({ accountPool, entryId, headers: rawResponse.headers });

  return {
    rawResponse,
    upstreamTurnState: rawResponse.headers.get("x-codex-turn-state") ?? undefined,
  };
}

function runCreateResponseWithHardTimeout(options: {
  api: ProxyUpstreamAttemptApi;
  request: CodexResponsesRequest;
  upstreamAbortSignal: AbortSignal;
  applyRateLimits: (rateLimits: ParsedRateLimit) => void;
  poolCtx: WsPoolContext | undefined;
  hardTimeoutMs: number;
  logWarn: (line: string) => void;
  tag: string;
  requestId: string;
  entryId: string;
}): Promise<Response> {
  const {
    api,
    request,
    upstreamAbortSignal,
    applyRateLimits,
    poolCtx,
    hardTimeoutMs,
    logWarn,
    tag,
    requestId,
    entryId,
  } = options;

  if (hardTimeoutMs <= 0) {
    return api.createResponse(request, upstreamAbortSignal, applyRateLimits, poolCtx);
  }

  const attemptAbortController = new AbortController();
  const onUpstreamAbort = () => attemptAbortController.abort(upstreamAbortSignal.reason);
  if (upstreamAbortSignal.aborted) {
    attemptAbortController.abort(upstreamAbortSignal.reason);
  } else {
    upstreamAbortSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const createResponsePromise = api
    .createResponse(request, attemptAbortController.signal, applyRateLimits, poolCtx)
    .finally(() => {
      upstreamAbortSignal.removeEventListener("abort", onUpstreamAbort);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });

  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      attemptAbortController.abort(new Error("upstream createResponse hard timeout"));
      const rid = requestId.slice(0, 8);
      const poolKey = poolCtx?.poolKey ?? "none";
      logWarn(
        `[${tag}] Account ${entryId} | rid=${rid} | upstream createResponse hard timeout ` +
          `after ${hardTimeoutMs}ms poolKey=${poolKey}`,
      );
      reject(new Error(
        `Upstream createResponse hard timeout after ${hardTimeoutMs}ms` +
          ` (rid=${rid}, entryId=${entryId}, poolKey=${poolKey})`,
      ));
    }, hardTimeoutMs);
    timer.unref?.();
  });

  return Promise.race([createResponsePromise, timeoutPromise]).finally(() => {
    if (!timedOut) return;
    createResponsePromise.catch(() => { /* abort fallout is already represented by the timeout error */ });
  });
}
