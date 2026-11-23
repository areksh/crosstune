/**
 * Playlist entries on a service that gives them no ids.
 *
 * An entry is named by its song and which copy of it, `<native>#<n>`, counted
 * when the playlist is read. Spotify's writes name songs (all copies at once) or
 * positions; the plans here turn changes to entries into those. Pure.
 */

import { applyMove, stayingIds } from "../../features/playlist-order.js";
import { nativeOf, tagId } from "../ids.js";
import type { EntryId } from "../model.js";
import { nativeOfUri } from "./uris.js";

/** The playlist's URIs in order; undefined for a place that cannot be read. */
export type Uris = readonly (string | undefined)[];

/** A playlist as last read or left: each place's URI and the id it goes by. */
export interface View {
  uris: Uris;
  ids: readonly EntryId[];
}

/** The most entries moved in one request (Spotify names no limit). */
export const MAX_MOVED_AT_ONCE = 100;

export function numberEntries(uris: Uris): EntryId[] {
  const copies = new Map<string, number>();
  return uris.map((uri) => {
    const native = nativeOfUri(uri) ?? "unreadable";
    const copy = (copies.get(native) ?? 0) + 1;
    copies.set(native, copy);
    return tagId<EntryId>("spotify", `${native}#${copy}`);
  });
}

/** The playlist after `added` went to its end; they get ids it has not used. */
export function appendEntries({ uris, ids }: View, added: readonly string[]): View {
  const last = new Map<string, number>();
  for (const id of ids) {
    const native = nativeOf("spotify", id);
    const track = trackNativeOf(native);
    last.set(track, Math.max(last.get(track) ?? 0, Number(native.slice(track.length + 1))));
  }
  const fresh = added.map((uri) => {
    const native = nativeOfUri(uri) ?? "unreadable";
    const copy = (last.get(native) ?? 0) + 1;
    last.set(native, copy);
    return tagId<EntryId>("spotify", `${native}#${copy}`);
  });
  return { uris: [...uris, ...added], ids: [...ids, ...fresh] };
}

/** The native track id in an entry id's own native part. */
export function trackNativeOf(entryNative: string): string {
  const mark = entryNative.lastIndexOf("#");
  return mark < 0 ? entryNative : entryNative.slice(0, mark);
}

/**
 * The entries of the playlist as it is now. When it is as `known` left it, they
 * go by the same ids, so ids stay good through our own changes; otherwise
 * somebody else changed it, and they are counted afresh.
 */
export function identify(uris: Uris, known: View | undefined): View & { changed: boolean } {
  if (known !== undefined && known.uris.length === uris.length && known.uris.every((uri, i) => uri === uris[i])) {
    return { uris, ids: known.ids, changed: false };
  }
  return { uris, ids: numberEntries(uris), changed: known !== undefined };
}

/**
 * Where entries are now (0-based, each once); undefined if one is no longer
 * there, or if the playlist changed and it cannot be told which copy was meant.
 */
export function findEntries(
  now: View & { changed: boolean },
  known: View | undefined,
  wanted: readonly EntryId[],
): number[] | undefined {
  const places = new Map(now.ids.map((id, place) => [id, place]));
  const copies = (uris: Uris, uri: string | undefined): number => uris.filter((other) => other === uri).length;
  const found: number[] = [];
  for (const id of new Set(wanted)) {
    const place = places.get(id);
    if (place === undefined) {
      return undefined;
    }
    const uri = now.uris[place];
    if (now.changed && (copies(now.uris, uri) > 1 || copies(known?.uris ?? [], uri) > 1)) {
      return undefined;
    }
    found.push(place);
  }
  return found;
}

export interface Removal {
  /** Songs no copy of which stays. */
  whole: string[];
  /**
   * Songs some copies of which stay, each with where those are (0-based) once
   * this song is dealt with, in this order and after `whole`.
   */
  repeated: { uri: string; keptAt: number[] }[];
}

/** How to remove the entries at `going`, as Spotify removes every copy of a song at once. */
export function planRemoval(uris: Uris, going: ReadonlySet<number>): Removal {
  const asked = new Set([...going].sort((a, b) => a - b).flatMap((place) => uris[place] ?? []));
  const keeps = new Set(uris.filter((_, place) => !going.has(place)));
  const whole = [...asked].filter((uri) => !keeps.has(uri));
  let list = uris.map((uri, place) => ({ uri, goes: going.has(place) }));
  list = list.filter(({ uri }) => uri === undefined || keeps.has(uri));
  const repeated = [...asked]
    .filter((uri) => keeps.has(uri))
    .map((uri) => {
      list = list.filter((item) => !(item.goes && item.uri === uri));
      return { uri, keptAt: list.flatMap((item, place) => (item.uri === uri ? [place] : [])) };
    });
  return { whole, repeated };
}

/** `length` entries from `start` go in front of the one at `before` (0-based, in the list as it is). */
export interface RangeMove {
  start: number;
  length: number;
  before: number;
}

/** The moves that spread copies, put together at the first of `places`, over all of them. */
export function spreadMoves(places: readonly number[]): RangeMove[] {
  const first = places[0] ?? 0;
  return places
    .map((place, i) => ({ start: first + i, length: 1, before: place + 1 }))
    .filter(({ start, before }) => before !== start + 1)
    .reverse();
}

/** What a range move does to a list. */
export function applyRange<T>(list: readonly T[], { start, length, before }: RangeMove): T[] {
  const moving = list.slice(start, start + length);
  const ahead = list.slice(0, before).filter((_, place) => place < start || place >= start + length);
  const after = list.slice(before).filter((_, i) => before + i < start || before + i >= start + length);
  return [...ahead, ...moving, ...after];
}

/** The order after moving entries, in the order given, in front of `anchor` (or to the end). */
export function orderAfterMove(ids: readonly EntryId[], moved: readonly EntryId[], anchor: EntryId | undefined): EntryId[] {
  return applyMove(ids, moved, anchor === undefined ? ids.length + 1 : ids.indexOf(anchor) + 1);
}

/**
 * The range moves that turn `current` into `wanted`: what can stay stays, and
 * neighbours that stay neighbours move together, first to last.
 */
export function rangeMoves(
  current: readonly EntryId[],
  wanted: readonly EntryId[],
  longest: number = MAX_MOVED_AT_ONCE,
): RangeMove[] {
  const staying = stayingIds(current, wanted);
  let list: readonly EntryId[] = current;
  const moves: RangeMove[] = [];
  for (let i = 0; i < wanted.length; ) {
    if (staying.has(wanted[i]!)) {
      i += 1;
      continue;
    }
    const start = list.indexOf(wanted[i]!);
    let length = 1;
    while (
      length < longest &&
      i + length < wanted.length &&
      !staying.has(wanted[i + length]!) &&
      list[start + length] === wanted[i + length]
    ) {
      length += 1;
    }
    const before = i === 0 ? 0 : list.indexOf(wanted[i - 1]!) + 1;
    if (before !== start) {
      const move = { start, length, before };
      moves.push(move);
      list = applyRange(list, move);
    }
    i += length;
  }
  return moves;
}
