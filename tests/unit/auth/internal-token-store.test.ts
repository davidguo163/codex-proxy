import { beforeEach, describe, expect, it } from "vitest";
import {
  InternalTokenStore,
  INTERNAL_TOKEN_SESSION_LIMITS,
} from "@src/auth/internal-token-store.js";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

const headers = new Headers({
  host: "easyceo.thelightco.net",
  "x-forwarded-proto": "https",
});

describe("InternalTokenStore", () => {
  beforeEach(() => {
    process.env.CODEX_INTERNAL_TOKEN_SECRET = "test-secret";
  });

  it("issues an internal token after start, approve, and poll", () => {
    const store = new InternalTokenStore();
    const start = store.start(headers, "127.0.0.1:18080");

    expect(start.verificationUri).toBe("https://easyceo.thelightco.net/codex/device");
    expect(store.poll(start.deviceCode, headers, "127.0.0.1:18080")).toMatchObject({
      ok: false,
      status: 428,
      error: "authorization_pending",
    });

    expect(store.approve(start.userCode)).toEqual({ ok: true });
    const result = store.poll(start.deviceCode, headers, "127.0.0.1:18080");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.access_token).toMatch(/^itg_access_/);
    expect(result.payload.refresh_token).toMatch(/^itg_refresh_/);
    expect(result.payload.id_token.split(".")).toHaveLength(3);
    expect(decodeJwtPayload(result.payload.id_token)).toMatchObject({
      email: "dev@topgamesinc.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "pro",
        chatgpt_account_id: "emp_dev_codex_proxy",
      },
    });
    expect(result.payload.apiBaseUrl).toBe("https://easyceo.thelightco.net/openai/v1");
    expect(result.payload.tokenEndpoint).toBe("https://easyceo.thelightco.net/oauth/token");
    expect(store.validateAccessToken(result.payload.access_token)).toBe(true);
  });

  it("supports the Codex deviceauth authorization-code compatibility flow", () => {
    const store = new InternalTokenStore();
    const start = store.start(headers, "127.0.0.1:18080");

    expect(store.pollAuthorizationCode(start.deviceCode, start.userCode)).toMatchObject({
      ok: false,
      status: 404,
      error: "authorization_pending",
    });
    expect(store.approve(start.userCode)).toEqual({ ok: true });

    const codeResult = store.pollAuthorizationCode(start.deviceCode, start.userCode);
    expect(codeResult.ok).toBe(true);
    if (!codeResult.ok) return;
    expect(codeResult.payload.authorization_code).toMatch(/^itg_code_/);

    const tokenResult = store.exchangeAuthorizationCode(
      codeResult.payload.authorization_code,
      codeResult.payload.code_verifier,
      headers,
      "127.0.0.1:18080",
    );
    expect(tokenResult.ok).toBe(true);
    if (!tokenResult.ok) return;
    expect(tokenResult.payload.access_token).toMatch(/^itg_access_/);
    expect(tokenResult.payload.tokenEndpoint).toBe("https://easyceo.thelightco.net/oauth/token");

    expect(store.exchangeAuthorizationCode(
      codeResult.payload.authorization_code,
      codeResult.payload.code_verifier,
      headers,
      "127.0.0.1:18080",
    )).toEqual({ ok: false, error: "invalid_grant" });
  });

  it("access tokens survive a store instance restart because they are signed", () => {
    const firstStore = new InternalTokenStore();
    const start = firstStore.start(headers, "127.0.0.1:18080");
    expect(firstStore.approve(start.userCode)).toEqual({ ok: true });
    const pollResult = firstStore.poll(start.deviceCode, headers, "127.0.0.1:18080");
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    const restartedStore = new InternalTokenStore();

    expect(restartedStore.validateAccessToken(pollResult.payload.access_token)).toBe(true);
  });

  it("refresh tokens survive a store instance restart because they are signed", () => {
    const firstStore = new InternalTokenStore();
    const start = firstStore.start(headers, "127.0.0.1:18080");
    expect(firstStore.approve(start.userCode)).toEqual({ ok: true });
    const pollResult = firstStore.poll(start.deviceCode, headers, "127.0.0.1:18080");
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    const restartedStore = new InternalTokenStore();
    const refreshResult = restartedStore.refresh(
      pollResult.payload.refresh_token,
      headers,
      "127.0.0.1:18080",
    );

    expect(refreshResult.ok).toBe(true);
    if (!refreshResult.ok) return;
    expect(refreshResult.payload.access_token).toMatch(/^itg_access_/);
    expect(restartedStore.validateAccessToken(refreshResult.payload.access_token)).toBe(true);
  });

  it("keeps the previous signed access token valid until it expires when a refresh token is used", () => {
    const store = new InternalTokenStore();
    const start = store.start(headers, "127.0.0.1:18080");
    expect(store.approve(start.userCode)).toEqual({ ok: true });
    const pollResult = store.poll(start.deviceCode, headers, "127.0.0.1:18080");
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    const oldAccessToken = pollResult.payload.access_token;
    expect(store.validateAccessToken(oldAccessToken)).toBe(true);

    const refreshResult = store.refresh(
      pollResult.payload.refresh_token,
      headers,
      "127.0.0.1:18080",
    );

    expect(refreshResult.ok).toBe(true);
    if (!refreshResult.ok) return;
    expect(refreshResult.payload.access_token).toMatch(/^itg_access_/);
    expect(refreshResult.payload.access_token).not.toBe(oldAccessToken);
    expect(refreshResult.payload.refresh_token).toBe(pollResult.payload.refresh_token);
    expect(store.validateAccessToken(oldAccessToken)).toBe(true);
    expect(store.validateAccessToken(refreshResult.payload.access_token)).toBe(true);
  });

  it("keeps all signed access tokens valid until expiry when the same refresh token is reused", () => {
    const store = new InternalTokenStore();
    const start = store.start(headers, "127.0.0.1:18080");
    expect(store.approve(start.userCode)).toEqual({ ok: true });
    const pollResult = store.poll(start.deviceCode, headers, "127.0.0.1:18080");
    expect(pollResult.ok).toBe(true);
    if (!pollResult.ok) return;

    const firstRefresh = store.refresh(
      pollResult.payload.refresh_token,
      headers,
      "127.0.0.1:18080",
    );
    expect(firstRefresh.ok).toBe(true);
    if (!firstRefresh.ok) return;

    const secondRefresh = store.refresh(
      pollResult.payload.refresh_token,
      headers,
      "127.0.0.1:18080",
    );
    expect(secondRefresh.ok).toBe(true);
    if (!secondRefresh.ok) return;

    expect(store.validateAccessToken(pollResult.payload.access_token)).toBe(true);
    expect(store.validateAccessToken(firstRefresh.payload.access_token)).toBe(true);
    expect(store.validateAccessToken(secondRefresh.payload.access_token)).toBe(true);
  });

  it("evicts restored refresh sessions when the refresh session limit is reached", () => {
    const firstStore = new InternalTokenStore();
    const refreshTokens: string[] = [];
    for (let i = 0; i <= INTERNAL_TOKEN_SESSION_LIMITS.maxRefreshSessions; i++) {
      const start = firstStore.start(headers, "127.0.0.1:18080");
      expect(firstStore.approve(start.userCode)).toEqual({ ok: true });
      const pollResult = firstStore.poll(start.deviceCode, headers, "127.0.0.1:18080");
      expect(pollResult.ok).toBe(true);
      if (!pollResult.ok) return;
      refreshTokens.push(pollResult.payload.refresh_token);
    }

    const restartedStore = new InternalTokenStore();
    let firstAccessToken = "";
    let latestAccessToken = "";
    for (const refreshToken of refreshTokens) {
      const refreshResult = restartedStore.refresh(
        refreshToken,
        headers,
        "127.0.0.1:18080",
      );
      expect(refreshResult.ok).toBe(true);
      if (!refreshResult.ok) return;
      firstAccessToken ||= refreshResult.payload.access_token;
      latestAccessToken = refreshResult.payload.access_token;
    }

    expect(restartedStore.validateAccessToken(firstAccessToken)).toBe(true);
    expect(restartedStore.validateAccessToken(latestAccessToken)).toBe(true);
  });

  it("requires a configured signing secret for internal refresh tokens", () => {
    const previous = process.env.CODEX_INTERNAL_TOKEN_SECRET;
    delete process.env.CODEX_INTERNAL_TOKEN_SECRET;
    const store = new InternalTokenStore();
    const start = store.start(headers, "127.0.0.1:18080");
    expect(store.approve(start.userCode)).toEqual({ ok: true });

    expect(() => store.poll(start.deviceCode, headers, "127.0.0.1:18080")).toThrow(
      "Internal token signing secret is not configured",
    );

    if (previous === undefined) {
      delete process.env.CODEX_INTERNAL_TOKEN_SECRET;
    } else {
      process.env.CODEX_INTERNAL_TOKEN_SECRET = previous;
    }
  });

  it("uses http URLs for direct local requests without forwarded proto", () => {
    const store = new InternalTokenStore();
    const start = store.start(new Headers({ host: "127.0.0.1:18080" }), "127.0.0.1:18080");

    expect(start.verificationUri).toBe("http://127.0.0.1:18080/codex/device");
  });
});
