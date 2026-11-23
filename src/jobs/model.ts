/**
 * Jobs: what qobuz-helper runs on a schedule, unattended (see ADR-0007 and
 * ADR-0008).
 *
 * A job is *a playlist and what manages it*: its target (a playlist the job
 * created, one of the user's own, or the favourites), an optional source that
 * keeps it current, and tidy-ups (dedupe, upgrade, repair) that keep it clean.
 *
 * A job's *definition* lives in `jobs.json` and is written only by the CLI and
 * the web UI; its *state* (`jobs-state/<id>.json`) is written only by the
 * runner. This module holds both shapes, their defaults and their validation:
 * every definition is checked on load, so a hand edit that breaks one job is
 * reported and the others still run. Version 1 files (one kind of job, the new
 * releases feed) and version 2 files (ids without their service) are read into
 * the version 3 shape; reading never rewrites.
 */

import {
  readId,
  type AnyId,
  type ArtistId,
  type EntryId,
  type PlaylistId,
  type TrackId,
} from "../services/ids.js";
import { randomUUID } from "node:crypto";

import { RELEASE_TYPES, type ReleaseType } from "../services/model.js";
import {
  COMBINE_KEEPS,
  COMBINE_MODES,
  COMBINE_ORDERS,
  type CombineKeep,
  type CombineMode,
  type CombineOrder,
  type CombineSource,
} from "../features/combine.js";
import { KEEP_STRATEGIES, type KeepStrategy } from "../features/deduplicate.js";
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
  id: ArtistId;
  name: string;
}

export type FeedArtists =
  | { type: "list"; artists: ArtistRef[] }
  | { type: "favourites" }
  | { type: "playlist"; playlistId: PlaylistId };

/** Similar artists, snapshotted every `refreshDays`. */
export interface SimilarSpec {
  perArtist: number;
  refreshDays: number;
}

// --- sources -----------------------------------------------------------------

export interface NewReleasesSource {
  type: "new-releases";
  artists: FeedArtists;
  /** Also each artist's top similar artists, snapshotted every `refreshDays`. */
  similar?: SimilarSpec;
  window: ReleaseWindow;
  include: ReleaseType[];
  /** Leave out releases already among the favourite albums (default false). */
  hideFavourites: boolean;
  exclude?: TrackFilterSpec;
}

/** @deprecated the v1 name; a new releases feed is now one kind of source. */
export type NewReleasesRecipeDef = NewReleasesSource;

/** A playlist (any readable id) or the favourites, as an input to a source. */
export type PlaylistInput = CombineSource;

export interface CombinedSource {
  type: "combined";
  inputs: PlaylistInput[];
  mode: CombineMode;
  keep: CombineKeep;
  order: CombineOrder;
  /** Treat ISRC / artist+title matches as the same song (default true). */
  matchSongs: boolean;
  exclude?: TrackFilterSpec;
}

export interface FollowSource {
  type: "follow";
  playlistId: PlaylistId;
  /** Archive: keep every track the playlist ever had (default false). */
  keepRemoved: boolean;
}

export type SmartRule =
  | { type: "quality"; quality: "hires" | "cd" }
  | { type: "decades"; decades: string[] }
  | { type: "genres"; genres: string[] }
  | { type: "favourited-within"; days: number }
  | { type: "artists"; include?: ArtistRef[]; exclude?: ArtistRef[] }
  | { type: "duration"; minSeconds?: number; maxSeconds?: number };

export const SMART_ORDERS = [
  "as-listed",
  "newest-favourited",
  "newest-release",
  "by-artist",
  "shuffle",
] as const;
export type SmartOrder = (typeof SMART_ORDERS)[number];

export interface SmartSource {
  type: "smart";
  from: PlaylistInput[];
  /** All must hold. */
  rules: SmartRule[];
  order: SmartOrder;
}

export interface DiscoverySource {
  type: "discovery";
  seeds: FeedArtists;
  similar: SimilarSpec;
  artistsPerRotation: number;
  tracksPerArtist: number;
  rotation: "day" | "week";
  /** Rotations a served track stays out for. */
  avoidRepeatsFor: number;
  skipFavouriteTracks: boolean;
  exclude?: TrackFilterSpec;
}

export type SourceDef =
  | NewReleasesSource
  | CombinedSource
  | FollowSource
  | SmartSource
  | DiscoverySource;

export type SourceType = SourceDef["type"];
export const SOURCE_TYPES: readonly SourceType[] = [
  "new-releases",
  "combined",
  "follow",
  "smart",
  "discovery",
];

