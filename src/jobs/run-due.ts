/**
 * Run the jobs that are due: the engine both drivers share (`run-due`, for an
 * OS scheduler, and the `serve` ticker).
 *
 * One runner at a time (a lock), one job after another (Qobuz throttles, and
 * the client's retry assumes a single caller). Each job's state and run record
 * are written as soon as it finishes. A rejected session or a broken bundle
 * stops every job until it is fixed, and is remembered in the global flags.
 */

import type { TrackId } from "../services/ids.js";
import { ServiceError } from "../services/model.js";
import { runOrder } from "./dependencies.js";
import type { InvalidJob, Job, JobState, RunResultSummary } from "./model.js";
import { RefreshWriteError, runPass, type RefreshClient } from "./refresh.js";
import { acceptSuggestions, type AcceptResult, type SuggestionKeys } from "./suggestions.js";
import { nextRunAt, retryAt } from "./schedule.js";
import {
  JobsFileError,
  JobStateError,
  type GlobalFlags,
  type GlobalStore,
  type JobStateStore,
  type JobStore,
  type RunLog,
} from "./stores.js";

export type ConnectResult =
  | { ok: true; client: RefreshClient }
  | { ok: false; reason: "needs-sign-in" | "bundle-broken"; message: string };

export type Connect = () => Promise<ConnectResult>;

export interface RunDueDeps {
  jobs: JobStore;
  state: JobStateStore;
  runs: RunLog;
  global: GlobalStore;
  /** Take the runner lock; undefined when another runner holds it. */
  acquireLock: () => { release(): void } | undefined;
  connect: Connect;
  /** Run one refresh as one history entry. */
  journalRun: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** The pass itself (injectable for tests). */
  refresh?: typeof runPass;
}

export interface JobRunReport {
  jobId: string;
  name: string;
  result: RunResultSummary;
}

export interface RunSummary {
  status: "ran" | "busy" | "nothing-due" | "needs-sign-in" | "bundle-broken" | "jobs-file-error";
  reports: JobRunReport[];
  invalid: InvalidJob[];
  message?: string;
}

export interface RunDueOptions {
  dryRun?: boolean;
  /** Run this job now, due or not (and whether enabled or not). */
  onlyJobId?: string;
}

function isDue(job: Job, state: JobState, now: Date): boolean {
  return (
    job.enabled &&
    state.paused === undefined &&
    (state.nextRunAt === undefined || Date.parse(state.nextRunAt) <= now.getTime())
  );
}

export async function runDue(
  deps: RunDueDeps,
  now: Date,
  options: RunDueOptions = {},
): Promise<RunSummary> {
  const lock = deps.acquireLock();
  if (lock === undefined) {
    return { status: "busy", reports: [], invalid: [], message: "Another qobuz-helper is running jobs." };
  }
  try {
    return await runLocked(deps, now, options);
  } finally {
    lock.release();
  }
}

