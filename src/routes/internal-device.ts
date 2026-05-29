import { Hono } from "hono";
import { getConfig } from "../config.js";
import { internalTokenStore } from "../auth/internal-token-store.js";

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

function htmlPage(userCode: string, message = ""): string {
  const escapedCode = userCode.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const escapedMessage = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex Device Login</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:28px;width:380px;box-shadow:0 20px 60px #0008}input,button{font:inherit;width:100%;box-sizing:border-box;border-radius:10px;padding:12px;margin-top:12px}input{background:#020617;color:#e2e8f0;border:1px solid #475569}button{background:#38bdf8;color:#082f49;border:0;font-weight:700;cursor:pointer}.msg{color:#86efac;margin-top:14px}.hint{color:#94a3b8;font-size:13px;line-height:1.5}</style>
</head><body><div class="card"><h1>Codex Device Login</h1><p class="hint">Dev POC only: this page simulates the future Feishu-authenticated approval step.</p><form method="post" action="/codex/device"><label>One-time code</label><input name="user_code" value="${escapedCode}" autofocus><button type="submit">Approve dev login</button></form>${escapedMessage ? `<p class="msg">${escapedMessage}</p>` : ""}</div></body></html>`;
}

export function createInternalDeviceRoutes(): Hono {
  const app = new Hono();

  app.get("/codex/device", (c) => {
    return c.html(htmlPage(c.req.query("user_code") ?? ""));
  });

  app.post("/codex/device", async (c) => {
    const body = await c.req.parseBody().catch(() => ({})) as Record<string, string | File>;
    const userCode = String(body.user_code ?? body.userCode ?? "");
    const approved = internalTokenStore.approve(userCode);
    if (!approved.ok) return c.html(htmlPage(userCode, `Approval failed: ${approved.error}`), 400);
    return c.html(htmlPage(userCode, "Approved. Return to minicodex."));
  });

  app.post("/api/codex/device-login/start", (c) => {
    return c.json(internalTokenStore.start(c.req.raw.headers, fallbackHost()));
  });

  app.post("/api/codex/device-login/poll", async (c) => {
    const body = await readBody(c);
    const deviceCode = String(body.device_code ?? body.deviceCode ?? "");
    if (!deviceCode) return c.json({ error: "device_code_required" }, 400);
    const result = internalTokenStore.poll(deviceCode, c.req.raw.headers, fallbackHost());
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 428);
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

  return app;
}
