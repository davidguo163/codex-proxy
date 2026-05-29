import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  authorizationUrl: string;
  accessTokenUrl: string;
  userInfoUrl: string;
  scope: string;
  redirectUri: string;
  allowedEmails: Set<string>;
  allowedEmailDomains: Set<string>;
  allowedTenantKeys: Set<string>;
}

export interface FeishuUser {
  email: string | null;
  name: string | null;
  openId: string | null;
  unionId: string | null;
  tenantKey: string | null;
}

export const FEISHU_STATE_COOKIE = "_codex_feishu_state";

const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  userCode: string;
  nonce: string;
  exp: number;
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function splitCsv(value: string): Set<string> {
  return new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
}

export function getFeishuConfig(): FeishuConfig | null {
  const appId = env("FEISHU_APP_ID");
  const appSecret = env("FEISHU_APP_SECRET");
  const redirectUri = env("FEISHU_REDIRECT_URI");
  if (!appId || !appSecret || !redirectUri) return null;
  return {
    appId,
    appSecret,
    authorizationUrl: env("FEISHU_AUTHORIZATION_URL") || "https://open.feishu.cn/open-apis/authen/v1/index",
    accessTokenUrl: env("FEISHU_ACCESS_TOKEN_URL") || "https://open.feishu.cn/open-apis/authen/v1/access_token",
    userInfoUrl: env("FEISHU_USER_INFO_URL") || "https://open.feishu.cn/open-apis/authen/v1/user_info",
    scope: env("FEISHU_SCOPE") || "email,profile",
    redirectUri,
    allowedEmails: splitCsv(env("FEISHU_ALLOWED_EMAILS")),
    allowedEmailDomains: splitCsv(env("FEISHU_ALLOWED_EMAIL_DOMAINS")),
    allowedTenantKeys: splitCsv(env("FEISHU_ALLOWED_TENANT_KEYS")),
  };
}

function stateSecret(config: FeishuConfig): string {
  const secret = process.env.CODEX_INTERNAL_TOKEN_SECRET || config.appSecret;
  if (!secret) throw new Error("Feishu state signing secret is not configured");
  return secret;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64urlJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sign(value: string, config: FeishuConfig): string {
  return createHmac("sha256", stateSecret(config)).update(value).digest("base64url");
}

export function createFeishuState(userCode: string, config: FeishuConfig): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const payload = base64urlJson({
    userCode: userCode.trim().toUpperCase(),
    nonce,
    exp: Date.now() + STATE_TTL_MS,
  } satisfies StatePayload);
  return { state: `${payload}.${sign(payload, config)}`, nonce };
}

export function verifyFeishuState(
  state: string,
  expectedNonce: string,
  config: FeishuConfig,
): { ok: true; userCode: string } | { ok: false; error: string } {
  const [payloadPart, signature] = state.split(".");
  if (!payloadPart || !signature) return { ok: false, error: "invalid_state" };
  const expected = sign(payloadPart, config);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return { ok: false, error: "invalid_state" };
  }
  const payload = parseBase64urlJson<StatePayload>(payloadPart);
  if (!payload || payload.exp <= Date.now()) return { ok: false, error: "expired_state" };
  if (!expectedNonce || payload.nonce !== expectedNonce) return { ok: false, error: "state_cookie_mismatch" };
  if (!payload.userCode) return { ok: false, error: "missing_user_code" };
  return { ok: true, userCode: payload.userCode };
}