async function runLocked(deps: RunDueDeps, now: Date, options: RunDueOptions): Promise<RunSummary> {
  let loaded: ReturnType<JobStore["load"]>;
  try {
    loaded = deps.jobs.load();
  } catch (error) {
    if (error instanceof JobsFileError) {
      return { status: "jobs-file-error", reports: [], invalid: [], message: error.message };
    }
    throw error;
  }
  const { file } = loaded;
  const invalid = [...loaded.invalid];
  // A job whose state cannot be read is reported and skipped, never started
  // over (that would make a second playlist).
  const withState = (job: Job): { job: Job; state: JobState }[] => {
    try {
      return [{ job, state: deps.state.load(job.id) }];
    } catch (error) {
      if (!(error instanceof JobStateError)) {
        throw error;
      }
      invalid.push({ index: file.jobs.indexOf(job), id: job.id, error: error.message });
      return [];
    }
  };

  let due: { job: Job; state: JobState }[];
  if (options.onlyJobId !== undefined) {
    const job = file.jobs.find((candidate) => candidate.id === options.onlyJobId);
    if (job === undefined) {
      throw new Error(`No job ${options.onlyJobId}`);
    }
    due = withState(job);
  } else {
    due = runOrder(
      file.jobs
        .flatMap(withState)
        .filter(({ job, state }) => isDue(job, state, now))
        .sort((a, b) => (a.state.nextRunAt ?? "").localeCompare(b.state.nextRunAt ?? "")),
    );
  }
  if (due.length === 0) {
    return { status: "nothing-due", reports: [], invalid };
  }

  const connected = await deps.connect();
  const flags = deps.global.load();
  if (!connected.ok) {
    const key = connected.reason === "needs-sign-in" ? "needsSignIn" : "bundleBroken";
    if (options.dryRun !== true) {
      deps.global.save({
        ...flags,
        [key]: { since: flags[key]?.since ?? now.toISOString(), message: connected.message },
      });
    }
    return { status: connected.reason, reports: [], invalid, message: connected.message };
  }
  if ((flags.needsSignIn !== undefined || flags.bundleBroken !== undefined) && options.dryRun !== true) {
    deps.global.save({});
  }

  const refresh = deps.refresh ?? runPass;
  const reports: JobRunReport[] = [];
  for (const { job, state } of due) {
    const started = Date.now();
    let next: JobState;
    let result: RunResultSummary;
    try {
      const favouriteDates = favouriteDatesOf(deps, file.jobs, job);
      const outcome = await deps.journalRun(`Managed: ${job.name}`, () =>
        refresh(connected.client, job, state, {
          now,
          ...(options.dryRun === true && { dryRun: true }),
          ...(favouriteDates !== undefined && { favouriteDates }),
        }),
      );
      result = outcome.result;
      next = {
        ...outcome.state,
        consecutiveFailures: 0,
        nextRunAt: nextRunAt(job.schedule, now).toISOString(),
      };
    } catch (error) {
      // A refresh that failed mid-write carries the state to keep.
      const cause = error instanceof RefreshWriteError ? error.cause : error;
      const base = error instanceof RefreshWriteError ? error.state : state;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof ServiceError && cause.kind === "authentication") {
        // Not this job's fault: count nothing, and stop until signed in again.
        if (options.dryRun !== true) {
          if (base !== state) {
            deps.state.save(job.id, base);
          }
          const signedOut: GlobalFlags = {
            ...deps.global.load(),
            needsSignIn: { since: now.toISOString(), message },
          };
          deps.global.save(signedOut);
        }
        return { status: "needs-sign-in", reports, invalid, message };
      }
      const failures = base.consecutiveFailures + 1;
      result = {
        at: now.toISOString(),
        status: "failed",
        added: 0,
        removed: 0,
        dismissed: 0,
        notes: [],
        error: message,
      };
      next = {
        ...base,
        consecutiveFailures: failures,
        nextRunAt: retryAt(job.schedule, now, failures).toISOString(),
        lastRunAt: now.toISOString(),
        lastResult: result,
      };
    }
    reports.push({ jobId: job.id, name: job.name, result });
    if (options.dryRun !== true) {
      deps.state.save(job.id, next);
      deps.runs.append(
        { at: now.toISOString(), jobId: job.id, jobName: job.name, result, durationMs: Date.now() - started },
        now,
      );
    }
  }
  return { status: "ran", reports, invalid };
}

/**
 * The favourites job's carried-over dates (see JobState.favouriteDates), read
 * fresh before each job so a favourites tidy-up earlier in the same run counts.
 */
function favouriteDatesOf(
  deps: Pick<RunDueDeps, "state">,
  jobs: readonly Job[],
  running: Job,
): ReadonlyMap<TrackId, string> | undefined {
  const favourites = jobs.find((job) => job.target.type === "favourites");
  if (favourites === undefined || favourites.id === running.id) {
    return undefined;
  }
  try {
    const dates = deps.state.load(favourites.id).favouriteDates ?? [];
    return dates.length === 0 ? undefined : new Map(dates.map((entry) => [entry.trackId, entry.at]));
  } catch {
    return undefined;
  }
}

export type AcceptOutcome =
  | ({ status: "accepted" } & Omit<AcceptResult, "state">)
  | { status: "busy" | "needs-sign-in" | "bundle-broken"; message: string };

/**
 * Accept suggestions of one job now: under the runner lock (another run may be
 * writing the same playlist), as one history entry, saving the job's state.
 */
export async function acceptNow(
  deps: RunDueDeps,
  jobId: string,
  keys: SuggestionKeys,
  now: Date,
): Promise<AcceptOutcome> {
  const lock = deps.acquireLock();
  if (lock === undefined) {
    return { status: "busy", message: "Another qobuz-helper is running jobs." };
  }
  try {
    const job = deps.jobs.load().file.jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) {
      throw new Error(`No job ${jobId}`);
    }
    const state = deps.state.load(jobId);
    const connected = await deps.connect();
    if (!connected.ok) {
      return { status: connected.reason, message: connected.message };
    }
    const result = await deps.journalRun(`Managed: ${job.name} (accepted)`, () =>
      acceptSuggestions(connected.client, job, state, keys, now),
    );
    deps.state.save(jobId, result.state);
    const { state: _state, ...rest } = result;
    return { status: "accepted", ...rest };
  } finally {
    lock.release();
  }
}
