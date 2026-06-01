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

function isAdminAuthorized(authHeader: string | undefined): boolean {
  const configKey = getConfig().server.proxy_api_key;
  if (!configKey) return true;
  const token = bearerToken(authHeader);
  return token === configKey;
}

function isClientAuthorized(pool: AccountPool, authHeader: string | undefined): boolean {
  const token = bearerToken(authHeader);
  try {
    return !!token && pool.validateProxyApiKey(token);
  } catch {
    return false;
  }
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

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function remainingPercent(window: (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined): number | null {
  if (!window) return null;
  if (window.limit_reached === true) return 0;
  if (typeof window.used_percent === "number" && Number.isFinite(window.used_percent)) {
    return clampPercent(100 - window.used_percent);
  }
  if (typeof window.remaining_percent === "number" && Number.isFinite(window.remaining_percent)) {
    return clampPercent(window.remaining_percent);
  }
  return null;
}

function usedPercentFromEncodedRemaining(encodedRemaining: number): number {
  if (encodedRemaining <= 0) return 100;
  return Math.min(99, Math.max(0, Math.floor(100 - encodedRemaining)));
}

type AggregatedWindow = {
  totalRemaining: number;
  encodedRemaining: number;
  usedPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
  accountCount: number;
};

function aggregateWindow(
  accounts: AccountInfo[],
  selectWindow: (account: AccountInfo) => (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined,
): AggregatedWindow | null {
  let totalRemaining = 0;
  let resetAt: number | null = null;
  let limitWindowSeconds: number | null = null;
  let accountCount = 0;

  for (const account of accounts) {
    if (account.status !== "active") continue;
    const window = selectWindow(account);
    const remaining = remainingPercent(window);
    if (remaining === null) continue;

    totalRemaining += remaining;
    accountCount++;

    if (typeof window?.reset_at === "number" && Number.isFinite(window.reset_at)) {
      resetAt = resetAt === null ? window.reset_at : Math.min(resetAt, window.reset_at);
    }
    if (
      typeof window?.limit_window_seconds === "number" &&
      Number.isFinite(window.limit_window_seconds)
    ) {
      limitWindowSeconds = limitWindowSeconds === null
        ? window.limit_window_seconds
        : Math.max(limitWindowSeconds, window.limit_window_seconds);
    }
  }

  if (accountCount === 0) return null;

  const encodedRemaining = clampPercent(totalRemaining / 100);
  return {
    totalRemaining,
    encodedRemaining,
    usedPercent: usedPercentFromEncodedRemaining(encodedRemaining),
    resetAt: Math.round(resetAt ?? (Date.now() / 1000 + 5 * 60 * 60)),
    limitWindowSeconds: Math.round(limitWindowSeconds ?? 5 * 60 * 60),
    accountCount,
  };
}

function rateLimitWindow(window: AggregatedWindow) {
  return {
    used_percent: window.usedPercent,
    limit_window_seconds: window.limitWindowSeconds,
    reset_after_seconds: Math.max(0, Math.round(window.resetAt - Date.now() / 1000)),
    reset_at: window.resetAt,
  };
}

function poolUsagePayload(accounts: AccountInfo[]) {
  const primary = aggregateWindow(accounts, (account) => account.quota?.rate_limit);
  const secondary = aggregateWindow(accounts, (account) => account.quota?.secondary_rate_limit);
  const anyQuotaAccount = accounts.find((account) => account.status === "active" && account.quota);

  if (!primary && !secondary) return null;

  const primaryWindow = primary ? rateLimitWindow(primary) : null;
  const secondaryWindow = secondary ? rateLimitWindow(secondary) : null;
  const limitReached = primary?.totalRemaining === 0 || secondary?.totalRemaining === 0;

  return {
    plan_type: anyQuotaAccount?.quota?.plan_type ?? anyQuotaAccount?.planType ?? "unknown",
    rate_limit: {
      allowed: true,
      limit_reached: limitReached,
      primary_window: primaryWindow,
      secondary_window: secondaryWindow,
    },
    code_review_rate_limit: null,
    additional_rate_limits: null,
    credits: {
      has_credits: false,
      unlimited: false,
      overage_limit_reached: false,
      balance: "0",
    },
    spend_control: null,
    rate_limit_reached_type: limitReached
      ? {
          type: "rate_limit_reached",
          details: "codex-proxy compressed pool usage reached zero remaining capacity",
        }
      : null,
    codex_proxy_pool: {
      encoding: "displayed_remaining_percent_x100",
      primary_total_remaining_percent: primary?.totalRemaining ?? null,
      secondary_total_remaining_percent: secondary?.totalRemaining ?? null,
      primary_account_count: primary?.accountCount ?? 0,
      secondary_account_count: secondary?.accountCount ?? 0,
    },
  };
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
    if (!isAdminAuthorized(c.req.header("Authorization"))) {
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

  app.get("/api/codex/usage", (c) => {
    if (!isClientAuthorized(pool, c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const payload = poolUsagePayload(pool.getAccounts());
    if (!payload) {
      c.status(503);
      return c.json({
        error: "codex_proxy_pool_quota_unavailable",
        message: "No active account has cached quota data. Refresh account quota first.",
      });
    }

    return c.json(payload);
  });

  return app;
}