// --- tidy-ups ----------------------------------------------------------------

export const CADENCES = ["every-pass", "weekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

export type TidyMode = "apply" | "suggest";

export interface TidyBase {
  cadence: Cadence;
  mode: TidyMode;
}

export interface DedupeTidy extends TidyBase {
  keep: KeepStrategy[];
}

export interface UpgradeTidy extends TidyBase {
  allowSignatureMatch: boolean;
  maxSearches: number;
}

export interface RepairTidy extends TidyBase {
  action: "replace" | "remove";
}

export interface TidySet {
  dedupe?: DedupeTidy;
  upgrade?: UpgradeTidy;
  repair?: RepairTidy;
}

export type TidyKind = keyof TidySet;
/** The order tidy-ups run in: repairs first, dedupe last (it sees the replacements). */
export const TIDY_ORDER: readonly TidyKind[] = ["repair", "upgrade", "dedupe"];

export const DEFAULT_TIDY = {
  dedupe: { cadence: "every-pass", mode: "apply", keep: ["highest-quality", "first-added"] },
  upgrade: { cadence: "monthly", mode: "apply", allowSignatureMatch: false, maxSearches: 200 },
  repair: { cadence: "weekly", mode: "apply", action: "replace" },
} as const satisfies { [K in TidyKind]: Required<TidySet>[K] };

// --- the job -----------------------------------------------------------------

export type Target =
  | { type: "created"; isPublic: boolean }
  | { type: "adopted"; playlistId: PlaylistId }
  | { type: "favourites" };

export interface Shape {
  maxReleases?: number;
  maxTracks?: number;
  maxMinutes?: number;
}

export type EditMode = "respect" | "mirror";

export interface PlaylistJob {
  id: string;
  name: string;
  createdAt: string;
  enabled: boolean;
  schedule: Schedule;
  kind: "playlist";
  target: Target;
  edits: EditMode;
  source?: SourceDef;
  shape?: Shape;
  tidy: TidySet;
}

/** @deprecated the v1 name. */
export type ManagedPlaylistJob = PlaylistJob;

export type Job = PlaylistJob;

export interface JobsFile {
  version: 3;
  jobs: Job[];
}

export interface InvalidJob {
  index: number;
  id?: string;
  error: string;
}

// --- state -------------------------------------------------------------------

export interface OwnedEntry {
  playlistTrackId: EntryId;
  trackId: TrackId;
}

export interface RunResultSummary {
  at: string;
  status: "ok" | "partial" | "failed" | "paused";
  added: number;
  removed: number;
  dismissed: number;
  /** Tracks a tidy-up replaced (upgrades, repairs). */
  replaced?: number;
  /** Tracks a tidy-up removed (duplicates, unplayable). */
  tidyRemoved?: number;
  /** Findings left as suggestions. */
  suggested?: number;
  notes: string[];
  error?: string;
}

/** Desired track `from` is satisfied by present track `to` (absent: left out). */
export interface Substitution {
  from: TrackId;
  to?: TrackId;
  /** The finding that made it, ignored if the user puts `from` back. */
  key: string;
}

/** A change a tidy-up wants to write (now, or once a suggestion is accepted). */
export type TidyChange =
  | { type: "replace"; trackId: TrackId; newTrackId: TrackId; playlistTrackId?: EntryId }
  | { type: "remove"; trackId: TrackId; playlistTrackId?: EntryId }
  | {
      type: "dedupe";
      keepTrackId: TrackId;
      remove: { trackId: TrackId; playlistTrackId?: EntryId }[];
    };

export interface Finding {
  /** Stable across passes: "repair:A", "upgrade:A>B", "dedupe:<ids>". */
  key: string;
  tidy: TidyKind;
  summary: string;
  change: TidyChange;
}

export interface Suggestion extends Finding {
  foundAt: string;
}

export interface TidyState {
  dedupe?: { lastRunAt: string };
  upgrade?: { lastRunAt: string; checked: { trackId: TrackId; at: string }[] };
  repair?: { lastRunAt: string };
}

export interface RotationState {
  number: number;
  artistIds: ArtistId[];
  tracks: { trackId: TrackId; source: string; durationSeconds?: number }[];
}

export interface SourceState {
  similar?: { takenAt: string; artists: ArtistRef[] };
  /** Archive: every track id seen, in first-seen order. */
  seen?: TrackId[];
  /** Discovery: the current rotation's picks. */
  rotation?: RotationState;
  /** Discovery: what earlier rotations served, newest last. */
  served?: { rotation: number; trackIds: TrackId[] }[];
}

export interface JobState {
  version: 3;
  /** The playlist a `created` target made on its first pass. */
  playlistId?: PlaylistId;
  lastRunAt?: string;
  nextRunAt?: string;
  consecutiveFailures: number;
  paused?: { reason: "playlist-deleted"; since: string };
  /** Entries this job added and that are still in the playlist. */
  owned: OwnedEntry[];
  /** Tracks the user took out; never added again (respect mode). */
  dismissed: TrackId[];
  /**
   * What a pass that failed part-way was writing: playlist-track ids it was
   * removing and track ids it was adding. The next pass settles them (see
   * settlePending), so a half-done write is neither mistaken for the user's
   * edits nor left unowned.
   */
  pending?: { removed: EntryId[]; added: TrackId[] };
  substitutions: Substitution[];
  tidy: TidyState;
  /** Finding keys applied without a substitution (exact duplicates, favourites). */
  applied: string[];
  suggestions: Suggestion[];
  /** Finding keys never to apply or suggest again. */
  ignored: string[];
  source?: SourceState;
  /**
   * Favourites only: the original "favourited" date of tracks a tidy-up put in
   * place of others (Qobuz dates the new copy today). Sources reading the
   * favourites and dedupe's first/last-added use these.
   */
  favouriteDates?: { trackId: TrackId; at: string }[];
  lastResult?: RunResultSummary;
}

/** How many entries the long state lists keep (oldest dropped first). */
export const STATE_LIST_CAP = 2_000;
export const CHECKED_CAP = 5_000;

export const DEFAULT_AT = "06:00";
export const DEFAULT_WEEKDAY = 1;

export function newJobId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function emptyJobState(): JobState {
  return {
    version: 3,
    consecutiveFailures: 0,
    owned: [],
    dismissed: [],
    substitutions: [],
    tidy: {},
    applied: [],
    suggestions: [],
    ignored: [],
  };
}

/** The managed playlist's id, once known (favourites have none). */
export function playlistIdOf(job: Job, state: Pick<JobState, "playlistId">): PlaylistId | undefined {
  return job.target.type === "adopted" ? job.target.playlistId : job.target.type === "created" ? state.playlistId : undefined;
}

/** Keep the newest `cap` items of a list. */
export function capList<T>(items: readonly T[], cap: number): T[] {
  return items.length <= cap ? [...items] : items.slice(items.length - cap);
}

/** What a source reads: playlist ids and whether it reads the favourite tracks. */
export function sourceReads(source: SourceDef | undefined): { playlists: PlaylistId[]; favourites: boolean } {
  if (source === undefined) {
    return { playlists: [], favourites: false };
  }
  const fromInputs = (inputs: readonly PlaylistInput[]) => ({
    playlists: inputs.flatMap((input) => (input.type === "playlist" ? [input.playlistId] : [])),
    favourites: inputs.some((input) => input.type === "favourites"),
  });
  switch (source.type) {
    case "combined":
      return fromInputs(source.inputs);
    case "smart":
      return fromInputs(source.from);
    case "follow":
      return { playlists: [source.playlistId], favourites: false };
    case "new-releases":
      return { playlists: source.artists.type === "playlist" ? [source.artists.playlistId] : [], favourites: false };
    case "discovery":
      return {
        playlists: source.seeds.type === "playlist" ? [source.seeds.playlistId] : [],
        favourites: source.skipFavouriteTracks,
      };
  }
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

/** An id, tagged or (before version 3) a bare one of Qobuz's. */
function idOf<T extends AnyId>(value: unknown, what: string): T {
  const id = readId<T>(value);
  if (id === undefined) {
    throw new Error(`${what} must be an id`);
  }
  return id;
}

function optionalInteger(value: unknown, what: string, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : integer(value, what, min, max);
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

const ID_MAX = Number.MAX_SAFE_INTEGER;
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
    weekday: optionalInteger(value["weekday"], "schedule.weekday", 0, 6, DEFAULT_WEEKDAY),
    at: time(value["at"]),
  };
}

function releaseWindow(raw: unknown): ReleaseWindow {
  const value = record(raw, "source.window");
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
      throw new Error("source.window type must be last-days, since or latest-per-artist");
  }
}

