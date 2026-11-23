/**
 * What a sync would do, worked out without writing anything.
 *
 * {@link findChanges} compares each copy with how they last matched;
 * {@link planSync} puts the changes together, given what the services said
 * about the songs concerned (matches, and whether a missing song is still
 * offered), or reports the conflicts that stop it.
 */

import { normaliseIsrc } from "../services/isrc.js";
import type { ServiceName, TrackId } from "../services/ids.js";
import type { Track } from "../services/model.js";
import type { SongMatch } from "../features/match.js";
import { mergeOrder, stayingIds } from "../features/playlist-order.js";
import { align, maybeMoved } from "./align.js";
import {
  MANY_REMOVED,
  type Answers,
  type Conflict,
  type Gap,
  type Question,
  type SongRef,
  type SyncBase,
  type SyncSong,
} from "./model.js";

/** One copy as read. */
export interface Copy {
  service: ServiceName;
  name: string;
  /** Every entry, songs and others, in order. */
  entries: Track[];
}

/** A copy's entry as the song it is: one of the base's, or an addition. */
interface Place {
  track: Track;
  /** The base song's index; undefined for an addition. */
  base?: number;
}

export interface CopyChanges {
  service: ServiceName;
  name: string;
  entries: Track[];
  places: Place[];
  /** Base songs no longer on it. */
  removed: number[];
  /** Base songs to put in order again; none when the order is as it was. */
  moved: Set<number>;
  /** Base songs that may be the ones the user moved. */
  maybeMoved: Set<number>;
  additions: Place[];
}

export function refOf(track: Pick<Track, "id" | "title" | "artist">): SongRef {
  return { id: track.id, title: track.title, ...(track.artist !== undefined && { artist: track.artist }) };
}

/** What changed on a copy since the copies last matched. */
export function findChanges(base: SyncBase, copy: Copy): CopyChanges {
  const { service } = copy;
  const songs = copy.entries.filter((track) => track.other === undefined);
  const held = base.songs.flatMap((song, index) => (song.ids[service] === undefined ? [] : [index]));
  const pairs = align(
    held.map((index) => base.songs[index]!.ids[service]!),
    songs.map((track) => track.id),
  );
  const places: Place[] = songs.map((track) => ({ track }));
  const unclaimed: number[] = [];
  held.forEach((index, at) => {
    const place = pairs[at]!;
    if (place === -1) {
      unclaimed.push(index);
    } else {
      places[place]!.base = index;
    }
  });
  // An id the service replaced: the same recording, under another id.
  const removed = unclaimed.filter((index) => {
    const { isrc } = base.songs[index]!;
    const place =
      isrc === undefined
        ? undefined
        : places.find((one) => one.base === undefined && one.track.isrc !== undefined && normaliseIsrc(one.track.isrc) === isrc);
    if (place !== undefined) {
      place.base = index;
    }
    return place === undefined;
  });
  const order = places.flatMap((place) => (place.base === undefined ? [] : [place.base]));
  const asIds = (list: readonly number[]) => list as unknown as Parameters<typeof stayingIds>[0];
  const staying = stayingIds(asIds([...order].sort((a, b) => a - b)), asIds(order)) as unknown as Set<number>;
  return {
    service,
    name: copy.name,
    entries: copy.entries,
    places,
    removed,
    moved: new Set(order.filter((index) => !staying.has(index))),
    maybeMoved: maybeMoved(order),
    additions: places.filter((place) => place.base === undefined),
  };
}

/** Whether a song missing from a copy is still offered there. */
export type Offered = "yes" | "no" | "unknown";

export interface Facts {
  /** The match of a track on a service. */
  match(track: Track, on: ServiceName): SongMatch;
  /** Asked about base songs missing from a copy that had them. */
  offered(id: TrackId, on: ServiceName): Offered;
  answers: Answers;
  /** Look again for songs a service did not have. */
  recheckGaps: boolean;
}

/** How to settle a conflict. */
export type Choice = { use: ServiceName } | { merge: ServiceName };

