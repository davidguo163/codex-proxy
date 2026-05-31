/**
 * Tests for RefreshScheduler — JWT auto-refresh scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      refresh_enabled: true,
      refresh_margin_seconds: 300,
      refresh_concurrency: 5,
    },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(),
}));

const refreshLockMock = vi.hoisted(() => ({
  tryAcquireRefreshLock: vi.fn(() => true),
  releaseRefreshLock: vi.fn(),
}));

vi.mock("@src/auth/refresh-lock.js", () => refreshLockMock);

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
  jitterInt: vi.fn((val: number) => val),
}));

import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { refreshAccessToken } from "@src/auth/oauth-pkce.js";
import type { AccountPool } from "@src/auth/account-pool.js";

function createMockPool(entries: Array<{
  id: string;
  token: string;
  refreshToken: string | null;
  status: string;
}>): AccountPool {
  return {
    getAllEntries: vi.fn(() => entries.map((e) => ({
      ...e,
      email: null,
      accountId: null,
      planType: null,
      proxyApiKey: "key",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        empty_response_count: 0,
        last_used: null,
        rate_limit_until: null,
      },
      addedAt: new Date().toISOString(),
    }))),
    getEntry: vi.fn((id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return undefined;
      return {
        ...entry,
        email: null,
        accountId: null,
        planType: null,
        proxyApiKey: "key",
        usage: {
          request_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          empty_response_count: 0,
          last_used: null,
          rate_limit_until: null,
        },
        addedAt: new Date().toISOString(),
      };
    }),
    updateToken: vi.fn(),
    markStatus: vi.fn((id: string, status: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return false;
      entry.status = status;
      return true;
    }),
  } as unknown as AccountPool;
}

describe("RefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    refreshLockMock.tryAcquireRefreshLock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules refresh for active accounts", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // Should have scheduled without error
    scheduler.destroy();
  });

  it("does not auto-retry 'refreshing' state after process restart", async () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "refreshing" },
    ]);

    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
    });

    const scheduler = new RefreshScheduler(pool);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

    expect(refreshAccessToken).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it("does not retry a one-time refresh token after the first refresh error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const entry = { id: "acc1", token: "token1", refreshToken: "oaistb_rt_old", status: "expired" };
    const pool = {
      getAllEntries: vi.fn(() => [entry]),
      getEntry: vi.fn((id: string) => (id === entry.id ? entry : undefined)),
      markStatus: vi.fn((_id: string, status: string) => {
        entry.status = status;
        return true;
      }),
      updateToken: vi.fn(),
      readEntryRTFromDisk: vi.fn(() => entry.refreshToken),
      readEntryRefreshStateFromDisk: vi.fn(() => ({
        token: entry.token,
        refreshToken: entry.refreshToken,
        status: entry.status,
      })),
    } as unknown as AccountPool;
    vi.mocked(refreshAccessToken).mockRejectedValue(new Error("ECONNRESET"));

    const scheduler = new RefreshScheduler(pool);
    await vi.advanceTimersByTimeAsync(35_000);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(entry.status).toBe("refreshing");
    expect(pool.updateToken).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });

  it("does not consume a one-time RT when disk state is already refreshing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const entry = { id: "acc1", token: "token1", refreshToken: "oaistb_rt_old", status: "expired" };
    const pool = {
      getAllEntries: vi.fn(() => [entry]),
      getEntry: vi.fn((id: string) => (id === entry.id ? entry : undefined)),
      markStatus: vi.fn((_id: string, status: string) => {
        entry.status = status;
        return true;
      }),
      updateToken: vi.fn(),
      readEntryRefreshStateFromDisk: vi.fn(() => ({
        token: entry.token,
        refreshToken: entry.refreshToken,
        status: "refreshing",
      })),
    } as unknown as AccountPool;
    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "oaistb_rt_new",
    });

    const scheduler = new RefreshScheduler(pool);
    await vi.advanceTimersByTimeAsync(35_000);

    expect(pool.markStatus).not.toHaveBeenCalledWith("acc1", "refreshing");
    expect(refreshAccessToken).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it("does not schedule success when persisting a rotated refresh token fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const entry = { id: "acc1", token: "token1", refreshToken: "oaistb_rt_old", status: "expired" };
    const { AccountPersistenceError } = await import("@src/auth/account-persistence.js");
    const pool = {
      getAllEntries: vi.fn(() => [entry]),
      getEntry: vi.fn((id: string) => (id === entry.id ? entry : undefined)),
      markStatus: vi.fn((_id: string, status: string) => {
        entry.status = status;
        return true;
      }),
      updateToken: vi.fn(() => {
        throw new AccountPersistenceError("Failed to persist accounts: disk full");
      }),
      readEntryRTFromDisk: vi.fn(() => entry.refreshToken),
      readEntryRefreshStateFromDisk: vi.fn(() => ({
        token: entry.token,
        refreshToken: entry.refreshToken,
        status: entry.status,
      })),
    } as unknown as AccountPool;
    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "oaistb_rt_new",
    });

    const scheduler = new RefreshScheduler(pool);
    await vi.advanceTimersByTimeAsync(35_000);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(pool.updateToken).toHaveBeenCalledOnce();
    expect(entry.status).toBe("refreshing");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });

  it("skips expired accounts without refresh token (no schedule, no error)", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: null, status: "expired" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // No timer scheduled for accounts without refresh token
    scheduler.destroy();
  });

  it("schedules recovery for expired accounts with refresh token", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "expired" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    // Should schedule delayed recovery without error
    scheduler.destroy();
  });

  it("destroy cancels all timers", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
      { id: "acc2", token: "token2", refreshToken: "refresh2", status: "active" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    scheduler.destroy();
    // No timers should fire after destroy
  });
});