function artistRef(raw: unknown): ArtistRef {
  const value = record(raw, "artist");
  const name = value["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("each artist needs a name");
  }
  return { id: idOf<ArtistId>(value["id"], "artist id"), name };
}

function artistList(raw: unknown, what: string, min: number): ArtistRef[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > 500) {
    throw new Error(`${what} must list from ${min} to 500 artists`);
  }
  return raw.map(artistRef);
}

function feedArtists(raw: unknown, what: string): FeedArtists {
  const value = record(raw, what);
  switch (value["type"]) {
    case "list":
      return { type: "list", artists: artistList(value["artists"], what, 1) };
    case "favourites":
      return { type: "favourites" };
    case "playlist":
      return { type: "playlist", playlistId: idOf<PlaylistId>(value["playlistId"], `${what} playlistId`) };
    default:
      throw new Error(`${what} type must be list, favourites or playlist`);
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
  const value = record(raw, "source.exclude");
  const tracks = terms(value["excludeTracks"], "exclude excludeTracks");
  const albums = terms(value["excludeAlbums"], "exclude excludeAlbums");
  const artists = terms(value["excludeArtists"], "exclude excludeArtists");
  return {
    ...(tracks !== undefined && { excludeTracks: tracks }),
    ...(albums !== undefined && { excludeAlbums: albums }),
    ...(artists !== undefined && { excludeArtists: artists }),
  };
}

function withExclude<T extends object>(def: T, raw: Raw): T & { exclude?: TrackFilterSpec } {
  const excluded = exclude(raw["exclude"]);
  return excluded === undefined ? def : { ...def, exclude: excluded };
}

function similarSpec(raw: unknown, what: string, fallbackPerArtist?: number): SimilarSpec {
  const value = raw === undefined && fallbackPerArtist !== undefined ? {} : record(raw, what);
  return {
    perArtist:
      fallbackPerArtist === undefined
        ? integer(value["perArtist"], `${what} perArtist`, 1, 20)
        : optionalInteger(value["perArtist"], `${what} perArtist`, 1, 20, fallbackPerArtist),
    refreshDays: optionalInteger(value["refreshDays"], `${what} refreshDays`, 1, 365, 30),
  };
}

function playlistInputs(raw: unknown, what: string, min: number, max: number): PlaylistInput[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    throw new Error(`${what} must list from ${min} to ${max} playlists`);
  }
  const inputs = raw.map((item: unknown): PlaylistInput => {
    const value = record(item, `${what} entry`);
    if (value["type"] === "favourites") {
      return { type: "favourites" };
    }
    if (value["type"] === "playlist") {
      return { type: "playlist", playlistId: idOf<PlaylistId>(value["playlistId"], `${what} playlistId`) };
    }
    throw new Error(`${what} entries must be a playlist or the favourites`);
  });
  const keys = inputs.map((input) => (input.type === "favourites" ? "f" : `p${input.playlistId}`));
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${what} lists a playlist twice`);
  }
  return inputs;
}

function newReleasesSource(value: Raw): NewReleasesSource {
  const include = value["include"] === undefined ? [...DEFAULT_NEW_RELEASE_INCLUDE] : value["include"];
  if (
    !Array.isArray(include) ||
    include.length === 0 ||
    !include.every((kind) => (RELEASE_TYPES as readonly unknown[]).includes(kind))
  ) {
    throw new Error(`source.include must list kinds of release from ${RELEASE_TYPES.join(", ")}`);
  }
  const def: NewReleasesSource = {
    type: "new-releases",
    artists: feedArtists(value["artists"], "source.artists"),
    window: releaseWindow(value["window"]),
    include: [...new Set(include as ReleaseType[])],
    hideFavourites: optionalBoolean(value["hideFavourites"], "source.hideFavourites", false),
  };
  if (value["similar"] !== undefined) {
    def.similar = similarSpec(value["similar"], "similar");
  }
  return withExclude(def, value);
}

function combinedSource(value: Raw): CombinedSource {
  return withExclude(
    {
      type: "combined",
      inputs: playlistInputs(value["inputs"], "source.inputs", 2, 10),
      mode: oneOf(value["mode"], "source.mode", COMBINE_MODES, "merge"),
      keep: oneOf(value["keep"], "source.keep", COMBINE_KEEPS, "highest-quality"),
      order: oneOf(value["order"], "source.order", COMBINE_ORDERS, "sequential"),
      matchSongs: optionalBoolean(value["matchSongs"], "source.matchSongs", true),
    },
    value,
  );
}

function followSource(value: Raw): FollowSource {
  return {
    type: "follow",
    playlistId: idOf<PlaylistId>(value["playlistId"], "source.playlistId"),
    keepRemoved: optionalBoolean(value["keepRemoved"], "source.keepRemoved", false),
  };
}

const DECADE = /^(\d{3}0s|unknown)$/;

function smartRule(raw: unknown): SmartRule {
  const value = record(raw, "rule");
  switch (value["type"]) {
    case "quality":
      return { type: "quality", quality: oneOf(value["quality"], "rule quality", ["hires", "cd"] as const) };
    case "decades": {
      const decades = terms(value["decades"], "rule decades") ?? [];
      if (decades.length === 0 || !decades.every((decade) => DECADE.test(decade))) {
        throw new Error('rule decades must list decades written like "1990s"');
      }
      return { type: "decades", decades: [...new Set(decades)] };
    }
    case "genres": {
      const genres = (terms(value["genres"], "rule genres") ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
      if (genres.length === 0 || genres.length > 20) {
        throw new Error("rule genres must list from 1 to 20 genres");
      }
      return { type: "genres", genres };
    }
    case "favourited-within":
      return { type: "favourited-within", days: integer(value["days"], "rule days", 1, 3650) };
    case "artists": {
      const include = value["include"] === undefined ? [] : artistList(value["include"], "rule include", 0);
      const excluded = value["exclude"] === undefined ? [] : artistList(value["exclude"], "rule exclude", 0);
      if (include.length === 0 && excluded.length === 0) {
        throw new Error("an artists rule needs artists to include or exclude");
      }
      return {
        type: "artists",
        ...(include.length > 0 && { include }),
        ...(excluded.length > 0 && { exclude: excluded }),
      };
    }
    case "duration": {
      const min = value["minSeconds"] === undefined ? undefined : integer(value["minSeconds"], "rule minSeconds", 0, 86_400);
      const max = value["maxSeconds"] === undefined ? undefined : integer(value["maxSeconds"], "rule maxSeconds", 1, 86_400);
      if (min === undefined && max === undefined) {
        throw new Error("a duration rule needs a shortest or longest length");
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error("a duration rule's shortest length is longer than its longest");
      }
      return {
        type: "duration",
        ...(min !== undefined && { minSeconds: min }),
        ...(max !== undefined && { maxSeconds: max }),
      };
    }
    default:
      throw new Error("rule type must be quality, decades, genres, favourited-within, artists or duration");
  }
}

function smartSource(value: Raw): SmartSource {
  const from = playlistInputs(value["from"], "source.from", 1, 10);
  const rawRules = value["rules"];
  if (!Array.isArray(rawRules) || rawRules.length === 0 || rawRules.length > 10) {
    throw new Error("source.rules must list from 1 to 10 rules");
  }
  const rules = rawRules.map(smartRule);
  if (rules.some((rule) => rule.type === "favourited-within") && !from.some((input) => input.type === "favourites")) {
    throw new Error("a favourited-within rule needs the favourites among the inputs");
  }
  return { type: "smart", from, rules, order: oneOf(value["order"], "source.order", SMART_ORDERS, "as-listed") };
}

function discoverySource(value: Raw): DiscoverySource {
  return withExclude(
    {
      type: "discovery",
      seeds: feedArtists(value["seeds"], "source.seeds"),
      similar: similarSpec(value["similar"], "similar", 10),
      artistsPerRotation: optionalInteger(value["artistsPerRotation"], "artistsPerRotation", 1, 50, 10),
      tracksPerArtist: optionalInteger(value["tracksPerArtist"], "tracksPerArtist", 1, 10, 3),
      rotation: oneOf(value["rotation"], "source.rotation", ["day", "week"] as const, "week"),
      avoidRepeatsFor: optionalInteger(value["avoidRepeatsFor"], "avoidRepeatsFor", 0, 52, 8),
      skipFavouriteTracks: optionalBoolean(value["skipFavouriteTracks"], "skipFavouriteTracks", true),
    },
    value,
  );
}

function source(raw: unknown): SourceDef {
  const value = record(raw, "source");
  switch (value["type"]) {
    case "new-releases":
      return newReleasesSource(value);
    case "combined":
      return combinedSource(value);
    case "follow":
      return followSource(value);
    case "smart":
      return smartSource(value);
    case "discovery":
      return discoverySource(value);
    default:
      throw new Error(`source type must be one of ${SOURCE_TYPES.join(", ")}`);
  }
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

function tidyBase(value: Raw, what: string, fallback: TidyBase): TidyBase {
  return {
    cadence: oneOf(value["cadence"], `${what} cadence`, CADENCES, fallback.cadence),
    mode: oneOf(value["mode"], `${what} mode`, ["apply", "suggest"] as const, fallback.mode),
  };
}

function tidySet(raw: unknown): TidySet {
  if (raw === undefined) {
    return {};
  }
  const value = record(raw, "tidy");
  const out: TidySet = {};
  if (value["dedupe"] !== undefined) {
    const dedupe = record(value["dedupe"], "tidy.dedupe");
    const keep = dedupe["keep"] === undefined ? [...DEFAULT_TIDY.dedupe.keep] : dedupe["keep"];
    if (
      !Array.isArray(keep) ||
      keep.length === 0 ||
      !keep.every((step) => (KEEP_STRATEGIES as readonly unknown[]).includes(step))
    ) {
      throw new Error(`tidy.dedupe keep must list strategies from ${KEEP_STRATEGIES.join(", ")}`);
    }
    out.dedupe = { ...tidyBase(dedupe, "tidy.dedupe", DEFAULT_TIDY.dedupe), keep: [...new Set(keep as KeepStrategy[])] };
  }
  if (value["upgrade"] !== undefined) {
    const upgrade = record(value["upgrade"], "tidy.upgrade");
    out.upgrade = {
      ...tidyBase(upgrade, "tidy.upgrade", DEFAULT_TIDY.upgrade),
      allowSignatureMatch: optionalBoolean(upgrade["allowSignatureMatch"], "tidy.upgrade allowSignatureMatch", false),
      maxSearches: optionalInteger(upgrade["maxSearches"], "tidy.upgrade maxSearches", 1, 600, DEFAULT_TIDY.upgrade.maxSearches),
    };
  }
  if (value["repair"] !== undefined) {
    const repair = record(value["repair"], "tidy.repair");
    out.repair = {
      ...tidyBase(repair, "tidy.repair", DEFAULT_TIDY.repair),
      action: oneOf(repair["action"], "tidy.repair action", ["replace", "remove"] as const, "replace"),
    };
  }
  return out;
}

function target(raw: unknown): Target {
  const value = record(raw, "target");
  switch (value["type"]) {
    case "created":
      return { type: "created", isPublic: optionalBoolean(value["isPublic"], "target.isPublic", false) };
    case "adopted":
      return { type: "adopted", playlistId: idOf<PlaylistId>(value["playlistId"], "target.playlistId") };
    case "favourites":
      return { type: "favourites" };
    default:
      throw new Error("target type must be created, adopted or favourites");
  }
}

/** A version 1 job (one new releases feed) in the version 2 shape. */
function fromV1(value: Raw): Raw {
  const { kind: _kind, isPublic, recipe, ...rest } = value;
  return {
    ...rest,
    kind: "playlist",
    target: { type: "created", isPublic: isPublic ?? false },
    source: recipe,
    tidy: {},
  };
}

/** Check a job definition and fill its defaults; throws a readable Error. */
export function validateJob(raw: unknown): Job {
  let value = record(raw, "job");
  if (value["kind"] === "managed-playlist") {
    value = fromV1(value);
  }
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
  if (value["kind"] !== "playlist") {
    throw new Error("job kind must be playlist");
  }
  const job: Job = {
    id,
    name,
    createdAt,
    enabled: optionalBoolean(value["enabled"], "enabled", true),
    kind: "playlist",
    target: target(value["target"]),
    edits: oneOf(value["edits"], "edits", ["respect", "mirror"] as const, "respect"),
    schedule: schedule(value["schedule"]),
    tidy: tidySet(value["tidy"]),
  };
  if (value["source"] !== undefined) {
    job.source = source(value["source"]);
  }
  const shaped = shape(value["shape"]);
  if (shaped !== undefined) {
    job.shape = shaped;
  }
  checkJob(job);
  return job;
}

/** The rules between a job's parts. */
function checkJob(job: Job): void {
  const hasTidy = Object.keys(job.tidy).length > 0;
  if (job.source === undefined && !hasTidy) {
    throw new Error("a job needs a source, a tidy-up, or both");
  }
  if (job.target.type === "created" && job.source === undefined) {
    throw new Error("a new playlist needs a source to fill it");
  }
  if (job.target.type === "favourites") {
    if (job.source !== undefined) {
      throw new Error("the favourites can only have tidy-ups, not a source");
    }
    if (job.shape !== undefined) {
      throw new Error("the favourites cannot have caps");
    }
  }
  if (job.edits === "mirror" && job.target.type !== "created") {
    throw new Error("strict mirror is only for playlists qobuz-helper created; use respect edits");
  }
  if (job.shape?.maxReleases !== undefined && job.source?.type !== "new-releases") {
    throw new Error("maxReleases is only for a new releases source");
  }
  if (job.target.type === "adopted" && sourceReads(job.source).playlists.includes(job.target.playlistId)) {
    throw new Error("a playlist's source cannot read the playlist itself");
  }
}

/**
 * Read a parsed `jobs.json`: valid jobs, and the invalid ones by index.
 *
 * @throws {Error} if it is not a version 1 to 3 jobs file at all.
 */
export function parseJobsFile(raw: unknown): { file: JobsFile; invalid: InvalidJob[] } {
  const value = record(raw, "jobs file");
  if (![1, 2, 3].includes(value["version"] as number)) {
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
  return { file: { version: 3, jobs }, invalid };
}

// --- state parsing ------------------------------------------------------------

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${what} must be a string`);
  }
  return value;
}

