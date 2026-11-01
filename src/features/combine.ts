/**
 * Combine playlists: merge two or more track lists into one, or compare them.
 *
 * Each input is a playlist or your favourites. The tracks of every input are
 * grouped into *songs*: by track id, and (by default) by the deduplicator's
 * matching too -- a shared ISRC or normalised artist+title -- so a remaster in
 * one playlist and the original in another count as the same song. Then:
 *
 *   - `merge` keeps every song once;
 *   - `only-first` keeps the songs of the first input that no other input has;
 *   - `common` keeps the songs every input has.
 *
 * Where a song has several copies, one is kept (`highest-quality` or `first`),
 * and the kept songs are ordered `sequential`ly (input 1, then 2, ...),
 * `interleave`d (taking turns between the inputs) or `shuffle`d (with an
 * injectable random source, so tests are deterministic).
 *
 * As with every tool, this is split into *resolve* ({@link resolveCombine},
 * returning a reviewable {@link CombinePlan}) and *commit*, which reuses the
 * playlist writers in `playlist-from-artists.ts`. {@link combineTracks} is the
 * pure core.
 */

import type { Playlist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { findDuplicateGroups, selectKeeper, toDedupTrack, type DedupTrack } from "./deduplicate.js";

/** Which songs the result keeps. */
export type CombineMode = "merge" | "only-first" | "common";
export const COMBINE_MODES: readonly CombineMode[] = ["merge", "only-first", "common"];

/** How the result is ordered. */
export type CombineOrder = "sequential" | "interleave" | "shuffle";
export const COMBINE_ORDERS: readonly CombineOrder[] = ["sequential", "interleave", "shuffle"];

/** Which copy of a song that appears more than once is kept. */
export type CombineKeep = "highest-quality" | "first";
export const COMBINE_KEEPS: readonly CombineKeep[] = ["highest-quality", "first"];

/** One input: your favourite tracks or one of your playlists. */
export type CombineSource = { type: "favourites" } | { type: "playlist"; playlistId: number };

/** An input's tracks, with the name it is shown under. */
export interface CombineInput {
  label: string;
  tracks: readonly Track[];
}

export interface CombineOptions {
  /** Default `merge`. */
  mode?: CombineMode;
  /** Default `sequential`. */
  order?: CombineOrder;
  /** Default `highest-quality`. */
  keep?: CombineKeep;
  /**
   * Also treat tracks as the same song when the deduplicator matches them (ISRC
   * or normalised artist+title), not only when their ids are equal. Default on.
   */
  matchSongs?: boolean;
  /** Random source in [0, 1) for `shuffle`; default `Math.random`. */
  random?: () => number;
}

/** A song in the result: the copy kept, and which inputs (0-based) have the song. */
export interface CombinedTrack {
  track: Track;
  inputs: number[];
}

/** How the inputs overlap, counted in songs (not copies). */
export interface CombineCounts {
  /** Distinct songs in each input. */
  perInput: number[];
  /** Songs found in that input and in no other. */
  onlyIn: number[];
  /** Songs found in at least two inputs. */
  shared: number;
  /** Songs found in every input. */
  inAll: number;
  /** Distinct songs across all inputs. */
  songs: number;
  /** Songs in the result. */
  result: number;
}

/** The reviewable outcome of a combine: the ordered result and the overlap. */
export interface CombinePlan {
  /** The inputs' labels, in input order. */
  labels: string[];
  tracks: CombinedTrack[];
  counts: CombineCounts;
  /** A suggested name for a new playlist, e.g. "Road Trip + Late Night". */
  suggestedName: string;
}

/** The client surface needed to read the inputs. */
export interface CombineClient {
  getFavoriteTracks(): Promise<Track[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getUserPlaylists(): Promise<Playlist[]>;
}

/** The label used for the favourites input. */
export const FAVOURITES_LABEL = "Favourites";

/**
 * Why a list of sources cannot be combined, or undefined if it can: at least
 * two are needed, and each may appear only once.
 */
export function sourcesProblem(sources: readonly CombineSource[]): string | undefined {
  if (sources.length < 2) {
    return "choose at least two playlists to combine";
  }
  const keys = sources.map((s) => (s.type === "favourites" ? "favourites" : `p${s.playlistId}`));
  if (new Set(keys).size !== keys.length) {
    return "each playlist can be used only once";
  }
  return undefined;
}

/**
 * Fetch each source's tracks (concurrently, keeping input order) and combine
 * them into a reviewable plan (phase one; nothing is written).
 *
 * @throws {Error} if {@link sourcesProblem} rejects the sources.
 */
export async function resolveCombine(
  client: CombineClient,
  sources: readonly CombineSource[],
  options: CombineOptions = {},
): Promise<CombinePlan> {
  const problem = sourcesProblem(sources);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const needsNames = sources.some((s) => s.type === "playlist");
  const playlists = needsNames ? await client.getUserPlaylists() : [];
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const inputs = await mapWithConcurrency(
    sources,
    DEFAULT_CONCURRENCY,
    async (source): Promise<CombineInput> =>
      source.type === "favourites"
        ? { label: FAVOURITES_LABEL, tracks: await client.getFavoriteTracks() }
        : {
            label: names.get(source.playlistId) ?? `Playlist ${source.playlistId}`,
            tracks: await client.getPlaylistTracks(source.playlistId),
          },
  );
  return combineTracks(inputs, options);
}

/** A copy of a track in one input, at its position there. */
interface Copy {
  track: Track;
  input: number;
  position: number;
}

/** All copies of one song, in input order, with the inputs that have it. */
interface Song {
  copies: Copy[];
  inputs: Set<number>;
}

/** Combine already-fetched inputs into a plan (the pure core of the tool). */
export function combineTracks(
  inputs: readonly CombineInput[],
  options: CombineOptions = {},
): CombinePlan {
  const mode = options.mode ?? "merge";
  const order = options.order ?? "sequential";
  const keep = options.keep ?? "highest-quality";
  const matchSongs = options.matchSongs ?? true;

  const copies: Copy[] = inputs.flatMap((input, inputIndex) =>
    input.tracks.map((track, position) => ({ track, input: inputIndex, position })),
  );
  const songs = groupSongs(copies, matchSongs);

  const all = inputs.map((_, i) => i);
  const onlyIn = all.map((i) => songs.filter((s) => s.inputs.size === 1 && s.inputs.has(i)).length);
  const counts: CombineCounts = {
    perInput: all.map((i) => songs.filter((s) => s.inputs.has(i)).length),
    onlyIn,
    shared: songs.filter((s) => s.inputs.size > 1).length,
    inAll: songs.filter((s) => s.inputs.size === inputs.length).length,
    songs: songs.length,
    result: 0,
  };

  const kept = songs.filter((song) => {
    switch (mode) {
      case "merge":
        return true;
      case "only-first":
        return song.inputs.size === 1 && song.inputs.has(0);
      case "common":
        return song.inputs.size === inputs.length;
    }
  });
  const ordered = orderSongs(kept, inputs.length, order, options.random ?? Math.random);
  const tracks = ordered.map((song) => ({
    track: keptCopy(song, keep).track,
    inputs: [...song.inputs].sort((a, b) => a - b),
  }));
  counts.result = tracks.length;

  const labels = inputs.map((input) => input.label);
  return { labels, tracks, counts, suggestedName: labels.join(" + ") };
}

/**
 * Group copies into songs, ordered by each song's first copy (input order, then
 * position). Copies with the same track id are always one song; with
 * `matchSongs`, so are copies the deduplicator groups.
 */
function groupSongs(copies: readonly Copy[], matchSongs: boolean): Song[] {
  // Collapse equal ids first, so the matcher sees each track once.
  const byId = new Map<number, Copy[]>();
  for (const copy of copies) {
    const same = byId.get(copy.track.id);
    if (same === undefined) {
      byId.set(copy.track.id, [copy]);
    } else {
      same.push(copy);
    }
  }
  const idGroups = [...byId.values()];

  let groups: Copy[][] = idGroups;
  if (matchSongs) {
    const dedup = idGroups.map((group) => toDedupTrack(group[0]!.track));
    const groupOf = new Map<DedupTrack, number>(dedup.map((d, i) => [d, i]));
    const merged = new Map<number, Copy[]>(); // keyed by the first id-group's index
    const absorbed = new Set<number>();
    for (const matched of findDuplicateGroups(dedup)) {
      const indexes = matched.map((d) => groupOf.get(d)!).sort((a, b) => a - b);
      merged.set(indexes[0]!, indexes.flatMap((i) => idGroups[i]!));
      for (const i of indexes.slice(1)) {
        absorbed.add(i);
      }
    }
    groups = idGroups.flatMap((group, i) =>
      absorbed.has(i) ? [] : [merged.get(i) ?? group],
    );
  }

  return groups.map((group) => {
    const sorted = [...group].sort(compareCopies);
    return { copies: sorted, inputs: new Set(sorted.map((c) => c.input)) };
  });
}

function compareCopies(a: Copy, b: Copy): number {
  return a.input - b.input || a.position - b.position;
}

/** The copy kept for a song: its first, or its highest-quality (ties: first). */
function keptCopy(song: Song, keep: CombineKeep): Copy {
  const first = song.copies[0]!;
  if (keep === "first" || song.copies.length === 1) {
    return first;
  }
  const dedup = song.copies.map((copy) => toDedupTrack(copy.track));
  const id = selectKeeper(dedup, "highest-quality");
  return song.copies.find((copy) => copy.track.id === id) ?? first;
}

/** Order the kept songs; each song sits where its first copy does. */
function orderSongs(
  songs: readonly Song[],
  inputCount: number,
  order: CombineOrder,
  random: () => number,
): Song[] {
  const sequential = [...songs].sort((a, b) => compareCopies(a.copies[0]!, b.copies[0]!));
  if (order === "sequential") {
    return sequential;
  }
  if (order === "shuffle") {
    return shuffle(sequential, random);
  }
  // Interleave: take turns between the inputs, skipping any that ran out.
  const queues: Song[][] = Array.from({ length: inputCount }, () => []);
  for (const song of sequential) {
    queues[song.copies[0]!.input]!.push(song);
  }
  const result: Song[] = [];
  for (let turn = 0; result.length < sequential.length; turn += 1) {
    for (const queue of queues) {
      const next = queue[turn];
      if (next !== undefined) {
        result.push(next);
      }
    }
  }
  return result;
}

/** A Fisher-Yates shuffle of a copy of `items`, drawing from `random`. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** A small seeded random source (mulberry32), for a reproducible shuffle. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The result's track ids, in order. */
export function combinedTrackIds(plan: CombinePlan): number[] {
  return plan.tracks.map((entry) => entry.track.id);
}

/** Render a plan's overlap and result as a human-readable report (for the CLI). */
export function formatCombineReport(plan: CombinePlan, mode: CombineMode): string {
  const { labels, counts } = plan;
  const lines: string[] = [];
  labels.forEach((label, i) => {
    lines.push(
      `  ${i + 1}. ${label}: ${plural(counts.perInput[i] ?? 0, "song")}, ${counts.onlyIn[i] ?? 0} only here`,
    );
  });
  lines.push(
    labels.length === 2
      ? `  In both: ${counts.shared}`
      : `  In more than one: ${counts.shared}; in all ${labels.length}: ${counts.inAll}`,
  );
  const what =
    mode === "merge"
      ? "every song once"
      : mode === "only-first"
        ? `songs only in ${labels[0] ?? "the first"}`
        : "songs in all of them";
  lines.push("", `Result (${what}): ${plural(counts.result, "track")}`);
  plan.tracks.forEach((entry, i) => {
    const artist = entry.track.artist === undefined ? "" : `${entry.track.artist} - `;
    const version = entry.track.version === undefined ? "" : ` (${entry.track.version})`;
    lines.push(`  ${i + 1}. ${artist}${entry.track.title}${version}`);
  });
  return lines.join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
