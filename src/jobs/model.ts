/**
 * Jobs: what qobuz-helper runs on a schedule, unattended (see ADR-0007).
 *
 * A job's *definition* lives in `jobs.json` and is written only by the CLI and
 * the web UI; its *state* (`jobs-state/<id>.json`) is written only by the
 * runner. This module holds both shapes, their defaults and their validation:
 * every definition is checked on load, so a hand edit that breaks one job is
 * reported and the others still run.
 */

import { randomUUID } from "node:crypto";

import { RELEASE_TYPES, type ReleaseType } from "../qobuz/index.js";
import {
  DEFAULT_NEW_RELEASE_INCLUDE,
  isIsoDate,
  type ReleaseWindow,
} from "../features/new-releases.js";
import type { TrackFilterSpec } from "../features/track-filter.js";

export type Schedule =
  | { every: "hour" }
  | { every: "day"; at: string }
  | { every: "week"; weekday: number; at: string };

export type { ReleaseWindow };

export interface ArtistRef {
  id: number;
  name: string;
}

export type FeedArtists =
  | { type: "list"; artists: ArtistRef[] }
  | { type: "favourites" }
  | { type: "playlist"; playlistId: number };

export interface NewReleasesRecipeDef {
  type: "new-releases";
  artists: FeedArtists;
  /** Also each artist's top similar artists, snapshotted every `refreshDays`. */
  similar?: { perArtist: number; refreshDays: number };
  window: ReleaseWindow;
  include: ReleaseType[];
  /** Leave out releases already among the favourite albums (default false). */
  hideFavourites: boolean;
  exclude?: TrackFilterSpec;
}

export interface Shape {
  maxReleases?: number;
  maxTracks?: number;
  maxMinutes?: number;
}

export type EditMode = "respect" | "mirror";

export interface ManagedPlaylistJob {
  id: string;
  name: string;
  createdAt: string;
  enabled: boolean;
  schedule: Schedule;
  kind: "managed-playlist";
  isPublic: boolean;
  edits: EditMode;
  recipe: NewReleasesRecipeDef;
  shape?: Shape;
}

export type Job = ManagedPlaylistJob;

export interface JobsFile {
  version: 1;
  jobs: Job[];
}

export interface InvalidJob {
  index: number;
  id?: string;
  error: string;
}

export interface OwnedEntry {
  playlistTrackId: number;
  trackId: number;
}

export interface RunResultSummary {
  at: string;
  status: "ok" | "partial" | "failed" | "paused";
  added: number;
  removed: number;
  dismissed: number;
  notes: string[];
  error?: string;
}

export interface JobState {
  version: 1;
  /** The managed playlist, once the first run has created it. */
  playlistId?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  consecutiveFailures: number;
  paused?: { reason: "playlist-deleted"; since: string };
  /** Entries this job added and that are still in the playlist. */
  owned: OwnedEntry[];
  /** Tracks the user took out; never added again (respect mode). */
  dismissed: number[];
  /**
   * What a refresh that failed part-way was writing: playlist-track ids it was
   * removing and track ids it was adding. The next refresh settles them (see
   * settlePending), so a half-done write is neither mistaken for the user's
   * edits nor left unowned.
   */
  pending?: { removed: number[]; added: number[] };
  similar?: { takenAt: string; artists: ArtistRef[] };
  lastResult?: RunResultSummary;
}

export const DEFAULT_AT = "06:00";
export const DEFAULT_WEEKDAY = 1;

export function newJobId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function emptyJobState(): JobState {
  return { version: 1, consecutiveFailures: 0, owned: [], dismissed: [] };
}

// --- validation -------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Raw {
  if (!isRecord(value)) {
    throw new Error(`${what} must be an object`);
  }
  return value;
}

