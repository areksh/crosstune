/**
 * Managing job definitions: what the CLI's `jobs` commands and the web UI's
 * Managed view do. Definitions are validated on every write -- each on its own
 * (model.ts) and against the others (one job per playlist, no source chains
 * leading back to themselves; dependencies.ts). Editing a job keeps its state
 * (the playlist, what it owns and what was dismissed) unless what the state
 * describes changed, so the next pass reconciles the playlist to the new
 * definition.
 */

import type { PlaylistId } from "../services/ids.js";
import { conflictWith, type JobWithState } from "./dependencies.js";
import {
  emptyJobState,
  newJobId,
  validateJob,
  type InvalidJob,
  type Job,
  type JobState,
  type SourceDef,
  type SourceState,
  type TidyKind,
} from "./model.js";
import type { GlobalFlags, GlobalStore, JobStateStore, JobStore, RunLog, RunRecord } from "./stores.js";
import { ignoreSuggestions, type SuggestionKeys } from "./suggestions.js";

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
  /** Clear a "playlist deleted" pause: the next run creates a new playlist (or retries an adopted one). */
  resume(id: string): JobState;
  /** Forget suggestions for good. */
  ignore(id: string, keys: SuggestionKeys): JobState;
  /**
   * Forget a job. Says which playlist it created, for the caller to delete if
   * asked -- never one the user's own playlist adopted.
   */
  remove(id: string): { job: Job; playlistId?: PlaylistId };
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What of a source's state still holds after its definition changed. */
function keptSourceState(before: SourceDef | undefined, after: SourceDef | undefined, state: SourceState | undefined): SourceState | undefined {
  if (state === undefined || before === undefined || after === undefined || before.type !== after.type) {
    return undefined;
  }
  const out: SourceState = {};
  switch (after.type) {
    case "new-releases": {
      const old = before as typeof after;
      if (same(old.artists, after.artists) && same(old.similar, after.similar) && state.similar !== undefined) {
        out.similar = state.similar;
      }
      break;
    }
    case "discovery": {
      const old = before as typeof after;
      if (same(old.seeds, after.seeds) && same(old.similar, after.similar) && state.similar !== undefined) {
        out.similar = state.similar;
      }
      if (state.served !== undefined) {
        out.served = state.served;
      }
      // The current rotation is picked again with the new settings.
      break;
    }
    case "follow": {
      const old = before as typeof after;
      if (old.playlistId === after.playlistId && state.seen !== undefined) {
        out.seen = state.seen;
      }
      break;
    }
    default:
      break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A job's state after its definition changed from `before` to `after`. */
function stateAfterEdit(before: Job, after: Job, state: JobState): JobState {
  const sameTarget =
    before.target.type === after.target.type &&
    (after.target.type !== "adopted" ||
      (before.target.type === "adopted" && before.target.playlistId === after.target.playlistId));
  if (!sameTarget) {
    // Another playlist: nothing about the old one applies.
    return { ...emptyJobState(), ...(state.lastResult !== undefined && { lastResult: state.lastResult }) };
  }
  const next: JobState = { ...state, tidy: { ...state.tidy } };
  if (after.edits === "mirror") {
    next.dismissed = [];
  }
  const source = keptSourceState(before.source, after.source, state.source);
  if (source === undefined) {
    delete next.source;
  } else {
    next.source = source;
  }
  // Suggestions of a tidy-up that is gone, or now applies by itself, go.
  const suggesting = (kind: TidyKind) => after.tidy[kind]?.mode === "suggest";
  next.suggestions = state.suggestions.filter((suggestion) => suggesting(suggestion.tidy));
  if (after.tidy.upgrade === undefined) {
    delete next.tidy.upgrade;
  }
  return next;
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
  const stateOf = (id: string): JobState => {
    try {
      return deps.state.load(id);
    } catch {
      return emptyJobState();
    }
  };
  const replace = (job: Job): void => {
    const { file } = load();
    deps.jobs.save({ ...file, jobs: file.jobs.map((existing) => (existing.id === job.id ? job : existing)) });
  };
  const check = (candidate: JobWithState, jobs: readonly Job[]): void => {
    const others = jobs.map((job) => ({ job, state: stateOf(job.id) }));
    const problem = conflictWith(candidate, others);
    if (problem !== undefined) {
      throw new Error(`This job cannot be saved: ${problem}.`);
    }
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
      check({ job, state: emptyJobState() }, file.jobs);
      deps.jobs.save({ ...file, jobs: [...file.jobs, job] });
      return job;
    },
    update: (id, input) => {
      const existing = find(id);
      const job = validateJob({ ...withoutIdentity(input), id, createdAt: existing.createdAt });
      const state = deps.state.load(id);
      const next = stateAfterEdit(existing, job, state);
      check({ job, state: next }, load().file.jobs);
      replace(job);
      if (!same(next, state)) {
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
      const job = find(id);
      const state = deps.state.load(id);
      if (state.paused === undefined) {
        return state; // paused by the user only: enabling it is enough
      }
      const next: JobState =
        job.target.type === "adopted"
          ? { ...state }
          : { ...state, owned: [], substitutions: [], suggestions: [], applied: [] };
      delete next.paused;
      if (job.target.type !== "adopted") {
        delete next.playlistId;
      }
      delete next.nextRunAt;
      deps.state.save(id, next);
      return next;
    },
    ignore: (id, keys) => {
      find(id);
      const next = ignoreSuggestions(deps.state.load(id), keys);
      deps.state.save(id, next);
      return next;
    },
    remove: (id) => {
      const job = find(id);
      let playlistId: PlaylistId | undefined;
      if (job.target.type === "created") {
        try {
          playlistId = deps.state.load(id).playlistId;
        } catch {
          // An unreadable state still lets the job be removed.
        }
      }
      const { file } = load();
      deps.jobs.save({ ...file, jobs: file.jobs.filter((existing) => existing.id !== id) });
      deps.state.remove(id);
      return { job, ...(playlistId !== undefined && { playlistId }) };
    },
  };
}
