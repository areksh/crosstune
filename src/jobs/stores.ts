/**
 * What the job runner reads and writes, as interfaces: the file-backed
 * implementations are in src/cli/job-store.ts, tests use in-memory ones.
 */

import type { InvalidJob, JobsFile, JobState, RunResultSummary } from "./model.js";

/** `jobs.json` exists but cannot be read; nothing should overwrite it. */
export class JobsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobsFileError";
  }
}

/** A job's state file exists but cannot be read; the job must not start over. */
export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStateError";
  }
}

export interface JobStore {
  /** @throws {JobsFileError} when the file is unreadable or not a jobs file. */
  load(): { file: JobsFile; invalid: InvalidJob[] };
  /** @throws {JobsFileError} rather than overwrite an unreadable file. */
  save(file: JobsFile): void;
}

export interface JobStateStore {
  /**
   * The job's state; the empty state when there is none yet.
   *
   * @throws {JobStateError} when it exists but cannot be read (starting over
   *   would make a second playlist and forget what was dismissed).
   */
  load(id: string): JobState;
  save(id: string, state: JobState): void;
  remove(id: string): void;
}

export interface RunRecord {
  at: string;
  jobId: string;
  jobName: string;
  result: RunResultSummary;
  durationMs: number;
}

export interface RunLog {
  append(record: RunRecord, now?: Date): void;
  /** Newest first, optionally one job's, at most `limit`. */
  read(jobId?: string, limit?: number): RunRecord[];
}

export interface GlobalFlags {
  needsSignIn?: { since: string; message: string };
  bundleBroken?: { since: string; message: string };
}

export interface GlobalStore {
  load(): GlobalFlags;
  save(flags: GlobalFlags): void;
}

export const RUN_LOG_LIMITS = { lines: 500, days: 90 } as const;
