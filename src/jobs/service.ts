/**
 * Managing job definitions: what the CLI's `jobs` commands and the web UI's
 * Managed view do. Definitions are validated on every write; editing a job
 * keeps its state (the playlist, what it owns and what was dismissed), so the
 * next refresh reconciles the playlist to the new recipe.
 */

import { emptyJobState, newJobId, validateJob, type InvalidJob, type Job, type JobState } from "./model.js";
import type { GlobalFlags, GlobalStore, JobStateStore, JobStore, RunLog, RunRecord } from "./stores.js";

export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`No job ${id}`);
    this.name = "UnknownJobError";
  }
}

export interface JobView {
  job: Job;
  state: JobState;
  recentRuns: RunRecord[];
  /** Why the job's state could not be read (it is shown as empty, and skipped). */
  stateError?: string;
}

export interface JobsService {
  list(): { jobs: JobView[]; invalid: InvalidJob[]; flags: GlobalFlags };
  get(id: string): JobView | undefined;
  /** Validate and save a new job; any id or creation time in `input` is replaced. */
  create(input: unknown, now: Date): Job;
  /** Replace a job's definition (keeping its id, creation time and state). */
  update(id: string, input: unknown): Job;
  setEnabled(id: string, enabled: boolean): Job;
  /** Clear a "playlist deleted" pause: the next run creates a new playlist. */
  resume(id: string): JobState;
  /** Forget a job; says which playlist it managed, for the caller to delete. */
  remove(id: string): { job: Job; playlistId?: number };
}

export interface JobsServiceDeps {
  jobs: JobStore;
  state: JobStateStore;
  runs: RunLog;
  global: GlobalStore;
  newId?: () => string;
}

/** Runs shown with each job. */
export const RECENT_RUNS = 10;

function withoutIdentity(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("job must be an object");
  }
  const { id: _id, createdAt: _createdAt, ...rest } = input as Record<string, unknown>;
  return rest;
}

export function jobsService(deps: JobsServiceDeps): JobsService {
  const newId = deps.newId ?? newJobId;
  const load = () => deps.jobs.load();
  const find = (id: string): Job => {
    const job = load().file.jobs.find((candidate) => candidate.id === id);
    if (job === undefined) {
      throw new UnknownJobError(id);
    }
    return job;
  };
  const replace = (job: Job): void => {
    const { file } = load();
    deps.jobs.save({ ...file, jobs: file.jobs.map((existing) => (existing.id === job.id ? job : existing)) });
  };
  const view = (job: Job): JobView => {
    const recentRuns = deps.runs.read(job.id, RECENT_RUNS);
    try {
      return { job, state: deps.state.load(job.id), recentRuns };
    } catch (error) {
      return {
        job,
        state: emptyJobState(),
        recentRuns,
        stateError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    list: () => {
      const { file, invalid } = load();
      return { jobs: file.jobs.map(view), invalid, flags: deps.global.load() };
    },
    get: (id) => {
      const job = load().file.jobs.find((candidate) => candidate.id === id);
      return job === undefined ? undefined : view(job);
    },
    create: (input, now) => {
      const { file } = load();
      let id = newId();
      while (file.jobs.some((job) => job.id === id)) {
        id = newId();
      }
      const job = validateJob({ ...withoutIdentity(input), id, createdAt: now.toISOString() });
      deps.jobs.save({ ...file, jobs: [...file.jobs, job] });
      return job;
    },
    update: (id, input) => {
      const existing = find(id);
      const job = validateJob({ ...withoutIdentity(input), id, createdAt: existing.createdAt });
      replace(job);
      const state = deps.state.load(id);
      const next: JobState = { ...state };
      if (job.edits === "mirror") {
        next.dismissed = [];
      }
      const sameSeeds =
        JSON.stringify(existing.recipe.artists) === JSON.stringify(job.recipe.artists) &&
        JSON.stringify(existing.recipe.similar) === JSON.stringify(job.recipe.similar);
      if (!sameSeeds) {
        delete next.similar;
      }
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        deps.state.save(id, next);
      }
      return job;
    },
    setEnabled: (id, enabled) => {
      const job = { ...find(id), enabled };
      replace(job);
      return job;
    },
    resume: (id) => {
      find(id);
      const state = deps.state.load(id);
      if (state.paused === undefined) {
        return state; // paused by the user only: enabling it is enough
      }
      const next: JobState = { ...state, owned: [] };
      delete next.paused;
      delete next.playlistId;
      delete next.nextRunAt;
      deps.state.save(id, next);
      return next;
    },
    remove: (id) => {
      const job = find(id);
      let playlistId: number | undefined;
      try {
        playlistId = deps.state.load(id).playlistId;
      } catch {
        // An unreadable state still lets the job be removed.
      }
      const { file } = load();
      deps.jobs.save({ ...file, jobs: file.jobs.filter((existing) => existing.id !== id) });
      deps.state.remove(id);
      return { job, ...(playlistId !== undefined && { playlistId }) };
    },
  };
}
