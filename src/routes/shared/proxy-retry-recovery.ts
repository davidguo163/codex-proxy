import {
  isPreviousResponseNotFoundError,
  isUnansweredFunctionCallError,
} from "../../proxy/error-classification.js";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { stripCodexErrorPrefix } from "./proxy-handler-utils.js";
import { isSelfContainedReplay, getFunctionCallOutputIds } from "./proxy-session-helpers.js";

export type ProxyRetryRecoveryKind =
  | "previous_response_not_found"
  | "unanswered_function_call";

export type ProxyRetryRecoveryDecision =
  | {
    action: "retry";
    kind: ProxyRetryRecoveryKind;
    staleId?: string;
    logMessage: string;
  }
  | { action: "none" };

export interface BuildProxyRetryRecoveryDecisionOptions {
  err: unknown;
  tag: string;
  entryId: string;
  stripAndRetryDone: boolean;
  previousResponseId: string | undefined;
  request?: ProxyRequest;
}

export interface ApplyProxyRetryRecoveryDecisionOptions {
  decision: ProxyRetryRecoveryDecision;
  request: ProxyRequest;
  affinityMap: Pick<SessionAffinityMap, "forget">;
  restoreImplicitResumeRequest: () => void;
  log?: (message: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function canStripPreviousResponseId(request: ProxyRequest | undefined): boolean {
  if (!request) return true;
  if (request.requirePreviousResponseAccount) {
    return isSelfContainedReplay(request.codexRequest.input);
  }
  const outputIds = getFunctionCallOutputIds(request.codexRequest.input);
  return outputIds.length === 0 || isSelfContainedReplay(request.codexRequest.input);
}

export function buildProxyRetryRecoveryDecision({
  err,
  tag,
  entryId,
  stripAndRetryDone,
  previousResponseId,
  request,
}: BuildProxyRetryRecoveryDecisionOptions): ProxyRetryRecoveryDecision {
  if (stripAndRetryDone) {
    return { action: "none" };
  }

  if (!canStripPreviousResponseId(request)) {
    return { action: "none" };
  }

  if (isPreviousResponseNotFoundError(err)) {
    return {
      action: "retry",
      kind: "previous_response_not_found",
      staleId: previousResponseId,
      logMessage:
        `[${tag}] Account ${entryId} | previous_response_not_found (id=${previousResponseId ?? "?"}), stripping and retrying same account`,
    };
  }

  if (isUnansweredFunctionCallError(err)) {
    const message = stripCodexErrorPrefix(errorMessage(err)).slice(0, 200);
    return {
      action: "retry",
      kind: "unanswered_function_call",
      staleId: previousResponseId,
      logMessage:
        `[${tag}] Account ${entryId} | unanswered_function_call (id=${previousResponseId ?? "?"}): ${message}, stripping and retrying same account`,
    };
  }

  return { action: "none" };
}

export function applyProxyRetryRecoveryDecision(
  options: ApplyProxyRetryRecoveryDecisionOptions,
): boolean {
  const {
    decision,
    request,
    affinityMap,
    restoreImplicitResumeRequest,
    log = console.warn,
  } = options;

  if (decision.action !== "retry") {
    return false;
  }

  log(decision.logMessage);
  if (decision.staleId) affinityMap.forget(decision.staleId);
  restoreImplicitResumeRequest();
  request.codexRequest.previous_response_id = undefined;
  request.codexRequest.turnState = undefined;
  return true;
}
