/**
 * Editing a playlist as a draft: the pure part of the playlist manager.
 *
 * A {@link Draft} is the order a playlist was opened in, the order wanted now,
 * and what is to be taken out (removed, or moved to another playlist). Every
 * edit returns a new draft, so undo is keeping the old ones ({@link EditStack}).
 * Entries are known by their playlist-track id, never the track id: a playlist
 * may hold the same track twice.
 *
 * Nothing here touches Qobuz; saving is in playlist-manager.ts. Pure and free
 * of Node dependencies: the web UI runs it in the page.
 */

import type { Track } from "../services/model.js";
import { shuffle } from "./combine.js";
import {
  findDuplicateGroups,
  findOtherVersions,
  removedTracks,
  resolveDuplicateGroups,
  toDedupTrack,
  trackSignature,
  type DedupTrack,
  type KeepChain,
  type KeepStrategy,
  type SameSongOptions,
} from "./deduplicate.js";
import { applyMove, mergeOrder, stayingIds } from "./playlist-order.js";
import { songKeys } from "./song-picker.js";
import { normaliseArtistName } from "./track-filter.js";

/** A playlist's entry: its track, with the entry's id. */
export type Entry = Track & { playlistTrackId: number };

/** Where entries are moved to. */
export type Destination =
  | { type: "existing"; playlistId: number; name: string }
  | { type: "new"; name: string; isPublic: boolean };

export interface Draft {
  /** The entries as opened, in order. */
  readonly base: readonly number[];
  /** The entries kept, in the order wanted. */
  readonly order: readonly number[];
  /** The entries taken out, with where they are moved to (if anywhere). */
  readonly removed: ReadonlyMap<number, Destination | undefined>;
}

export function startDraft(base: readonly number[]): Draft {
  return { base: [...base], order: [...base], removed: new Map() };
}

/** Take entries out: removed, or moved to `destination` on save. */
export function takeOut(draft: Draft, ids: Iterable<number>, destination?: Destination): Draft {
  const here = new Set(draft.order);
  const going = [...new Set(ids)].filter((id) => here.has(id));
  if (going.length === 0) {
    return draft;
  }
  const removed = new Map(draft.removed);
  going.forEach((id) => removed.set(id, destination));
  return { ...draft, order: draft.order.filter((id) => !removed.has(id)), removed };
}

/** Put taken-out entries back, each after the entry it followed when opened. */
export function putBack(draft: Draft, ids: Iterable<number>): Draft {
  const wanted = new Set([...ids].filter((id) => draft.removed.has(id)));
  if (wanted.size === 0) {
    return draft;
  }
  const order = [...draft.order];
  const here = new Set(order);
  let previous: number | undefined;
  for (const id of draft.base) {
    if (wanted.has(id)) {
      order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, id);
      here.add(id);
    }
    if (here.has(id)) {
      previous = id;
    }
  }
  const removed = new Map([...draft.removed].filter(([id]) => !wanted.has(id)));
  return { ...draft, order, removed };
}

/**
 * Move entries, in the order they are in now, in front of the entry now at
 * `index` (the length means the end). When that entry is itself moved, they go
 * where it was.
 */
export function moveTo(draft: Draft, ids: Iterable<number>, index: number): Draft {
  const moving = new Set(ids);
  const ordered = draft.order.filter((id) => moving.has(id));
  return withOrder(draft, applyMove(draft.order, ordered, index + 1));
}

