/**
 * Upgrade & repair: swap tracks for a better-quality release of the same
 * recording, and replace (or remove) tracks Qobuz can no longer stream.
 *
 * Two phases, so a caller can review and edit between them (the web UI does):
 *
 *   1. *Resolve* ({@link resolveUpgrades}) -- read the source (favourites, one
 *      playlist, or every playlist), and for each track
 *      - below the best quality: look for another release of the same
 *        recording (same ISRC) that is streamable and strictly better;
 *      - no longer streamable: look for a streamable release of it (same ISRC
 *        first, then the same normalised artist+title).
 *      The result is an editable plan: per item, its candidates (best first)
 *      and a default action (replace, remove, or leave).
 *   2. *Commit* ({@link commitUpgrades}) -- write the chosen changes. An old
 *      track is only ever removed once its replacement was added.
 *
 * Candidates come from the track search queried with the ISRC (Qobuz accepts an
 * ISRC as a search query). The search ranking is never trusted on its own: a
 * result counts only if its ISRC equals the track's (or, where a signature
 * match is allowed, its normalised artist+title signature does -- "same song,
 * maybe a different recording"). Searches run through a small pool, are shared
 * between tracks with the same query, and are capped per run; tracks beyond the
 * cap are reported as not checked.
 *
 * Each function depends only on the small client surface it needs, so it is
 * unit-testable against stubs; QobuzClient satisfies them structurally.
 */

