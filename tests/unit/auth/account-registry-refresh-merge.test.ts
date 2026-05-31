import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPersistence } from "@src/auth/account-persistence.js";
import type { AccountEntry } from "@src/auth/types.js";
import { createValidJwt } from "@helpers/jwt.js";

let tmpDataDir = "";

vi.mock("@src/paths.js", () => ({
  getDataDir: () => tmpDataDir,
}));

function makeEntry(id: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    id,
    token: overrides.token ?? createValidJwt({ accountId: `acct-${id}`, email: `${id}@test.com` }),
    refreshToken: overrides.refreshToken ?? `rt-${id}-old`,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: null,
    label: null,
    planType: "free",
    proxyApiKey: `pk-${id}`,
    status: overrides.status ?? "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_cached_tokens: 0,
      window_counters_reset_at: null,
      limit_window_seconds: null,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
    ...overrides,
  };
}

function createFileBackedTestPersistence(): AccountPersistence {
  return {
    isFileBacked: true,
    load: () => ({ entries: [], needsPersist: false }),
    save: (entries: AccountEntry[]) => {
      writeFileSync(
        join(tmpDataDir, "accounts.json"),
        JSON.stringify({ accounts: entries }, null, 2),
        "utf-8",
      );
    },
  };
}

describe("AccountRegistry refresh-critical disk merge", () => {
  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), "codex-registry-merge-"));
    mkdirSync(join(tmpDataDir, ".locks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
    tmpDataDir = "";
  });

  it("does not overwrite another account's rotated refresh token when marking one account", async () => {
    const { AccountRegistry } = await import("@src/auth/account-registry.js");
    const accountA = makeEntry("a", { refreshToken: "oaistb_rt_a_old" });
    const accountBMemory = makeEntry("b", {
      token: "token-b-old",
      refreshToken: "oaistb_rt_b_old",
      status: "active",
    });
    const accountBDisk = makeEntry("b", {
      token: "token-b-new",
      refreshToken: "oaistb_rt_b_new",
      status: "refreshing",
    });
    writeFileSync(
      join(tmpDataDir, "accounts.json"),
      JSON.stringify({ accounts: [accountA, accountBDisk] }, null, 2),
      "utf-8",
    );

    const registry = new AccountRegistry(
      createFileBackedTestPersistence(),
      [accountA, accountBMemory],
    );

    registry.markStatus("a", "refreshing");

    const persisted = JSON.parse(readFileSync(join(tmpDataDir, "accounts.json"), "utf-8")) as {
      accounts: AccountEntry[];
    };
    const persistedA = persisted.accounts.find((entry) => entry.id === "a");
    const persistedB = persisted.accounts.find((entry) => entry.id === "b");

    expect(persistedA).toMatchObject({ id: "a", refreshToken: "oaistb_rt_a_old", status: "refreshing" });
    expect(persistedB).toMatchObject({
      id: "b",
      token: "token-b-new",
      refreshToken: "oaistb_rt_b_new",
      status: "refreshing",
    });
    expect(registry.getEntry("b")).toMatchObject({
      token: "token-b-new",
      refreshToken: "oaistb_rt_b_new",
      status: "refreshing",
    });
  });

  it("does not let ordinary status changes overwrite a disk refreshing tombstone", async () => {
    const { AccountRegistry } = await import("@src/auth/account-registry.js");
    const memoryEntry = makeEntry("a", {
      token: "token-a-old",
      refreshToken: "oaistb_rt_a_old",
      status: "active",
    });
    const diskEntry = makeEntry("a", {
      token: "token-a-old",
      refreshToken: "oaistb_rt_a_old",
      status: "refreshing",
    });
    writeFileSync(
      join(tmpDataDir, "accounts.json"),
      JSON.stringify({ accounts: [diskEntry] }, null, 2),
      "utf-8",
    );

    const registry = new AccountRegistry(
      createFileBackedTestPersistence(),
      [memoryEntry],
    );

    registry.markStatus("a", "expired");

    const persisted = JSON.parse(readFileSync(join(tmpDataDir, "accounts.json"), "utf-8")) as {
      accounts: AccountEntry[];
    };
    expect(persisted.accounts[0]).toMatchObject({
      id: "a",
      refreshToken: "oaistb_rt_a_old",
      status: "refreshing",
    });
    expect(registry.getEntry("a")).toMatchObject({
      refreshToken: "oaistb_rt_a_old",
      status: "refreshing",
    });
  });

  it("allows token refresh success to replace a disk refreshing tombstone", async () => {
    const { AccountRegistry } = await import("@src/auth/account-registry.js");
    const oldToken = createValidJwt({ accountId: "acct-a", email: "a@test.com" });
    const newToken = createValidJwt({ accountId: "acct-a", email: "new@test.com" });
    const memoryEntry = makeEntry("a", {
      token: oldToken,
      refreshToken: "oaistb_rt_a_old",
      status: "refreshing",
    });
    const diskEntry = makeEntry("a", {
      token: oldToken,
      refreshToken: "oaistb_rt_a_old",
      status: "refreshing",
    });
    writeFileSync(
      join(tmpDataDir, "accounts.json"),
      JSON.stringify({ accounts: [diskEntry] }, null, 2),
      "utf-8",
    );

    const registry = new AccountRegistry(
      createFileBackedTestPersistence(),
      [memoryEntry],
    );

    registry.updateToken("a", newToken, "oaistb_rt_a_new");

    const persisted = JSON.parse(readFileSync(join(tmpDataDir, "accounts.json"), "utf-8")) as {
      accounts: AccountEntry[];
    };
    expect(persisted.accounts[0]).toMatchObject({
      id: "a",
      token: newToken,
      refreshToken: "oaistb_rt_a_new",
      status: "active",
    });
  });
});
