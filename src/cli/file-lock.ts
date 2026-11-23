/**
 * A cross-process lock file, for the job runner (`run-due` and the `serve`
 * ticker must never refresh the same playlist at once) and for compacting the
 * history file.
 *
 * The lock is a file created exclusively (`wx`) holding who took it. A lock is
 * taken over when it is stale: its process is gone (judged only on the same
 * host, where a lock taken before the machine last started is gone too, since
 * its pid may since belong to another process), it is older than `staleMs`
 * while its host cannot be asked whether the process lives (a lock held on
 * this host by a live process is never stale, so a long job does not get a
 * second runner), or it cannot be read and is more than a few seconds old (a
 * fresh one may still be being written).
 *
 * A takeover is atomic: the stale file is renamed aside (one process wins the
 * rename), checked to be the holder that was judged stale, and only then
 * removed. Removing it by path would let a slow second judge delete a lock
 * that a faster process had just taken over, leaving two holders.
 */

import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, uptime } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

export interface LockOptions {
  /** A lock from another host older than this is stale (default 2 hours). */
  staleMs?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  /** When this machine started (default from `os.uptime()`). */
  bootedAt?: () => Date;
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (create(path, info)) {
      return {
        path,
        release: () => {
          // Move it aside before looking, so a takeover cannot slip in between
          // the look and the removal.
          const aside = takeAside(path);
          if (aside === undefined) {
            return;
          }
          if (sameHolder(readLock(aside), info)) {
            rmSync(aside, { force: true });
          } else {
            putBack(aside, path);
          }
        },
      };
    }
    if (attempt === 0) {
      const judged = readLock(path);
      if (isStale(path, judged, info.host, now(), options)) {
        const aside = takeAside(path);
        if (aside === undefined) {
          continue; // someone else took it first; try to create once more
        }
        if (sameHolder(readLock(aside), judged)) {
          rmSync(aside, { force: true });
          continue;
        }
        // A fresh lock was swapped in after we judged: give it back.
        putBack(aside, path);
      }
    }
    return undefined;
  }
  return undefined;
}

/** Rename the lock file aside, or undefined if it is already gone. */
function takeAside(path: string): string | undefined {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
    return aside;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Best effort: restore a file taken aside by mistake, unless the path is taken again. */
function putBack(aside: string, path: string): void {
  try {
    linkSync(aside, path); // fails, rather than overwrites, if the path exists
  } catch {
    // Someone took the lock meanwhile; theirs stands.
  }
  rmSync(aside, { force: true });
}

function sameHolder(a: LockInfo | undefined, b: LockInfo | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.pid === b.pid && a.startedAt === b.startedAt && a.host === b.host;
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

/** Allowance for the boot time, which `os.uptime()` gives only roughly. */
const BOOT_SLACK_MS = 60_000;

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
  if (holder.host === host) {
    // Taken before this machine last started: its process is gone, whatever
    // now has that pid (pids are handed out afresh after a restart).
    const bootedAt = options.bootedAt?.() ?? new Date(Date.now() - uptime() * 1000);
    if (Date.parse(holder.startedAt) < bootedAt.getTime() - BOOT_SLACK_MS) {
      return true;
    }
    // Liveness can be asked: age alone never makes a live holder stale.
    return !(options.isAlive ?? processIsAlive)(holder.pid);
  }
  const age = now.getTime() - Date.parse(holder.startedAt);
  return !Number.isFinite(age) || age > (options.staleMs ?? DEFAULT_STALE_MS);
}