import type { Playlist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { trackSignature } from "./deduplicate.js";

/** Where the upgrade tool looks for tracks. */
export type UpgradeSource =
  | { type: "favourites" }
  | { type: "playlist"; playlistId: number }
  | { type: "all-playlists" };

/** Where a track sits: in the favourites, or as an entry of a playlist. */
export type TrackLocation =
  | { type: "favourites" }
  | {
      type: "playlist";
      playlistId: number;
      /** The playlist's name, when known (all-playlists scans). */
      playlistName?: string;
      /** The entry's id within the playlist, needed to remove it. */
      playlistTrackId: number;
    };

/**
 * How a candidate matched: `isrc` is the same recording; `signature` is the
 * same normalised artist+title -- the same song, maybe a different recording.
 */
export type MatchKind = "isrc" | "signature";

/** Another release of a track that could replace it. */
export interface Candidate {
  track: Track;
  match: MatchKind;
}

/** What to do with an item when committing. */
export type UpgradeAction = "replace" | "remove" | "leave";

/** One track in the plan, with what was found for it. */
export interface UpgradeItem {
  /** `upgrade`: better quality available; `unplayable`: no longer streamable. */
  kind: "upgrade" | "unplayable";
  track: Track;
  location: TrackLocation;
  /** Candidate replacements, best first (may be empty for an unplayable track). */
  candidates: Candidate[];
  /** The proposed action; the caller may change it. */
  action: UpgradeAction;
  /** The chosen candidate's id when the action is `replace`. */
  replacementId?: number;
}

/** The resolved plan, plus what was skipped and why. */
export interface UpgradePlan {
  items: UpgradeItem[];
  /** How many tracks (entries) the source held. */
  scanned: number;
  /** Below the best quality but without an ISRC to search by. */
  skippedNoIsrc: number;
  /** Quality unknown, so there is nothing to compare a candidate against. */
  skippedUnknownQuality: number;
  /** Not checked because the run's search cap was reached. */
  unchecked: number;
  /** Checks whose search failed. */
  failed: number;
}

export interface UpgradeOptions {
  /**
   * Also propose upgrades that only match by normalised artist+title (same
   * song, maybe a different recording). Off by default: upgrades are the same
   * recording only. Unplayable tracks always fall back to such a match when no
   * same-recording release is left; it is flagged either way.
   */
  allowSignatureMatch?: boolean;
  /**
   * Default action for an unplayable track with no replacement: remove it
   * (true) or leave it (false, the default).
   */
  removeUnplayable?: boolean;
  /** Maximum searches per run (default {@link DEFAULT_MAX_SEARCHES}). */
  maxSearches?: number;
  /** Concurrent searches (default {@link DEFAULT_CONCURRENCY}). */
  concurrency?: number;
}

/** The client surface resolving needs; QobuzClient satisfies it. */
export interface UpgradeResolverClient {
  getFavoriteTracks(): Promise<Track[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getUserPlaylists(): Promise<Playlist[]>;
  searchTracks(query: string, limit?: number): Promise<Track[]>;
}

/** The best quality Qobuz streams; a track at it has nothing to upgrade to. */
export const BEST_QUALITY = { bitDepth: 24, samplingRate: 192 } as const;

/**
 * Searches per run, at most. Each checked track costs one or two searches
 * (shared between tracks with the same query); the cap keeps a single web
 * request within the browser's patience and Qobuz's throttling.
 */
export const DEFAULT_MAX_SEARCHES = 600;

/** Results requested per search. */
const SEARCH_LIMIT = 20;

/** Candidates kept per item. */
const MAX_CANDIDATES = 5;

/** Ids per add/remove request in a commit (mirrors the client's batch size). */
const MUTATION_BATCH = 50;

interface Quality {
  bitDepth?: number;
  samplingRate?: number;
}

/** Positive when `a` is strictly better than `b` (bit depth, then sampling rate). */
export function compareQuality(a: Quality, b: Quality): number {
  return (
    (a.bitDepth ?? 0) - (b.bitDepth ?? 0) || (a.samplingRate ?? 0) - (b.samplingRate ?? 0)
  );
}

function hasKnownQuality(track: Quality): boolean {
  return track.bitDepth !== undefined && track.samplingRate !== undefined;
}

/** Whether a track is below {@link BEST_QUALITY} (so an upgrade may exist). */
export function isBelowBestQuality(track: Quality): boolean {
  return compareQuality(BEST_QUALITY, track) > 0;
}

/** ISRCs compare case-insensitively, ignoring hyphens and spaces. */
function normaliseIsrc(isrc: string): string {
  return isrc.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The normalised artist+title signature of a track, from the deduplicator,
 * with the version label folded into the title: Qobuz keeps "Live" or "Remix"
 * in `version`, and those must keep a match apart, while edition noise
 * ("2011 Remaster") is dropped by the normalisation anyway.
 */
function signatureOf(track: Track): string | undefined {
  if (track.artist === undefined || track.artist.length === 0) {
    return undefined;
  }
  const title = track.version === undefined ? track.title : `${track.title} (${track.version})`;
  return trackSignature({ id: track.id, title, artist: track.artist });
}

/** A track as found in the source, with where it sits. */
interface SourceEntry {
  track: Track;
  location: TrackLocation;
}

/** Read every entry of the source. Playlist entries without an entry id are left out. */
async function readSource(
  client: UpgradeResolverClient,
  source: UpgradeSource,
  concurrency: number,
): Promise<SourceEntry[]> {
  if (source.type === "favourites") {
    const tracks = await client.getFavoriteTracks();
    return tracks.map((track) => ({ track, location: { type: "favourites" } }));
  }
  const playlists: Array<{ id: number; name?: string }> =
    source.type === "playlist"
      ? [{ id: source.playlistId }]
      : await client.getUserPlaylists();
  const perPlaylist = await mapWithConcurrency(playlists, concurrency, async (playlist) => {
    const tracks = await client.getPlaylistTracks(playlist.id);
    const entries: SourceEntry[] = [];
    for (const track of tracks) {
      if (track.playlistTrackId === undefined) {
        continue;
      }
      entries.push({
        track,
        location: {
          type: "playlist",
          playlistId: playlist.id,
          ...(playlist.name !== undefined && { playlistName: playlist.name }),
          playlistTrackId: track.playlistTrackId,
        },
      });
    }
    return entries;
  });
  return perPlaylist.flat();
}

/**
 * Order and trim candidates: same-recording matches first, then by quality
 * (best first), keeping search order otherwise; each track once.
 */
function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byId = new Map<number, Candidate>();
  for (const candidate of candidates) {
    const seen = byId.get(candidate.track.id);
    if (seen === undefined || (seen.match === "signature" && candidate.match === "isrc")) {
      byId.set(candidate.track.id, candidate);
    }
  }
  const matchRank = (c: Candidate): number => (c.match === "isrc" ? 0 : 1);
  return [...byId.values()]
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        matchRank(a.candidate) - matchRank(b.candidate) ||
        compareQuality(b.candidate.track, a.candidate.track) ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate)
    .slice(0, MAX_CANDIDATES);
}

type CheckOutcome =
  | { status: "checked"; candidates: Candidate[] }
  | { status: "unchecked" }
  | { status: "failed" };

/**
 * Resolve a source into an upgrade & repair plan, without writing anything.
 *
 * Unplayable tracks are checked before upgrades, so a capped run spends its
 * searches on repairs first. Items keep the source's order within each kind.
 */
export async function resolveUpgrades(
  client: UpgradeResolverClient,
  source: UpgradeSource,
  options: UpgradeOptions = {},
): Promise<UpgradePlan> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const allowSignature = options.allowSignatureMatch ?? false;
  const entries = await readSource(client, source, concurrency);

  let skippedNoIsrc = 0;
  let skippedUnknownQuality = 0;
  const unplayable: SourceEntry[] = [];
  const upgradable: SourceEntry[] = [];
  for (const entry of entries) {
    const { track } = entry;
    if (track.streamable === false) {
      unplayable.push(entry);
    } else if (!hasKnownQuality(track)) {
      skippedUnknownQuality += 1;
    } else if (!isBelowBestQuality(track)) {
      continue;
    } else if (track.isrc === undefined && !(allowSignature && signatureOf(track) !== undefined)) {
      skippedNoIsrc += 1;
    } else {
      upgradable.push(entry);
    }
  }

  // Searches shared by query (the same track in several playlists, or the same
  // recording twice, costs one search) and capped per run.
  let searchesLeft = options.maxSearches ?? DEFAULT_MAX_SEARCHES;
  const cache = new Map<string, Promise<Track[]>>();
  const search = (query: string): Promise<Track[]> | undefined => {
    const cached = cache.get(query);
    if (cached !== undefined) {
      return cached;
    }
    if (searchesLeft <= 0) {
      return undefined;
    }
    searchesLeft -= 1;
    const pending = client.searchTracks(query, SEARCH_LIMIT);
    cache.set(query, pending);
    return pending;
  };

  const check = async (entry: SourceEntry, kind: UpgradeItem["kind"]): Promise<CheckOutcome> => {
    const { track } = entry;
    const usable = (candidate: Track): boolean =>
      candidate.id !== track.id &&
      candidate.streamable !== false &&
      (kind === "unplayable" ||
        (hasKnownQuality(candidate) && compareQuality(candidate, track) > 0));
    const found: Candidate[] = [];
    // Unchecked only when the cap stopped every search this track wanted.
    let searched = false;
    let blocked = false;
    try {
      if (track.isrc !== undefined && track.isrc.length > 0) {
        const pending = search(track.isrc);
        if (pending === undefined) {
          blocked = true;
        } else {
          searched = true;
          const isrc = normaliseIsrc(track.isrc);
          for (const result of await pending) {
            if (result.isrc !== undefined && normaliseIsrc(result.isrc) === isrc && usable(result)) {
              found.push({ track: result, match: "isrc" });
            }
          }
        }
      }
      const signature = signatureOf(track);
      const wantSignature =
        signature !== undefined &&
        (kind === "upgrade" ? allowSignature : found.length === 0);
      if (wantSignature) {
        const pending = search(`${track.artist} ${track.title}`);
        if (pending === undefined) {
          blocked = true;
        } else {
          searched = true;
          for (const result of await pending) {
            if (signatureOf(result) === signature && usable(result)) {
              found.push({ track: result, match: "signature" });
            }
          }
        }
      }
    } catch {
      return { status: "failed" };
    }
    return blocked && !searched
      ? { status: "unchecked" }
      : { status: "checked", candidates: rankCandidates(found) };
  };

  const work: Array<{ entry: SourceEntry; kind: UpgradeItem["kind"] }> = [
    ...unplayable.map((entry) => ({ entry, kind: "unplayable" as const })),
    ...upgradable.map((entry) => ({ entry, kind: "upgrade" as const })),
  ];
  const outcomes = await mapWithConcurrency(work, concurrency, ({ entry, kind }) =>
    check(entry, kind),
  );

  const items: UpgradeItem[] = [];
  let unchecked = 0;
  let failed = 0;
  outcomes.forEach((outcome, index) => {
    const { entry, kind } = work[index]!;
    if (outcome.status === "unchecked") {
      unchecked += 1;
      return;
    }
    if (outcome.status === "failed") {
      failed += 1;
      return;
    }
    const best = outcome.candidates[0];
    if (kind === "upgrade" && best === undefined) {
      return; // nothing better
    }
    items.push({
      kind,
      track: entry.track,
      location: entry.location,
      candidates: outcome.candidates,
      ...(best === undefined
        ? { action: options.removeUnplayable === true ? "remove" : "leave" }
        : { action: "replace", replacementId: best.track.id }),
    });
  });

  return {
    items,
    scanned: entries.length,
    skippedNoIsrc,
    skippedUnknownQuality,
    unchecked,
    failed,
  };
}

