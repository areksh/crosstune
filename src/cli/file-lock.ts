/**
 * A cross-process lock file, for the job runner (`run-due` and the `serve`
 * ticker must never refresh the same playlist at once) and for compacting the
 * history file.
 *
 * The lock is a file created exclusively (`wx`) holding who took it. A lock is
 * taken over when it is stale: its process is gone (judged only on the same
 * host), it is older than `staleMs`, or it cannot be read and is more than a
 * few seconds old (a fresh one may still be being written).
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

export interface LockOptions {
  /** A lock older than this is stale whoever holds it (default 2 hours). */
  staleMs?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  host?: string;
  pid?: number;
}

export interface FileLock {
  readonly path: string;
  /** Remove the lock, if it is still ours. */
  release(): void;
}

export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

/** True if a process with this pid exists (on this host). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's holder, or undefined when there is none or it is unreadable. */
export function readLock(path: string): LockInfo | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as LockInfo).pid === "number" &&
      typeof (raw as LockInfo).startedAt === "string" &&
      typeof (raw as LockInfo).host === "string"
    ) {
      const { pid, startedAt, host } = raw as LockInfo;
      return { pid, startedAt, host };
    }
  } catch {
    // Missing or unreadable.
  }
  return undefined;
}

/**
 * Take the lock, or return undefined if someone else holds it. A stale lock is
 * replaced (once).
 */
export function tryAcquireLock(path: string, options: LockOptions = {}): FileLock | undefined {
  const now = options.now ?? (() => new Date());
  const info: LockInfo = {
    pid: options.pid ?? process.pid,
    startedAt: now().toISOString(),
    host: options.host ?? hostname(),
  };
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (create(path, info)) {
      return {
        path,
        release: () => {
          const holder = readLock(path);
          if (holder !== undefined && holder.pid === info.pid && holder.startedAt === info.startedAt) {
            rmSync(path, { force: true });
          }
        },
      };
    }
    if (attempt === 0 && isStale(path, readLock(path), info.host, now(), options)) {
      rmSync(path, { force: true });
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Take the lock, trying for up to `waitMs` while someone else holds it. */
export async function acquireLockWithin(
  path: string,
  waitMs: number,
  options: LockOptions & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<FileLock | undefined> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; ; waited += LOCK_POLL_MS) {
    const lock = tryAcquireLock(path, options);
    if (lock !== undefined || waited >= waitMs) {
      return lock;
    }
    await sleep(LOCK_POLL_MS);
  }
}

const LOCK_POLL_MS = 250;

function create(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** An unreadable lock younger than this may still be being written. */
const UNREADABLE_GRACE_MS = 10_000;

function isStale(
  path: string,
  holder: LockInfo | undefined,
  host: string,
  now: Date,
  options: LockOptions,
): boolean {
  if (holder === undefined) {
    try {
      return now.getTime() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return true; // gone already
    }
  }
  const age = now.getTime() - Date.parse(holder.startedAt);
  if (!Number.isFinite(age) || age > (options.staleMs ?? DEFAULT_STALE_MS)) {
    return true;
  }
  const isAlive = options.isAlive ?? processIsAlive;
  return holder.host === host && !isAlive(holder.pid);
}