function integer(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${what} must be true or false`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, what: string, options: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new Error(`${what} must be one of ${options.join(", ")}`);
  }
  return value as T;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function time(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_AT;
  }
  if (typeof value !== "string" || !TIME.test(value)) {
    throw new Error("schedule.at must be a time written HH:MM");
  }
  return value;
}

function schedule(raw: unknown): Schedule {
  const value = record(raw, "schedule");
  const every = oneOf(value["every"], "schedule.every", ["hour", "day", "week"] as const);
  if (every === "hour") {
    return { every };
  }
  if (every === "day") {
    return { every, at: time(value["at"]) };
  }
  return {
    every,
    weekday:
      value["weekday"] === undefined
        ? DEFAULT_WEEKDAY
        : integer(value["weekday"], "schedule.weekday", 0, 6),
    at: time(value["at"]),
  };
}

function releaseWindow(raw: unknown): ReleaseWindow {
  const value = record(raw, "recipe.window");
  switch (value["type"]) {
    case "last-days":
      return { type: "last-days", days: integer(value["days"], "window days", 1, 3650) };
    case "since": {
      const date = value["date"];
      if (typeof date !== "string" || !isIsoDate(date)) {
        throw new Error("window date must be a date written YYYY-MM-DD");
      }
      return { type: "since", date };
    }
    case "latest-per-artist":
      return {
        type: "latest-per-artist",
        count: integer(value["count"], "window count", 1, 50),
      };
    default:
      throw new Error("recipe.window type must be last-days, since or latest-per-artist");
  }
}

function artistRef(raw: unknown): ArtistRef {
  const value = record(raw, "artist");
  const name = value["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("each artist needs a name");
  }
  return { id: integer(value["id"], "artist id", 1, Number.MAX_SAFE_INTEGER), name };
}

function feedArtists(raw: unknown): FeedArtists {
  const value = record(raw, "recipe.artists");
  switch (value["type"]) {
    case "list": {
      const list = value["artists"];
      if (!Array.isArray(list) || list.length === 0 || list.length > 500) {
        throw new Error("recipe.artists must list from 1 to 500 artists");
      }
      return { type: "list", artists: list.map(artistRef) };
    }
    case "favourites":
      return { type: "favourites" };
    case "playlist":
      return {
        type: "playlist",
        playlistId: integer(value["playlistId"], "recipe.artists playlistId", 1, Number.MAX_SAFE_INTEGER),
      };
    default:
      throw new Error("recipe.artists type must be list, favourites or playlist");
  }
}

function terms(value: unknown, what: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((term) => typeof term === "string")) {
    throw new Error(`${what} must be a list of words`);
  }
  return value as string[];
}

function exclude(raw: unknown): TrackFilterSpec | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = record(raw, "recipe.exclude");
  const tracks = terms(value["excludeTracks"], "exclude excludeTracks");
  const albums = terms(value["excludeAlbums"], "exclude excludeAlbums");
  const artists = terms(value["excludeArtists"], "exclude excludeArtists");
  return {
    ...(tracks !== undefined && { excludeTracks: tracks }),
    ...(albums !== undefined && { excludeAlbums: albums }),
    ...(artists !== undefined && { excludeArtists: artists }),
  };
}

function recipe(raw: unknown): NewReleasesRecipeDef {
  const value = record(raw, "recipe");
  if (value["type"] !== "new-releases") {
    throw new Error("recipe type must be new-releases");
  }
  const include =
    value["include"] === undefined ? [...DEFAULT_NEW_RELEASE_INCLUDE] : value["include"];
  if (
    !Array.isArray(include) ||
    include.length === 0 ||
    !include.every((kind) => (RELEASE_TYPES as readonly unknown[]).includes(kind))
  ) {
    throw new Error(`recipe.include must list kinds of release from ${RELEASE_TYPES.join(", ")}`);
  }
  const def: NewReleasesRecipeDef = {
    type: "new-releases",
    artists: feedArtists(value["artists"]),
    window: releaseWindow(value["window"]),
    include: [...new Set(include as ReleaseType[])],
    hideFavourites: optionalBoolean(value["hideFavourites"], "recipe.hideFavourites", false),
  };
  if (value["similar"] !== undefined) {
    const similar = record(value["similar"], "recipe.similar");
    def.similar = {
      perArtist: integer(similar["perArtist"], "similar perArtist", 1, 20),
      refreshDays:
        similar["refreshDays"] === undefined
          ? 30
          : integer(similar["refreshDays"], "similar refreshDays", 1, 365),
    };
  }
  const excluded = exclude(value["exclude"]);
  if (excluded !== undefined) {
    def.exclude = excluded;
  }
  return def;
}

function shape(raw: unknown): Shape | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = record(raw, "shape");
  const out: Shape = {};
  for (const key of ["maxReleases", "maxTracks", "maxMinutes"] as const) {
    if (value[key] !== undefined) {
      out[key] = integer(value[key], key, 1, 100_000);
    }
  }
  return out;
}

/** Check a job definition and fill its defaults; throws a readable Error. */
export function validateJob(raw: unknown): Job {
  const value = record(raw, "job");
  const id = value["id"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}$/.test(id)) {
    throw new Error("job id must be 8 hex characters");
  }
  const name = typeof value["name"] === "string" ? value["name"].trim() : "";
  if (name.length === 0 || name.length > 200) {
    throw new Error("job name must be 1 to 200 characters");
  }
  const createdAt = value["createdAt"];
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("job createdAt must be a timestamp");
  }
  if (value["kind"] !== "managed-playlist") {
    throw new Error("job kind must be managed-playlist");
  }
  const job: Job = {
    id,
    name,
    createdAt,
    enabled: optionalBoolean(value["enabled"], "enabled", true),
    kind: "managed-playlist",
    isPublic: optionalBoolean(value["isPublic"], "isPublic", false),
    edits: oneOf(value["edits"], "edits", ["respect", "mirror"] as const, "respect"),
    schedule: schedule(value["schedule"]),
    recipe: recipe(value["recipe"]),
  };
  const shaped = shape(value["shape"]);
  if (shaped !== undefined) {
    job.shape = shaped;
  }
  return job;
}

/**
 * Read a parsed `jobs.json`: valid jobs, and the invalid ones by index.
 *
 * @throws {Error} if it is not a version 1 jobs file at all.
 */
export function parseJobsFile(raw: unknown): { file: JobsFile; invalid: InvalidJob[] } {
  const value = record(raw, "jobs file");
  if (value["version"] !== 1) {
    throw new Error(`unsupported jobs file version ${String(value["version"])}`);
  }
  const list = value["jobs"];
  if (!Array.isArray(list)) {
    throw new Error("jobs file has no jobs list");
  }
  const jobs: Job[] = [];
  const invalid: InvalidJob[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, index) => {
    const id = isRecord(entry) && typeof entry["id"] === "string" ? entry["id"] : undefined;
    try {
      const job = validateJob(entry);
      if (seen.has(job.id)) {
        throw new Error(`job id ${job.id} is repeated`);
      }
      seen.add(job.id);
      jobs.push(job);
    } catch (error) {
      invalid.push({
        index,
        ...(id !== undefined && { id }),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { file: { version: 1, jobs }, invalid };
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${what} must be a string`);
  }
  return value;
}