function ids<T extends AnyId>(raw: unknown, what: string): T[] {
  return Array.isArray(raw) ? raw.map((id) => idOf<T>(id, what)) : [];
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** Parse the items of a list, skipping (not rejecting) the unusable ones. */
function lenient<T>(raw: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item: unknown) => {
    try {
      return [parse(item)];
    } catch {
      return [];
    }
  });
}

function ownedEntry(raw: unknown): OwnedEntry {
  const value = record(raw, "owned entry");
  return {
    playlistTrackId: idOf<EntryId>(value["playlistTrackId"], "playlistTrackId"),
    trackId: idOf<TrackId>(value["trackId"], "trackId"),
  };
}

function resultSummary(raw: unknown): RunResultSummary {
  const value = record(raw, "lastResult");
  const count = (key: string): number => integer(value[key], key, 0, ID_MAX);
  const optionalCount = (key: string): number | undefined =>
    value[key] === undefined ? undefined : count(key);
  const notes = terms(value["notes"], "notes") ?? [];
  const error = optionalString(value["error"], "error");
  const replaced = optionalCount("replaced");
  const tidyRemoved = optionalCount("tidyRemoved");
  const suggested = optionalCount("suggested");
  return {
    at: optionalString(value["at"], "at") ?? "",
    status: oneOf(value["status"], "status", ["ok", "partial", "failed", "paused"] as const),
    added: count("added"),
    removed: count("removed"),
    dismissed: count("dismissed"),
    ...(replaced !== undefined && { replaced }),
    ...(tidyRemoved !== undefined && { tidyRemoved }),
    ...(suggested !== undefined && { suggested }),
    notes,
    ...(error !== undefined && { error }),
  };
}

