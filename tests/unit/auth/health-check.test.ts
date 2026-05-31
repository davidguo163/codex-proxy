/**
 * Tests for account health check (probeAccount + batchHealthCheck).
 *
 * Verifies:
 * 1. probeAccount succeeds → alive, updates token
 * 2. probeAccount permanent error → dead, marks expired
 * 3. probeAccount temporary error → dead, does NOT mark expired
 * 4. probeAccount skips: no RT, disabled, not found
 * 5. batchHealthCheck respects stagger + concurrency
 * 6. batchHealthCheck filters by ids
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { createMockConfig } from "@helpers/config.js";

// ── Mocks ────────────────────────────────────────────────────────────

let refreshResult: { access_token: string; refresh_token: string | null } | Error = {
  access_token: "",
  refresh_token: "new_rt",
};

const refreshLockMock = vi.hoisted(() => ({
  tryAcquireRefreshLock: vi.fn(() => true),
  releaseRefreshLock: vi.fn(),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(async () => {
    if (refreshResult instanceof Error) throw refreshResult;
    return refreshResult;
  }),
}));

vi.mock("@src/auth/refresh-lock.js", () => refreshLockMock);

vi.mock("@src/utils/jitter.js", () => ({
  jitter: (val: number) => val,
  jitterInt: (val: number) => val,
}));

import { refreshAccessToken } from "@src/auth/oauth-pkce.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeJwt(expSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(JSON.stringify({ exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

function makeValidJwt(): string {
  return makeJwt(Math.floor(Date.now() / 1000) + 3600);
}

interface MockEntry {
  id: string;
  token: string;
  refreshToken: string | null;
  email: string | null;
  status: string;
  accountId: string | null;
  userId: string | null;
  planType: string | null;
}

function makeEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: overrides.id ?? "acc-1",
    token: makeValidJwt(),
    refreshToken: overrides.refreshToken ?? "rt_test123",
    email: overrides.email ?? "test@example.com",
    status: overrides.status ?? "active",
    accountId: null,
    userId: null,
    planType: null,
    ...overrides,
  };
}

function makePool(entries: MockEntry[]) {
  return {
    getEntry: (id: string) => entries.find((e) => e.id === id),
    getAllEntries: () => entries,
    readEntryRTFromDisk: vi.fn(() => null as string | null),
    readEntryRefreshStateFromDisk: vi.fn(() => null as {
      token: string | null;
      refreshToken: string | null;
      status: string | null;
    } | null),
    markStatus: vi.fn((id: string, status: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return false;
      entry.status = status;
      return true;
    }),
    updateToken: vi.fn((id: string, token: string, refreshToken?: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      entry.token = token;
      if (refreshToken) entry.refreshToken = refreshToken;
      entry.status = "active";
    }),
  };
}

function makeScheduler() {
  return {
    scheduleOne: vi.fn(),
    clearOne: vi.fn(),
    isRefreshing: vi.fn(() => false),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("probeAccount", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig());
    vi.clearAllMocks();
    refreshLockMock.tryAcquireRefreshLock.mockReturnValue(true);
    const validToken = makeValidJwt();
    refreshResult = { access_token: validToken, refresh_token: "new_rt" };
  });

  afterEach(() => {
    resetConfigForTesting();
    vi.restoreAllMocks();
  });

  it("returns alive and updates token on success", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("alive");
    expect(result.previousStatus).toBe("active");
    expect(result.email).toBe("test@example.com");
    expect(result.durationMs).toBeTypeOf("number");
    expect(pool.updateToken).toHaveBeenCalledOnce();
    expect(scheduler.scheduleOne).toHaveBeenCalledOnce();
    expect(pool.markStatus.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshAccessToken).mock.invocationCallOrder[0],
    );
  });

  it("skips persisted refreshing accounts without consuming the refresh token", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ status: "refreshing", refreshToken: "oaistb_rt_old" })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toContain("manual recovery");
    expect(refreshLockMock.tryAcquireRefreshLock).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("skips when the shared refresh lock is already held", async () => {
    refreshLockMock.tryAcquireRefreshLock.mockReturnValueOnce(false);
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("refresh already in progress");
    expect(pool.markStatus).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(refreshLockMock.releaseRefreshLock).not.toHaveBeenCalled();
  });

  it("does not consume the refresh token when durable refreshing mark fails", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    pool.markStatus.mockReturnValueOnce(false);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("not found");
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(refreshLockMock.releaseRefreshLock).toHaveBeenCalledWith("acc-1");
  });

  it("syncs a cross-process disk refresh-token rotation instead of consuming stale memory RT", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ token: "old-token", refreshToken: "oaistb_rt_stale" })];
    const pool = makePool(entries);
    pool.readEntryRefreshStateFromDisk.mockReturnValueOnce({
      token: "fresh-token",
      refreshToken: "oaistb_rt_fresh",
      status: "active",
    });
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("alive");
    expect(pool.markStatus).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(pool.updateToken).toHaveBeenCalledWith("acc-1", "fresh-token", "oaistb_rt_fresh");
    expect(scheduler.scheduleOne).toHaveBeenCalledWith("acc-1", "fresh-token");
    expect(refreshLockMock.releaseRefreshLock).toHaveBeenCalledWith("acc-1");
  });

  it("respects a cross-process disk refreshing marker before persisting local state", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ refreshToken: "oaistb_rt_old" })];
    const pool = makePool(entries);
    pool.readEntryRefreshStateFromDisk.mockReturnValueOnce({
      token: "old-token",
      refreshToken: "oaistb_rt_old",
      status: "refreshing",
    });
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toContain("manual recovery");
    expect(pool.markStatus).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(refreshLockMock.releaseRefreshLock).toHaveBeenCalledWith("acc-1");
  });

  it("keeps one-time RT in refreshing state when refresh succeeds without replacement RT", async () => {
    refreshResult = { access_token: makeValidJwt(), refresh_token: null };
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ refreshToken: "oaistb_rt_no_replacement" })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("replacement refresh token");
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(pool.updateToken).not.toHaveBeenCalled();
    expect(scheduler.scheduleOne).not.toHaveBeenCalled();
    expect(entries[0].status).toBe("refreshing");
  });

  it("keeps one-time RT in refreshing state on refresh errors", async () => {
    refreshResult = new Error("invalid_grant: token already used");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ refreshToken: "oaistb_rt_reused" })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("invalid_grant");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "refreshing");
    expect(pool.markStatus).not.toHaveBeenCalledWith("acc-1", "expired");
    expect(entries[0].status).toBe("refreshing");
  });

  it("returns dead and marks expired on permanent error", async () => {
    refreshResult = new Error("invalid_grant: token revoked");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("invalid_grant");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "expired");
  });

  it("returns dead but does NOT mark expired on temporary error", async () => {
    refreshResult = new Error("ECONNREFUSED");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(result.error).toContain("ECONNREFUSED");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "refreshing");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "active");
    expect(pool.markStatus).not.toHaveBeenCalledWith("acc-1", "expired");
    expect(entries[0].status).toBe("active");
  });

  it("skips account with no refresh token", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ refreshToken: null })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("no refresh token");
  });

  it("skips disabled account", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry({ status: "disabled" })];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("manually disabled");
  });

  it("returns skipped for non-existent account", async () => {
    const { probeAccount } = await import("@src/auth/health-check.js");
    const pool = makePool([]);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "nonexistent");

    expect(result.result).toBe("skipped");
    expect(result.error).toBe("not found");
  });

  it("detects 'account has been deactivated' as permanent", async () => {
    refreshResult = new Error("account has been deactivated");
    const { probeAccount } = await import("@src/auth/health-check.js");
    const entries = [makeEntry()];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const result = await probeAccount(pool as never, scheduler as never, "acc-1");

    expect(result.result).toBe("dead");
    expect(pool.markStatus).toHaveBeenCalledWith("acc-1", "expired");
  });
});

describe("batchHealthCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setConfigForTesting(createMockConfig());
    const validToken = makeValidJwt();
    refreshResult = { access_token: validToken, refresh_token: "new_rt" };
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConfigForTesting();
    vi.restoreAllMocks();
  });

  it("checks all eligible accounts and skips those without RT", async () => {
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: null }),
      makeEntry({ id: "a3", refreshToken: "rt_3", status: "disabled" }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      staggerMs: 100,
      concurrency: 2,
    });

    expect(results).toHaveLength(3);
    const alive = results.filter((r) => r.result === "alive");
    const skipped = results.filter((r) => r.result === "skipped");
    expect(alive).toHaveLength(1);
    expect(skipped).toHaveLength(2);
  });

  it("filters by specified ids", async () => {
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: "rt_2" }),
      makeEntry({ id: "a3", refreshToken: "rt_3" }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      ids: ["a1", "a3"],
      staggerMs: 100,
      concurrency: 2,
    });

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["a1", "a3"]);
  });

  it("returns summary counts", async () => {
    refreshResult = new Error("invalid_grant");
    const { batchHealthCheck } = await import("@src/auth/health-check.js");
    const entries = [
      makeEntry({ id: "a1", refreshToken: "rt_1" }),
      makeEntry({ id: "a2", refreshToken: null }),
    ];
    const pool = makePool(entries);
    const scheduler = makeScheduler();

    const results = await batchHealthCheck(pool as never, scheduler as never, {
      staggerMs: 100,
    });

    const dead = results.filter((r) => r.result === "dead").length;
    const skipped = results.filter((r) => r.result === "skipped").length;
    expect(dead).toBe(1);
    expect(skipped).toBe(1);
  });
});
