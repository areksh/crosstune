/**
 * Shaping a playlist plan: its order, its length, and how to describe it.
 *
 * The playlist builders produce their tracks in *groups* -- one per artist (or
 * per album) -- most popular (or first on the album) first. This module turns
 * those groups into the playlist as it will play:
 *
 *   - {@link orderGroups} flattens them `by-artist` (each group in turn),
 *     `take-turns` (round-robin between the groups) or `shuffle` (with an
 *     injectable random source, so a preview and the write agree);
 *   - {@link fitToLength} trims them to at most a target length, dropping from
 *     the end of the groups in turn so each keeps its first (most popular)
 *     tracks; and
 *   - {@link totalSeconds}, {@link formatDuration} and {@link playsAs} describe
 *     the result.
 *
 * It is pure and has no Node dependencies, so the web UI imports it too: the
 * review applies the same order and fit the CLI does.
 */

import { shuffle } from "./combine.js";

/** How the artists tools order the playlist. */
export type PlaylistOrder = "by-artist" | "take-turns" | "shuffle";
export const PLAYLIST_ORDERS: readonly PlaylistOrder[] = ["by-artist", "take-turns", "shuffle"];
/** The CLI default, which keeps the order the tools always used. */
export const DEFAULT_PLAYLIST_ORDER: PlaylistOrder = "by-artist";

/** How the albums tool orders the playlist: as listed, or shuffled. */
export type AlbumOrder = "as-listed" | "shuffle";
export const ALBUM_ORDERS: readonly AlbumOrder[] = ["as-listed", "shuffle"];

export function isPlaylistOrder(value: unknown): value is PlaylistOrder {
  return typeof value === "string" && (PLAYLIST_ORDERS as readonly string[]).includes(value);
}

export function isAlbumOrder(value: unknown): value is AlbumOrder {
  return typeof value === "string" && (ALBUM_ORDERS as readonly string[]).includes(value);
}

/**
 * Flatten groups into play order. `as-listed` is `by-artist` under the albums
 * tool's name. `random` (default `Math.random`) is only drawn from to shuffle.
 */
export function orderGroups<T>(
  groups: readonly (readonly T[])[],
  order: PlaylistOrder | AlbumOrder,
  random: () => number = Math.random,
): T[] {
  const sequential = groups.flat();
  if (order === "shuffle") {
    return shuffle(sequential, random);
  }
  if (order !== "take-turns") {
    return sequential;
  }
  const longest = Math.max(0, ...groups.map((group) => group.length));
  const result: T[] = [];
  for (let turn = 0; turn < longest; turn += 1) {
    for (const group of groups) {
      const next = group[turn];
      if (next !== undefined) {
        result.push(next);
      }
    }
  }
  return result;
}

/** Fit-to-length choices the web UI offers, in minutes. */
export const FIT_CHOICES: readonly number[] = [30, 45, 60, 80, 120];
/** The longest target accepted: a day. */
export const MAX_FIT_MINUTES = 24 * 60;

/**
 * Parse a fit-to-length target in whole minutes (1 to {@link MAX_FIT_MINUTES}).
 *
 * @throws {Error} if it is not such a number.
 */
export function parseFitMinutes(raw: string): number {
  const text = raw.trim();
  const minutes = Number(text);
  if (!/^\d+$/.test(text) || minutes < 1 || minutes > MAX_FIT_MINUTES) {
    throw new Error(
      `The length to fit must be a whole number of minutes from 1 to ${MAX_FIT_MINUTES}, got "${raw}"`,
    );
  }
  return minutes;
}

/** What a track of unknown length counts as when no length is known at all. */
const FALLBACK_SECONDS = 240;

/**
 * A duration function where unknown lengths count as the average of the known
 * ones (or {@link FALLBACK_SECONDS} when none is known).
 */
function withAverage<T>(
  items: readonly T[],
  durationOf: (item: T) => number | undefined,
): (item: T) => number {
  const known = items
    .map(durationOf)
    .filter((seconds): seconds is number => seconds !== undefined && seconds > 0);
  const average =
    known.length > 0 ? known.reduce((sum, seconds) => sum + seconds, 0) / known.length : FALLBACK_SECONDS;
  return (item) => {
    const seconds = durationOf(item);
    return seconds !== undefined && seconds > 0 ? seconds : average;
  };
}

/** The total length in seconds; an unknown length counts as the average. */
export function totalSeconds<T>(
  items: readonly T[],
  durationOf: (item: T) => number | undefined,
): number {
  const seconds = withAverage(items, durationOf);
  return Math.round(items.reduce((sum, item) => sum + seconds(item), 0));
}

