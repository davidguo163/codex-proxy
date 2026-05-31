/**
 * AccountPersistence — file-system persistence for AccountPool.
 * Handles load/save/migrate operations as an injectable dependency.
 */

import {
  closeSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import { appendErrorLog } from "../logs/error-log.js";
import {
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import type { AccountEntry, AccountsFile, CodexQuota } from "./types.js";

export class AccountPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AccountPersistenceError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

class AccountsFileShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsFileShapeError";
  }
}

/**
 * Migrate a legacy entry to the new schema:
 *   status === "rate_limited" + usage.rate_limit_until  →  status="active" +
 *   cachedQuota.rate_limit.{limit_reached, reset_at}.
 *
 * Trust rule: if cachedQuota was fetched AFTER rate_limit_until was last set
 * (quotaFetchedAt > rate_limit_until), we treat cachedQuota as ground truth
 * and just drop the local lock. Otherwise we synthesize/overwrite the primary
 * bucket from rate_limit_until.
 *
 * Returns true when the entry was mutated.
 */
export function migrateLegacyRateLimit(entry: AccountEntry): boolean {
  const usage = entry.usage;
  const legacyUntil = usage.rate_limit_until;
  // On-disk shape pre-dates the enum narrowing; cast through string to compare
  // against the retired "rate_limited" literal without tripping TS no-overlap.
  const wasRateLimitedStatus = (entry.status as string) === "rate_limited";
  if (!wasRateLimitedStatus && !legacyUntil) return false;

  let mutated = false;

  if (wasRateLimitedStatus) {
    entry.status = "active";
    mutated = true;
  }

  if (legacyUntil) {
    const untilMs = Date.parse(legacyUntil);
    const untilSec = Number.isFinite(untilMs) ? Math.floor(untilMs / 1000) : 0;
    const inFuture = Number.isFinite(untilMs) && untilMs > Date.now();

    const fetchedMs = entry.quotaFetchedAt ? Date.parse(entry.quotaFetchedAt) : NaN;
    const cachedQuotaIsFresh =
      entry.cachedQuota != null &&
      Number.isFinite(fetchedMs) &&
      Number.isFinite(untilMs) &&
      fetchedMs > untilMs;

    if (inFuture && !cachedQuotaIsFresh) {
      const synthesized: CodexQuota = entry.cachedQuota ?? {
        plan_type: entry.planType ?? "unknown",
        rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: untilSec,
          limit_window_seconds: usage.limit_window_seconds ?? null,
        },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      };
      synthesized.rate_limit = {
        ...synthesized.rate_limit,
        allowed: false,
        limit_reached: true,
        used_percent: Math.max(synthesized.rate_limit.used_percent ?? 0, 100),
        reset_at: untilSec,
      };
      entry.cachedQuota = synthesized;
      entry.quotaFetchedAt = new Date().toISOString();
    }

    usage.rate_limit_until = null;
    mutated = true;
  }

  return mutated;
}

export interface PersistenceLoadHealth {
  /**
   * Whether the corrupt `accounts.json` was successfully renamed aside.
   * False means the rename itself failed — the original file is still
   * on disk and the user-facing message must NOT instruct recovery
   * from a `.bak` that does not exist.
   */
  quarantined: boolean;
  /** Absolute path of the `.bak` file if quarantine succeeded. */
  backupPath: string | null;
}

export interface AccountPersistence {
  /** True for the production accounts.json persistence backend. */
  isFileBacked?: boolean;
  load(): {
    entries: AccountEntry[];
    needsPersist: boolean;
    loadFailed?: boolean;
    /** Populated when loadFailed=true so dashboard can show accurate recovery instructions. */
    health?: PersistenceLoadHealth;
  };
  save(accounts: AccountEntry[]): void;
}

function getAccountsFile(): string {
  return resolve(getDataDir(), "accounts.json");
}
function getPreviousAccountsFile(): string {
  return getAccountsFile() + ".prev";
}
function getLegacyAuthFile(): string {
  return resolve(getDataDir(), "auth.json");
}

