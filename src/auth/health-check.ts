/**
 * Account health check — probes accounts by attempting token refresh.
 *
 * Uses OAuth refresh_token endpoint (auth.openai.com) only, never
 * hits the Codex API (chatgpt.com), so it won't trigger risk detection.
 *
 * Features:
 * - Single-account and batch modes
 * - Configurable stagger delay between accounts (anti-fingerprinting)
 * - Concurrent limit via semaphore
 * - Auto-marks accounts as expired on permanent refresh failure
 */

import { refreshAccessToken } from "./oauth-pkce.js";
import { AccountPersistenceError } from "./account-persistence.js";
import { tryAcquireRefreshLock, releaseRefreshLock } from "./refresh-lock.js";
import { jitterInt } from "../utils/jitter.js";
import type { AccountPool } from "./account-pool.js";
import type { RefreshScheduler } from "./refresh-scheduler.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";

export interface HealthCheckResult {
  id: string;
  email: string | null;
  previousStatus: string;
  result: "alive" | "dead" | "skipped";
  /** Error message when result is "dead". */
  error?: string;
  /** Duration in ms for this probe. */
  durationMs?: number;
}

export interface BatchHealthCheckOptions {
  /** Stagger delay between accounts in ms (default 3000). */
  staggerMs?: number;
  /** Max concurrent probes (default 2). */
  concurrency?: number;
  /** Only check accounts with these IDs (default: all with RT). */
  ids?: string[];
}

const PERMANENT_ERRORS = [
  "invalid_grant",
  "invalid_token",
  "access_denied",
  "refresh_token_expired",
  "refresh_token_reused",
  "account has been deactivated",
];

/**
 * Probe a single account by refreshing its token.
 * Returns the health check result without mutating account state.
 */
export async function probeAccount(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  entryId: string,
  proxyPool?: ProxyPool | null,
): Promise<HealthCheckResult> {
  const entry = pool.getEntry(entryId);
  if (!entry) {
    return { id: entryId, email: null, previousStatus: "unknown", result: "skipped", error: "not found" };
  }

  if (!entry.refreshToken) {
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "no refresh token" };
  }

  if (entry.status === "disabled") {
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "manually disabled" };
  }

  if (entry.status === "refreshing") {
    return {
      id: entryId,
      email: entry.email,
      previousStatus: entry.status,
      result: "skipped",
      error: "refresh already in progress; manual recovery required",
    };
  }

  // Skip if scheduler is already refreshing this account — avoid racing for the same one-time RT
  if (scheduler.isRefreshing?.(entryId)) {
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "refresh already in progress" };
  }

  if (!tryAcquireRefreshLock(entryId)) {
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "refresh already in progress" };
  }

  const previousStatus = entry.status;
  const start = Date.now();

  try {
    const accountProxyUrl = proxyPool?.resolveProxyUrl(entryId, true);
    const diskState = pool.readEntryRefreshStateFromDisk?.(entryId) ??
      (pool.readEntryRTFromDisk
        ? { token: null, refreshToken: pool.readEntryRTFromDisk(entryId), status: null }
        : null);
    if (diskState?.status === "refreshing") {
      return {
        id: entryId,
        email: entry.email,
        previousStatus,
        result: "skipped",
        error: "refresh already in progress; manual recovery required",
        durationMs: Date.now() - start,
      };
    }
    const memoryRefreshToken = pool.getEntry(entryId)?.refreshToken ?? entry.refreshToken;
    if (diskState?.refreshToken && diskState.refreshToken !== memoryRefreshToken) {
      const token = diskState.token ?? pool.getEntry(entryId)?.token ?? entry.token;
      pool.updateToken(entryId, token, diskState.refreshToken);
      scheduler.scheduleOne(entryId, token);
      return {
        id: entryId,
        email: entry.email,
        previousStatus,
        result: "alive",
        durationMs: Date.now() - start,
      };
    }

    if (!pool.markStatus(entryId, "refreshing")) {
      return {
        id: entryId,
        email: entry.email,
        previousStatus,
        result: "skipped",
        error: "not found",
        durationMs: Date.now() - start,
      };
    }
    const refreshToken = pool.getEntry(entryId)?.refreshToken ?? entry.refreshToken;

    const isOneTimeRT = refreshToken.startsWith("oaistb_rt_");
    const tokens = await refreshAccessToken(refreshToken, accountProxyUrl);
    if (isOneTimeRT && !tokens.refresh_token) {
      return {
        id: entryId,
        email: entry.email,
        previousStatus,
        result: "dead",
        error: "one-time refresh token response did not include a replacement refresh token",
        durationMs: Date.now() - start,
      };
    }
    pool.updateToken(entryId, tokens.access_token, tokens.refresh_token ?? undefined);
    scheduler.scheduleOne(entryId, tokens.access_token);

    return {
      id: entryId,
      email: entry.email,
      previousStatus,
      result: "alive",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof AccountPersistenceError) {
      return {
        id: entryId,
        email: entry.email,
        previousStatus,
        result: "dead",
        error: msg,
        durationMs: Date.now() - start,
      };
    }
    const isPermanent = PERMANENT_ERRORS.some((e) => msg.toLowerCase().includes(e));
    const isOneTimeRT = entry.refreshToken.startsWith("oaistb_rt_");

    if (isPermanent && !isOneTimeRT) {
      pool.markStatus(entryId, "expired");
    } else if (!isOneTimeRT) {
      pool.markStatus(entryId, previousStatus);
    }

    return {
      id: entryId,
      email: entry.email,
      previousStatus,
      result: "dead",
      error: msg,
      durationMs: Date.now() - start,
    };
  } finally {
    releaseRefreshLock(entryId);
  }
}

/**
 * Batch health check with stagger delay and concurrency control.
 * Yields results as they complete (for SSE streaming if needed).
 */
export async function batchHealthCheck(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  options?: BatchHealthCheckOptions,
  proxyPool?: ProxyPool | null,
): Promise<HealthCheckResult[]> {
  const staggerMs = options?.staggerMs ?? 3000;
  const concurrency = options?.concurrency ?? 2;

  // Collect eligible accounts
  const allEntries = pool.getAllEntries();
  const candidates = options?.ids
    ? allEntries.filter((e) => options.ids!.includes(e.id))
    : allEntries;

  // Filter: need RT, not disabled
  const eligible = candidates.filter((e) => e.refreshToken && e.status !== "disabled");
  const skipped = candidates.filter((e) => !e.refreshToken || e.status === "disabled");

  const results: HealthCheckResult[] = skipped.map((e) => ({
    id: e.id,
    email: e.email,
    previousStatus: e.status,
    result: "skipped" as const,
    error: !e.refreshToken ? "no refresh token" : "manually disabled",
  }));

  // Process with concurrency limit + stagger
  let running = 0;
  const queue: Array<() => void> = [];
  let accountIndex = 0;

  const acquireSlot = (): Promise<void> => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };

  const releaseSlot = (): void => {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  };

  const tasks = eligible.map((entry) => {
    const myIndex = accountIndex++;
    return (async () => {
      // Stagger: wait before starting (skip first account)
      if (myIndex > 0) {
        const delay = jitterInt(staggerMs * Math.min(myIndex, concurrency), 0.3);
        await new Promise((r) => setTimeout(r, delay));
      }
      await acquireSlot();
      try {
        const result = await probeAccount(pool, scheduler, entry.id, proxyPool);
        results.push(result);
      } finally {
        releaseSlot();
      }
    })();
  });

  await Promise.all(tasks);
  return results;
}