export interface CopyPlan {
  service: ServiceName;
  before: TrackId[];
  after: TrackId[];
  added: number;
  removed: number;
  moved: boolean;
  rename?: string;
}

export interface SyncPlan {
  base: SyncBase;
  copies: CopyPlan[];
  questions: Question[];
}

/** A song of the merged list. */
interface Item {
  song: SyncSong;
  /** The index in the old base; undefined for a new song. */
  index?: number;
  /** A track of it, to show and to match. */
  track?: Track;
  /** Copies it is not on and must not be put on while a question waits. */
  held: Set<ServiceName>;
}

export function planSync(
  base: SyncBase,
  copies: readonly CopyChanges[],
  facts: Facts,
  choice?: Choice,
): { plan: SyncPlan } | { conflicts: Conflict[] } {
  const services = copies.map((copy) => copy.service);
  const used = choice !== undefined && "use" in choice ? choice.use : undefined;
  const leader = choice === undefined ? undefined : "use" in choice ? choice.use : choice.merge;
  const questions: Question[] = [];
  const conflicts: Conflict[] = [];

  const items: Item[] = base.songs.map((song, index) => ({
    song: {
      ids: { ...song.ids },
      ...(song.gaps !== undefined && { gaps: { ...song.gaps } }),
      ...(song.sameAs !== undefined && { sameAs: { ...song.sameAs } }),
      ...(song.isrc !== undefined && { isrc: song.isrc }),
    },
    index,
    held: new Set(),
  }));
  /** What each entry stands for; entries of songs that wait stand for nothing. */
  const itemOf = new Map<Track, Item>();
  for (const copy of copies) {
    for (const { track, base: index } of copy.places) {
      if (index !== undefined) {
        const item = items[index]!;
        item.track ??= track;
        item.song.ids[copy.service] = track.id; // it may have been replaced
        itemOf.set(track, item);
      }
    }
  }

  // ---- Additions ------------------------------------------------------------
  const fresh: { item: Item; copy: CopyChanges; track: Track }[] = [];
  const isrcOf = (track: Track): string | undefined => (track.isrc === undefined ? undefined : normaliseIsrc(track.isrc));
  const changed = (copy: CopyChanges, index: number): "moved" | "duplicated" | undefined => {
    if (copy.maybeMoved.has(index)) {
      return "moved";
    }
    const id = items[index]!.song.ids[copy.service];
    return copy.additions.some((place) => place.track.id === id) ? "duplicated" : undefined;
  };
  for (const copy of copies) {
    if (used !== undefined && copy.service !== used) {
      continue; // "use that copy": what the others added goes
    }
    for (const { track } of copy.additions) {
      if (itemOf.has(track)) {
        continue; // joined to another copy's addition already
      }
      // A song that was missing here, added by hand.
      const gap = items.find(
        (item) =>
          item.song.ids[copy.service] === undefined && item.song.isrc !== undefined && item.song.isrc === isrcOf(track),
      );
      if (gap !== undefined) {
        fill(gap, copy.service, track);
        itemOf.set(track, gap);
        continue;
      }
      const item: Item = {
        song: { ids: { [copy.service]: track.id }, ...(isrcOf(track) !== undefined && { isrc: isrcOf(track)! }) },
        track,
        held: new Set(),
      };
      let waits = false;
      let known: Item | undefined;
      const joins: Track[] = [];
      for (const other of copies) {
        if (other === copy) {
          continue;
        }
        // Added there too: the same recording, or the match.
        const open = other.additions.filter((place) => !itemOf.has(place.track) && !joins.includes(place.track));
        const twin =
          used !== undefined ? undefined : open.find((place) => isrcOf(place.track) !== undefined && isrcOf(place.track) === item.song.isrc);
        if (twin !== undefined) {
          item.song.ids[other.service] = twin.track.id;
          joins.push(twin.track);
          continue;
        }
        const match = facts.match(track, other.service);
        if (match.grade === "likely") {
          questions.push({
            kind: "match",
            key: `match ${track.id} ${other.service}`,
            song: refOf(track),
            on: other.service,
            options: match.options.map(refOf),
            ...(match.reason !== undefined && { reason: match.reason }),
          });
          waits = true;
        } else if (match.failed !== undefined) {
          waits = true; // asked again next time
        } else if (match.track === undefined) {
          setGap(item, other.service, "not-found");
        } else {
          const id = match.track.id;
          const joined = used !== undefined ? undefined : open.find((place) => place.track.id === id);
          const there = items.find((one) => one.song.ids[other.service] === id);
          if (joined !== undefined) {
            item.song.ids[other.service] = id;
            joins.push(joined.track);
          } else if (there === undefined || there.song.ids[copy.service] === track.id) {
            item.song.ids[other.service] = id; // new there, or one more of a repeated song
          } else if (there.song.ids[copy.service] === undefined || !onCopy(copy, there)) {
            known = there; // that song, which this copy lacked or lost
          } else {
            setGap(item, other.service, "same-as");
            item.song.sameAs = { ...item.song.sameAs, [other.service]: id };
          }
        }
      }
      if (known !== undefined) {
        fill(known, copy.service, track);
        itemOf.set(track, known);
      } else if (!waits) {
        items.push(item);
        fresh.push({ item, copy, track });
        itemOf.set(track, item);
        joins.forEach((one) => itemOf.set(one, item));
      }
    }
  }
  function onCopy(copy: CopyChanges, item: Item): boolean {
    return copy.places.some((place) => itemOf.get(place.track) === item);
  }

  // ---- Songs a service did not have, looked for again -----------------------
  if (facts.recheckGaps) {
    for (const item of items) {
      for (const service of services) {
        if (item.song.gaps?.[service] === "not-found" && item.track !== undefined && item.index !== undefined) {
          const match = facts.match(item.track, service);
          if (match.grade === "exact" && match.track !== undefined) {
            const id = match.track.id;
            if (!items.some((one) => one.song.ids[service] === id)) {
              fill(item, service, match.track);
            }
          } else if (match.grade === "likely") {
            questions.push({
              kind: "match",
              key: `match ${item.track.id} ${service}`,
              song: refOf(item.track),
              on: service,
              options: match.options.map(refOf),
              ...(match.reason !== undefined && { reason: match.reason }),
            });
          }
        }
      }
    }
  }

  // ---- Removals -------------------------------------------------------------
  const dropped = new Set<Item>();
  const hasIt = (copy: CopyChanges, item: Item): boolean => onCopy(copy, item);
  for (const copy of copies) {
    // Refilled above (removed and added again under another id): not removed.
    const removed = copy.removed.filter((index) => !onCopy(copy, items[index]!));
    const spreading = removed.filter((index) => copies.some((other) => other !== copy && hasIt(other, items[index]!)));
    const of = base.songs.filter((song) => song.ids[copy.service] !== undefined).length;
    if (
      choice === undefined &&
      spreading.length > 0 &&
      (removed.length === of || (removed.length >= MANY_REMOVED.songs && removed.length >= of * MANY_REMOVED.share))
    ) {
      conflicts.push({ kind: "many-removed", service: copy.service, removed: removed.length, of });
      continue;
    }
    for (const index of removed) {
      const item = items[index]!;
      const id = base.songs[index]!.ids[copy.service]!;
      if (used !== undefined) {
        if (copy.service === used) {
          dropped.add(item);
        }
        continue; // the others get it back
      }
      if (!spreading.includes(index)) {
        dropIfNowhere(item, copy.service);
        continue;
      }
      const key = `removed ${id}`;
      const answer = facts.answers[key];
      const offered: Offered =
        answer === "removed" ? "yes" : answer === "withdrawn" || answer === "keep" ? "no" : facts.offered(id, copy.service);
      const song = refOf(item.track ?? { id, title: id });
      const aliases = items.filter((one) => one.song.sameAs?.[copy.service] === id);
      if (offered === "no") {
        delete item.song.ids[copy.service];
        setGap(item, copy.service, "withdrawn");
      } else if (offered === "unknown") {
        questions.push({ kind: "removed-or-withdrawn", key, song: { ...song, id }, service: copy.service });
        item.held.add(copy.service);
      } else if (aliases.length > 0 && answer === undefined) {
        questions.push({
          kind: "which-was-removed",
          key,
          songs: [{ ...song, id }, ...aliases.map((one) => refOf(one.track ?? { id, title: id }))],
          service: copy.service,
        });
        item.held.add(copy.service);
      } else {
        const clash = copies
          .filter((other) => other !== copy)
          .flatMap((other) => {
            const change = changed(other, index);
            return change === undefined ? [] : [{ other, change }];
          })[0];
        if (clash !== undefined && choice === undefined) {
          conflicts.push({
            kind: "removed-and-changed",
            song,
            removedOn: copy.service,
            changedOn: clash.other.service,
            change: clash.change,
          });
        } else if (clash === undefined) {
          dropped.add(item);
          aliases.forEach((one) => dropped.add(one));
        }
        // Merging keeps what another copy changed: it goes back where it was removed.
      }
    }
  }

  // ---- Repeats a copy kept, as it could not take one out alone ---------------
  for (const item of items) {
    if (item.index === undefined || dropped.has(item) || !Object.values(item.song.gaps ?? {}).includes("left-out")) {
      continue;
    }
    for (const copy of copies) {
      const id = item.song.ids[copy.service];
      if (id === undefined || !onCopy(copy, item)) {
        continue;
      }
      const key = `repeated ${id}`;
      const answer = facts.answers[key];
      if (answer === "removed") {
        dropped.add(item);
      } else if (answer === "keep") {
        for (const [service, gap] of Object.entries(item.song.gaps!)) {
          if (gap === "left-out") {
            setGap(item, service as ServiceName, "only-there");
          }
        }
      } else {
        questions.push({ kind: "repeated", key, song: refOf(item.track ?? { id, title: id }), service: copy.service });
      }
    }
  }

  function dropIfNowhere(item: Item, _service: ServiceName): void {
    if (!copies.some((copy) => hasIt(copy, item))) {
      dropped.add(item);
    }
  }

  // ---- Names and order ------------------------------------------------------
  const renamed = copies.filter((copy) => copy.name !== base.name);
  const names = new Set(renamed.map((copy) => copy.name));
  if (names.size > 1 && choice === undefined) {
    conflicts.push({ kind: "renamed", names: renamed.map(({ service, name }) => ({ service, name })) });
  }
  const name =
    copies.find((copy) => copy.service === leader && (used !== undefined || copy.name !== base.name))?.name ??
    renamed[0]?.name ??
    base.name;

  const orderOf = (copy: CopyChanges): number[] =>
    copy.places.flatMap((place) => {
      const index = itemOf.get(place.track)?.index;
      return index === undefined || dropped.has(items[index]!) ? [] : [index];
    });
  const reordered = copies.filter((copy) => [...copy.moved].some((index) => !dropped.has(items[index]!)));
  const first = reordered[0];
  if (first !== undefined && choice === undefined) {
    const differing = reordered.filter((copy) => {
      const common = new Set(orderOf(copy));
      const mine = orderOf(first).filter((index) => common.has(index));
      const ours = new Set(mine);
      return orderOf(copy)
        .filter((index) => ours.has(index))
        .some((index, at) => index !== mine[at]);
    });
    if (differing.length > 0) {
      conflicts.push({ kind: "reordered", services: [first, ...differing].map((copy) => copy.service) });
    }
  }
  if (conflicts.length > 0) {
    return { conflicts };
  }
  const winner = copies.find((copy) => copy.service === leader && (used !== undefined || reordered.includes(copy))) ?? first;

  // ---- The merged list ------------------------------------------------------
  const baseOrder = base.songs.map((_, index) => index);
  const ordered =
    winner === undefined
      ? baseOrder
      : (mergeOrder(
          baseOrder as unknown as Parameters<typeof mergeOrder>[0],
          unique(orderOf(winner)) as unknown as Parameters<typeof mergeOrder>[1],
        ) as unknown as number[]);
  const merged: Item[] = ordered.map((index) => items[index]!).filter((item) => !dropped.has(item));
  for (const { item, copy, track } of fresh) {
    // After the nearest song before it on its copy that the list has.
    const at = copy.places.findIndex((place) => place.track === track);
    let after = -1;
    for (let before = at - 1; before >= 0 && after === -1; before -= 1) {
      const previous = itemOf.get(copy.places[before]!.track);
      after = previous === undefined ? -1 : merged.indexOf(previous);
    }
    merged.splice(after + 1, 0, item);
  }

  // ---- Each copy ------------------------------------------------------------
  const copyPlans = copies.map((copy): CopyPlan => {
    const { service } = copy;
    const want = merged.filter((item) => item.song.ids[service] !== undefined && !item.held.has(service));
    const keep = new Set(want);
    const before = copy.entries.map((track) => track.id);
    // Entries that stand for no song of the list (others, and songs that wait)
    // stay, each after the entry it follows.
    const stays = copy.entries.filter((track) => {
      const item = itemOf.get(track);
      return item === undefined ? track.other !== undefined || used === undefined || service === used : keep.has(item);
    });
    const current = stays.map((_, index) => index);
    const placeOf = new Map<Item, number>();
    stays.forEach((track, index) => {
      const item = itemOf.get(track);
      if (item !== undefined && !placeOf.has(item)) {
        placeOf.set(item, index);
      }
    });
    const existing = want.flatMap((item) => placeOf.get(item) ?? []);
    const sequence = mergeOrder(
      current as unknown as Parameters<typeof mergeOrder>[0],
      existing as unknown as Parameters<typeof mergeOrder>[1],
    ) as unknown as number[];
    const after = sequence.map((index) => stays[index]!.id);
    const whose: (Item | undefined)[] = sequence.map((index) => itemOf.get(stays[index]!));
    let added = 0;
    want.forEach((item, position) => {
      if (placeOf.has(item)) {
        return;
      }
      const previous = want
        .slice(0, position)
        .reverse()
        .map((one) => whose.indexOf(one))
        .find((place) => place !== -1);
      after.splice((previous ?? -1) + 1, 0, item.song.ids[service]!);
      whose.splice((previous ?? -1) + 1, 0, item);
      added += 1;
    });
    return {
      service,
      before,
      after,
      added,
      removed: copy.entries.length - stays.length,
      moved: sequence.some((index, at) => at > 0 && index < sequence[at - 1]!),
      ...(copy.name !== name && { rename: name }),
    };
  });

  return {
    plan: {
      base: {
        name,
        songs: merged
          .filter((item) => Object.keys(item.song.ids).length > 0)
          .map((item) => item.song),
      },
      copies: copyPlans.filter((copy) => copy.rename !== undefined || copy.added > 0 || copy.removed > 0 || copy.moved),
      questions: uniqueBy(questions, (question) => question.key),
    },
  };

  function setGap(item: Item, service: ServiceName, gap: Gap): void {
    item.song.gaps = { ...item.song.gaps, [service]: gap };
  }

  function fill(item: Item, service: ServiceName, track: Track): void {
    item.song.ids[service] = track.id;
    if (item.song.gaps !== undefined) {
      delete item.song.gaps[service];
      if (Object.keys(item.song.gaps).length === 0) {
        delete item.song.gaps;
      }
    }
    if (item.song.sameAs !== undefined) {
      delete item.song.sameAs[service];
      if (Object.keys(item.song.sameAs).length === 0) {
        delete item.song.sameAs;
      }
    }
  }
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

function uniqueBy<T>(list: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => !seen.has(key(item)) && seen.add(key(item)));
}
