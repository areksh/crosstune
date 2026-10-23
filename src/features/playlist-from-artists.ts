/**
 * Build a playlist from a list of artist names.
 *
 * The work splits into two phases so a caller can review and edit between them
 * (the web UI does exactly this):
 *
 *   1. *Resolve* -- turn each name into a Qobuz artist and gather that artist's
 *      top tracks. Names that cannot be resolved are reported, not fatal.
 *   2. *Commit* -- create a new playlist from chosen tracks, or add them to an
 *      existing one (skipping tracks already present).
 *
 * {@link buildPlaylistFromArtists} composes both phases in one call for the CLI.
 * An optional {@link TrackFilter} excludes tracks by title or album; excluded
 * tracks are replaced by the artist's next most popular ones, and those passed
 * over are reported so the web UI can offer them unticked.
 * Each function depends only on the small client surface it needs, so all are
 * unit-testable against stubs; QobuzClient satisfies them structurally.
 */

import type { Artist, Playlist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import {
  isFilterActive,
  NO_FILTER,
  trackExclusion,
  type FilteredTrack,
  type TrackFilter,
} from "./track-filter.js";

/** The client surface needed to resolve artists to their top tracks. */
export interface ArtistResolverClient {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
}

/** The client surface needed to create a playlist and add tracks to it. */
export interface PlaylistWriterClient {
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void>;
}

/** The client surface needed to add tracks to an existing playlist. */
export interface ExistingPlaylistClient {
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void>;
}

/** The full surface {@link buildPlaylistFromArtists} depends on. */
export type PlaylistBuilderClient = ArtistResolverClient & PlaylistWriterClient;

/** A track the filter excluded, with the reason. */
export type ExcludedTrack = Required<FilteredTrack>;

/** A resolved artist together with the top tracks fetched for it. */
export interface ResolvedArtistTracks {
  query: string;
  artist: Artist;
  /** The kept tracks, most popular first (at most `tracksPerArtist`). */
  tracks: Track[];
  /**
   * Tracks the filter excluded that ranked above the last kept track, most
   * popular first, so a reviewer can tick one back on. Empty without a filter.
   */
  excluded: ExcludedTrack[];
}

/**
 * A resolved artist that yielded fewer tracks than requested -- either none at
 * all (e.g. regional restrictions), or some but short of `tracksPerArtist`.
 */
export interface UnderfilledArtist {
  query: string;
  artist: Artist;
  /** Tracks actually fetched (0 when none were available). */
  trackCount: number;
  /** Tracks requested per artist (`tracksPerArtist`). */
  requested: number;
}

export interface ResolveArtistsResult {
  /** Artists resolved to at least one track, in input order. */
  resolvedArtists: ResolvedArtistTracks[];
  /** Input names that matched no artist. */
  unresolvedArtists: string[];
  /** Resolved artists for which no tracks at all could be fetched. */
  emptyArtists: UnderfilledArtist[];
  /**
   * Resolved artists that yielded at least one track but fewer than requested.
   * These still appear in `resolvedArtists`; this list is for surfacing a note.
   */
  partialArtists: UnderfilledArtist[];
}

export interface ResolveArtistsOptions {
  /** Artist names to resolve. */
  artists: string[];
  /** Top tracks to take per artist (default 10). */
  tracksPerArtist?: number;
  /** Tracks to exclude; excluded tracks are replaced by the next most popular. */
  filter?: TrackFilter;
}

export interface BuildPlaylistOptions {
  /** Artist names to include. */
  artists: string[];
  /** Name for the new playlist. */
  playlistName: string;
  /** Top tracks to take per artist (default 10). */
  tracksPerArtist?: number;
  /** Tracks to leave out; the next most popular tracks take their place. */
  filter?: TrackFilter;
  /** Optional playlist description. */
  description?: string;
  /** Whether the playlist is public (default false). */
  isPublic?: boolean;
}

/** A resolved artist and how many of its tracks were added. */
export interface ResolvedArtist {
  query: string;
  artist: Artist;
  trackCount: number;
  /** Tracks the filter left out (those ranked above the last one added). */
  excludedCount: number;
}

export interface BuildPlaylistResult {
  playlist: Playlist;
  resolvedArtists: ResolvedArtist[];
  unresolvedArtists: string[];
  /** Matched artists that yielded no tracks (excluded from the playlist). */
  emptyArtists: UnderfilledArtist[];
  /** Matched artists that yielded fewer tracks than requested. */
  partialArtists: UnderfilledArtist[];
  trackCount: number;
}

/** How many search results to consider when looking for an exact-name match. */
const ARTIST_SEARCH_LIMIT = 5;

/**
 * How many top tracks to fetch when a filter may exclude some, so the excluded
 * ones can be replaced. Qobuz's artist page lists at most this many.
 */
export const TOP_TRACKS_POOL = 30;
const DEFAULT_TRACKS_PER_ARTIST = 10;

/**
 * Resolve each artist name to its top tracks (phase 1).
 *
 * The per-artist track lists are returned as fetched, without de-duplicating
 * across artists, so a caller can present them grouped by artist for review.
 */
export async function resolveArtistTracks(
  client: ArtistResolverClient,
  options: ResolveArtistsOptions,
): Promise<ResolveArtistsResult> {
  const tracksPerArtist = options.tracksPerArtist ?? DEFAULT_TRACKS_PER_ARTIST;
  const filter = options.filter ?? NO_FILTER;

  // Resolve with a bounded pool, then split the outcomes. Results come back in
  // input order (see mapWithConcurrency), so the grouped-by-artist preview keeps
  // the order the user typed regardless of which lookups finished first.
  const outcomes = await mapWithConcurrency(
    options.artists,
    DEFAULT_CONCURRENCY,
    async (query): Promise<ResolvedArtistTracks | undefined> => {
      const candidates = await client.searchArtists(query, ARTIST_SEARCH_LIMIT);
      const artist = pickArtist(candidates, query);
      if (artist === undefined) {
        return undefined;
      }
      // With a filter, fetch the whole pool so excluded tracks can be replaced
      // by the next most popular ones.
      const fetchCount = isFilterActive(filter)
        ? Math.max(tracksPerArtist, TOP_TRACKS_POOL)
        : tracksPerArtist;
      const pool = await client.getArtistTopTracks(artist.id, fetchCount);
      return { query, artist, ...takeTopTracks(pool, tracksPerArtist, filter) };
    },
  );

  const resolvedArtists: ResolvedArtistTracks[] = [];
  const unresolvedArtists: string[] = [];
  const emptyArtists: UnderfilledArtist[] = [];
  const partialArtists: UnderfilledArtist[] = [];
  options.artists.forEach((query, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) {
      unresolvedArtists.push(query);
      return;
    }
    const trackCount = outcome.tracks.length;
    if (trackCount === 0 && outcome.excluded.length === 0) {
      // Matched an artist, but Qobuz returned no tracks (commonly a regional
      // restriction). Drop it from the list and flag it separately.
      emptyArtists.push({
        query,
        artist: outcome.artist,
        trackCount,
        requested: tracksPerArtist,
      });
      return;
    }
    resolvedArtists.push(outcome);
    if (trackCount < tracksPerArtist) {
      partialArtists.push({
        query,
        artist: outcome.artist,
        trackCount,
        requested: tracksPerArtist,
      });
    }
  });

  return { resolvedArtists, unresolvedArtists, emptyArtists, partialArtists };
}

