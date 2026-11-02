/**
 * The job files under `$XDG_CONFIG_HOME/qobuz-helper/` (see ADR-0007):
 *
 * - `jobs.json` -- definitions, written by the CLI and the web UI;
 * - `jobs-state/<id>.json` -- each job's state, written by the runner;
 * - `jobs-runs.jsonl` -- the run log, appended to and compacted on write;
 * - `jobs-global.json` -- flags that stop every job (signed out, bundle broken).
 *
 * All owner-only. Whole-file writes go through a temporary file and a rename,
 * so a crash never leaves one half-written.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { emptyJobState, parseJobsFile, parseJobState, type JobsFile } from "../jobs/model.js";
import {
  JobsFileError,
  JobStateError,
  RUN_LOG_LIMITS,
  type GlobalFlags,
  type GlobalStore,
  type JobStateStore,
  type JobStore,
  type RunLog,
  type RunRecord,
} from "../jobs/stores.js";
import { configDir } from "./config-dir.js";

export {
  JobsFileError,
  JobStateError,
  type GlobalFlags,
  type GlobalStore,
  type JobStateStore,
  type JobStore,
  type RunLog,
  type RunRecord,
};

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function fileJobStore(dir: string = configDir()): JobStore {
  const path = join(dir, "jobs.json");
  const read = (): { raw: unknown; parsed: ReturnType<JobStore["load"]> } | undefined => {
    const text = readText(path);
    if (text === undefined) {
      return undefined;
    }
    try {
      const raw: unknown = JSON.parse(text);
      return { raw, parsed: parseJobsFile(raw) };
    } catch (error) {
      throw new JobsFileError(
        `${path} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it`,
      );
    }
  };
  return {
    load: () => read()?.parsed ?? { file: { version: 2, jobs: [] }, invalid: [] },
    save: (file: JobsFile) => {
      // Refuse to overwrite a file we cannot read, and keep the jobs that
      // failed validation as they were (a hand edit to fix, not to lose).
      const current = read();
      const entries = (current?.raw as { jobs?: unknown[] } | undefined)?.jobs ?? [];
      const invalid = (current?.parsed.invalid ?? []).map(({ index }) => entries[index]);
      writeAtomically(path, `${JSON.stringify({ ...file, jobs: [...file.jobs, ...invalid] }, null, 2)}\n`);
    },
  };
}

export function fileJobStateStore(dir: string = configDir()): JobStateStore {
  const pathOf = (id: string): string => {
    if (!/^[0-9a-f]{8}$/.test(id)) {
      throw new Error(`invalid job id ${id}`);
    }
    return join(dir, "jobs-state", `${id}.json`);
  };
  return {
    load: (id) => {
      let text: string | undefined;
      try {
        text = readText(pathOf(id));
        return text === undefined ? emptyJobState() : parseJobState(JSON.parse(text));
      } catch (error) {
        throw new JobStateError(
          `${pathOf(id)} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it`,
        );
      }
    },
    save: (id, state) => writeAtomically(pathOf(id), `${JSON.stringify(state, null, 2)}\n`),
    remove: (id) => rmSync(pathOf(id), { force: true }),
  };
}

function parseRunRecords(text: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value = JSON.parse(line) as RunRecord;
      if (typeof value.at === "string" && typeof value.jobId === "string" && typeof value.result === "object") {
        records.push(value);
      }
    } catch {
      // Skip a line we cannot read.
    }
  }
  return records;
}

export function fileRunLog(dir: string = configDir()): RunLog {
  const path = join(dir, "jobs-runs.jsonl");
  const readAll = (): RunRecord[] => parseRunRecords(readText(path) ?? "");
  return {
    append: (record, now = new Date()) => {
      const all = [...readAll(), record];
      const cutoff = now.getTime() - RUN_LOG_LIMITS.days * 86_400_000;
      const kept = all.filter((r) => Date.parse(r.at) >= cutoff).slice(-RUN_LOG_LIMITS.lines);
      if (kept.length < all.length) {
        writeAtomically(path, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
      } else {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      }
    },
    read: (jobId, limit = Infinity) =>
      readAll()
        .filter((r) => jobId === undefined || r.jobId === jobId)
        .reverse()
        .slice(0, limit),
  };
}

export function fileGlobalStore(dir: string = configDir()): GlobalStore {
  const path = join(dir, "jobs-global.json");
  return {
    load: () => {
      try {
        const value: unknown = JSON.parse(readText(path) ?? "{}");
        return typeof value === "object" && value !== null ? (value as GlobalFlags) : {};
      } catch {
        return {};
      }
    },
    save: (flags) => writeAtomically(path, `${JSON.stringify(flags, null, 2)}\n`),
  };
}
