import { describe, expect, it } from "vitest";
import type { AccountInfo, CodexQuota } from "@src/auth/types.js";
import { aggregatePoolWindow, encodePoolRemaining } from "@src/proxy/pool-rate-limit-encoding.js";

function makeQuota(secondaryRemaining: number): CodexQuota {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 0,
      remaining_percent: 100,
      reset_at: 1700000000,
      limit_window_seconds: 18000,
    },
    secondary_rate_limit: {
      limit_reached: false,
      used_percent: 100 - secondaryRemaining,
      remaining_percent: secondaryRemaining,
      reset_at: 1700500000,
      limit_window_seconds: 604800,
    },
    code_review_rate_limit: null,
  };
}

function makeAccount(id: string, secondaryRemaining: number): AccountInfo {
  return {
    id,
    email: `${id}@example.com`,
    accountId: id,
    userId: id,
    label: null,
    planType: "pro",
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
    },
    addedAt: new Date().toISOString(),
    expiresAt: null,
    quota: makeQuota(secondaryRemaining),
    quotaFetchedAt: new Date().toISOString(),
  };
}

describe("pool rate limit encoding", () => {
  it("encodes 196% real remain as 20% displayed remain => used_percent 80", () => {
    expect(encodePoolRemaining(196)).toEqual({
      displayRemaining: 19.6,
      usedPercent: 80,
    });
  });

  it("aggregates active accounts into pooled encoded window", () => {
    const window = aggregatePoolWindow(
      [makeAccount("a", 100), makeAccount("b", 96)],
      (account) => account.quota?.secondary_rate_limit,
    );

    expect(window).toMatchObject({
      totalRemaining: 196,
      displayRemaining: 19.6,
      usedPercent: 80,
      accountCount: 2,
      resetAt: 1700500000,
      limitWindowSeconds: 604800,
    });
  });
});
