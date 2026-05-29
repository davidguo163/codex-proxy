import { Hono } from "hono";
import { getConfig } from "../config.js";
import { internalTokenStore } from "../auth/internal-token-store.js";
import {
  buildFeishuAuthorizationUrl,
  createFeishuState,
  exchangeFeishuCodeForUser,
  feishuAccountId,
  FEISHU_STATE_COOKIE,
  getFeishuConfig,
  isFeishuUserAllowed,
  verifyFeishuState,
} from "../auth/feishu-device-login.js";

function fallbackHost(): string {
  const config = getConfig();
  return `127.0.0.1:${config.server.port}`;
}

async function readBody(c: { req: { header(name: string): string | undefined; json(): Promise<unknown>; parseBody(): Promise<Record<string, string | File>> } }): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => ({}));
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  }
  const body = await c.req.parseBody().catch(() => ({}));
  return body as Record<string, unknown>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function cookieValue(cookieHeader: string | undefined, name: string): string {
  const parts = cookieHeader?.split(";") ?? [];
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return "";
}

function isHttps(headers: Headers): boolean {
  return (headers.get("x-forwarded-proto") ?? "").toLowerCase() === "https";
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  let result = `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/codex/device; Max-Age=${maxAge}`;
  if (secure) result += "; Secure";
  return result;
}

function htmlPage(userCode: string, message = ""): string {
  const escapedCode = escapeHtml(userCode);
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex Device Login</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:28px;width:380px;box-shadow:0 20px 60px #0008}.code{font:700 28px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2px;background:#020617;border:1px solid #475569;border-radius:10px;padding:12px;text-align:center}.msg{color:#86efac;margin-top:14px}.hint{color:#94a3b8;font-size:13px;line-height:1.5}</style>
</head><body><div class="card"><h1>Codex Device Login</h1>${escapedCode ? `<div class="code">${escapedCode}</div>` : ""}<p class="hint">Use Feishu to approve this one-time Codex login code.</p>${escapedMessage ? `<p class="msg">${escapedMessage}</p>` : ""}</div></body></html>`;
}

function codeEntryPage(message = ""): string {
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex Device Login</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:28px;width:380px;box-shadow:0 20px 60px #0008}input,button{font:inherit;width:100%;box-sizing:border-box;border-radius:10px;padding:12px;margin-top:12px}input{background:#020617;color:#e2e8f0;border:1px solid #475569}button{background:#38bdf8;color:#082f49;border:0;font-weight:700;cursor:pointer}.msg{color:#fca5a5;margin-top:14px}.hint{color:#94a3b8;font-size:13px;line-height:1.5}</style>
</head><body><div class="card"><h1>Codex Device Login</h1><p class="hint">Enter the one-time code shown by minicodex, then approve with Feishu.</p><form method="get" action="/codex/device"><label>One-time code</label><input name="user_code" autofocus><button type="submit">Continue with Feishu</button></form>${escapedMessage ? `<p class="msg">${escapedMessage}</p>` : ""}</div></body></html>`;
}

function feishuConfigErrorPage(): string {
  return htmlPage("", "Feishu login is not configured for this server.");
}