/** A change to write: replace a track with another, or remove it. */
export type UpgradeChange =
  | { action: "replace"; location: TrackLocation; trackId: number; newTrackId: number }
  | { action: "remove"; location: TrackLocation; trackId: number };

/**
 * The changes a (possibly edited) plan asks for: left items are dropped, and a
 * replace without a chosen replacement takes the best candidate.
 */
export function planChanges(items: readonly UpgradeItem[]): UpgradeChange[] {
  const changes: UpgradeChange[] = [];
  for (const item of items) {
    if (item.action === "remove") {
      changes.push({ action: "remove", location: item.location, trackId: item.track.id });
    } else if (item.action === "replace") {
      const newTrackId = item.replacementId ?? item.candidates[0]?.track.id;
      if (newTrackId !== undefined) {
        changes.push({
          action: "replace",
          location: item.location,
          trackId: item.track.id,
          newTrackId,
        });
      }
    }
  }
  return changes;
}

/** The client surface committing needs; QobuzClient satisfies it. */
export interface UpgradeCommitClient {
  addFavoriteTracks(trackIds: readonly number[]): Promise<void>;
  removeFavoriteTracks(trackIds: readonly number[]): Promise<void>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  addTracksToPlaylist(playlistId: number, trackIds: readonly number[]): Promise<void>;
  removeTracksFromPlaylist(playlistId: number, playlistTrackIds: readonly number[]): Promise<void>;
  /**
   * Move entries to a position (see QobuzClient.movePlaylistTracks, whose
   * endpoint is unverified). Optional and best-effort: without it, or when it
   * fails, replacements stay at the end of the playlist.
   */
  movePlaylistTracks?(
    playlistId: number,
    playlistTrackIds: readonly number[],
    insertBefore: number,
  ): Promise<void>;
}

