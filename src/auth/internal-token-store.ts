import { createHash, createHmac, randomBytes } from "crypto";
import { getConfig } from "../config.js";

export interface DeviceLoginStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface InternalAuthPayload {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  token_type: "Bearer";
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  accountId: string;
  email: string;
  tokenEndpoint: string;
  apiBaseUrl: string;
  issuer: "topgames_internal_dev";
}

export interface AuthorizationCodePayload {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

type DeviceSessionStatus = "pending" | "approved" | "consumed";

interface DeviceSession {
  deviceCode: string;
  userCode: string;
  status: DeviceSessionStatus;
  createdAtMs: number;
  expiresAtMs: number;
  approvedAtMs?: number;
  email?: string;
}

interface AccessSession {
  accessToken: string;
  email: string;
  accountId: string;
  expiresAtMs: number;
}

interface AuthorizationSession {
  code: string;
  codeVerifier: string;
  codeChallenge: string;
  email: string;
  accountId: string;
  expiresAtMs: number;
}

interface SignedRefreshPayload {
  typ: "itg_refresh";
  email: string;
  accountId: string;
  exp: number;
  jti: string;
}

const DEVICE_TTL_MS = 15 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
const DEV_EMAIL = "dev@topgamesinc.com";
const DEV_ACCOUNT_ID = "emp_dev_codex_proxy";
const MAX_DEVICE_SESSIONS = 1000;
const MAX_ACCESS_SESSIONS = 2000;
const MAX_AUTH_CODE_SESSIONS = 1000;
const ISSUER = "topgames_internal_dev";

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += alphabet[randomBytes(1)[0] % alphabet.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
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

function signingSecret(): string {
  return process.env.CODEX_INTERNAL_TOKEN_SECRET || getConfig().server.proxy_api_key || "codex-proxy-dev-internal-token-secret";
}

function sign(parts: string): string {
  return createHmac("sha256", signingSecret()).update(parts).digest("base64url");
}

function compactJwt(payload: unknown): string {
  const header = base64urlJson({ alg: "HS256", typ: "JWT" });
  const body = base64urlJson(payload);
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

function signedToken(prefix: string, payload: unknown): string {
  return `${prefix}_${compactJwt(payload)}`;
}

function verifySignedToken<T>(token: string, prefix: string): T | null {
  if (!token.startsWith(`${prefix}_`)) return null;
  const raw = token.slice(prefix.length + 1);
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  if (sign(`${header}.${body}`) !== signature) return null;
  return parseBase64urlJson<T>(body);
}

function makeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function originFromRequest(headers: Headers, fallbackHost: string): string {
  const configured = process.env.CODEX_INTERNAL_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = headers.get("x-forwarded-proto") || "http";
  const host = headers.get("host") || fallbackHost;
  return `${proto}://${host}`.replace(/\/$/, "");
}

export class InternalTokenStore {
  private deviceByCode = new Map<string, DeviceSession>();
  private deviceByUserCode = new Map<string, DeviceSession>();
  private accessSessions = new Map<string, AccessSession>();
  private authorizationSessions = new Map<string, AuthorizationSession>();

  start(headers: Headers, fallbackHost: string): DeviceLoginStart {
    this.cleanupExpired();
    this.evictDeviceSessionsIfNeeded();
    const origin = originFromRequest(headers, fallbackHost);
    const deviceCode = randomToken("itg_device");
    let userCode = randomUserCode();
    while (this.deviceByUserCode.has(userCode)) userCode = randomUserCode();

    const session: DeviceSession = {
      deviceCode,
      userCode,
      status: "pending",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + DEVICE_TTL_MS,
    };
    this.deviceByCode.set(deviceCode, session);
    this.deviceByUserCode.set(userCode, session);

    const verificationUri = `${origin}/codex/device`;
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expiresIn: DEVICE_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    };
  }

  approve(userCode: string, email = DEV_EMAIL): { ok: true } | { ok: false; error: string } {
    this.cleanupExpired();
    const normalized = userCode.trim().toUpperCase();
    const session = this.deviceByUserCode.get(normalized);
    if (!session) return { ok: false, error: "code_not_found_or_expired" };
    if (session.status !== "pending") return { ok: false, error: `code_${session.status}` };
    session.status = "approved";
    session.approvedAtMs = Date.now();
    session.email = email;
    return { ok: true };
  }

  poll(deviceCode: string, headers: Headers, fallbackHost: string):
    | { ok: true; payload: InternalAuthPayload }
    | { ok: false; status: number; error: string } {
    this.cleanupExpired();
    const session = this.deviceByCode.get(deviceCode.trim());
    if (!session) return { ok: false, status: 400, error: "expired_token" };
    if (session.status === "pending") return { ok: false, status: 428, error: "authorization_pending" };
    if (session.status === "consumed") return { ok: false, status: 400, error: "code_already_consumed" };

    session.status = "consumed";
    return { ok: true, payload: this.issue(headers, fallbackHost, session.email ?? DEV_EMAIL) };
  }

  pollAuthorizationCode(deviceCode: string, userCode: string):
    | { ok: true; payload: AuthorizationCodePayload }
    | { ok: false; status: number; error: string } {
    this.cleanupExpired();
    const session = this.deviceByCode.get(deviceCode.trim());
    if (!session || session.userCode !== userCode.trim().toUpperCase()) {
      return { ok: false, status: 400, error: "expired_token" };
    }
    if (session.status === "pending") return { ok: false, status: 404, error: "authorization_pending" };
    if (session.status === "consumed") return { ok: false, status: 400, error: "code_already_consumed" };

    this.evictAuthorizationSessionsIfNeeded();
    session.status = "consumed";
    const code = randomToken("itg_code");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = makeCodeChallenge(codeVerifier);
    this.authorizationSessions.set(code, {
      code,
      codeVerifier,
      codeChallenge,
      email: session.email ?? DEV_EMAIL,
      accountId: DEV_ACCOUNT_ID,
      expiresAtMs: Date.now() + AUTH_CODE_TTL_MS,
    });
    return {
      ok: true,
      payload: {
        authorization_code: code,
        code_challenge: codeChallenge,
        code_verifier: codeVerifier,
      },
    };
  }

  exchangeAuthorizationCode(code: string, codeVerifier: string, headers: Headers, fallbackHost: string):
    | { ok: true; payload: InternalAuthPayload }
    | { ok: false; error: string } {
    this.cleanupExpired();
    const session = this.authorizationSessions.get(code.trim());
    if (!session) return { ok: false, error: "invalid_grant" };
    if (session.codeVerifier !== codeVerifier) return { ok: false, error: "invalid_grant" };
    this.authorizationSessions.delete(session.code);
    return { ok: true, payload: this.issue(headers, fallbackHost, session.email, session.accountId) };
  }

  refresh(refreshToken: string, headers: Headers, fallbackHost: string):
    | { ok: true; payload: InternalAuthPayload }
    | { ok: false; error: string } {
    this.cleanupExpired();
    const payload = verifySignedToken<SignedRefreshPayload>(refreshToken.trim(), "itg_refresh");
    if (!payload || payload.typ !== "itg_refresh" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: "invalid_grant" };
    }
    return { ok: true, payload: this.issue(headers, fallbackHost, payload.email, payload.accountId) };
  }

  validateAccessToken(token: string): boolean {
    this.cleanupExpired();
    const session = this.accessSessions.get(token);
    return session !== undefined && session.expiresAtMs > Date.now();
  }

  private issue(
    headers: Headers,
    fallbackHost: string,
    email: string,
    accountId = DEV_ACCOUNT_ID,
  ): InternalAuthPayload {
    this.evictAccessSessionsIfNeeded();
    const origin = originFromRequest(headers, fallbackHost);
    const now = Date.now();
    const accessToken = randomToken("itg_access");
    const refreshExp = Math.floor((now + REFRESH_TTL_MS) / 1000);
    const refreshToken = signedToken("itg_refresh", {
      typ: "itg_refresh",
      email,
      accountId,
      exp: refreshExp,
      jti: randomBytes(16).toString("base64url"),
    } satisfies SignedRefreshPayload);
    const idToken = compactJwt({
      iss: ISSUER,
      sub: accountId,
      email,
      aud: "codex-proxy-dev",
      exp: Math.floor((now + ACCESS_TTL_MS) / 1000),
      iat: Math.floor(now / 1000),
      "https://api.openai.com/profile": {
        email,
      },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "pro",
        chatgpt_user_id: accountId,
        user_id: accountId,
        chatgpt_account_id: accountId,
        chatgpt_account_is_fedramp: false,
      },
    });
    const session: AccessSession = {
      accessToken,
      email,
      accountId,
      expiresAtMs: now + ACCESS_TTL_MS,
    };
    this.accessSessions.set(accessToken, session);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expires_in: ACCESS_TTL_MS / 1000,
      token_type: "Bearer",
      accessToken,
      refreshToken,
      idToken,
      expiresAt: Math.floor(session.expiresAtMs / 1000),
      accountId,
      email,
      tokenEndpoint: `${origin}/oauth/token`,
      apiBaseUrl: `${origin}/openai/v1`,
      issuer: ISSUER,
    };
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [code, session] of this.deviceByCode.entries()) {
      if (session.expiresAtMs <= now) {
        this.deviceByCode.delete(code);
        this.deviceByUserCode.delete(session.userCode);
      }
    }
    for (const [token, session] of this.accessSessions.entries()) {
      if (session.expiresAtMs <= now) this.accessSessions.delete(token);
    }
    for (const [code, session] of this.authorizationSessions.entries()) {
      if (session.expiresAtMs <= now) this.authorizationSessions.delete(code);
    }
  }

  private evictDeviceSessionsIfNeeded(): void {
    while (this.deviceByCode.size >= MAX_DEVICE_SESSIONS) {
      const oldest = this.deviceByCode.values().next().value as DeviceSession | undefined;
      if (!oldest) return;
      this.deviceByCode.delete(oldest.deviceCode);
      this.deviceByUserCode.delete(oldest.userCode);
    }
  }

  private evictAccessSessionsIfNeeded(): void {
    while (this.accessSessions.size >= MAX_ACCESS_SESSIONS) {
      const oldest = this.accessSessions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.accessSessions.delete(oldest);
    }
  }

  private evictAuthorizationSessionsIfNeeded(): void {
    while (this.authorizationSessions.size >= MAX_AUTH_CODE_SESSIONS) {
      const oldest = this.authorizationSessions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.authorizationSessions.delete(oldest);
    }
  }
}

export const internalTokenStore = new InternalTokenStore();
