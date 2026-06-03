import type { AccountInfo, CodexQuotaWindow } from "../auth/types.js";

export interface PoolEncodedWindow {
  totalRemaining: number;
  displayRemaining: number;
  usedPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
  accountCount: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function remainingPercent(
  window: (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined,
): number | null {
  if (!window) return null;
  if (window.limit_reached === true) return 0;
  if (typeof window.remaining_percent === "number" && Number.isFinite(window.remaining_percent)) {
    return clampPercent(window.remaining_percent);
  }
  if (typeof window.used_percent === "number" && Number.isFinite(window.used_percent)) {
    return clampPercent(100 - window.used_percent);
  }
  return null;
}

export function encodePoolRemaining(totalRemaining: number): { displayRemaining: number; usedPercent: number } {
  const displayRemaining = clampPercent(totalRemaining / 10);
  return {
    displayRemaining,
    usedPercent: clampPercent(Math.round(100 - displayRemaining)),
  };
}

export function aggregatePoolWindow(
  accounts: AccountInfo[],
  selectWindow: (account: AccountInfo) => (CodexQuotaWindow & { limit_reached?: boolean }) | null | undefined,
): PoolEncodedWindow | null {
  let totalRemaining = 0;
  let resetAt: number | null = null;
  let limitWindowSeconds: number | null = null;
  let accountCount = 0;

  for (const account of accounts) {
    if (account.status !== "active") continue;
    const window = selectWindow(account);
    const remaining = remainingPercent(window);
    if (remaining == null) continue;

    totalRemaining += remaining;
    accountCount++;

    if (typeof window?.reset_at === "number" && Number.isFinite(window.reset_at)) {
      resetAt = resetAt == null ? window.reset_at : Math.min(resetAt, window.reset_at);
    }
    if (typeof window?.limit_window_seconds === "number" && Number.isFinite(window.limit_window_seconds)) {
      limitWindowSeconds = limitWindowSeconds == null
        ? window.limit_window_seconds
        : Math.max(limitWindowSeconds, window.limit_window_seconds);
    }
  }

  if (accountCount === 0) return null;

  const encoded = encodePoolRemaining(totalRemaining);
  return {
    totalRemaining,
    displayRemaining: encoded.displayRemaining,
    usedPercent: encoded.usedPercent,
    resetAt: Math.round(resetAt ?? (Date.now() / 1000 + 5 * 60 * 60)),
    limitWindowSeconds: Math.round(limitWindowSeconds ?? 5 * 60 * 60),
    accountCount,
  };
}
