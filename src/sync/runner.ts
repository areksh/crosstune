/**
 * Linked playlists on a schedule: `links.json` holds their definitions,
 * `links-state/<id>.json` each one's state. They run beside the managed
 * playlists, under the same lock and into the same run log (ADR-0013).
 */

import type { MatchMemory } from "../features/match.js";
import { capList } from "../jobs/model.js";
import { nextRunAt, retryAt } from "../jobs/schedule.js";
import type { RunRecord } from "../jobs/stores.js";
import type { JobRunReport } from "../jobs/run-due.js";
import type { Schedule } from "../jobs/model.js";
import { readId, SERVICES, type PlaylistId, type ServiceName } from "../services/ids.js";
import type { LinkCopies, LinkState } from "./model.js";
import { syncLink, type SyncClient } from "./run.js";

export interface Link {
  id: string;
  name: string;
  createdAt: string;
  enabled: boolean;
  copies: LinkCopies;
  schedule: Schedule;
}

export interface InvalidLink {
  index: number;
  id?: string;
  error: string;
}

export type LinkConnect = (
  services: readonly ServiceName[],
) => Promise<
  | { ok: true; clients: ReadonlyMap<ServiceName, SyncClient> }
  | { ok: false; reason: "needs-sign-in" | "bundle-broken"; message: string; service?: ServiceName }
>;

export interface LinksDeps {
  links: { load(): { links: Link[]; invalid: InvalidLink[] } };
  state: { load(id: string): LinkState; save(id: string, state: LinkState): void };
  runs: { append(record: RunRecord, now?: Date): void };
  matches: MatchMemory;
  connect: LinkConnect;
  /** `link` is stored on the History entry, so undoing it, however old, pauses that link. */
  journalRun<T>(label: string, fn: (entry: { id: string }) => Promise<T>, link?: string): Promise<T>;
}

export interface LinksSummary {
  reports: JobRunReport[];
  /** Links whose copies disagree, waiting for the user. */
  conflicts: number;
  /** A service that needs a sign-in (or a fix) before its links can run. */
  blocked?: { service: ServiceName; message: string };
}

/** How many of its sync entries a link remembers, to be paused by undoing one. */
const ENTRIES_KEPT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @throws {Error} saying what is wrong. */
export function validateLink(raw: unknown): Link {
  if (!isRecord(raw)) {
    throw new Error("a link must be an object");
  }
  const { id, name, createdAt, copies, schedule } = raw;
  if (typeof id !== "string" || !/^[0-9a-f]{8}$/.test(id)) {
    throw new Error("a link needs an id of 8 hex characters");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
    throw new Error("a link needs a name of 1 to 200 characters");
  }
  if (!isRecord(copies)) {
    throw new Error("copies must name a playlist on each service");
  }
  const out: LinkCopies = {};
  for (const [service, value] of Object.entries(copies)) {
    const playlistId = readId<PlaylistId>(value);
    if (!SERVICES.includes(service as ServiceName) || playlistId === undefined || !playlistId.startsWith(`${service}:`)) {
      throw new Error(`copies.${service} must be a playlist on ${service}`);
    }
    out[service as ServiceName] = playlistId;
  }
  if (Object.keys(out).length < 2) {
    throw new Error("a link joins playlists on two or more services");
  }
  return {
    id,
    name: name.trim(),
    createdAt: typeof createdAt === "string" ? createdAt : "",
    enabled: raw["enabled"] !== false,
    copies: out,
    schedule: readSchedule(schedule),
  };
}

function readSchedule(raw: unknown): Schedule {
  const value = isRecord(raw) ? raw : {};
  const at = typeof value["at"] === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value["at"]) ? value["at"] : "06:00";
  switch (value["every"]) {
    case "hour":
      return { every: "hour" };
    case "week":
      return { every: "week", weekday: Number.isInteger(value["weekday"]) ? (value["weekday"] as number) % 7 : 1, at };
    case "day":
    case undefined:
      return { every: "day", at };
    default:
      throw new Error("schedule.every must be hour, day or week");
  }
}

