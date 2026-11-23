/**
 * What the job runner reads and writes, as interfaces: the file-backed
 * implementations are in src/cli/job-store.ts, tests use in-memory ones.
 */

import { SERVICES, type ServiceName } from "../services/names.js";
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

export interface Flag {
  since: string;
  message: string;
}

/** What stops jobs: those that use a service which needs a sign-in. */
export interface GlobalFlags {
  /** Qobuz needs a sign-in. */
  needsSignIn?: Flag;
  /** Qobuz changed its web player. */
  bundleBroken?: Flag;
  /** Other services that need a sign-in. */
  signIn?: Partial<Record<ServiceName, Flag>>;
}

/** The flags with a service needing a sign-in; when it first did is kept. */
export function flagSignIn(flags: GlobalFlags, service: ServiceName, flag: Flag): GlobalFlags {
  if (service === "qobuz") {
    return { ...flags, needsSignIn: { ...flag, since: flags.needsSignIn?.since ?? flag.since } };
  }
  const since = flags.signIn?.[service]?.since ?? flag.since;
  return { ...flags, signIn: { ...flags.signIn, [service]: { ...flag, since } } };
}

/** The flags once these services work again. */
export function unflag(flags: GlobalFlags, services: readonly ServiceName[]): GlobalFlags {
  const { needsSignIn, bundleBroken, signIn = {} } = flags;
  const left = Object.fromEntries(Object.entries(signIn).filter(([name]) => !services.includes(name as ServiceName)));
  const qobuz = services.includes("qobuz");
  return {
    ...(!qobuz && needsSignIn !== undefined && { needsSignIn }),
    ...(!qobuz && bundleBroken !== undefined && { bundleBroken }),
    ...(Object.keys(left).length > 0 && { signIn: left }),
  };
}

/** The services that need a sign-in, with why. */
export function signInFlags(flags: GlobalFlags): { service: ServiceName; flag: Flag }[] {
  return SERVICES.flatMap((service) => {
    const flag = service === "qobuz" ? flags.needsSignIn : flags.signIn?.[service];
    return flag === undefined ? [] : [{ service, flag }];
  });
}

export interface GlobalStore {
  load(): GlobalFlags;
  save(flags: GlobalFlags): void;
}

export const RUN_LOG_LIMITS = { lines: 500, days: 90 } as const;
