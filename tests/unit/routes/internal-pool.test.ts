import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";
import type { CodexQuota } from "@src/auth/types.js";
import { createInternalPoolRoutes } from "@src/routes/internal-pool.js";

const mockConfig = {
  server: { proxy_api_key: "proxy-secret" as string | null },
  auth: {
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 300,
  },
  quota: { skip_exhausted: true },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

function quotaWithLimits({
  primary = false,
  weekly = false,
  codeReview = false,
}: {
  primary?: boolean;
  weekly?: boolean;
  codeReview?: boolean;
}): CodexQuota {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: !primary,
      limit_reached: primary,
      used_percent: primary ? 100 : 10,
      remaining_percent: primary ? 0 : 90,
      reset_at: 1780055839,
      limit_window_seconds: 18000,
    },
    secondary_rate_limit: {
      limit_reached: weekly,
      used_percent: weekly ? 100 : 33,
      remaining_percent: weekly ? 0 : 67,
      reset_at: 1780566830,
      limit_window_seconds: 604800,
    },
    code_review_rate_limit: {
      allowed: !codeReview,
      limit_reached: codeReview,
      used_percent: codeReview ? 100 : 20,
      remaining_percent: codeReview ? 0 : 80,
      reset_at: 1780060000,
      limit_window_seconds: 18000,
    },
  };
}

function addAccountWithQuota(
  pool: AccountPool,
  email: string,
  quota: CodexQuota,
): { id: string; token: string } {
  const token = createValidJwt({
    accountId: `${email}-account`,
    userId: `${email}-user`,
    email,
    planType: "pro",
  });
  const id = pool.addAccount(token, `${email}-refresh-token-should-not-leak`);
  pool.updateCachedQuota(id, quota);
  return { id, token };
}

describe("GET /api/codex/pool/accounts", () => {
  beforeEach(() => {
    mockConfig.server.proxy_api_key = "proxy-secret";
  });

  it("requires the proxy API key when configured", async () => {
    const app = createInternalPoolRoutes(makePool());

    const missing = await app.request("/api/codex/pool/accounts");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });

    const wrong = await app.request("/api/codex/pool/accounts", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
  });

  it("returns a redacted pool summary with effective quota status", async () => {
    const pool = makePool();
    const { id, token } = addAccountWithQuota(
      pool,
      "dev@example.com",
      quotaWithLimits({ primary: true }),
    );

    const app = createInternalPoolRoutes(pool);
    const res = await app.request("/api/codex/pool/accounts", {
      headers: { Authorization: "Bearer proxy-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary).toMatchObject({ total: 1, rate_limited: 1 });
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      id,
      email: "dev@example.com",
      label: null,
      planType: "pro",
      status: "active",
      effectiveStatus: "rate_limited",
      quotaStatus: {
        exhausted: true,
        primary: {
          used_percent: 100,
          remaining_percent: 0,
          limit_reached: true,
          reset_at: 1780055839,
          reset_at_iso: "2026-05-29T11:57:19.000Z",
          limit_window_seconds: 18000,
        },
        weekly: {
          used_percent: 33,
          remaining_percent: 67,
          limit_reached: false,
          reset_at: 1780566830,
          reset_at_iso: "2026-06-04T09:53:50.000Z",
          limit_window_seconds: 604800,
        },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("dev@example.com-refresh-token-should-not-leak");
    expect(serialized).not.toContain("dev@example.com-account");
    expect(serialized).not.toContain("dev@example.com-user");
    expect(serialized).not.toContain(token);
  });

  it("marks weekly-only and code-review-only quota limits as rate limited", async () => {
    const pool = makePool();
    addAccountWithQuota(pool, "weekly@example.com", quotaWithLimits({ weekly: true }));
    addAccountWithQuota(pool, "code-review@example.com", quotaWithLimits({ codeReview: true }));

    const app = createInternalPoolRoutes(pool);
    const res = await app.request("/api/codex/pool/accounts", {
      headers: { Authorization: "Bearer proxy-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary).toMatchObject({ total: 2, rate_limited: 2 });
    expect(body.accounts).toEqual([
      expect.objectContaining({
        email: "weekly@example.com",
        effectiveStatus: "rate_limited",
        quotaStatus: expect.objectContaining({
          exhausted: true,
          primary: expect.objectContaining({ limit_reached: false }),
          weekly: expect.objectContaining({ limit_reached: true }),
          codeReview: expect.objectContaining({ limit_reached: false }),
        }),
      }),
      expect.objectContaining({
        email: "code-review@example.com",
        effectiveStatus: "rate_limited",
        quotaStatus: expect.objectContaining({
          exhausted: true,
          primary: expect.objectContaining({ limit_reached: false }),
          weekly: expect.objectContaining({ limit_reached: false }),
          codeReview: expect.objectContaining({ limit_reached: true }),
        }),
      }),
    ]);
  });
});