export function createInternalDeviceRoutes(): Hono {
  const app = new Hono();

  app.get("/codex/device", (c) => {
    const userCode = c.req.query("user_code") ?? "";
    if (!userCode.trim()) return c.html(codeEntryPage());
    const feishuConfig = getFeishuConfig();
    if (!feishuConfig) return c.html(feishuConfigErrorPage(), 503);

    const { state, nonce } = createFeishuState(userCode, feishuConfig);
    c.header("Set-Cookie", cookie(FEISHU_STATE_COOKIE, nonce, 10 * 60, isHttps(c.req.raw.headers)));
    return c.redirect(buildFeishuAuthorizationUrl(feishuConfig, state), 302);
  });

  app.get("/codex/device/callback", async (c) => {
    const feishuConfig = getFeishuConfig();
    if (!feishuConfig) return c.html(feishuConfigErrorPage(), 503);
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const feishuError = c.req.query("error") ?? "";
    const feishuErrorDescription = c.req.query("error_description") ?? "";
    const nonce = cookieValue(c.req.header("cookie"), FEISHU_STATE_COOKIE);
    const stateResult = verifyFeishuState(state, nonce, feishuConfig);
    c.header("Set-Cookie", cookie(FEISHU_STATE_COOKIE, "", 0, isHttps(c.req.raw.headers)));
    if (!stateResult.ok) return c.html(htmlPage("", `Feishu callback failed: ${stateResult.error}`), 400);
    if (feishuError) {
      const suffix = feishuErrorDescription ? `: ${escapeHtml(feishuErrorDescription)}` : "";
      return c.html(htmlPage(stateResult.userCode, `Feishu authorization failed: ${escapeHtml(feishuError)}${suffix}`), 400);
    }
    if (!code) return c.html(htmlPage(stateResult.userCode, "Feishu callback is missing code."), 400);

    try {
      const user = await exchangeFeishuCodeForUser(code, feishuConfig);
      const displayIdentity = user.email ?? user.name ?? user.unionId ?? user.openId ?? "Feishu user";
      if (!isFeishuUserAllowed(user, feishuConfig)) {
        return c.html(htmlPage(stateResult.userCode, `Feishu user is not allowed: ${escapeHtml(displayIdentity)}`), 403);
      }
      const approved = internalTokenStore.approve(stateResult.userCode, {
        email: user.email ?? displayIdentity,
        accountId: feishuAccountId(user),
      });
      if (!approved.ok) return c.html(htmlPage(stateResult.userCode, `Approval failed: ${approved.error}`), 400);
      return c.html(htmlPage(stateResult.userCode, `Approved for ${escapeHtml(displayIdentity)}. Return to minicodex.`));
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      return c.html(htmlPage(stateResult.userCode, `Feishu login failed: ${escapeHtml(message)}`), 502);
    }
  });

  app.post("/codex/device", (c) => {
    return c.html(htmlPage("", "Dashboard approval is disabled. Open the device URL and approve with Feishu."), 405);
  });

  app.post("/api/codex/device-login/start", (c) => {
    return c.json(internalTokenStore.start(c.req.raw.headers, fallbackHost()));
  });

  app.post("/api/accounts/deviceauth/usercode", (c) => {
    const started = internalTokenStore.start(c.req.raw.headers, fallbackHost());
    return c.json({
      device_auth_id: started.deviceCode,
      user_code: started.userCode,
      interval: String(started.interval),
    });
  });

  app.post("/api/codex/device-login/poll", async (c) => {
    const body = await readBody(c);
    const deviceCode = String(body.device_code ?? body.deviceCode ?? "");
    if (!deviceCode) return c.json({ error: "device_code_required" }, 400);
    const result = internalTokenStore.poll(deviceCode, c.req.raw.headers, fallbackHost());
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 428);
    return c.json(result.payload);
  });

  app.post("/api/accounts/deviceauth/token", async (c) => {
    const body = await readBody(c);
    const deviceCode = String(body.device_auth_id ?? body.deviceAuthId ?? "");
    const userCode = String(body.user_code ?? body.userCode ?? "");
    if (!deviceCode || !userCode) return c.json({ error: "device_auth_id_and_user_code_required" }, 400);
    const result = internalTokenStore.pollAuthorizationCode(deviceCode, userCode);
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json(result.payload);
  });

  app.post("/api/codex/oauth/token", async (c) => {
    const body = await readBody(c);
    const grantType = String(body.grant_type ?? body.grantType ?? "");
    const refreshToken = String(body.refresh_token ?? body.refreshToken ?? "");
    if (grantType !== "refresh_token") return c.json({ error: "unsupported_grant_type" }, 400);
    if (!refreshToken) return c.json({ error: "refresh_token_required" }, 400);
    const result = internalTokenStore.refresh(refreshToken, c.req.raw.headers, fallbackHost());
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.payload);
  });

  app.post("/oauth/token", async (c) => {
    const body = await readBody(c);
    const grantType = String(body.grant_type ?? body.grantType ?? "");
    if (grantType === "authorization_code") {
      const code = String(body.code ?? "");
      const codeVerifier = String(body.code_verifier ?? body.codeVerifier ?? "");
      const result = internalTokenStore.exchangeAuthorizationCode(code, codeVerifier, c.req.raw.headers, fallbackHost());
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result.payload);
    }
    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token ?? body.refreshToken ?? "");
      const result = internalTokenStore.refresh(refreshToken, c.req.raw.headers, fallbackHost());
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result.payload);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return app;
}
