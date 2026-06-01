#!/usr/bin/env tsx

type UserCodeResponse = {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
  expires_at?: string;
};

type TokenPollResponse = {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
};

type ImportResponse = {
  success?: boolean;
  added?: number;
  updated?: number;
  failed?: number;
  errors?: string[];
};

type AccountInfo = {
  id?: string;
  email?: string | null;
  accountId?: string | null;
  userId?: string | null;
  label?: string | null;
  status?: string | null;
};

type AccountsResponse = {
  accounts?: AccountInfo[];
};

type QuotaWindow = {
  remaining_percent?: number;
  used_percent?: number;
  reset_at?: number | null;
};

type QuotaRefreshResponse = {
  quota?: {
    rate_limit?: QuotaWindow | null;
    secondary_rate_limit?: QuotaWindow | null;
  };
};

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function usage(exitCode = 2): never {
  console.error(`Usage: npm run import-openai-device-account -- [options]\n\nOptions:\n  --proxy-url URL            codex-proxy base URL (default: CODEX_PROXY_URL or http://127.0.0.1:8080)\n  --issuer URL               OpenAI auth issuer (default: https://auth.openai.com)\n  --label LABEL              Optional account label override (default: openai:<email>)\n  --timeout SEC              Poll timeout in seconds (default: 900)\n  --quota-refresh            Refresh quota after import (default: off)\n  --quota-refresh-delay SEC  Delay before quota refresh when enabled (default: 60; set 0 to refresh immediately)\n`);
  process.exit(exitCode);
}

if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  usage(0);
}

function argValue(name: string): string | null {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? usage();
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultProxyUrl(): string {
  return process.env.CODEX_PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const directEmail = payload?.email;
  if (typeof directEmail === "string" && directEmail.trim()) return directEmail.trim();

  const profile = payload?.["https://api.openai.com/profile"];
  if (profile && typeof profile === "object") {
    const profileEmail = (profile as Record<string, unknown>).email;
    if (typeof profileEmail === "string" && profileEmail.trim()) return profileEmail.trim();
  }

  return null;
}

function accountIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) return accountId.trim();
  }
  return null;
}

function userIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const userId = (auth as Record<string, unknown>).chatgpt_user_id;
    if (typeof userId === "string" && userId.trim()) return userId.trim();
  }
  return null;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON but got HTTP ${response.status}: ${text}`);
  }
}

function errorMessageFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const errRecord = error as Record<string, unknown>;
      const code = typeof errRecord.code === "string" ? errRecord.code : "";
      const message = typeof errRecord.message === "string" ? errRecord.message : "";
      return [code, message].filter(Boolean).join(": ") || JSON.stringify(error);
    }
    if (typeof record.error === "string") return record.error;
  }
  return JSON.stringify(payload);
}

async function postJson<T>(url: string, body: unknown): Promise<{ response: Response; json: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await readJson<T>(response);
  return { response, json };
}

async function getJson<T>(url: string): Promise<{ response: Response; json: T }> {
  const response = await fetch(url);
  const json = await readJson<T>(response);
  return { response, json };
}

function findImportedAccount(
  accounts: AccountInfo[],
  tokenAccountId: string | null,
  tokenUserId: string | null,
  email: string | null,
  label: string | null,
): AccountInfo | null {
  if (tokenAccountId && tokenUserId) {
    const match = accounts.find((account) => account.accountId === tokenAccountId && account.userId === tokenUserId);
    if (match) return match;
  }

  // Team members can share accountId. Only use accountId alone when it is
  // unambiguous; otherwise fall through to email/label.
  if (tokenAccountId) {
    const matches = accounts.filter((account) => account.accountId === tokenAccountId);
    if (matches.length === 1) return matches[0];
  }

  const normalizedEmail = email?.toLowerCase();
  if (normalizedEmail) {
    const emailMatches = accounts.filter((account) => account.email?.toLowerCase() === normalizedEmail);
    if (emailMatches.length === 1) return emailMatches[0];
    const activeEmailMatch = emailMatches.find((account) => account.status === "active");
    if (activeEmailMatch) return activeEmailMatch;
  }

  if (label) {
    const labelMatches = accounts.filter((account) => account.label === label);
    if (labelMatches.length === 1) return labelMatches[0];
    const activeLabelMatch = labelMatches.find((account) => account.status === "active");
    if (activeLabelMatch) return activeLabelMatch;
  }

  return null;
}

function formatReset(resetAt: number | null | undefined): string {
  if (!resetAt) return "-";
  return new Date(resetAt * 1000).toISOString();
}

async function refreshImportedQuota(
  proxyUrl: string,
  tokenAccountId: string | null,
  tokenUserId: string | null,
  email: string | null,
  label: string | null,
): Promise<void> {
  const { response: accountsResp, json: accountsJson } = await getJson<AccountsResponse>(`${proxyUrl}/auth/accounts`);
  if (!accountsResp.ok) {
    console.warn(`quota refresh skipped: failed to list accounts (${accountsResp.status})`);
    return;
  }

  const account = findImportedAccount(accountsJson.accounts ?? [], tokenAccountId, tokenUserId, email, label);
  if (!account?.id) {
    console.warn("quota refresh skipped: imported account was not found in codex-proxy account list");
    return;
  }

  const { response: quotaResp, json: quotaJson } = await getJson<QuotaRefreshResponse | Record<string, unknown>>(
    `${proxyUrl}/auth/accounts/${encodeURIComponent(account.id)}/quota`,
  );
  if (!quotaResp.ok) {
    console.warn(`quota refresh failed for ${account.id} (${account.email ?? account.label ?? "unknown"}): ${JSON.stringify(quotaJson)}`);
    return;
  }

  const quota = (quotaJson as QuotaRefreshResponse).quota;
  const fiveHour = quota?.rate_limit;
  const weekly = quota?.secondary_rate_limit;
  console.log(
    [
      "quota refreshed:",
      account.email ?? account.label ?? account.id,
      `id=${account.id}`,
      `5h=${fiveHour?.remaining_percent ?? "-"}%`,
      `weekly=${weekly?.remaining_percent ?? "-"}%`,
      `weekly_reset=${formatReset(weekly?.reset_at)}`,
    ].join(" "),
  );
}

async function main(): Promise<void> {
  const issuer = trimTrailingSlash(argValue("--issuer") ?? "https://auth.openai.com");
  const proxyUrl = trimTrailingSlash(argValue("--proxy-url") ?? defaultProxyUrl());
  const label = argValue("--label");
  const timeoutSec = Number(argValue("--timeout") ?? "900");
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usage();
  const quotaRefreshDelaySec = Number(argValue("--quota-refresh-delay") ?? "60");
  if (!Number.isFinite(quotaRefreshDelaySec) || quotaRefreshDelaySec < 0) usage();
  const shouldRefreshQuota = hasArg("--quota-refresh");

  const userCodeUrl = `${issuer}/api/accounts/deviceauth/usercode`;
  const tokenPollUrl = `${issuer}/api/accounts/deviceauth/token`;
  const oauthTokenUrl = `${issuer}/oauth/token`;

  const { response: userCodeResp, json: userCode } = await postJson<UserCodeResponse>(userCodeUrl, {
    client_id: CLIENT_ID,
  });
  if (!userCodeResp.ok) {
    throw new Error(`Device code request failed (${userCodeResp.status}): ${errorMessageFromPayload(userCode)}`);
  }

  const intervalSec = Math.max(1, Number(userCode.interval ?? 5));
  const verificationUrl = `${issuer}/codex/device`;
  console.log("OpenAI device authorization started.");
  console.log(`Open this URL: ${verificationUrl}`);
  console.log(`One-time code: ${userCode.user_code}`);
  console.log("Waiting for browser approval...");

  const started = Date.now();
  let poll: TokenPollResponse | null = null;
  while (Date.now() - started < timeoutSec * 1000) {
    await sleep(intervalSec * 1000);
    const { response, json } = await postJson<TokenPollResponse | Record<string, unknown>>(tokenPollUrl, {
      device_auth_id: userCode.device_auth_id,
      user_code: userCode.user_code,
    });
    if (response.ok) {
      poll = json as TokenPollResponse;
      break;
    }
    const message = errorMessageFromPayload(json);
    if (response.status === 403 || response.status === 404 || message.includes("authorization_pending")) {
      process.stdout.write(".");
      continue;
    }
    throw new Error(`Device authorization failed (${response.status}): ${message}`);
  }
  console.log();

  if (!poll) {
    throw new Error(`Timed out after ${timeoutSec}s waiting for device authorization`);
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: poll.authorization_code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: poll.code_verifier,
  });
  const tokenResp = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const tokens = await readJson<OAuthTokenResponse | Record<string, unknown>>(tokenResp);
  if (!tokenResp.ok) {
    throw new Error(`OAuth token exchange failed (${tokenResp.status}): ${errorMessageFromPayload(tokens)}`);
  }
  const tokenPayload = tokens as OAuthTokenResponse;
  if (!tokenPayload.access_token) throw new Error("OAuth token exchange did not return access_token");

  const autoEmail = emailFromToken(tokenPayload.access_token);
  const tokenAccountId = accountIdFromToken(tokenPayload.access_token);
  const tokenUserId = userIdFromToken(tokenPayload.access_token);
  const resolvedLabel = label ?? (autoEmail ? `openai:${autoEmail}` : null);
  const importBody = {
    accounts: [
      {
        token: tokenPayload.access_token,
        ...(tokenPayload.refresh_token ? { refreshToken: tokenPayload.refresh_token } : {}),
        ...(resolvedLabel ? { label: resolvedLabel } : {}),
      },
    ],
  };
  const { response: importResp, json: importJson } = await postJson<ImportResponse>(
    `${proxyUrl}/auth/accounts/import`,
    importBody,
  );
  if (!importResp.ok || importJson.failed) {
    throw new Error(`codex-proxy import failed (${importResp.status}): ${JSON.stringify(importJson)}`);
  }

  console.log("codex-proxy account import completed.");
  if (resolvedLabel) console.log(`label: ${resolvedLabel}`);
  console.log(JSON.stringify(importJson, null, 2));

  if (shouldRefreshQuota) {
    if (quotaRefreshDelaySec > 0) {
      console.log(`waiting ${quotaRefreshDelaySec}s before quota refresh to avoid immediate post-login usage probe`);
      await sleep(quotaRefreshDelaySec * 1000);
    }
    await refreshImportedQuota(proxyUrl, tokenAccountId, tokenUserId, autoEmail, resolvedLabel);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