/** A change that could not be (fully) written, and why. */
export interface FailedChange {
  change: UpgradeChange;
  reason: string;
}

export interface UpgradeCommitResult {
  replaced: number;
  removed: number;
  failed: FailedChange[];
  /**
   * Playlist replacements that could not be moved into the old track's place
   * and sit at the end of their playlist instead.
   */
  movedToEnd: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a bulk mutation in batches, returning the items whose batch succeeded and
 * a reason for each that failed (so one failing batch does not hide the rest).
 */
async function inBatches<T>(
  items: readonly T[],
  run: (batch: T[]) => Promise<void>,
): Promise<{ ok: Set<T>; errors: Map<T, string> }> {
  const ok = new Set<T>();
  const errors = new Map<T, string>();
  for (const batch of chunk(items, MUTATION_BATCH)) {
    try {
      await run(batch);
      batch.forEach((item) => ok.add(item));
    } catch (error) {
      batch.forEach((item) => errors.set(item, messageOf(error)));
    }
  }
  return { ok, errors };
}

/**
 * Write upgrade changes. Favourites: add the replacements, then remove the old
 * tracks whose replacement was added (plus the plain removals). Playlists: add
 * the replacements, confirm by re-reading the playlist which new entries
 * arrived, delete only the old entries whose replacement is confirmed (plus the
 * plain removals), then move each replacement into its old track's place when
 * the client can. Failures are reported per change rather than thrown, so one
 * failing batch or playlist does not hide what did get written.
 */
export async function commitUpgrades(
  client: UpgradeCommitClient,
  changes: readonly UpgradeChange[],
): Promise<UpgradeCommitResult> {
  const result: UpgradeCommitResult = { replaced: 0, removed: 0, failed: [], movedToEnd: 0 };

  const favourites = changes.filter((c) => c.location.type === "favourites");
  if (favourites.length > 0) {
    await commitFavourites(client, favourites, result);
  }
  const byPlaylist = new Map<number, UpgradeChange[]>();
  for (const change of changes) {
    if (change.location.type === "playlist") {
      const list = byPlaylist.get(change.location.playlistId) ?? [];
      list.push(change);
      byPlaylist.set(change.location.playlistId, list);
    }
  }
  for (const [playlistId, playlistChanges] of byPlaylist) {
    await commitPlaylist(client, playlistId, playlistChanges, result);
  }
  return result;
}

async function commitFavourites(
  client: UpgradeCommitClient,
  changes: readonly UpgradeChange[],
  result: UpgradeCommitResult,
): Promise<void> {
  const newIds = [
    ...new Set(changes.flatMap((c) => (c.action === "replace" ? [c.newTrackId] : []))),
  ];
  const added = await inBatches(newIds, (batch) => client.addFavoriteTracks(batch));

  const toRemove: UpgradeChange[] = [];
  for (const change of changes) {
    if (change.action === "replace" && !added.ok.has(change.newTrackId)) {
      result.failed.push({
        change,
        reason: `could not add the replacement: ${added.errors.get(change.newTrackId) ?? "unknown error"}`,
      });
    } else {
      toRemove.push(change);
    }
  }
  const oldIds = [...new Set(toRemove.map((c) => c.trackId))];
  const removed = await inBatches(oldIds, (batch) => client.removeFavoriteTracks(batch));
  for (const change of toRemove) {
    if (removed.ok.has(change.trackId)) {
      if (change.action === "replace") {
        result.replaced += 1;
      } else {
        result.removed += 1;
      }
    } else {
      const why = removed.errors.get(change.trackId) ?? "unknown error";
      result.failed.push({
        change,
        reason:
          change.action === "replace"
            ? `the replacement was added, but the old track could not be removed: ${why}`
            : `could not remove: ${why}`,
      });
    }
  }
}

async function commitPlaylist(
  client: UpgradeCommitClient,
  playlistId: number,
  changes: readonly UpgradeChange[],
  result: UpgradeCommitResult,
): Promise<void> {
  const failAll = (list: readonly UpgradeChange[], reason: string): void => {
    list.forEach((change) => result.failed.push({ change, reason }));
  };
  const entryId = (change: UpgradeChange): number =>
    change.location.type === "playlist" ? change.location.playlistTrackId : -1;

  let before: Track[];
  try {
    before = await client.getPlaylistTracks(playlistId);
  } catch (error) {
    failAll(changes, `could not read the playlist: ${messageOf(error)}`);
    return;
  }
  const position = new Map<number, number>();
  before.forEach((track, index) => {
    if (track.playlistTrackId !== undefined) {
      position.set(track.playlistTrackId, index);
    }
  });

  // Each old entry once, still in the playlist, in playlist order.
  const seen = new Set<number>();
  const live: UpgradeChange[] = [];
  for (const change of changes) {
    const id = entryId(change);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (position.has(id)) {
      live.push(change);
    } else {
      result.failed.push({ change, reason: "no longer in the playlist" });
    }
  }
  live.sort((a, b) => position.get(entryId(a))! - position.get(entryId(b))!);

  const replaces = live.filter(
    (c): c is Extract<UpgradeChange, { action: "replace" }> => c.action === "replace",
  );

  // Add the replacements (in the old entries' order), then confirm which arrived.
  const newEntry = new Map<UpgradeChange, number>();
  if (replaces.length > 0) {
    const order = replaces.map((c) => c.newTrackId);
    for (const batch of chunk(order, MUTATION_BATCH)) {
      try {
        await client.addTracksToPlaylist(playlistId, batch);
      } catch {
        // Confirmed (or not) by re-reading the playlist below.
      }
    }
    let after: Track[] | undefined;
    try {
      after = await client.getPlaylistTracks(playlistId);
    } catch (error) {
      failAll(
        replaces,
        `could not confirm the replacement was added (check the end of the playlist): ${messageOf(error)}`,
      );
    }
    if (after !== undefined) {
      const arrived = new Map<number, number[]>();
      for (const track of after) {
        if (track.playlistTrackId !== undefined && !position.has(track.playlistTrackId)) {
          const queue = arrived.get(track.id) ?? [];
          queue.push(track.playlistTrackId);
          arrived.set(track.id, queue);
        }
      }
      for (const change of replaces) {
        const id = arrived.get(change.newTrackId)?.shift();
        if (id === undefined) {
          result.failed.push({ change, reason: "could not add the replacement" });
        } else {
          newEntry.set(change, id);
        }
      }
    }
  }

  // Delete the old entries: confirmed replacements and plain removals only.
  const deletable = live.filter((c) => c.action === "remove" || newEntry.has(c));
  const deleted = await inBatches(deletable, (batch) =>
    client.removeTracksFromPlaylist(playlistId, batch.map(entryId)),
  );
  const replacedInPlace: UpgradeChange[] = [];
  for (const change of deletable) {
    if (deleted.ok.has(change)) {
      if (change.action === "replace") {
        result.replaced += 1;
        replacedInPlace.push(change);
      } else {
        result.removed += 1;
      }
    } else {
      const why = deleted.errors.get(change) ?? "unknown error";
      result.failed.push({
        change,
        reason:
          change.action === "replace"
            ? `the replacement was added at the end, but the old entry could not be removed: ${why}`
            : `could not remove: ${why}`,
      });
    }
  }

  await moveIntoPlace(client, playlistId, before, deleted.ok, replacedInPlace, newEntry, result);
}

/**
 * Move each replacement from the end of the playlist into its old entry's
 * place. The target index of a replacement is its old index minus the removed
 * entries before it; moving them in ascending order keeps every earlier index
 * settled, and consecutive targets move together in one call.
 */
async function moveIntoPlace(
  client: UpgradeCommitClient,
  playlistId: number,
  before: readonly Track[],
  deleted: ReadonlySet<UpgradeChange>,
  replaced: readonly UpgradeChange[],
  newEntry: ReadonlyMap<UpgradeChange, number>,
  result: UpgradeCommitResult,
): Promise<void> {
  if (replaced.length === 0) {
    return;
  }
  if (client.movePlaylistTracks === undefined) {
    result.movedToEnd += replaced.length;
    return;
  }
  const deletedIds = new Map<number, UpgradeChange>();
  for (const change of deleted) {
    if (change.location.type === "playlist") {
      deletedIds.set(change.location.playlistTrackId, change);
    }
  }
  // Target index of each replacement in the final playlist.
  const targets: Array<{ id: number; index: number }> = [];
  let index = 0;
  for (const track of before) {
    const change =
      track.playlistTrackId === undefined ? undefined : deletedIds.get(track.playlistTrackId);
    if (change === undefined) {
      index += 1;
    } else if (change.action === "replace") {
      targets.push({ id: newEntry.get(change)!, index });
      index += 1;
    }
  }
  const runs: Array<{ ids: number[]; index: number }> = [];
  for (const target of targets) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.index + last.ids.length === target.index) {
      last.ids.push(target.id);
    } else {
      runs.push({ ids: [target.id], index: target.index });
    }
  }
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    try {
      await client.movePlaylistTracks(playlistId, run.ids, run.index);
    } catch {
      result.movedToEnd += runs.slice(i).reduce((sum, r) => sum + r.ids.length, 0);
      return;
    }
  }
}

