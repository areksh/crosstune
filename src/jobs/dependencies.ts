/**
 * How jobs depend on each other through playlists: a combined, smart or
 * follow source may read a playlist another job manages. Such a job runs after
 * that one when both are due, two jobs never manage the same playlist, and a
 * chain of sources must not lead back to where it started.
 */

import { playlistIdOf, sourceReads, type Job, type JobState } from "./model.js";

export interface JobWithState {
  job: Job;
  state: JobState;
}

/** The playlist a job manages, as a key ("p:<id>" or "favourites"); undefined before it exists. */
export function managedKey(job: Job, state: Pick<JobState, "playlistId">): string | undefined {
  if (job.target.type === "favourites") {
    return "favourites";
  }
  const id = playlistIdOf(job, state);
  return id === undefined ? undefined : `p:${id}`;
}

/** The keys of what a job's source reads. */
export function readKeys(job: Job): string[] {
  const reads = sourceReads(job.source);
  return [...reads.playlists.map((id) => `p:${id}`), ...(reads.favourites ? ["favourites"] : [])];
}

/**
 * Order jobs so that one reading a playlist comes after the job managing it
 * (when both are in the list); otherwise keep the given order. A cycle (which
 * validation refuses) falls back to the given order.
 */
export function runOrder<T extends JobWithState>(items: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = managedKey(item.job, item.state);
    if (key !== undefined) {
      byKey.set(key, item);
    }
  }
  const out: T[] = [];
  const done = new Set<T>();
  const visiting = new Set<T>();
  const visit = (item: T): void => {
    if (done.has(item) || visiting.has(item)) {
      return;
    }
    visiting.add(item);
    for (const key of readKeys(item.job)) {
      const dependency = byKey.get(key);
      if (dependency !== undefined && dependency !== item) {
        visit(dependency);
      }
    }
    visiting.delete(item);
    done.add(item);
    out.push(item);
  };
  items.forEach(visit);
  return out;
}

/** Why a job cannot be saved alongside the others, or undefined. */
export function conflictWith(candidate: JobWithState, others: readonly JobWithState[]): string | undefined {
  const rest = others.filter((other) => other.job.id !== candidate.job.id);
  const key = managedKey(candidate.job, candidate.state);
  if (key !== undefined) {
    const twin = rest.find((other) => managedKey(other.job, other.state) === key);
    if (twin !== undefined) {
      return key === "favourites"
        ? `the favourites are already managed by "${twin.job.name}"`
        : `that playlist is already managed by "${twin.job.name}"; add to that job instead`;
    }
  }
  if (key !== undefined) {
    const cycle = cycleFrom(candidate, [candidate, ...rest], key);
    if (cycle !== undefined) {
      return `its source would read back its own playlist through ${cycle.map((j) => `"${j.name}"`).join(" -> ")}`;
    }
  }
  return undefined;
}

/** A chain of jobs whose sources lead from `start`'s source back to `targetKey`. */
function cycleFrom(start: JobWithState, all: readonly JobWithState[], targetKey: string): Job[] | undefined {
  const byKey = new Map<string, JobWithState>();
  for (const item of all) {
    const key = managedKey(item.job, item.state);
    if (key !== undefined) {
      byKey.set(key, item);
    }
  }
  const seen = new Set<string>();
  const walk = (item: JobWithState, path: Job[]): Job[] | undefined => {
    for (const key of readKeys(item.job)) {
      if (key === targetKey) {
        return path;
      }
      const next = byKey.get(key);
      if (next !== undefined && !seen.has(key)) {
        seen.add(key);
        const found = walk(next, [...path, next.job]);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  const path = walk(start, []);
  return path === undefined ? undefined : path.length === 0 ? [start.job] : path;
}