/**
 * Walk a popularity-ordered pool, keeping the first `count` tracks the filter
 * allows and collecting the excluded ones passed over on the way.
 */
function takeTopTracks(
  pool: readonly Track[],
  count: number,
  filter: TrackFilter,
): { tracks: Track[]; excluded: ExcludedTrack[] } {
  const tracks: Track[] = [];
  const excluded: ExcludedTrack[] = [];
  for (const track of pool) {
    if (tracks.length >= count) {
      break;
    }
    const exclusion = trackExclusion(track, filter);
    if (exclusion === undefined) {
      tracks.push(track);
    } else {
      excluded.push({ track, exclusion });
    }
  }
  return { tracks, excluded };
}

/**
 * Flatten resolved artists to an ordered list of unique track ids, keeping the
 * first occurrence of any id shared across artists.
 */
export function collectTrackIds(
  resolvedArtists: readonly ResolvedArtistTracks[],
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const resolved of resolvedArtists) {
    for (const track of resolved.tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        ids.push(track.id);
      }
    }
  }
  return ids;
}

/** Create a new playlist and fill it with the given tracks (phase 2). */
export async function createPlaylistWithTracks(
  client: PlaylistWriterClient,
  options: {
    name: string;
    trackIds: readonly number[];
    description?: string;
    isPublic?: boolean;
  },
): Promise<Playlist> {
  const playlist = await client.createPlaylist(options.name, {
    ...(options.description !== undefined && { description: options.description }),
    isPublic: options.isPublic ?? false,
  });
  await client.addTracksToPlaylist(playlist.id, options.trackIds);
  return playlist;
}