/** Move each entry one place up (-1) or down (1), those at the edge aside. */
export function moveBy(draft: Draft, ids: Iterable<number>, step: 1 | -1): Draft {
  const moving = new Set(ids);
  const order = step === -1 ? [...draft.order] : [...draft.order].reverse();
  for (let i = 1; i < order.length; i += 1) {
    if (moving.has(order[i]!) && !moving.has(order[i - 1]!)) {
      [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
    }
  }
  return withOrder(draft, step === -1 ? order : order.reverse());
}

/**
 * Put entries in the given order: the whole playlist's, or -- when only some
 * are given -- among the places those occupy.
 */
export function reorder(draft: Draft, ids: readonly number[]): Draft {
  const here = new Set(draft.order);
  const given = ids.filter((id) => here.has(id));
  const set = new Set(given);
  let next = 0;
  return withOrder(
    draft,
    draft.order.map((id) => (set.has(id) ? given[next++]! : id)),
  );
}

function withOrder(draft: Draft, order: readonly number[]): Draft {
  return order.every((id, i) => id === draft.order[i]) ? draft : { ...draft, order };
}

/** What saving a draft would do. */
export interface DraftSummary {
  removed: number;
  moved: Array<{ destination: Destination; count: number }>;
  /** Entries out of their opened order (the fewest that must move). */
  reordered: number;
  changed: boolean;
}

export function summarise(draft: Draft): DraftSummary {
  let removed = 0;
  const moved = new Map<string, { destination: Destination; count: number }>();
  for (const destination of draft.removed.values()) {
    if (destination === undefined) {
      removed += 1;
      continue;
    }
    const key = destinationKey(destination);
    const known = moved.get(key);
    if (known === undefined) {
      moved.set(key, { destination, count: 1 });
    } else {
      known.count += 1;
    }
  }
  const kept = draft.base.filter((id) => !draft.removed.has(id));
  const reordered = kept.length - stayingIds(kept, draft.order).size;
  return {
    removed,
    moved: [...moved.values()],
    reordered,
    changed: draft.removed.size > 0 || reordered > 0,
  };
}

function destinationKey(destination: Destination): string {
  return destination.type === "existing" ? `p:${destination.playlistId}` : `n:${destination.name}:${destination.isPublic}`;
}

/** The request that saves a draft (see savePlaylist in playlist-manager.ts). */
export interface DraftChanges {
  base: number[];
  order: number[];
  remove: number[];
  moves: Array<{ destination: Destination; entries: number[] }>;
}

export function draftChanges(draft: Draft): DraftChanges {
  const remove: number[] = [];
  const moves = new Map<string, { destination: Destination; entries: number[] }>();
  // In opened order, so moved songs arrive in the order they were in.
  for (const id of draft.base) {
    if (!draft.removed.has(id)) {
      continue;
    }
    const destination = draft.removed.get(id);
    if (destination === undefined) {
      remove.push(id);
      continue;
    }
    const key = destinationKey(destination);
    const known = moves.get(key) ?? { destination, entries: [] };
    known.entries.push(id);
    moves.set(key, known);
  }
  return { base: [...draft.base], order: [...draft.order], remove, moves: [...moves.values()] };
}

/** Send what was to be moved to `from` to `to` instead (a playlist made meanwhile). */
export function retarget(draft: Draft, from: Destination, to: Destination): Draft {
  const key = destinationKey(from);
  return {
    ...draft,
    removed: new Map(
      [...draft.removed].map(([id, destination]) => [
        id,
        destination !== undefined && destinationKey(destination) === key ? to : destination,
      ]),
    ),
  };
}

/** How a playlist changed elsewhere since a draft was opened. */
export interface Drift {
  added: number;
  gone: number;
  reordered: boolean;
}

export function driftOf(base: readonly number[], fresh: readonly number[]): Drift {
  const baseSet = new Set(base);
  const freshSet = new Set(fresh);
  const common = base.filter((id) => freshSet.has(id));
  const commonFresh = fresh.filter((id) => baseSet.has(id));
  return {
    added: fresh.length - commonFresh.length,
    gone: base.length - common.length,
    reordered: common.some((id, i) => id !== commonFresh[i]),
  };
}

/**
 * Carry a draft over to the playlist as it is now: entries that have gone drop
 * out, new ones go after the entry they follow there, and the draft's removals
 * and order otherwise stand (a draft that reorders nothing takes the new order).
 */
export function rebase(draft: Draft, fresh: readonly number[]): Draft {
  const present = new Set(fresh);
  const removed = new Map([...draft.removed].filter(([id]) => present.has(id)));
  const kept = fresh.filter((id) => !removed.has(id));
  return {
    base: [...fresh],
    order: summarise(draft).reordered === 0 ? kept : mergeOrder(kept, draft.order),
    removed,
  };
}

/** The ids from one row to another, inclusive, as shown (for shift-click). */
export function rangeBetween(shown: readonly number[], from: number, to: number): number[] {
  const a = shown.indexOf(from);
  const b = shown.indexOf(to);
  if (a === -1 || b === -1) {
    return b === -1 ? [] : [to];
  }
  return shown.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Past and future drafts, for undo and redo. */
export class EditStack<T> {
  #past: T[] = [];
  #future: T[] = [];
  #now: T;

  constructor(start: T) {
    this.#now = start;
  }

  get now(): T {
    return this.#now;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** Make an edit; one that changes nothing is not kept. */
  push(next: T): void {
    if (next !== this.#now) {
      this.#past.push(this.#now);
      this.#now = next;
      this.#future = [];
    }
  }

  undo(): void {
    const back = this.#past.pop();
    if (back !== undefined) {
      this.#future.push(this.#now);
      this.#now = back;
    }
  }

  redo(): void {
    const ahead = this.#future.pop();
    if (ahead !== undefined) {
      this.#past.push(this.#now);
      this.#now = ahead;
    }
  }
}

// ---- Orders -----------------------------------------------------------------

/** What a playlist can be sorted by. */
export const SORT_KEYS = ["title", "artist", "album", "added", "released", "length", "quality"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

type Comparable = string | number | undefined;

const SORT_VALUES: Record<SortKey, (entry: Entry) => Comparable[]> = {
  title: (e) => [e.title, e.version],
  artist: (e) => [e.artist, e.album, e.discNumber, e.trackNumber],
  album: (e) => [e.album, e.discNumber, e.trackNumber],
  added: (e) => [e.addedAt],
  released: (e) => [e.releaseDate],
  length: (e) => [e.duration],
  quality: (e) => [e.bitDepth, e.samplingRate],
};

/** Entry ids sorted; entries without the value go last either way, ties keep their order. */
export function sortIds(entries: readonly Entry[], key: SortKey, descending = false): number[] {
  const values = new Map(entries.map((entry) => [entry, SORT_VALUES[key](entry)]));
  return [...entries]
    .sort((a, b) => compareValues(values.get(a)!, values.get(b)!, descending))
    .map((entry) => entry.playlistTrackId);
}

function compareValues(a: readonly Comparable[], b: readonly Comparable[], descending: boolean): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) {
      if (x !== y) {
        return x === undefined ? 1 : -1;
      }
      continue;
    }
    const result =
      typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    if (result !== 0) {
      // Only what is sorted by is reversed: an album still plays in track order.
      return descending && i === 0 ? -result : result;
    }
  }
  return 0;
}

export function shuffleIds(entries: readonly Entry[], random: () => number = Math.random): number[] {
  return shuffle(
    entries.map((entry) => entry.playlistTrackId),
    random,
  );
}

/**
 * Entry ids with no artist twice in a row where that can be done, otherwise
 * changing the order as little as it can: the next entry is the first left by
 * another artist, unless one artist has so many left that they must go now.
 */
export function spreadArtists(entries: readonly Entry[]): number[] {
  const left = entries.map((entry) => ({ id: entry.playlistTrackId, artist: artistKey(entry) }));
  const counts = new Map<string, number>();
  left.forEach(({ artist }) => counts.set(artist, (counts.get(artist) ?? 0) + 1));
  const out: number[] = [];
  let last: string | undefined;
  while (left.length > 0) {
    let pressing: string | undefined;
    for (const [artist, count] of counts) {
      if (artist !== last && count * 2 > left.length) {
        pressing = artist;
      }
    }
    const index = left.findIndex(({ artist }) => (pressing === undefined ? artist !== last : artist === pressing));
    const [next] = left.splice(Math.max(index, 0), 1);
    counts.set(next!.artist, counts.get(next!.artist)! - 1);
    last = next!.artist;
    out.push(next!.id);
  }
  return out;
}

function artistKey(entry: Entry): string {
  if (entry.artistId !== undefined) {
    return `i:${entry.artistId}`;
  }
  // An entry without an artist clashes with none.
  return entry.artist === undefined ? `e:${entry.playlistTrackId}` : `n:${normaliseArtistName(entry.artist)}`;
}

// ---- Picking entries --------------------------------------------------------

/** Entries of which another copy is kept (as the Deduplicator decides). */
export function duplicateIds(
  entries: readonly Entry[],
  keep: KeepStrategy | KeepChain,
  options: SameSongOptions = {},
): number[] {
  const groups = resolveDuplicateGroups(findDuplicateGroups(dedupTracks(entries), options), keep);
  return groups.flatMap(removedTracks).map((track) => track.playlistTrackId!);
}

/**
 * Entries that are another version (live, acoustic, remix) of a song here: in
 * each such song, all but the copies of its ordinary version, or of its first.
 */
export function otherVersionIds(entries: readonly Entry[]): number[] {
  return findOtherVersions(dedupTracks(entries)).flatMap((group) => {
    // The ordinary version: without a label, or with one that says no more.
    const main = group.find((track) => trackSignature(track) === plainSignature(track)) ?? group[0]!;
    const same = (track: DedupTrack): boolean =>
      trackSignature(track) === trackSignature(main) || (track.isrc !== undefined && track.isrc === main.isrc);
    return group.filter((track) => !same(track)).map((track) => track.playlistTrackId!);
  });
}

/** A track's signature as if it had no version label. */
function plainSignature(track: DedupTrack): string {
  const { version: _version, ...plain } = track;
  return trackSignature(plain);
}

function dedupTracks(entries: readonly Entry[]): DedupTrack[] {
  return entries.map(toDedupTrack);
}

/** Entries Qobuz can no longer play. */
export function unplayableIds(entries: readonly Entry[]): number[] {
  return entries.filter((entry) => entry.streamable === false).map((entry) => entry.playlistTrackId);
}

/** Entries known to be no better than CD quality. */
export function notHiResIds(entries: readonly Entry[]): number[] {
  return entries
    .filter((e) => e.bitDepth !== undefined && e.samplingRate !== undefined && e.bitDepth <= 16 && e.samplingRate <= 48)
    .map((entry) => entry.playlistTrackId);
}

/** Entries labelled live: in the version, or in brackets or after a dash in the title. */
export function liveIds(entries: readonly Entry[]): number[] {
  return entries
    .filter(
      (entry) =>
        /\blive\b/i.test(entry.version ?? "") ||
        /(?:[([][^)\]]*|\s[-–—]\s.*)\blive\b/i.test(entry.title),
    )
    .map((entry) => entry.playlistTrackId);
}

/** Entries added before (or on and after) a date, YYYY-MM-DD, in local time. */
export function addedIds(entries: readonly Entry[], when: "before" | "since", date: string): number[] {
  const limit = new Date(`${date}T00:00:00`).getTime();
  return entries
    .filter((entry) => {
      const at = entry.addedAt === undefined ? NaN : Date.parse(entry.addedAt);
      return when === "before" ? at < limit : at >= limit;
    })
    .map((entry) => entry.playlistTrackId);
}

/** Entries that are the same song as one of `others` (favourites, another playlist). */
export function alreadyInIds(entries: readonly Entry[], others: readonly Track[]): number[] {
  const known = new Set(others.flatMap(songKeys));
  return entries
    .filter((entry) => songKeys(entry).some((key) => known.has(key)))
    .map((entry) => entry.playlistTrackId);
}

/** Entries whose title, version, artist, album or guests hold every word of `query`. */
export function searchIds(entries: readonly Entry[], query: string): number[] {
  const words = foldText(query).split(" ").filter((word) => word.length > 0);
  return entries
    .filter((entry) => {
      const text = foldText(
        [entry.title, entry.version, entry.artist, entry.album, ...(entry.jointArtists ?? []), ...(entry.guestArtists ?? [])].join(" "),
      );
      return words.every((word) => text.includes(word));
    })
    .map((entry) => entry.playlistTrackId);
}

const foldText = normaliseArtistName;