function substitution(raw: unknown): Substitution {
  const value = record(raw, "substitution");
  const key = optionalString(value["key"], "key") ?? "";
  return {
    from: idOf<TrackId>(value["from"], "from"),
    ...(value["to"] !== undefined && { to: idOf<TrackId>(value["to"], "to") }),
    key,
  };
}

function tidyChange(raw: unknown): TidyChange {
  const value = record(raw, "change");
  const entry = (item: Raw) =>
    item["playlistTrackId"] === undefined
      ? {}
      : { playlistTrackId: idOf<EntryId>(item["playlistTrackId"], "playlistTrackId") };
  switch (value["type"]) {
    case "replace":
      return {
        type: "replace",
        trackId: idOf<TrackId>(value["trackId"], "trackId"),
        newTrackId: idOf<TrackId>(value["newTrackId"], "newTrackId"),
        ...entry(value),
      };
    case "remove":
      return { type: "remove", trackId: idOf<TrackId>(value["trackId"], "trackId"), ...entry(value) };
    case "dedupe": {
      const remove = Array.isArray(value["remove"]) ? value["remove"] : [];
      return {
        type: "dedupe",
        keepTrackId: idOf<TrackId>(value["keepTrackId"], "keepTrackId"),
        remove: remove.map((item: unknown) => {
          const copy = record(item, "copy");
          return { trackId: idOf<TrackId>(copy["trackId"], "trackId"), ...entry(copy) };
        }),
      };
    }
    default:
      throw new Error("unknown change");
  }
}

