/**
 * What the sources share: their result shape, the similar-artist snapshot,
 * caps, and a stable shuffle.
 *
 * Every source must be deterministic for the same inputs and state -- a
 * reconciler that gets a different answer each pass churns the playlist.
 */

import type { PlaylistId } from "../../services/ids.js";
import type { Artist } from "../../services/model.js";
import { fitToLength } from "../../features/playlist-shape.js";
import {
  seedsFromPlaylist,
  walkSimilarArtists,
  type SimilarArtistsClient,
} from "../../features/similar-artists.js";
import { NO_FILTER, type TrackFilter } from "../../features/track-filter.js";
import type { ArtistRef, FeedArtists, Shape, SimilarSpec, SourceState } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";

export interface RecipeContext<S> {
  now: Date;
  jobId: string;
  state: S;
}

export interface RecipeResult {
  /** The desired tracks, in order. */
  tracks: DesiredTrack[];
  /** False when something failed to load: the refresh then removes nothing. */
  complete: boolean;
  notes: string[];
  /** The similar-artist snapshot to keep (unchanged unless refreshed). */
  similar?: SourceState["similar"];
}

/** What every source returns: desired tracks and its new state. */
export interface SourceResult {
  tracks: DesiredTrack[];
  complete: boolean;
  notes: string[];
  state: SourceState;
}

const DAY_MS = 86_400_000;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SeedArtistsClient {
  getFavoriteArtists(): Promise<Artist[]>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<import("../../services/model.js").Track[]>;
}

/** A source's own artists: as listed, or read live (favourites, a playlist's). */
export async function seedArtists(client: SeedArtistsClient, artists: FeedArtists): Promise<Artist[]> {
  const list: readonly ArtistRef[] =
    artists.type === "list"
      ? artists.artists
      : artists.type === "favourites"
        ? await client.getFavoriteArtists()
        : seedsFromPlaylist(await client.getPlaylistTracks(artists.playlistId), Infinity).seeds;
  const seen = new Set<number>();
  return list
    .filter((artist) => !seen.has(artist.id) && seen.add(artist.id))
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The similar-artist snapshot: the previous one while younger than
 * `refreshDays`, otherwise a fresh walk. A failed walk keeps the previous
 * snapshot and says so (the caller marks the result incomplete).
 */
export async function similarSnapshot(
  client: Pick<SimilarArtistsClient, "getSimilarArtists">,
  seeds: readonly Artist[],
  spec: SimilarSpec,
  previous: SourceState["similar"],
  now: Date,
  filter: TrackFilter = NO_FILTER,
): Promise<{ similar: SourceState["similar"]; failure?: string }> {
  const age = previous === undefined ? Infinity : now.getTime() - Date.parse(previous.takenAt);
  if (age <= spec.refreshDays * DAY_MS) {
    return { similar: previous };
  }
  try {
    const walk = await walkSimilarArtists(client, {
      seeds: [...seeds],
      similarPerArtist: spec.perArtist,
      depth: 1,
      filter,
    });
    return {
      similar: {
        takenAt: now.toISOString(),
        artists: walk.found.map(({ artist }) => ({ id: artist.id, name: artist.name })),
      },
    };
  } catch (error) {
    return {
      similar: previous,
      failure: `Similar artists could not be refreshed (${message(error)}); kept the previous list.`,
    };
  }
}

/** Apply the track caps (`maxTracks`, then `maxMinutes`) to a desired list. */
export function applyShape(tracks: readonly DesiredTrack[], shape: Shape | undefined): DesiredTrack[] {
  let out = [...tracks];
  if (shape?.maxTracks !== undefined) {
    out = out.slice(0, shape.maxTracks);
  }
  if (shape?.maxMinutes !== undefined && out.length > 0) {
    out = fitToLength([out], shape.maxMinutes * 60, (t) => t.durationSeconds).kept[0] ?? [];
  }
  return out;
}

/** 32-bit FNV-1a of a string. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A shuffle that is stable as the list changes: items are ordered by a hash of
 * the seed and their id, so adding or removing one leaves the others' order
 * alone (a seeded Fisher-Yates would reshuffle everything, churning a
 * mirrored playlist).
 */
export function stableShuffle<T>(seed: string, items: readonly T[], idOf: (item: T) => number): T[] {
  return items
    .map((item) => ({ item, rank: hashText(`${seed}:${idOf(item)}`) }))
    .sort((a, b) => a.rank - b.rank || idOf(a.item) - idOf(b.item))
    .map(({ item }) => item);
}