export function createFsPersistence(): AccountPersistence {
  // Once a load discovers `accounts.json` is unparseable and quarantines it,
  // any subsequent `save()` on this persistence instance must be refused.
  // The registry's persistDisabled flag covers the normal mutation path,
  // but a future caller that holds the persistence reference directly
  // (e.g. a refactor, a script, a stray test) would otherwise race-write
  // a fresh empty file on top of the just-renamed `.bak`. This per-instance
  // latch is the second line of defense.
  let quarantineActive = false;
  let quarantineHealth: PersistenceLoadHealth | null = null;

  const persistence: AccountPersistence = {
    isFileBacked: true,

    load() {
      // Migrate from legacy auth.json if needed
      const migrated = migrateFromLegacy();

      // Load from accounts.json
      const { entries: loaded, needsPersist, loadFailed, health } = loadPersisted();
      if (loadFailed) {
        quarantineActive = true;
        quarantineHealth = health ?? { quarantined: false, backupPath: null };
      }

      const entries = migrated.length > 0 && loaded.length === 0 ? migrated : loaded;

      // Auto-persist when backfill was applied (preserves original behavior).
      // Suppressed when loadFailed — the registry will be put into a
      // persist-disabled state by AccountPool, and we must not write the
      // partially-recovered map back over the (now quarantined) original.
      if (needsPersist && loaded.length > 0 && !loadFailed) {
        persistence.save(loaded);
      }

      return { entries, needsPersist, loadFailed, health };
    },

    save(accounts: AccountEntry[]): void {
      if (quarantineActive) {
        throw new AccountPersistenceError(
          "[AccountPool] save() refused: accounts.json was quarantined this session" +
            (quarantineHealth?.backupPath ? ` (backup: ${quarantineHealth.backupPath})` : "") +
            ". Restore a healthy file and restart the process to resume auto-save.",
        );
      }
      try {
        const accountsFile = getAccountsFile();
        const dir = dirname(accountsFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data: AccountsFile = { accounts };
        preservePreviousAccountsFile(accountsFile);
        durableWriteFile(accountsFile, JSON.stringify(data, null, 2));
      } catch (err) {
        if (err instanceof AccountPersistenceError) {
          throw err;
        }
        throw new AccountPersistenceError(
          `Failed to persist accounts: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
  return persistence;
}

function durableWriteFile(filePath: string, data: string): void {
  const tmpFile = filePath + ".tmp";
  let wroteTmp = false;
  let renamed = false;
  try {
    writeFileSync(tmpFile, data, { encoding: "utf-8", mode: 0o600 });
    wroteTmp = true;
    fsyncFile(tmpFile);
    renameSync(tmpFile, filePath);
    renamed = true;
    fsyncDirBestEffortAfterRename(dirname(filePath));
  } catch (err) {
    if (wroteTmp && !renamed) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best-effort cleanup only; preserve the original error.
      }
    }
    throw err;
  }
}

function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirBestEffortAfterRename(dir: string): void {
  try {
    fsyncDir(dir);
  } catch (err) {
    if (isUnsupportedDirectoryFsyncError(err)) {
      console.warn(
        `[AccountPool] Directory fsync unsupported for ${dir}; accounts file was renamed but parent-directory durability is best-effort on this platform.`,
      );
      return;
    }
    throw err;
  }
}

function isUnsupportedDirectoryFsyncError(err: unknown): boolean {
  if (process.platform === "win32") return true;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EISDIR" ||
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EPERM" ||
    code === "EACCES";
}

function preservePreviousAccountsFile(accountsFile: string): void {
  if (!existsSync(accountsFile)) return;
  if (statSync(accountsFile).size === 0) return;

  const raw = readFileSync(accountsFile, "utf-8");
  parseAccountsFile(raw, accountsFile, { allowRefreshing: true });

  durableWriteFile(getPreviousAccountsFile(), raw);
}

function migrateFromLegacy(): AccountEntry[] {
  try {
    const accountsFile = getAccountsFile();
    const legacyAuthFile = getLegacyAuthFile();
    if (existsSync(accountsFile)) return []; // already migrated
    if (!existsSync(legacyAuthFile)) return [];

    const raw = readFileSync(legacyAuthFile, "utf-8");
    const data = JSON.parse(raw) as {
      token: string;
      proxyApiKey?: string | null;
      userInfo?: { email?: string; accountId?: string; planType?: string } | null;
    };

    if (!data.token) return [];

    const id = randomBytes(8).toString("hex");
    const accountId = extractChatGptAccountId(data.token);
    const entry: AccountEntry = {
      id,
      token: data.token,
      refreshToken: null,
      email: data.userInfo?.email ?? null,
      accountId: accountId,
      userId: extractUserProfile(data.token)?.chatgpt_user_id ?? null,
      label: null,
      planType: data.userInfo?.planType ?? null,
      proxyApiKey: data.proxyApiKey ?? "codex-proxy-" + randomBytes(24).toString("hex"),
      status: isTokenExpired(data.token) ? "expired" : "active",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        empty_response_count: 0,
        last_used: null,
        rate_limit_until: null,
        window_request_count: 0,
        window_input_tokens: 0,
        window_output_tokens: 0,
        window_cached_tokens: 0,
        window_counters_reset_at: null,
        limit_window_seconds: null,
      },
      addedAt: new Date().toISOString(),
      cachedQuota: null,
      quotaFetchedAt: null,
    };

    // Write new format
    const dir = dirname(accountsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const accountsData: AccountsFile = { accounts: [entry] };
    durableWriteFile(accountsFile, JSON.stringify(accountsData, null, 2));

    // Rename old file
    renameSync(legacyAuthFile, legacyAuthFile + ".bak");
    console.log("[AccountPool] Migrated from auth.json → accounts.json");
    return [entry];
  } catch (err) {
    console.warn("[AccountPool] Migration failed:", err);
    return [];
  }
}

function loadPersisted(): {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed?: boolean;
  health?: PersistenceLoadHealth;
} {
  const accountsFile = getAccountsFile();
  if (!existsSync(accountsFile)) return { entries: [], needsPersist: false };

  let raw: string;
  try {
    raw = readFileSync(accountsFile, "utf-8");
  } catch (err) {
    return quarantineCorruptFile(accountsFile, null, err, "read_failed");
  }

  try {
    const data = parseAccountsFile(raw, accountsFile, { allowRefreshing: true });
    const loaded = loadParsedAccounts(accountsFile, data);
    if (loaded.loadFailed) {
      return recoverFromPreviousAccountsFile(loaded as {
        entries: AccountEntry[];
        needsPersist: boolean;
        loadFailed: true;
        health: PersistenceLoadHealth;
      });
    }
    return loaded;
  } catch (err) {
    const reason = err instanceof AccountsFileShapeError ? "shape_invalid" : "json_parse_failed";
    const failure = quarantineCorruptFile(accountsFile, raw, err, reason);
    return recoverFromPreviousAccountsFile(failure);
  }
}

function parseAccountsFile(
  raw: string,
  sourcePath: string,
  options: { allowRefreshing: boolean },
): AccountsFile {
  const parsed = JSON.parse(raw) as unknown;
  // Validate shape BEFORE reading `.accounts` — `null`, primitives, or
  // arrays at the top level would otherwise crash on property access or
  // pass an Array.isArray check on the wrong target.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AccountsFileShapeError(
      `top-level JSON is not an object in ${sourcePath} (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }

  const data = parsed as AccountsFile;
  if (!Array.isArray(data.accounts)) {
    throw new AccountsFileShapeError(`accounts field is not an array in ${sourcePath}`);
  }
  if (!options.allowRefreshing && data.accounts.some((entry) => entry.status === "refreshing")) {
    throw new AccountPersistenceError(
      `${sourcePath} contains an account left in 'refreshing' state; refusing automatic restore because its refresh token may already have been consumed.`,
    );
  }
  return data;
}

function loadParsedAccounts(
  accountsFile: string,
  data: AccountsFile,
): {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed?: boolean;
  health?: PersistenceLoadHealth;
} {
  try {
    const entries: AccountEntry[] = [];
    let needsPersist = false;

    for (const entry of data.accounts) {
      if (!entry.id || !entry.token) continue;

      // Backfill missing fields from JWT
      if (!entry.planType || !entry.email || !entry.accountId || !entry.userId) {
        const profile = extractUserProfile(entry.token);
        const accountId = extractChatGptAccountId(entry.token);
        if (!entry.planType && profile?.chatgpt_plan_type) {
          entry.planType = profile.chatgpt_plan_type;
          needsPersist = true;
        }
        if (!entry.email && profile?.email) {
          entry.email = profile.email;
          needsPersist = true;
        }
        if (!entry.accountId && accountId) {
          entry.accountId = accountId;
          needsPersist = true;
        }
        if (!entry.userId && profile?.chatgpt_user_id) {
          entry.userId = profile.chatgpt_user_id;
          needsPersist = true;
        }
      }
      // Backfill userId for entries missing it (pre-v1.0.68)
      if (entry.userId === undefined) {
        entry.userId = null;
        needsPersist = true;
      }
      // Backfill empty_response_count
      if (entry.usage.empty_response_count == null) {
        entry.usage.empty_response_count = 0;
        needsPersist = true;
      }
      // Backfill window counter fields
      if (entry.usage.window_request_count == null) {
        entry.usage.window_request_count = 0;
        entry.usage.window_input_tokens = 0;
        entry.usage.window_output_tokens = 0;
        entry.usage.window_counters_reset_at = null;
        entry.usage.limit_window_seconds = null;
        needsPersist = true;
      }
      // Backfill cached_tokens fields (added in cache-hit-rate stats)
      if (entry.usage.cached_tokens == null) {
        entry.usage.cached_tokens = 0;
        needsPersist = true;
      }
      if (entry.usage.window_cached_tokens == null) {
        entry.usage.window_cached_tokens = 0;
        needsPersist = true;
      }
      // Backfill window_reset_at (missing causes NaN in refreshStatus)
      if (!("window_reset_at" in entry.usage)) {
        entry.usage.window_reset_at = null;
        needsPersist = true;
      }
      // Backfill label field
      if ((entry as unknown as Record<string, unknown>).label === undefined) {
        entry.label = null;
        needsPersist = true;
      }
      // Backfill cachedQuota fields
      if (entry.cachedQuota === undefined) {
        entry.cachedQuota = null;
        entry.quotaFetchedAt = null;
        needsPersist = true;
      }
      // Migrate legacy rate_limit_until + status="rate_limited" → cachedQuota
      if (migrateLegacyRateLimit(entry)) {
        needsPersist = true;
      }
      entries.push(entry);
    }

    return { entries, needsPersist };
  } catch (err) {
    // The per-entry migration/backfill loop threw. Treat as corruption.
    return quarantineCorruptFile(accountsFile, null, err, "entry_processing_failed");
  }
}

function recoverFromPreviousAccountsFile(failure: {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed: true;
  health: PersistenceLoadHealth;
}): {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed?: boolean;
  health?: PersistenceLoadHealth;
} {
  const prevFile = getPreviousAccountsFile();
  if (!existsSync(prevFile)) return failure;

  let raw: string;
  try {
    raw = readFileSync(prevFile, "utf-8");
    const data = parseAccountsFile(raw, prevFile, { allowRefreshing: false });
    const recovered = loadParsedAccounts(prevFile, data);
    if (recovered.loadFailed) return failure;
    durableWriteFile(getAccountsFile(), raw);
    console.warn(
      `[AccountPool] Restored accounts.json from safe previous copy ${prevFile} after load failure.`,
    );
    return recovered;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[AccountPool] Previous accounts copy ${prevFile} was not safe to restore: ${message}`,
    );
    return failure;
  }
}

/**
 * Move the unparseable `accounts.json` aside so the next launch can start
 * cleanly, and surface the failure via the local error log. The caller
 * (AccountPool) reads `loadFailed=true` and flips the registry into a
 * persist-disabled state so we don't overwrite the quarantine with the
 * empty in-memory map.
 *
 * Renaming is best-effort: filesystem quirks (lock, permission) must not
 * prevent the caller from getting a `loadFailed` signal. If rename fails,
 * the original file stays on disk and the next launch will hit the same
 * code path — still better than silent data loss.
 */
function quarantineCorruptFile(
  accountsFile: string,
  rawContent: string | null,
  err: unknown,
  reason: string,
): {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed: true;
  health: PersistenceLoadHealth;
} {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${accountsFile}.corrupt-${stamp}.bak`;
  let quarantined = false;
  let renameError: unknown = null;
  try {
    renameSync(accountsFile, backupPath);
    quarantined = true;
  } catch (renameErr) {
    renameError = renameErr;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[AccountPool] Failed to load accounts (${reason}): ${message}. ` +
      (quarantined
        ? `Quarantined original to ${backupPath}.`
        : `Quarantine rename failed; original file left in place.`),
  );

  try {
    appendErrorLog({
      source: "server",
      error: {
        name: "AccountsFileLoadFailed",
        message,
        stack: err instanceof Error ? err.stack : undefined,
      },
      context: {
        reason,
        accountsFile,
        quarantined,
        backupPath: quarantined ? backupPath : null,
        renameError:
          renameError instanceof Error ? renameError.message : renameError ? String(renameError) : null,
        rawByteLength: rawContent != null ? Buffer.byteLength(rawContent, "utf-8") : null,
      },
    });
  } catch {
    // appendErrorLog already swallows write failures, but guard against
    // upstream-side throws (e.g. getConfig() unavailable in early boot).
  }

  return {
    entries: [],
    needsPersist: false,
    loadFailed: true,
    health: { quarantined, backupPath: quarantined ? backupPath : null },
  };
}