function suggestion(raw: unknown): Suggestion {
  const value = record(raw, "suggestion");
  const key = optionalString(value["key"], "key");
  if (key === undefined || key.length === 0) {
    throw new Error("suggestion needs a key");
  }
  return {
    key,
    tidy: oneOf(value["tidy"], "tidy", TIDY_ORDER),
    summary: optionalString(value["summary"], "summary") ?? key,
    change: tidyChange(value["change"]),
    foundAt: optionalString(value["foundAt"], "foundAt") ?? "",
  };
}

function lastRun(raw: unknown): { lastRunAt: string } {
  return { lastRunAt: optionalString(record(raw, "tidy state")["lastRunAt"], "lastRunAt") ?? "" };
}

function tidyState(raw: unknown): TidyState {
  if (!isRecord(raw)) {
    return {};
  }
  const out: TidyState = {};
  if (raw["dedupe"] !== undefined) {
    out.dedupe = lastRun(raw["dedupe"]);
  }
  if (raw["repair"] !== undefined) {
    out.repair = lastRun(raw["repair"]);
  }
  if (raw["upgrade"] !== undefined) {
    const upgrade = record(raw["upgrade"], "upgrade state");
    out.upgrade = {
      ...lastRun(upgrade),
      checked: lenient(upgrade["checked"], (item) => {
        const value = record(item, "checked");
        return { trackId: idOf<TrackId>(value["trackId"], "trackId"), at: optionalString(value["at"], "at") ?? "" };
      }),
    };
  }
  return out;
}

