import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountEntry, AccountsFile } from "@src/auth/types.js";

// Must use vi.hoisted() for mock variables referenced in vi.mock factories
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 123),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 100 })),
  unlinkSync: vi.fn(),
}));

vi.mock("fs", () => mockFs);

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-persistence"),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

import { createFsPersistence } from "@src/auth/account-persistence.js";

function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index: number): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) {
    throw new Error(`Missing invocation order at index ${index}`);
  }
  return order;
}

function makeEntry(id: string): AccountEntry {
  return {
    id,
    token: `tok-${id}`,
    refreshToken: null,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    planType: "free",
    proxyApiKey: `key-${id}`,
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_counters_reset_at: null,
      limit_window_seconds: null,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
}

describe("account-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.openSync.mockImplementation(() => 123);
  });

  describe("load", () => {
    it("returns empty entries when no files exist", () => {
      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toEqual([]);
      expect(result.needsPersist).toBe(false);
    });

    it("loads from accounts.json", () => {
      const entry = makeEntry("a");
      const data: AccountsFile = { accounts: [entry] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("a");
    });

    it("skips entries without id or token", () => {
      const data = { accounts: [{ id: "", token: "x" }, { id: "b" }] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      expect(p.load().entries).toEqual([]);
    });

    it("backfills missing empty_response_count and auto-persists", () => {
      const entry = makeEntry("a");
      (entry.usage as unknown as Record<string, unknown>).empty_response_count = undefined;
      const data: AccountsFile = { accounts: [entry] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries[0].usage.empty_response_count).toBe(0);
      expect(result.needsPersist).toBe(true);
      // Verify auto-persist was triggered.
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      expect(mockFs.renameSync).toHaveBeenCalled();
    });
  });

  describe("save", () => {
    it("writes durably via tmp file fsync + rename + directory fsync", () => {
      mockFs.existsSync.mockImplementation(((path: string) =>
        !path.endsWith("accounts.json") && !path.endsWith("accounts.json.prev")) as () => boolean);
      const p = createFsPersistence();
      const entry = makeEntry("a");

      p.save([entry]);

      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenPath = mockFs.writeFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toMatch(/accounts\.json\.tmp$/);
      expect(mockFs.fsyncSync).toHaveBeenCalled();
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/accounts\.json\.tmp$/),
        expect.stringMatching(/accounts\.json$/),
      );
      expect(mockFs.openSync).toHaveBeenCalledWith(
        expect.stringMatching(/test-persistence$/),
        "r",
      );

      const tmpOpenIndex = mockFs.openSync.mock.calls.findIndex(([path]) =>
        String(path).endsWith("accounts.json.tmp"),
      );
      const dirOpenIndex = mockFs.openSync.mock.calls.findIndex(([path]) =>
        String(path).endsWith("test-persistence"),
      );
      expect(tmpOpenIndex).toBeGreaterThanOrEqual(0);
      expect(dirOpenIndex).toBeGreaterThanOrEqual(0);

      expect(callOrder(mockFs.writeFileSync, 0)).toBeLessThan(callOrder(mockFs.openSync, tmpOpenIndex));
      expect(callOrder(mockFs.openSync, tmpOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 0));
      expect(callOrder(mockFs.fsyncSync, 0)).toBeLessThan(callOrder(mockFs.renameSync, 0));
      expect(callOrder(mockFs.renameSync, 0)).toBeLessThan(callOrder(mockFs.openSync, dirOpenIndex));
      expect(callOrder(mockFs.openSync, dirOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 1));
    });

    it("preserves previous accounts.json as accounts.json.prev before replacing current", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path.endsWith("accounts.json")) {
          return JSON.stringify({ accounts: [makeEntry("old")] });
        }
        return "";
      });
      const p = createFsPersistence();

      p.save([makeEntry("new")]);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/accounts\.json\.prev\.tmp$/),
        expect.stringContaining('"old"'),
        expect.anything(),
      );
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/accounts\.json\.prev\.tmp$/),
        expect.stringMatching(/accounts\.json\.prev$/),
      );

      const prevTmpOpenIndex = mockFs.openSync.mock.calls.findIndex(([path]) =>
        String(path).endsWith("accounts.json.prev.tmp"),
      );
      const prevDirOpenIndex = mockFs.openSync.mock.calls.findIndex(([_path], index) =>
        index > prevTmpOpenIndex,
      );
      const currentTmpOpenIndex = mockFs.openSync.mock.calls.findIndex(([path]) =>
        String(path).endsWith("accounts.json.tmp"),
      );
      const currentDirOpenIndex = mockFs.openSync.mock.calls.findIndex(([_path], index) =>
        index > currentTmpOpenIndex,
      );
      expect(prevTmpOpenIndex).toBeGreaterThanOrEqual(0);
      expect(prevDirOpenIndex).toBeGreaterThanOrEqual(0);
      expect(currentTmpOpenIndex).toBeGreaterThan(prevDirOpenIndex);
      expect(currentDirOpenIndex).toBeGreaterThan(currentTmpOpenIndex);

      expect(callOrder(mockFs.writeFileSync, 0)).toBeLessThan(callOrder(mockFs.openSync, prevTmpOpenIndex));
      expect(callOrder(mockFs.openSync, prevTmpOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 0));
      expect(callOrder(mockFs.fsyncSync, 0)).toBeLessThan(callOrder(mockFs.renameSync, 0));
      expect(callOrder(mockFs.renameSync, 0)).toBeLessThan(callOrder(mockFs.openSync, prevDirOpenIndex));
      expect(callOrder(mockFs.openSync, prevDirOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 1));
      expect(callOrder(mockFs.fsyncSync, 1)).toBeLessThan(callOrder(mockFs.writeFileSync, 1));
      expect(callOrder(mockFs.writeFileSync, 1)).toBeLessThan(callOrder(mockFs.openSync, currentTmpOpenIndex));
      expect(callOrder(mockFs.openSync, currentTmpOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 2));
      expect(callOrder(mockFs.fsyncSync, 2)).toBeLessThan(callOrder(mockFs.renameSync, 1));
      expect(callOrder(mockFs.renameSync, 1)).toBeLessThan(callOrder(mockFs.openSync, currentDirOpenIndex));
      expect(callOrder(mockFs.openSync, currentDirOpenIndex)).toBeLessThan(callOrder(mockFs.fsyncSync, 3));
    });

    it("throws when durable write fails instead of silently continuing", () => {
      mockFs.existsSync.mockImplementation(((path: string) =>
        !path.endsWith("accounts.json") && !path.endsWith("accounts.json.prev")) as () => boolean);
      mockFs.writeFileSync.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      const p = createFsPersistence();

      expect(() => p.save([makeEntry("a")])).toThrow("Failed to persist accounts");
    });

    it("does not report failure after rename when directory fsync is unsupported", () => {
      mockFs.existsSync.mockImplementation(((path: string) =>
        !path.endsWith("accounts.json") && !path.endsWith("accounts.json.prev")) as () => boolean);
      mockFs.openSync.mockImplementation((path: string) => {
        if (path.endsWith("test-persistence")) {
          const err = new Error("directory fsync unsupported") as NodeJS.ErrnoException;
          err.code = "EINVAL";
          throw err;
        }
        return 123;
      });
      const p = createFsPersistence();

      expect(() => p.save([makeEntry("a")])).not.toThrow();
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/accounts\.json\.tmp$/),
        expect.stringMatching(/accounts\.json$/),
      );
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });

    it("creates directory if missing", () => {
      mockFs.existsSync.mockReturnValue(false);
      const p = createFsPersistence();
      p.save([makeEntry("a")]);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it("serializes accounts as JSON", () => {
      mockFs.existsSync.mockImplementation(((path: string) =>
        !path.endsWith("accounts.json") && !path.endsWith("accounts.json.prev")) as () => boolean);
      const p = createFsPersistence();
      const entries = [makeEntry("a"), makeEntry("b")];
      p.save(entries);

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as AccountsFile;
      expect(written.accounts).toHaveLength(2);
      expect(written.accounts[0].id).toBe("a");
      expect(written.accounts[1].id).toBe("b");
    });
  });

  describe("legacy migration", () => {
    it("migrates from auth.json when accounts.json does not exist", () => {
      const legacyData = {
        token: "legacy-token",
        proxyApiKey: "old-key",
        userInfo: { email: "old@test.com", planType: "free" },
      };
      mockFs.existsSync.mockImplementation(((path: string) => {
        if (path.includes("accounts.json")) return false;
        if (path.includes("auth.json")) return true;
        return false;
      }) as () => boolean);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(legacyData));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].token).toBe("legacy-token");
      // Should rename old file
      expect(mockFs.renameSync).toHaveBeenCalled();
    });
  });
});
