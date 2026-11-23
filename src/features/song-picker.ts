/**
 * Plan-wide track exclusions: "skip tracks already in my Favourites" and "one
 * copy of each song".
 *
 * Unlike a {@link TrackFilter}, which judges each track on its own, these
 * depend on the rest of the run: what is in the user's favourites, and which
 * songs the plan has already taken. A {@link SongPicker} holds that state. The
 * playlist builders ask it about each track in plan order
 * ({@link SongPicker.exclusion}) and tell it what they kept
 * ({@link SongPicker.take}) or passed over ({@link SongPicker.skip}); an
 * excluded track is reported like a filtered one (listed unticked on the web,
 * replaced by the next most popular in the top-track tools).
 *
 * Songs are matched the way the deduplicator matches them: the same track id,
 * the same ISRC, or the same normalised artist and title -- with the version
 * label counted as part of the title, so edition noise ("2011 Remaster") is
 * ignored but a live take or a remix stays a different song.
 *
 * The state serialises ({@link SongPicker.state}), so the web UI can carry one
 * run across several requests (the similar-artists tool fetches its tracks in
 * batches) and the favourites are fetched once per run.
 */

import type { Track } from "../services/model.js";
import { toDedupTrack, trackSignature } from "./deduplicate.js";
import type { Exclusion } from "./track-filter.js";

/** The plan-wide options, as the CLI flags and API requests give them. */
export interface SongPickerOptions {
  /** Exclude tracks already in the user's favourites (as songs, not just ids). */
  skipFavourites?: boolean;
  /** Exclude later copies of a song already in the plan. */
  oneCopy?: boolean;
}

/** A picker's serialisable state. */
export interface SongPickerState {
  oneCopy: boolean;
  /** Song keys of the favourites; absent when favourites are not skipped. */
  favourites?: string[];
  /** Song keys already in the plan, each with the title of its first copy. */
  seen: [string, string][];
}

/** "Title (Version)", as Qobuz displays a track. */
function labelOf(track: Track): string {
  return track.version === undefined ? track.title : `${track.title} (${track.version})`;
}

/**
 * The keys a track is matched on: its id, its ISRC (when known) and its
 * normalised artist and title-with-version (when the artist is known).
 */
export function songKeys(track: Track): string[] {
  const keys = [`id:${track.id}`];
  if (track.isrc !== undefined && track.isrc.length > 0) {
    keys.push(`isrc:${track.isrc}`);
  }
  if (track.artist !== undefined && track.artist.trim().length > 0) {
    keys.push(`sig:${trackSignature(toDedupTrack(track))}`);
  }
  return keys;
}

export class SongPicker {
  readonly #oneCopy: boolean;
  readonly #favourites: ReadonlySet<string> | undefined;
  readonly #seen = new Map<string, string>();

  constructor(options: {
    oneCopy: boolean;
    favourites?: Iterable<string>;
    seen?: Iterable<readonly [string, string]>;
  }) {
    this.#oneCopy = options.oneCopy;
    this.#favourites = options.favourites === undefined ? undefined : new Set(options.favourites);
    for (const [key, title] of options.seen ?? []) {
      this.#seen.set(key, title);
    }
  }

  /** A picker that skips these favourite tracks. */
  static fromFavourites(favourites: readonly Track[], options: { oneCopy: boolean }): SongPicker {
    return new SongPicker({ oneCopy: options.oneCopy, favourites: favourites.flatMap(songKeys) });
  }

  /** Resume a run from {@link state}. */
  static fromState(state: SongPickerState): SongPicker {
    return new SongPicker({
      oneCopy: state.oneCopy,
      ...(state.favourites !== undefined && { favourites: state.favourites }),
      seen: state.seen,
    });
  }

  /** True when it can exclude anything. */
  get active(): boolean {
    return this.#oneCopy || this.#favourites !== undefined;
  }

  /**
   * Why this track should be left out (a favourite, or a later copy of a song
   * already taken), or undefined to keep it. Does not record anything.
   */
  exclusion(track: Track): Exclusion | undefined {
    const keys = songKeys(track);
    if (this.#favourites !== undefined && keys.some((key) => this.#favourites!.has(key))) {
      return { kind: "favourite" };
    }
    const of = this.#firstCopy(keys);
    return of === undefined ? undefined : { kind: "repeat", of };
  }

  /** Record a track the plan kept, so later copies of its song are repeats. */
  take(track: Track): void {
    if (!this.#oneCopy) {
      return;
    }
    const keys = songKeys(track);
    const title = this.#firstCopy(keys) ?? labelOf(track);
    this.#remember(keys, title);
  }

  /**
   * Record a track the plan passed over. Only a repeat matters: its keys are
   * remembered under the first copy's title, so a copy matching only it is
   * still recognised as the same song (as the deduplicator chains matches).
   */
  skip(track: Track): void {
    if (!this.#oneCopy) {
      return;
    }
    const keys = songKeys(track);
    const of = this.#firstCopy(keys);
    if (of !== undefined) {
      this.#remember(keys, of);
    }
  }

  /** The state to carry the run on with {@link fromState}. */
  state(): SongPickerState {
    return {
      oneCopy: this.#oneCopy,
      ...(this.#favourites !== undefined && { favourites: [...this.#favourites] }),
      seen: [...this.#seen],
    };
  }

  #firstCopy(keys: readonly string[]): string | undefined {
    if (!this.#oneCopy) {
      return undefined;
    }
    for (const key of keys) {
      const title = this.#seen.get(key);
      if (title !== undefined) {
        return title;
      }
    }
    return undefined;
  }

  #remember(keys: readonly string[], title: string): void {
    for (const key of keys) {
      if (!this.#seen.has(key)) {
        this.#seen.set(key, title);
      }
    }
  }
}

/** The client surface needed to skip favourites. */
export interface FavouriteTracksClient {
  getFavoriteTracks(): Promise<Track[]>;
}

/**
 * A picker for these options, fetching the favourites (once) only when they
 * are to be skipped.
 */
export async function createSongPicker(
  client: FavouriteTracksClient,
  options: SongPickerOptions,
): Promise<SongPicker> {
  const oneCopy = options.oneCopy ?? false;
  if (options.skipFavourites !== true) {
    return new SongPicker({ oneCopy });
  }
  return SongPicker.fromFavourites(await client.getFavoriteTracks(), { oneCopy });
}

/**
 * Validate a picker state sent back by the web UI.
 *
 * @throws {Error} if it is not a well-formed state.
 */
export function parseSongPickerState(raw: unknown): SongPickerState {
  const fail = (): never => {
    throw new Error("picker must be the state a previous response returned");
  };
  if (typeof raw !== "object" || raw === null) {
    return fail();
  }
  const record = raw as Record<string, unknown>;
  const { oneCopy, favourites, seen } = record;
  if (typeof oneCopy !== "boolean") {
    return fail();
  }
  if (
    favourites !== undefined &&
    !(Array.isArray(favourites) && favourites.every((key) => typeof key === "string"))
  ) {
    return fail();
  }
  const pairs = seen ?? [];
  if (
    !Array.isArray(pairs) ||
    !pairs.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    )
  ) {
    return fail();
  }
  return {
    oneCopy,
    ...(favourites !== undefined && { favourites: favourites as string[] }),
    seen: pairs as [string, string][],
  };
}