function similarSnapshot(raw: unknown): { takenAt: string; artists: ArtistRef[] } {
  const value = record(raw, "similar");
  return {
    takenAt: optionalString(value["takenAt"], "similar takenAt") ?? "",
    // Skip an unusable artist rather than lose the whole state over it.
    artists: lenient(value["artists"], artistRef),
  };
}

function desiredTrack(raw: unknown): RotationState["tracks"][number] {
  const value = record(raw, "track");
  return {
    trackId: idOf<TrackId>(value["trackId"], "trackId"),
    source: optionalString(value["source"], "source") ?? "",
    ...(value["durationSeconds"] !== undefined && {
      durationSeconds: integer(value["durationSeconds"], "durationSeconds", 0, ID_MAX),
    }),
  };
}

function sourceState(raw: unknown): SourceState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: SourceState = {};
  if (raw["similar"] !== undefined) {
    out.similar = similarSnapshot(raw["similar"]);
  }
  if (raw["seen"] !== undefined) {
    out.seen = ids(raw["seen"], "seen track");
  }
  if (isRecord(raw["rotation"])) {
    const rotation = raw["rotation"];
    out.rotation = {
      number: integer(rotation["number"], "rotation number", 0, ID_MAX),
      artistIds: ids(rotation["artistIds"], "rotation artist"),
      tracks: lenient(rotation["tracks"], desiredTrack),
    };
  }
  if (raw["served"] !== undefined) {
    out.served = lenient(raw["served"], (item) => {
      const value = record(item, "served");
      return {
        rotation: integer(value["rotation"], "served rotation", 0, ID_MAX),
        trackIds: ids(value["trackIds"], "served track"),
      };
    });
  }
  return out;
}

