/**
 * Accounts and their tokens on disk, owner-only, in the config directory:
 *
 * - `accounts.json`: who is (or was) signed in to each service, and the client
 *   ids of the apps the user registered. No secrets.
 * - `sessions/<service>.json`: a service's tokens. (Qobuz's session keeps its
 *   own file, see ./session-store.ts.)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AccountRecord, AccountStore } from "../accounts/accounts.js";
import { labelOf, ServiceError } from "../services/errors.js";
import { parseId, SERVICES, type ServiceName, type UserId } from "../services/ids.js";
import type { Tokens } from "../services/oauth.js";
import type { TokenVault } from "../services/tokens.js";
import { configDir } from "./config-dir.js";
import { tryAcquireLock } from "./file-lock.js";

interface AccountsFile {
  accounts: Partial<Record<ServiceName, AccountRecord>>;
  clientIds: Partial<Record<ServiceName, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`${path} cannot be read; fix or remove it`, { cause: error });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readAccount(service: ServiceName, value: unknown): AccountRecord | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["displayName"] !== "string") {
    return undefined;
  }
  return parseId(value["id"])?.service === service
    ? {
        id: value["id"] as UserId,
        displayName: value["displayName"],
        since: typeof value["since"] === "number" ? value["since"] : 0,
      }
    : undefined;
}

export function fileAccountStore(dir: string = configDir()): AccountStore {
  const path = join(dir, "accounts.json");
  const load = (): AccountsFile => {
    const raw = readJson(path);
    const accounts = isRecord(raw) && isRecord(raw["accounts"]) ? raw["accounts"] : {};
    const clientIds = isRecord(raw) && isRecord(raw["clientIds"]) ? raw["clientIds"] : {};
    const file: AccountsFile = { accounts: {}, clientIds: {} };
    for (const service of SERVICES) {
      const account = readAccount(service, accounts[service]);
      if (account !== undefined) {
        file.accounts[service] = account;
      }
      const clientId = clientIds[service];
      if (typeof clientId === "string" && clientId.length > 0) {
        file.clientIds[service] = clientId;
      }
    }
    return file;
  };
  const update = (change: (file: AccountsFile) => void): void => {
    const file = load();
    change(file);
    writeJson(path, { version: 1, ...file });
  };
  return {
    account: (service) => load().accounts[service],
    saveAccount: (service, record) =>
      update((file) => {
        file.accounts[service] = record;
      }),
    removeAccount: (service) =>
      update((file) => {
        delete file.accounts[service];
      }),
    clientId: (service) => load().clientIds[service],
    saveClientId: (service, clientId) =>
      update((file) => {
        file.clientIds[service] = clientId;
      }),
  };
}

function tokensPath(service: ServiceName, dir: string): string {
  return join(dir, "sessions", `${service}.json`);
}

/** Tokens that cannot be used read as none: signing in again replaces them. */
function readTokens(path: string): Tokens | undefined {
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw["accessToken"] !== "string" || raw["accessToken"] === "" || typeof raw["expiresAt"] !== "number") {
    return undefined;
  }
  const { accessToken, refreshToken, expiresAt, authorisedAt, scopes } = raw;
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken.length > 0 && { refreshToken }),
    expiresAt,
    authorisedAt: typeof authorisedAt === "number" ? authorisedAt : 0,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [],
  };
}

export interface VaultOptions {
  /** How long to wait for another process's refresh. */
  waitMs?: number;
  pollMs?: number;
}

/** A refresh takes seconds; a lock older than this was left behind. */
const REFRESH_STALE_MS = 2 * 60 * 1000;

export function fileTokenVault(service: ServiceName, dir: string = configDir(), options: VaultOptions = {}): TokenVault {
  const path = tokensPath(service, dir);
  const { waitMs = 30_000, pollMs = 100 } = options;
  return {
    load: () => readTokens(path),
    save: (tokens) => writeJson(path, tokens),
    exclusive: async (fn) => {
      const until = Date.now() + waitMs;
      for (;;) {
        const lock = tryAcquireLock(`${path}.lock`, { staleMs: REFRESH_STALE_MS });
        if (lock !== undefined) {
          try {
            return await fn();
          } finally {
            lock.release();
          }
        }
        if (Date.now() >= until) {
          throw new ServiceError(service, "network", `${labelOf(service)}'s sign-in is being renewed elsewhere; try again`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}

export function removeTokens(service: ServiceName, dir: string = configDir()): void {
  rmSync(tokensPath(service, dir), { force: true });
}

/** Whether a sign-in to `service` is saved (not whether it still works). */
export function hasSavedSignIn(service: ServiceName, dir: string = configDir()): boolean {
  return existsSync(service === "qobuz" ? join(dir, "session.json") : tokensPath(service, dir));
}
