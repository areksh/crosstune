/**
 * The history file: `$XDG_CONFIG_HOME/qobuz-helper/history.jsonl`.
 *
 * It lists what qobuz-helper changed in the account (playlist and track ids,
 * playlist names), so like the session it is written owner-only and kept on
 * this machine. Records are appended; compaction (see ../features/journal.ts)
 * rewrites the file through a temporary file and a rename, so a crash never
 * leaves it half-written.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { HistoryStore } from "../features/journal.js";

/** The default history path, honouring `XDG_CONFIG_HOME`. */
export function defaultHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : join(homedir(), ".config");
  return join(configHome, "qobuz-helper", "history.jsonl");
}

/** A history store backed by the local history file. */
export function fileHistoryStore(filePath: string = defaultHistoryPath()): HistoryStore {
  return {
    read: () => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    },
    append: (text) => {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, text, { mode: 0o600 });
    },
    replace: (text) => {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, filePath);
    },
  };
}