export interface AddToExistingResult {
  /** Track ids actually added (not already present, de-duplicated). */
  added: number[];
  /** Track ids skipped because they were already in the playlist or repeated. */
  skipped: number[];
}

/**
 * Add tracks to an existing playlist (phase 2), skipping any already present in
 * it and any repeated within the request.
 */
export async function addTracksToExistingPlaylist(
  client: ExistingPlaylistClient,
  options: { playlistId: number; trackIds: readonly number[] },
): Promise<AddToExistingResult> {
  const existing = await client.getPlaylistTracks(options.playlistId);
  const present = new Set(existing.map((track) => track.id));
  const added: number[] = [];
  const skipped: number[] = [];
  const seen = new Set<number>();
  for (const id of options.trackIds) {
    if (present.has(id) || seen.has(id)) {
      skipped.push(id);
      continue;
    }
    seen.add(id);
    added.push(id);
  }
  await client.addTracksToPlaylist(options.playlistId, added);
  return { added, skipped };
}

/**
 * Resolve artists, then create and fill a new playlist with their top tracks.
 *
 * @throws {Error} if no artist names are given.
 */
export async function buildPlaylistFromArtists(
  client: PlaylistBuilderClient,
  options: BuildPlaylistOptions,
): Promise<BuildPlaylistResult> {
  if (options.artists.length === 0) {
    throw new Error("At least one artist is required");
  }

  const { resolvedArtists, unresolvedArtists, emptyArtists, partialArtists } =
    await resolveArtistTracks(client, {
      artists: options.artists,
      ...(options.tracksPerArtist !== undefined && {
        tracksPerArtist: options.tracksPerArtist,
      }),
      ...(options.filter !== undefined && { filter: options.filter }),
    });

  // De-duplicate across artists, counting how many each contributed.
  const trackIds: number[] = [];
  const seen = new Set<number>();
  const summaries: ResolvedArtist[] = [];
  for (const resolved of resolvedArtists) {
    let added = 0;
    for (const track of resolved.tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        trackIds.push(track.id);
        added += 1;
      }
    }
    summaries.push({
      query: resolved.query,
      artist: resolved.artist,
      trackCount: added,
      excludedCount: resolved.excluded.length,
    });
  }

  const playlist = await createPlaylistWithTracks(client, {
    name: options.playlistName,
    trackIds,
    ...(options.description !== undefined && { description: options.description }),
    isPublic: options.isPublic ?? false,
  });

  return {
    playlist,
    resolvedArtists: summaries,
    unresolvedArtists,
    emptyArtists,
    partialArtists,
    trackCount: trackIds.length,
  };
}

/** Prefer an exact (case-insensitive) name match, else the first (most relevant) result. */
function pickArtist(candidates: Artist[], query: string): Artist | undefined {
  const wanted = query.trim().toLowerCase();
  const exact = candidates.find((a) => a.name.toLowerCase() === wanted);
  return exact ?? candidates[0];
}