export function buildFeishuAuthorizationUrl(config: FeishuConfig, state: string): string {
  const url = new URL(config.authorizationUrl);
  const isLegacyIndex = url.pathname.endsWith("/authen/v1/index");
  url.searchParams.set(isLegacyIndex ? "app_id" : "client_id", config.appId);
  if (!isLegacyIndex) url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  if (config.scope) url.searchParams.set("scope", config.scope);
  return url.toString();
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringField(source: JsonObject, ...names: string[]): string | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function assertFeishuSuccess(body: JsonObject, operation: string): JsonObject {
  const code = body.code;
  if (code !== undefined && code !== 0) {
    const msg = stringField(body, "msg", "message") ?? "unknown_feishu_error";
    throw new Error(`${operation}_failed:${code}:${msg}`);
  }
  return asObject(body.data);
}

function debugValue(value: string | null): string {
  if (!value) return "missing";
  if (process.env.FEISHU_DEBUG_IDENTITY_FULL === "1") return value;
  if (value.includes("@")) return value.replace(/^(.).+(@.*)$/, "$1***$2");
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function debugFields(tokenData: JsonObject, userInfo: JsonObject): string {
  const keys = (value: JsonObject) => Object.keys(value).sort().join(",") || "none";
  const merged = {
    email: stringField(userInfo, "email", "enterprise_email") ?? stringField(tokenData, "email", "enterprise_email"),
    name: stringField(userInfo, "name", "en_name") ?? stringField(tokenData, "name", "en_name"),
    open_id: stringField(userInfo, "open_id") ?? stringField(tokenData, "open_id"),
    union_id: stringField(userInfo, "union_id") ?? stringField(tokenData, "union_id"),
    tenant_key: stringField(userInfo, "tenant_key") ?? stringField(tokenData, "tenant_key"),
  };
  return `token_keys=[${keys(tokenData)}]; user_info_keys=[${keys(userInfo)}]; ` +
    `email=${debugValue(merged.email)}; name=${debugValue(merged.name)}; ` +
    `open_id=${debugValue(merged.open_id)}; union_id=${debugValue(merged.union_id)}; ` +
    `tenant_key=${debugValue(merged.tenant_key)}`;
}

export async function exchangeFeishuCodeForUser(code: string, config: FeishuConfig): Promise<FeishuUser> {
  const tokenResponse = await fetch(config.accessTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      app_id: config.appId,
      app_secret: config.appSecret,
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const tokenBody = asObject(await tokenResponse.json().catch(() => ({})));
  if (!tokenResponse.ok) throw new Error(`feishu_token_http_${tokenResponse.status}`);
  const tokenData = assertFeishuSuccess(tokenBody, "feishu_token");
  const accessToken = stringField(tokenData, "access_token", "user_access_token");
  if (!accessToken) throw new Error("feishu_access_token_missing");

  const userInfoResponse = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const userInfoBody = asObject(await userInfoResponse.json().catch(() => ({})));
  if (!userInfoResponse.ok) throw new Error(`feishu_user_info_http_${userInfoResponse.status}`);
  const userInfo = assertFeishuSuccess(userInfoBody, "feishu_user_info");

  const email = stringField(userInfo, "email", "enterprise_email") ??
    stringField(tokenData, "email", "enterprise_email");
  const name = stringField(userInfo, "name", "en_name") ?? stringField(tokenData, "name", "en_name");
  const openId = stringField(userInfo, "open_id") ?? stringField(tokenData, "open_id");
  const unionId = stringField(userInfo, "union_id") ?? stringField(tokenData, "union_id");
  const tenantKey = stringField(userInfo, "tenant_key") ?? stringField(tokenData, "tenant_key");
  if (!email && !openId && !unionId) {
    const detail = process.env.FEISHU_DEBUG_IDENTITY === "1" ? `: ${debugFields(tokenData, userInfo)}` : "";
    throw new Error(`feishu_identity_missing${detail}`);
  }
  if (!email && process.env.FEISHU_DEBUG_IDENTITY === "1") {
    throw new Error(`feishu_email_missing: ${debugFields(tokenData, userInfo)}`);
  }
  return {
    email,
    name,
    openId,
    unionId,
    tenantKey,
  };
}

export function isFeishuUserAllowed(user: FeishuUser, config: FeishuConfig): boolean {
  const email = user.email?.toLowerCase() ?? "";
  if (email && config.allowedEmails.size > 0 && config.allowedEmails.has(email)) return true;
  const domain = email.split("@")[1] ?? "";
  if (domain && config.allowedEmailDomains.size > 0 && config.allowedEmailDomains.has(domain)) return true;
  if (!email && user.tenantKey && config.allowedTenantKeys.size > 0 && config.allowedTenantKeys.has(user.tenantKey.toLowerCase())) return true;
  return false;
}

export function feishuAccountId(user: FeishuUser): string {
  const rawId = user.unionId ?? user.openId ?? user.email ?? "unknown";
  return `feishu_${rawId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
