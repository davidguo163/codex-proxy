import { Hono } from "hono";
import { getConfig } from "../config.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { AccountInfo, CodexQuotaWindow } from "../auth/types.js";

type WindowSummary = {
  used_percent: number | null;
  remaining_percent: number | null;
  limit_reached: boolean;
  reset_at: number | null;
  reset_at_iso: string | null;
  limit_window_seconds: number | null;
};

function bearerToken(authHeader: string | undefined): string {
  return authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
}

function isAuthorized(authHeader: string | undefined): boolean {
  const configKey = getConfig().server.proxy_api_key;
  if (!configKey) return true;
  return bearerToken(authHeader) === configKey;
}

function resetAtIso(resetAt: number | null | undefined): string | null {
  return typeof resetAt === "number" ? new Date(resetAt * 1000).toISOString() : null;
}

function windowSummary(
  window: (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined,
): WindowSummary | null {
  if (!window) return null;
  return {
    used_percent: window.used_percent ?? null,
    remaining_percent: window.remaining_percent ?? null,
    limit_reached: window.limit_reached === true,
    reset_at: window.reset_at ?? null,
    reset_at_iso: resetAtIso(window.reset_at),
    limit_window_seconds: window.limit_window_seconds ?? null,
  };
}

function quotaEffectiveStatus(account: AccountInfo): string {
  const quota = account.quota;
  if (
    account.status === "active" &&
    (quota?.rate_limit.limit_reached === true ||
      quota?.secondary_rate_limit?.limit_reached === true ||
      quota?.code_review_rate_limit?.limit_reached === true)
  ) {
    return "rate_limited";
  }
  return account.status;
}

function toInternalAccountSummary(account: AccountInfo) {
  const primary = windowSummary(account.quota?.rate_limit);
  const weekly = windowSummary(account.quota?.secondary_rate_limit);
  return {
    id: account.id,
    email: account.email,
    label: account.label,
    planType: account.planType,
    status: account.status,
    effectiveStatus: quotaEffectiveStatus(account),
    quotaStatus: {
      exhausted: primary?.limit_reached === true ||
        weekly?.limit_reached === true ||
        account.quota?.code_review_rate_limit?.limit_reached === true,
      primary,
      weekly,
      codeReview: windowSummary(account.quota?.code_review_rate_limit),
      quotaFetchedAt: account.quotaFetchedAt ?? null,
    },
    usage: {
      request_count: account.usage.request_count,
      input_tokens: account.usage.input_tokens,
      output_tokens: account.usage.output_tokens,
      cached_tokens: account.usage.cached_tokens ?? 0,
      last_used: account.usage.last_used,
      window_request_count: account.usage.window_request_count ?? 0,
      window_reset_at: account.usage.window_reset_at ?? null,
      window_reset_at_iso: resetAtIso(account.usage.window_reset_at),
      limit_window_seconds: account.usage.limit_window_seconds ?? null,
    },
  };
}

export function createInternalPoolRoutes(pool: AccountPool): Hono {
  const app = new Hono();

  app.get("/api/codex/pool/accounts", (c) => {
    if (!isAuthorized(c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const accounts = pool.getAccounts().map(toInternalAccountSummary);
    return c.json({
      accounts,
      summary: pool.getPoolSummary(),
      generatedAt: new Date().toISOString(),
    });
  });

  return app;
}