function ownedEntry(raw: unknown): OwnedEntry {
  const value = record(raw, "owned entry");
  return {
    playlistTrackId: integer(value["playlistTrackId"], "playlistTrackId", 0, Number.MAX_SAFE_INTEGER),
    trackId: integer(value["trackId"], "trackId", 0, Number.MAX_SAFE_INTEGER),
  };
}

function resultSummary(raw: unknown): RunResultSummary {
  const value = record(raw, "lastResult");
  const count = (key: string): number => integer(value[key], key, 0, Number.MAX_SAFE_INTEGER);
  const notes = terms(value["notes"], "notes") ?? [];
  const error = optionalString(value["error"], "error");
  return {
    at: optionalString(value["at"], "at") ?? "",
    status: oneOf(value["status"], "status", ["ok", "partial", "failed", "paused"] as const),
    added: count("added"),
    removed: count("removed"),
    dismissed: count("dismissed"),
    notes,
    ...(error !== undefined && { error }),
  };
}

/** Read a parsed job state file; throws on anything but a valid version 1 state. */
export function parseJobState(raw: unknown): JobState {
  const value = record(raw, "job state");
  if (value["version"] !== 1) {
    throw new Error(`unsupported job state version ${String(value["version"])}`);
  }
  const state = emptyJobState();
  if (value["playlistId"] !== undefined) {
    state.playlistId = integer(value["playlistId"], "playlistId", 1, Number.MAX_SAFE_INTEGER);
  }
  const lastRunAt = optionalString(value["lastRunAt"], "lastRunAt");
  if (lastRunAt !== undefined) {
    state.lastRunAt = lastRunAt;
  }
  const nextRunAt = optionalString(value["nextRunAt"], "nextRunAt");
  if (nextRunAt !== undefined) {
    state.nextRunAt = nextRunAt;
  }
  state.consecutiveFailures = integer(value["consecutiveFailures"] ?? 0, "consecutiveFailures", 0, 1_000_000);
  if (value["paused"] !== undefined) {
    const paused = record(value["paused"], "paused");
    state.paused = {
      reason: oneOf(paused["reason"], "paused reason", ["playlist-deleted"] as const),
      since: optionalString(paused["since"], "paused since") ?? "",
    };
  }
  state.owned = Array.isArray(value["owned"]) ? value["owned"].map(ownedEntry) : [];
  state.dismissed = Array.isArray(value["dismissed"])
    ? value["dismissed"].map((id) => integer(id, "dismissed track", 0, Number.MAX_SAFE_INTEGER))
    : [];
  if (value["pending"] !== undefined) {
    const pending = record(value["pending"], "pending");
    const ids = (raw: unknown, what: string): number[] =>
      Array.isArray(raw) ? raw.map((id) => integer(id, what, 0, Number.MAX_SAFE_INTEGER)) : [];
    state.pending = {
      removed: ids(pending["removed"], "pending removal"),
      added: ids(pending["added"], "pending addition"),
    };
  }
  if (value["similar"] !== undefined) {
    const similar = record(value["similar"], "similar");
    state.similar = {
      takenAt: optionalString(similar["takenAt"], "similar takenAt") ?? "",
      // Skip an unusable artist rather than lose the whole state over it.
      artists: Array.isArray(similar["artists"])
        ? similar["artists"].flatMap((raw: unknown) => {
            try {
              return [artistRef(raw)];
            } catch {
              return [];
            }
          })
        : [],
    };
  }
  if (value["lastResult"] !== undefined) {
    state.lastResult = resultSummary(value["lastResult"]);
  }
  return state;
}