export function parseLinksFile(raw: unknown): { links: Link[]; invalid: InvalidLink[] } {
  const list = isRecord(raw) && Array.isArray(raw["links"]) ? raw["links"] : [];
  const links: Link[] = [];
  const invalid: InvalidLink[] = [];
  list.forEach((item: unknown, index) => {
    try {
      links.push(validateLink(item));
    } catch (error) {
      const id = isRecord(item) && typeof item["id"] === "string" ? item["id"] : undefined;
      invalid.push({ index, ...(id !== undefined && { id }), error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { links, invalid };
}

function isDue(state: LinkState, now: Date): boolean {
  return state.nextRunAt === undefined || Date.parse(state.nextRunAt) <= now.getTime();
}

/**
 * Whether a history entry was one of a link's syncs (read without the lock):
 * by the link id on the entry, else (older entries) by the link's recent list.
 */
export function isLinkEntry(deps: Pick<LinksDeps, "links" | "state">, entryId: string, linkId?: string): boolean {
  if (linkId !== undefined && deps.links.load().links.some((link) => link.id === linkId)) {
    return true;
  }
  return deps.links.load().links.some((link) => {
    try {
      return (deps.state.load(link.id).entries ?? []).includes(entryId);
    } catch {
      return false;
    }
  });
}

/**
 * A state saver that notes the history entry of a run that writes: its
 * intended writes (`pending`) change only around writes. A run that writes
 * nothing leaves no entry, so the ones that did are not pushed out.
 */
export function savingEntries(
  save: (state: LinkState) => void,
  first: LinkState,
  entryId: string,
): (next: LinkState) => LinkState {
  let previous = first;
  let noted = false;
  return (next) => {
    noted ||= JSON.stringify(next.pending) !== JSON.stringify(previous.pending);
    const entries = next.entries ?? previous.entries ?? [];
    previous = {
      ...next,
      entries: noted && !entries.includes(entryId) ? capList([...entries, entryId], ENTRIES_KEPT) : entries,
    };
    save(previous);
    return previous;
  };
}

function failedResult(now: Date, error: unknown): RunRecord["result"] {
  return {
    at: now.toISOString(),
    status: "failed",
    added: 0,
    removed: 0,
    dismissed: 0,
    notes: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Sync the links that are due (or `onlyLinkId`, due or not; never a paused
 * one). Call under the jobs lock: every write of a link's state holds it.
 */
export async function runLinks(
  deps: LinksDeps,
  now: Date,
  options: { onlyLinkId?: string } = {},
): Promise<LinksSummary> {
  const { links } = deps.links.load();
  const summary: LinksSummary = { reports: [], conflicts: 0 };
  const blocked = new Set<ServiceName>();
  const record = (link: Link, result: RunRecord["result"], started: number): void => {
    deps.runs.append({ at: now.toISOString(), jobId: link.id, jobName: link.name, result, durationMs: Date.now() - started }, now);
    summary.reports.push({ jobId: link.id, name: link.name, result });
  };
  for (const link of links) {
    if (options.onlyLinkId === undefined ? !link.enabled : link.id !== options.onlyLinkId) {
      continue;
    }
    const started = Date.now();
    let state: LinkState;
    try {
      state = deps.state.load(link.id);
    } catch (error) {
      // Not taken as a first link, and the others still run.
      record(link, failedResult(now, error), started);
      continue;
    }
    if (state.paused !== undefined || (options.onlyLinkId === undefined && !isDue(state, now))) {
      continue;
    }
    const services = SERVICES.filter((service) => link.copies[service] !== undefined);
    if (services.some((service) => blocked.has(service))) {
      continue;
    }
    let result: RunRecord["result"];
    try {
      const connected = await deps.connect(services);
      if (!connected.ok) {
        const service = connected.service ?? services[0]!;
        blocked.add(service);
        summary.blocked ??= { service, message: connected.message };
        continue;
      }
      const outcome = await deps.journalRun(`Synced ${link.name}`, async (entry) => {
        const save = savingEntries((next) => deps.state.save(link.id, next), state, entry.id);
        const synced = await syncLink({
          clients: connected.clients,
          copies: link.copies,
          state,
          matches: deps.matches,
          now,
          // Kept as it goes: the intended writes are on disk before the first.
          save: (next) => {
            state = save(next);
          },
        });
        return synced;
      }, link.id);
      state = { ...outcome.state, entries: state.entries ?? outcome.state.entries ?? [] };
      const added = outcome.changes.reduce((sum, change) => sum + change.added, 0);
      const removed = outcome.changes.reduce((sum, change) => sum + change.removed, 0);
      const failed = outcome.status === "failed";
      result = {
        at: now.toISOString(),
        status: outcome.status === "conflict" ? "conflict" : failed ? "failed" : "ok",
        added,
        removed,
        dismissed: 0,
        notes: [
          ...(outcome.state.questions.length > 0 ? [`${outcome.state.questions.length} song(s) wait for an answer`] : []),
          ...(outcome.gaps.length > 0 ? [`${outcome.gaps.length} song(s) missing on a service`] : []),
        ],
        ...(failed && { error: outcome.error ?? "the sync stopped" }),
      };
      if (outcome.status === "conflict") {
        summary.conflicts += 1;
      }
      const failures = failed ? (state.consecutiveFailures ?? 0) + 1 : 0;
      state = {
        ...state,
        consecutiveFailures: failures,
        nextRunAt: (failed ? retryAt(link.schedule, now, failures) : nextRunAt(link.schedule, now)).toISOString(),
      };
    } catch (error) {
      const failures = (state.consecutiveFailures ?? 0) + 1;
      result = failedResult(now, error);
      state = { ...state, consecutiveFailures: failures, nextRunAt: retryAt(link.schedule, now, failures).toISOString() };
    }
    deps.state.save(link.id, state);
    record(link, result, started);
  }
  return summary;
}

/** Pause the links a history entry was a sync of; their ids. */
export function pausedByUndo(deps: Pick<LinksDeps, "links" | "state">, entryId: string, now: Date, linkId?: string): string[] {
  return deps.links.load().links.flatMap((link) => {
    let state: LinkState;
    try {
      state = deps.state.load(link.id);
    } catch {
      return []; // it cannot run either until it is fixed
    }
    if (link.id !== linkId && !(state.entries ?? []).includes(entryId)) {
      return [];
    }
    deps.state.save(link.id, { ...state, paused: { since: now.toISOString(), reason: "undone" } });
    return [link.id];
  });
}
