import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalDeviceRoutes } from "@src/routes/internal-device.js";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ server: { port: 18080 } })),
}));

const envKeys = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_AUTHORIZATION_URL",
  "FEISHU_ACCESS_TOKEN_URL",
  "FEISHU_USER_INFO_URL",
  "FEISHU_SCOPE",
  "FEISHU_REDIRECT_URI",
  "FEISHU_ALLOWED_EMAIL_DOMAINS",
  "FEISHU_ALLOWED_EMAILS",
  "CODEX_INTERNAL_TOKEN_SECRET",
] as const;

const savedEnv = new Map<string, string | undefined>();

function setFeishuEnv(): void {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_APP_SECRET = "test-secret";
  process.env.FEISHU_AUTHORIZATION_URL = "https://open.feishu.cn/open-apis/authen/v1/index";
  process.env.FEISHU_ACCESS_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/access_token";
  process.env.FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
  process.env.FEISHU_SCOPE = "email,profile";
  process.env.FEISHU_REDIRECT_URI = "https://easyceo.thelightco.net/codex/device/callback";
  process.env.FEISHU_ALLOWED_EMAIL_DOMAINS = "topgamesinc.com";
  delete process.env.FEISHU_ALLOWED_EMAILS;
  process.env.CODEX_INTERNAL_TOKEN_SECRET = "test-secret";
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

describe("internal device Feishu login routes", () => {
  beforeEach(() => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    setFeishuEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("redirects device approval to Feishu with state and callback URL", async () => {
    const app = createInternalDeviceRoutes();
    const res = await app.request("/codex/device?user_code=ABCD-EFGH", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("_codex_feishu_state=");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://open.feishu.cn/open-apis/authen/v1/index");
    expect(location.searchParams.get("app_id")).toBe("cli_test");
    expect(location.searchParams.get("client_id")).toBeNull();
    expect(location.searchParams.get("response_type")).toBeNull();
    expect(location.searchParams.get("redirect_uri")).toBe("https://easyceo.thelightco.net/codex/device/callback");
    expect(location.searchParams.get("scope")).toBe("email,profile");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("renders a one-time code form for the bare device URL", async () => {
    const app = createInternalDeviceRoutes();
    const res = await app.request("/codex/device");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Enter the one-time code");
    expect(body).toContain('name="user_code"');
    expect(body).toContain('method="get"');
  });

  it("approves a device code only after Feishu callback succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access_token")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { access_token: "feishu-user-access-token" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/user_info")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            email: "dev@topgamesinc.com",
            name: "Dev User",
            open_id: "ou_test",
            union_id: "on_test",
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createInternalDeviceRoutes();
    const start = await app.request("/api/accounts/deviceauth/usercode", { method: "POST" });
    const started = await start.json();
    const pending = await app.request("/api/accounts/deviceauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: started.device_auth_id,
        user_code: started.user_code,
      }),
    });
    expect(pending.status).toBe(404);

    const approval = await app.request(`/codex/device?user_code=${encodeURIComponent(started.user_code)}`, {
      headers: { "x-forwarded-proto": "https" },
    });
    const location = new URL(approval.headers.get("location") ?? "");
    const callback = await app.request(`/codex/device/callback?code=feishu-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, {
      headers: {
        cookie: cookiePair(approval.headers.get("set-cookie") ?? ""),
        "x-forwarded-proto": "https",
      },
    });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Approved for dev@topgamesinc.com");

    const token = await app.request("/api/accounts/deviceauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: started.device_auth_id,
        user_code: started.user_code,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json();
    expect(tokenBody).toMatchObject({
      authorization_code: expect.stringMatching(/^itg_code_/),
    });
    const tokenResult = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: tokenBody.authorization_code,
        code_verifier: tokenBody.code_verifier,
      }),
    });
    expect(tokenResult.status).toBe(200);
    await expect(tokenResult.json()).resolves.toMatchObject({
      email: "dev@topgamesinc.com",
      accountId: "feishu_on_test",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports current Feishu OAuth authorize parameters", async () => {
    process.env.FEISHU_AUTHORIZATION_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
    const app = createInternalDeviceRoutes();
    const res = await app.request("/codex/device?user_code=ABCD-EFGH", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("cli_test");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("app_id")).toBeNull();
  });

  it("fails closed when no Feishu allowlist is configured", async () => {
    delete process.env.FEISHU_ALLOWED_EMAIL_DOMAINS;
    delete process.env.FEISHU_ALLOWED_EMAILS;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/access_token")) {
        return new Response(JSON.stringify({ code: 0, data: { access_token: "feishu-user-access-token" } }));
      }
      return new Response(JSON.stringify({ code: 0, data: { email: "dev@topgamesinc.com" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createInternalDeviceRoutes();
    const approval = await app.request("/codex/device?user_code=ZZZZ-9999", {
      headers: { "x-forwarded-proto": "https" },
    });
    const location = new URL(approval.headers.get("location") ?? "");
    const callback = await app.request(`/codex/device/callback?code=feishu-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, {
      headers: {
        cookie: cookiePair(approval.headers.get("set-cookie") ?? ""),
        "x-forwarded-proto": "https",
      },
    });

    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("not allowed");
  });

  it("renders Feishu authorization errors without exchanging a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createInternalDeviceRoutes();
    const approval = await app.request("/codex/device?user_code=ZZZZ-9999", {
      headers: { "x-forwarded-proto": "https" },
    });
    const location = new URL(approval.headers.get("location") ?? "");

    const callback = await app.request(`/codex/device/callback?error=access_denied&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`, {
      headers: {
        cookie: cookiePair(approval.headers.get("set-cookie") ?? ""),
        "x-forwarded-proto": "https",
      },
    });

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("access_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects callback without the Feishu state cookie", async () => {
    const app = createInternalDeviceRoutes();
    const approval = await app.request("/codex/device?user_code=ZZZZ-9999", {
      headers: { "x-forwarded-proto": "https" },
    });
    const location = new URL(approval.headers.get("location") ?? "");

    const callback = await app.request(`/codex/device/callback?code=feishu-code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`);

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("state_cookie_mismatch");
  });

  it("disables direct dashboard approval posts", async () => {
    const app = createInternalDeviceRoutes();
    const res = await app.request("/codex/device", { method: "POST" });

    expect(res.status).toBe(405);
    expect(await res.text()).toContain("Dashboard approval is disabled");
  });
});
