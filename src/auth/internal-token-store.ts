import { randomBytes, timingSafeEqual } from "crypto";

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
  refreshToken: string;
  idToken: string;
  email: string;
  accountId: string;
  expiresAtMs: number;
  refreshExpiresAtMs: number;
}

const DEVICE_TTL_MS = 15 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
const DEV_EMAIL = "dev@topgamesinc.com";
const DEV_ACCOUNT_ID = "emp_dev_codex_proxy";

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

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function originFromRequest(headers: Headers, fallbackHost: string): string {
  const proto = headers.get("x-forwarded-proto") || "https";
  const host = headers.get("x-forwarded-host") || headers.get("host") || fallbackHost;
  return `${proto}://${host}`.replace(/\/$/, "");
}

class InternalTokenStore {
  private deviceByCode = new Map<string, DeviceSession>();
  private deviceByUserCode = new Map<string, DeviceSession>();
  private accessSessions = new Map<string, AccessSession>();
  private refreshSessions = new Map<string, AccessSession>();

  start(headers: Headers, fallbackHost: string): DeviceLoginStart {
    this.cleanupExpired();
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

  refresh(refreshToken: string, headers: Headers, fallbackHost: string):
    | { ok: true; payload: InternalAuthPayload }
    | { ok: false; error: string } {
    this.cleanupExpired();
    const existing = this.refreshSessions.get(refreshToken.trim());
    if (!existing) return { ok: false, error: "invalid_grant" };
    this.accessSessions.delete(existing.accessToken);
    this.refreshSessions.delete(existing.refreshToken);
    return { ok: true, payload: this.issue(headers, fallbackHost, existing.email, existing.accountId) };
  }

  validateAccessToken(token: string): boolean {
    this.cleanupExpired();
    for (const [stored, session] of this.accessSessions.entries()) {
      if (safeEqual(stored, token)) {
        return session.expiresAtMs > Date.now();
      }
    }
    return false;
  }

  private issue(
    headers: Headers,
    fallbackHost: string,
    email: string,
    accountId = DEV_ACCOUNT_ID,
  ): InternalAuthPayload {
    const origin = originFromRequest(headers, fallbackHost);
    const now = Date.now();
    const accessToken = randomToken("itg_access");
    const refreshToken = randomToken("itg_refresh");
    const idToken = randomToken("itg_id");
    const session: AccessSession = {
      accessToken,
      refreshToken,
      idToken,
      email,
      accountId,
      expiresAtMs: now + ACCESS_TTL_MS,
      refreshExpiresAtMs: now + REFRESH_TTL_MS,
    };
    this.accessSessions.set(accessToken, session);
    this.refreshSessions.set(refreshToken, session);
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
      tokenEndpoint: `${origin}/api/codex/oauth/token`,
      apiBaseUrl: `${origin}/openai/v1`,
      issuer: "topgames_internal_dev",
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
    for (const [token, session] of this.refreshSessions.entries()) {
      if (session.refreshExpiresAtMs <= now) this.refreshSessions.delete(token);
    }
  }
}

export const internalTokenStore = new InternalTokenStore();