/** Read a parsed job state file (version 1 to 3); throws on anything else. */
export function parseJobState(raw: unknown): JobState {
  const value = record(raw, "job state");
  if (![1, 2, 3].includes(value["version"] as number)) {
    throw new Error(`unsupported job state version ${String(value["version"])}`);
  }
  const state = emptyJobState();
  if (value["playlistId"] !== undefined) {
    state.playlistId = idOf<PlaylistId>(value["playlistId"], "playlistId");
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
  state.dismissed = ids(value["dismissed"], "dismissed track");
  if (value["pending"] !== undefined) {
    const pending = record(value["pending"], "pending");
    state.pending = {
      removed: ids(pending["removed"], "pending removal"),
      added: ids(pending["added"], "pending addition"),
    };
  }
  state.substitutions = lenient(value["substitutions"], substitution);
  state.tidy = tidyState(value["tidy"]);
  state.applied = strings(value["applied"]);
  state.suggestions = lenient(value["suggestions"], suggestion);
  state.ignored = strings(value["ignored"]);
  const source = sourceState(value["source"]) ?? {};
  // Version 1 kept the similar-artist snapshot at the top level.
  if (source.similar === undefined && value["similar"] !== undefined) {
    source.similar = similarSnapshot(value["similar"]);
  }
  if (Object.keys(source).length > 0) {
    state.source = source;
  }
  if (value["favouriteDates"] !== undefined) {
    state.favouriteDates = lenient(value["favouriteDates"], (item) => {
      const entry = record(item, "favourite date");
      const at = optionalString(entry["at"], "at");
      if (at === undefined || Number.isNaN(Date.parse(at))) {
        throw new Error("favourite date needs a timestamp");
      }
      return { trackId: idOf<TrackId>(entry["trackId"], "trackId"), at };
    });
  }
  if (value["lastResult"] !== undefined) {
    state.lastResult = resultSummary(value["lastResult"]);
  }
  return state;
}
