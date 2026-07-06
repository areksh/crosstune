/**
 * Local cache of the validated Qobuz bundle credentials.
 *
 * Extracting the app id and app secret is expensive: it fetches the web
 * player's login page and its (large) JavaScript bundle, then probes candidate
 * secrets against the API. Those credentials change infrequently, so caching
 * the validated result on the user's own machine lets later runs skip the whole
 * dance and start almost instantly.
 *
 * The cache is not a secret in the way the session token is (it holds only the
 * public app id and the scraped app secret), but it is written owner-only for
 * consistency with the session store and to keep it beside it. It is versioned
 * and time-stamped so a stale or incompatible cache is ignored rather than
 * trusted blindly -- Qobuz can rotate these values, and a bad cache should heal
 * on the next run.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedCredentials } from "../qobuz/index.js";

/** Bump when the on-disk shape changes, to invalidate older caches. */
const CACHE_VERSION = 1;

/** Default backstop age after which a cache is refetched even if still parseable. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheFile {
  version: number;
  cachedAt: number;
  credentials: ResolvedCredentials;
}

export interface LoadOptions {
  /** Millisecond clock; defaults to the real clock. Injectable for tests. */
  now?: () => number;
  /** Maximum cache age in milliseconds before it is treated as absent. */
  maxAgeMs?: number;
}

/** The default bundle-cache path, honouring `XDG_CONFIG_HOME`. */
export function defaultBundlePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : join(homedir(), ".config");
  return join(configHome, "qobuz-helper", "bundle.json");
}

/** Cache validated credentials, creating the directory and restricting permissions. */
export function saveCredentials(
  credentials: ResolvedCredentials,
  filePath: string = defaultBundlePath(),
  options: { now?: () => number } = {},
): void {
  const now = options.now ?? (() => Date.now());
  mkdirSync(dirname(filePath), { recursive: true });
  const data: CacheFile = {
    version: CACHE_VERSION,
    cachedAt: now(),
    credentials,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Load cached credentials, or undefined if none are cached, the cache is
 * unusable, was written in an older format, or is older than the max age.
 */
export function loadCredentials(
  filePath: string = defaultBundlePath(),
  options: LoadOptions = {},
): ResolvedCredentials | undefined {
  const now = options.now ?? (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: Partial<CacheFile>;
  try {
    parsed = JSON.parse(raw) as Partial<CacheFile>;
  } catch {
    return undefined;
  }
  if (parsed.version !== CACHE_VERSION || typeof parsed.cachedAt !== "number") {
    return undefined;
  }
  if (now() - parsed.cachedAt > maxAgeMs) {
    return undefined;
  }
  return parseCredentials(parsed.credentials);
}

/** Remove any cached credentials. A no-op if none exist. */
export function clearCredentials(filePath: string = defaultBundlePath()): void {
  rmSync(filePath, { force: true });
}

/** Validate the stored credentials shape, returning undefined if malformed. */
function parseCredentials(value: unknown): ResolvedCredentials | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { appId, secret, privateKey } = record;
  if (
    typeof appId !== "string" ||
    appId.length === 0 ||
    typeof secret !== "string" ||
    secret.length === 0
  ) {
    return undefined;
  }
  return typeof privateKey === "string"
    ? { appId, secret, privateKey }
    : { appId, secret };
}