/** A short label for a quality, e.g. "24/96"; "?" when unknown. */
function qualityLabel(track: Quality): string {
  return hasKnownQuality(track) ? `${track.bitDepth}/${track.samplingRate}` : "?";
}

function describeTrack(track: Track): string {
  const title = track.version === undefined ? track.title : `${track.title} (${track.version})`;
  const artist = track.artist === undefined ? "" : `${track.artist} - `;
  const album = track.album === undefined ? "" : `  [${track.album}]`;
  return `${artist}${title}${album}`;
}

function describeLocation(location: TrackLocation): string {
  if (location.type === "favourites") {
    return "";
  }
  return location.playlistName === undefined
    ? ""
    : `  (in "${location.playlistName}")`;
}

function matchNote(candidate: Candidate): string {
  return candidate.match === "signature" ? " (same song, maybe a different recording)" : "";
}

/** Render a plan as a human-readable report (for the CLI). */
export function formatUpgradeReport(plan: UpgradePlan): string {
  const upgrades = plan.items.filter((item) => item.kind === "upgrade");
  const broken = plan.items.filter((item) => item.kind === "unplayable");
  const lines: string[] = [];

  if (upgrades.length === 0) {
    lines.push("No better-quality versions found.");
  } else {
    lines.push(`Better quality available (${upgrades.length}):`);
    for (const item of upgrades) {
      const chosen = item.candidates.find((c) => c.track.id === item.replacementId) ?? item.candidates[0]!;
      lines.push(`  ${describeTrack(item.track)}${describeLocation(item.location)}`);
      lines.push(
        `    ${qualityLabel(item.track)} -> ${qualityLabel(chosen.track)}  id ${chosen.track.id}${chosen.track.album === undefined ? "" : ` [${chosen.track.album}]`}${matchNote(chosen)}`,
      );
    }
  }
  lines.push("");
  if (broken.length === 0) {
    lines.push("No unplayable tracks found.");
  } else {
    lines.push(`No longer playable (${broken.length}):`);
    for (const item of broken) {
      lines.push(`  ${describeTrack(item.track)}${describeLocation(item.location)}`);
      const chosen = item.candidates.find((c) => c.track.id === item.replacementId) ?? item.candidates[0];
      if (chosen === undefined) {
        lines.push(`    no replacement found -- ${item.action === "remove" ? "remove" : "leave"}`);
      } else {
        lines.push(
          `    replace with id ${chosen.track.id}${chosen.track.album === undefined ? "" : ` [${chosen.track.album}]`}${matchNote(chosen)}`,
        );
      }
    }
  }

  const notes: string[] = [];
  if (plan.skippedNoIsrc > 0) {
    notes.push(`${plan.skippedNoIsrc} without an ISRC to search by`);
  }
  if (plan.skippedUnknownQuality > 0) {
    notes.push(`${plan.skippedUnknownQuality} of unknown quality`);
  }
  if (plan.unchecked > 0) {
    notes.push(`${plan.unchecked} not checked (search limit reached)`);
  }
  if (plan.failed > 0) {
    notes.push(`${plan.failed} whose search failed`);
  }
  lines.push("");
  lines.push(`Scanned ${plan.scanned} track${plan.scanned === 1 ? "" : "s"}.`);
  if (notes.length > 0) {
    lines.push(`Skipped: ${notes.join("; ")}.`);
  }
  return lines.join("\n");
}
