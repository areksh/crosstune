/**
 * The history file: `$XDG_CONFIG_HOME/crosstune/history.jsonl`.
 *
 * It lists what crosstune changed in the account (playlist and track ids,
 * playlist names), so like the session it is written owner-only and kept on
 * this machine. Records are appended; compaction (see ../features/journal.ts)
 * rewrites the file through a temporary file and a rename, so a crash never
 * leaves it half-written.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HistoryStore } from "../features/journal.js";
import { tryAcquireLock } from "./file-lock.js";
import { configDir } from "./config-dir.js";

/** A compaction takes well under this; an older history lock is a leftover. */
const HISTORY_LOCK_STALE_MS = 60_000;

/** The default history path, honouring `XDG_CONFIG_HOME`. */
export function defaultHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "history.jsonl");
}

/** A history store backed by the local history file. */
/** Block the thread for `ms` (the history writes are synchronous). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function fileHistoryStore(
  filePath: string = defaultHistoryPath(),
  options: { lockWaitMs?: number } = {},
): HistoryStore {
  const lockWaitMs = options.lockWaitMs ?? 2_000;
  return {
    read: () => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    },
    append: (text) => {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      appendFileSync(filePath, text, { mode: 0o600 });
    },
    replace: (text) => {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, filePath);
    },
    exclusive: <T>(fn: () => T): T | undefined => {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      // Another process holds the lock for milliseconds: wait a little.
      let lock = tryAcquireLock(`${filePath}.lock`, { staleMs: HISTORY_LOCK_STALE_MS });
      for (let waited = 0; lock === undefined && waited < lockWaitMs; waited += 25) {
        pause(25);
        lock = tryAcquireLock(`${filePath}.lock`, { staleMs: HISTORY_LOCK_STALE_MS });
      }
      if (lock === undefined) {
        return undefined;
      }
      try {
        return fn();
      } finally {
        lock.release();
      }
    },
  };
}
