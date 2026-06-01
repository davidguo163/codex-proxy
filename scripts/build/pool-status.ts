#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type AccountStatus = "active" | "expired" | "quota_exhausted" | "refreshing" | "disabled" | "banned" | string;

type QuotaWindow = {
  used_percent?: number | null;
  remaining_percent?: number | null;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
  limit_reached?: boolean | null;
};

type CachedQuota = {
  plan_type?: string | null;
  rate_limit?: (QuotaWindow & { allowed?: boolean | null }) | null;
  secondary_rate_limit?: QuotaWindow | null;
  code_review_rate_limit?: QuotaWindow | null;
};

type AccountEntry = {
  id?: string | null;
  token?: string | null;
  email?: string | null;
  label?: string | null;
  planType?: string | null;
  status?: AccountStatus | null;
  quotaFetchedAt?: string | null;
  addedAt?: string | null;
  expiresAt?: string | null;
  cachedQuota?: CachedQuota | null;
};

type AccountsFile = { accounts?: AccountEntry[] } | AccountEntry[];

type WindowDisplay = {
  remain: number | null;
  used: number | null;
  resetAt: number | null;
  resetText: string;
  limitReached: boolean;
};

type Row = {
  sortReset: number;
  account: AccountEntry;
  effectiveStatus: string;
  primary: WindowDisplay;
  weekly: WindowDisplay;
};

function usage(): never {
  console.error("Usage: npm run pool-status -- [--file data/accounts.json] [--json]");
  process.exit(2);
}

function argValue(name: string): string | null {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? usage();
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function accountsFilePath(): string {
  return resolve(process.cwd(), argValue("--file") ?? "data/accounts.json");
}

function parseAccounts(path: string): AccountEntry[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as AccountsFile;
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed.accounts) ? parsed.accounts : [];
}

function pct(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function remaining(window: QuotaWindow | null | undefined): number | null {
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

function used(window: QuotaWindow | null | undefined): number | null {
  if (!window) return null;
  if (typeof window.used_percent === "number" && Number.isFinite(window.used_percent)) {
    return clampPercent(window.used_percent);
  }
  const remain = remaining(window);
  return remain === null ? null : clampPercent(100 - remain);
}

function resetText(resetAt: number | null): string {
  if (resetAt === null || !Number.isFinite(resetAt)) return "-";
  return new Date(resetAt * 1000).toISOString();
}

function windowDisplay(window: QuotaWindow | null | undefined): WindowDisplay {
  const resetAt = typeof window?.reset_at === "number" && Number.isFinite(window.reset_at)
    ? window.reset_at
    : null;
  return {
    remain: remaining(window),
    used: used(window),
    resetAt,
    resetText: resetText(resetAt),
    limitReached: window?.limit_reached === true,
  };
}

function effectiveStatus(account: AccountEntry): string {
  const status = account.status ?? "unknown";
  const quota = account.cachedQuota;
  if (
    status === "active" &&
    (quota?.rate_limit?.limit_reached === true ||
      quota?.secondary_rate_limit?.limit_reached === true ||
      quota?.code_review_rate_limit?.limit_reached === true)
  ) {
    return "rate_limited";
  }
  return status;
}

function rowFor(account: AccountEntry): Row {
  const primary = windowDisplay(account.cachedQuota?.rate_limit);
  const weekly = windowDisplay(account.cachedQuota?.secondary_rate_limit);
  return {
    sortReset: weekly.resetAt ?? Number.MAX_SAFE_INTEGER,
    account,
    effectiveStatus: effectiveStatus(account),
    primary,
    weekly,
  };
}

function pad(value: string, width: number): string {
  const chars = [...value];
  if (chars.length >= width) return value;
  return value + " ".repeat(width - chars.length);
}

function truncate(value: string, width: number): string {
  const chars = [...value];
  if (chars.length <= width) return value;
  return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailFor(account: AccountEntry): string {
  if (account.email) return account.email;
  const payload = account.token?.split(".")[1];
  if (!payload) return "-";
  const decoded = decodeBase64UrlJson(payload);
  return typeof decoded?.email === "string" && decoded.email.length > 0 ? decoded.email : "-";
}

function renderTable(rows: Row[], filePath: string): string {
  const activeWeeklyTotal = rows
    .filter((row) => row.effectiveStatus === "active" && row.weekly.remain !== null)
    .reduce((sum, row) => sum + (row.weekly.remain ?? 0), 0);
  const cachedWeeklyTotal = rows
    .filter((row) => row.weekly.remain !== null)
    .reduce((sum, row) => sum + (row.weekly.remain ?? 0), 0);

  const headers = ["weekly reset", "status", "5h remain", "weekly remain", "email", "label", "id", "quota fetched"];
  const widths = [24, 14, 18, 20, 42, 18, 16, 24];
  const lines = [
    `codex-proxy account pool status`,
    `source: ${filePath}`,
    `accounts: ${rows.length}; active weekly total: ${Math.round(activeWeeklyTotal)}%; cached weekly total: ${Math.round(cachedWeeklyTotal)}%`,
    `encoding note: minicodex compressed display would show ~${Math.round(activeWeeklyTotal / 100)}% for ${Math.round(activeWeeklyTotal)}% real active weekly remaining`,
    "",
    headers.map((header, i) => pad(header, widths[i] ?? header.length)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];

  for (const row of rows) {
    const account = row.account;
    const values = [
      row.weekly.resetText,
      row.effectiveStatus,
      `${pct(row.primary.remain)} used=${pct(row.primary.used)}`,
      `${pct(row.weekly.remain)} used=${pct(row.weekly.used)}`,
      emailFor(account),
      account.label ?? "-",
      account.id ?? "-",
      account.quotaFetchedAt ?? "-",
    ];
    lines.push(values.map((value, i) => pad(truncate(value, widths[i] ?? 20), widths[i] ?? 20)).join("  "));
  }

  return lines.join("\n");
}

function redactedRows(rows: Row[]): unknown[] {
  return rows.map((row) => ({
    sortReset: row.sortReset,
    effectiveStatus: row.effectiveStatus,
    primary: row.primary,
    weekly: row.weekly,
    account: {
      id: row.account.id ?? null,
      email: emailFor(row.account),
      label: row.account.label ?? null,
      planType: row.account.planType ?? null,
      status: row.account.status ?? null,
      quotaFetchedAt: row.account.quotaFetchedAt ?? null,
      addedAt: row.account.addedAt ?? null,
      expiresAt: row.account.expiresAt ?? null,
      hasToken: !!row.account.token,
    },
  }));
}

const filePath = accountsFilePath();
const rows = parseAccounts(filePath)
  .map(rowFor)
  .sort((left, right) => left.sortReset - right.sortReset || String(left.account.email ?? "").localeCompare(String(right.account.email ?? "")));

if (hasFlag("--json")) {
  console.log(JSON.stringify(redactedRows(rows), null, 2));
} else {
  console.log(renderTable(rows, filePath));
}