export interface FitResult<T> {
  /** The groups with the dropped items removed (same group count and order). */
  kept: T[][];
  /** The dropped items, in the order they were dropped. */
  dropped: T[];
  /** The kept items' total length in seconds. */
  seconds: number;
}

/**
 * Trim groups to at most `maxSeconds`, dropping from the end fairly: every
 * group's last item goes before any group loses its second-to-last, and so on
 * (the last group first within a round), so each group keeps its first items.
 * Pass a single group to trim from the end of a list instead. An unknown
 * length counts as the average; at least one item is always kept.
 */
export function fitToLength<T>(
  groups: readonly (readonly T[])[],
  maxSeconds: number,
  durationOf: (item: T) => number | undefined,
): FitResult<T> {
  const all = groups.flat();
  const seconds = withAverage(all, durationOf);
  let total = all.reduce((sum, item) => sum + seconds(item), 0);
  let remaining = all.length;

  // Deepest rank first; within a rank, the last group first.
  const candidates = groups
    .flatMap((group, groupIndex) => group.map((item, rank) => ({ item, rank, groupIndex })))
    .sort((a, b) => b.rank - a.rank || b.groupIndex - a.groupIndex);
  const dropped: T[] = [];
  const droppedSet = new Set<T>();
  for (const candidate of candidates) {
    if (total <= maxSeconds || remaining <= 1) {
      break;
    }
    dropped.push(candidate.item);
    droppedSet.add(candidate.item);
    total -= seconds(candidate.item);
    remaining -= 1;
  }
  return {
    kept: groups.map((group) => group.filter((item) => !droppedSet.has(item))),
    dropped,
    seconds: Math.round(total),
  };
}

/**
 * Keep each key's first occurrence across the groups (a track shared by two
 * artists plays once, under the first); groups that empty out stay, empty.
 */
export function uniqueGroups<T>(
  groups: readonly (readonly T[])[],
  keyOf: (item: T) => unknown,
): T[][] {
  const seen = new Set<unknown>();
  return groups.map((group) =>
    group.filter((item) => {
      const key = keyOf(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  );
}

export interface ShapeOptions {
  /** Default `by-artist` (as listed). */
  order?: PlaylistOrder | AlbumOrder;
  /** Trim to at most about this many minutes; absent keeps everything. */
  fitMinutes?: number;
  /**
   * `fair` (default) trims every group's end in turn; `tail` trims the end of
   * the list, i.e. the last groups first (the albums tool keeps whole albums).
   */
  fit?: "fair" | "tail";
  /** Random source for `shuffle`; default `Math.random`. */
  random?: () => number;
}

export interface ShapedPlaylist<T> extends FitResult<T> {
  /** The kept items in play order. */
  ordered: T[];
}

/** Fit the groups to length (when asked), then put what is left in order. */
export function shapePlaylist<T>(
  groups: readonly (readonly T[])[],
  durationOf: (item: T) => number | undefined,
  options: ShapeOptions = {},
): ShapedPlaylist<T> {
  let fitted: FitResult<T>;
  if (options.fitMinutes === undefined) {
    fitted = {
      kept: groups.map((group) => [...group]),
      dropped: [],
      seconds: totalSeconds(groups.flat(), durationOf),
    };
  } else if (options.fit === "tail") {
    const flat = fitToLength([groups.flat()], options.fitMinutes * 60, durationOf);
    const dropped = new Set(flat.dropped);
    fitted = {
      kept: groups.map((group) => group.filter((item) => !dropped.has(item))),
      dropped: flat.dropped,
      seconds: flat.seconds,
    };
  } else {
    fitted = fitToLength(groups, options.fitMinutes * 60, durationOf);
  }
  return {
    ...fitted,
    ordered: orderGroups(fitted.kept, options.order ?? "by-artist", options.random),
  };
}

/** A length as "58 min", "1 h" or "1 h 19 min" (rounded to the minute). */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * A one-line preview of the play order: "Plays as A, B, C, and so on." with
 * the first `shown` titles (default 6), or the whole list when it is short.
 */
export function playsAs(titles: readonly string[], shown = 6): string {
  if (titles.length === 0) {
    return "Nothing ticked yet.";
  }
  if (titles.length > shown) {
    return `Plays as ${titles.slice(0, shown).join(", ")}, and so on.`;
  }
  if (titles.length === 1) {
    return `Plays as ${titles[0]}.`;
  }
  return `Plays as ${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}.`;
}
