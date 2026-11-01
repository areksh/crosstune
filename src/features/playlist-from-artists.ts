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
 * over are reported so the web UI can offer them unticked. An optional
 * {@link SongPicker} does the same for tracks already in the user's favourites
 * and for later copies of a song the plan already has; it is consulted in
 * input order, so the first artist listed keeps a shared song. The CLI's
 * composed build then fits the plan to a length and orders it (see
 * ./playlist-shape.ts); the web UI does both in its review.
 * Each function depends only on the small client surface it needs, so all are
 * unit-testable against stubs; QobuzClient satisfies them structurally.
 */

import type { Artist, Playlist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { shapePlaylist, uniqueGroups, type PlaylistOrder } from "./playlist-shape.js";
import { describeLinkMismatch, parseQobuzLink } from "./qobuz-links.js";
import {
  createSongPicker,
  type FavouriteTracksClient,
  type SongPicker,
  type SongPickerOptions,
} from "./song-picker.js";
import {
  isFilterActive,
  NO_FILTER,
  trackExclusion,
  type FilteredTrack,
  type TrackFilter,
} from "./track-filter.js";

/** The client surface needed to resolve artists to their top tracks. */
export interface ArtistResolverClient extends ArtistLookupClient {
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
}

/** The client surface needed to find an artist by name or by link. */
export interface ArtistLookupClient {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtist(artistId: number): Promise<Artist>;
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
export type PlaylistBuilderClient = ArtistResolverClient &
  PlaylistWriterClient &
  FavouriteTracksClient;

/**
 * A track the filter excluded, with the reason and its `position`: the index it
 * would have among the listed tracks (kept and excluded, most popular first),
 * so a reviewer can show it, and put it back, where it ranked.
 */
export type ExcludedTrack = Required<FilteredTrack> & { position: number };

/** A resolved artist together with the top tracks fetched for it. */
export interface ResolvedArtistTracks {
  query: string;
  artist: Artist;
  /** True when the line was a Qobuz artist link, resolved by id. */
  fromLink?: boolean;
  /** The kept tracks, most popular first (at most `tracksPerArtist`). */
  tracks: Track[];
  /**
   * Tracks the filter excluded that ranked above the last kept track, most
   * popular first, each with its `position` in that order, so a reviewer can
   * tick one back on in place. Empty without a filter.
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
  /**
   * Input names that matched no artist, and links that are not artist links
   * or lead to no artist, the latter with the reason ("<link> (an album link,
   * not an artist)").
   */
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
  /**
   * Top tracks to take per artist (default 10). Zero resolves the artists only:
   * nothing is fetched and no artist is flagged as empty or partial.
   */
  tracksPerArtist?: number;
  /** Tracks to exclude; excluded tracks are replaced by the next most popular. */
  filter?: TrackFilter;
  /**
   * Favourites and repeats to exclude (replaced like filtered tracks). It is
   * updated with the tracks taken, so a later request can carry the run on.
   */
  picker?: SongPicker;
}

/** How the composed builds shape the plan: song exclusions, length and order. */
export interface PlanShapeOptions extends SongPickerOptions {
  /** Default `by-artist`. */
  order?: PlaylistOrder;
  /** Trim to at most about this many minutes. */
  fitMinutes?: number;
  /** Random source for `shuffle`; default `Math.random`. */
  random?: () => number;
}

export interface BuildPlaylistOptions extends PlanShapeOptions {
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
  /** Tracks the filter or picker left out (those ranked above the last one added). */
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
  /** Total length of the tracks written, in seconds (unknown ones as the average). */
  durationSeconds: number;
  /** Tracks dropped to fit the length asked for (0 without one). */
  droppedToFit: number;
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
  const deep = isFilterActive(filter) || options.picker?.active === true;

  // Look up and fetch with a bounded pool. Results come back in input order
  // (see mapWithConcurrency), so the grouped-by-artist preview keeps the order
  // the user typed regardless of which lookups finished first.
  const lookups = await mapWithConcurrency(
    options.artists,
    DEFAULT_CONCURRENCY,
    async (query): Promise<(ArtistMatch & { pool: Track[] }) | { problem: string }> => {
      const match = await lookUpArtist(client, query);
      if ("problem" in match || tracksPerArtist === 0) {
        return { ...match, pool: [] };
      }
      return {
        ...match,
        pool: await fetchTopTrackPool(client, match.artist.id, tracksPerArtist, deep),
      };
    },
  );
  // Then take each artist's tracks in input order: the picker's "first copy"
  // must not depend on which fetch finished first.
  const outcomes = lookups.map((lookup, index): ResolvedArtistTracks | string =>
    "problem" in lookup
      ? lookup.problem
      : {
          query: options.artists[index]!,
          artist: lookup.artist,
          ...(lookup.fromLink && { fromLink: true }),
          ...takeTopTracks(lookup.pool, tracksPerArtist, filter, options.picker),
        },
  );

  const resolvedArtists: ResolvedArtistTracks[] = [];
  const unresolvedArtists: string[] = [];
  const emptyArtists: UnderfilledArtist[] = [];
  const partialArtists: UnderfilledArtist[] = [];
  options.artists.forEach((query, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined || typeof outcome === "string") {
      unresolvedArtists.push(outcome ?? query);
      return;
    }
    const trackCount = outcome.tracks.length;
    if (tracksPerArtist === 0) {
      resolvedArtists.push(outcome);
      return;
    }
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
 * Fetch an artist's `count` most popular tracks that the filter allows, plus
 * the excluded ones passed over on the way (most popular first).
 *
 * With an active filter (or picker) the whole top-track pool is fetched, so
 * excluded tracks can be replaced by the next most popular ones; without one
 * only `count` are requested.
 */
export async function fetchTopTracks(
  client: Pick<ArtistResolverClient, "getArtistTopTracks">,
  artistId: number,
  count: number,
  filter: TrackFilter = NO_FILTER,
  picker?: SongPicker,
): Promise<{ tracks: Track[]; excluded: ExcludedTrack[] }> {
  const deep = isFilterActive(filter) || picker?.active === true;
  const pool = await fetchTopTrackPool(client, artistId, count, deep);
  return takeTopTracks(pool, count, filter, picker);
}

/**
 * Fetch an artist's top tracks, most popular first: `count` of them, or the
 * whole pool when `deep` (so excluded tracks can be replaced).
 */
export async function fetchTopTrackPool(
  client: Pick<ArtistResolverClient, "getArtistTopTracks">,
  artistId: number,
  count: number,
  deep: boolean,
): Promise<Track[]> {
  return client.getArtistTopTracks(artistId, deep ? Math.max(count, TOP_TRACKS_POOL) : count);
}

/**
 * Walk a popularity-ordered pool, keeping the first `count` tracks the filter
 * and the picker allow and collecting the excluded ones passed over on the
 * way. The picker is told what was taken and skipped.
 */
export function takeTopTracks(
  pool: readonly Track[],
  count: number,
  filter: TrackFilter,
  picker?: SongPicker,
): { tracks: Track[]; excluded: ExcludedTrack[] } {
  const tracks: Track[] = [];
  const excluded: ExcludedTrack[] = [];
  for (const track of pool) {
    if (tracks.length >= count) {
      break;
    }
    const filtered = trackExclusion(track, filter);
    const exclusion = filtered ?? picker?.exclusion(track);
    if (exclusion === undefined) {
      tracks.push(track);
      picker?.take(track);
    } else {
      excluded.push({ track, exclusion, position: tracks.length + excluded.length });
      if (filtered === undefined) {
        picker?.skip(track);
      }
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

  const picker = await createSongPicker(client, options);
  const { resolvedArtists, unresolvedArtists, emptyArtists, partialArtists } =
    await resolveArtistTracks(client, {
      artists: options.artists,
      ...(options.tracksPerArtist !== undefined && {
        tracksPerArtist: options.tracksPerArtist,
      }),
      ...(options.filter !== undefined && { filter: options.filter }),
      picker,
    });

  // De-duplicate across artists, fit to length and order, counting how many
  // tracks each artist contributed.
  const shaped = shapeArtistGroups(
    resolvedArtists.map((resolved) => resolved.tracks),
    options,
  );
  const trackIds = shaped.ordered.map((track) => track.id);
  const summaries: ResolvedArtist[] = resolvedArtists.map((resolved, index) => ({
    query: resolved.query,
    artist: resolved.artist,
    trackCount: shaped.kept[index]?.length ?? 0,
    excludedCount: resolved.excluded.length,
  }));

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
    durationSeconds: shaped.seconds,
    droppedToFit: shaped.dropped.length,
  };
}

/**
 * Shape per-artist track groups into the playlist the CLI writes: each track
 * once (under the first artist with it), fitted fairly to the length asked
 * for, in the order asked for.
 */
export function shapeArtistGroups(
  groups: readonly (readonly Track[])[],
  options: Pick<PlanShapeOptions, "order" | "fitMinutes" | "random">,
): ReturnType<typeof shapePlaylist<Track>> {
  return shapePlaylist(uniqueGroups(groups, (track) => track.id), (track) => track.duration, {
    order: options.order ?? "by-artist",
    ...(options.fitMinutes !== undefined && { fitMinutes: options.fitMinutes }),
    ...(options.random !== undefined && { random: options.random }),
  });
}

/** An artist found for a typed line, and whether the line was a link. */
export interface ArtistMatch {
  artist: Artist;
  fromLink: boolean;
}

/**
 * Find the artist a typed line names: a Qobuz artist link by its id, anything
 * else by a name search ({@link pickArtist}). A link to something else (an
 * album, a playlist...) or to no artist is a problem, given as the line with
 * the reason; so is a name that matches nothing (the line alone).
 */
export async function lookUpArtist(
  client: ArtistLookupClient,
  query: string,
): Promise<ArtistMatch | { problem: string }> {
  const link = parseQobuzLink(query);
  if (link === undefined) {
    const artist = pickArtist(await client.searchArtists(query, ARTIST_SEARCH_LIMIT), query);
    return artist === undefined ? { problem: query } : { artist, fromLink: false };
  }
  if (link.kind !== "artist") {
    return { problem: `${query} (${describeLinkMismatch(link, "artist")})` };
  }
  try {
    return { artist: await client.getArtist(link.id), fromLink: true };
  } catch {
    return { problem: `${query} (no Qobuz artist has this id)` };
  }
}

/** Prefer an exact (case-insensitive) name match, else the first (most relevant) result. */
export function pickArtist(candidates: Artist[], query: string): Artist | undefined {
  const wanted = query.trim().toLowerCase();
  const exact = candidates.find((a) => a.name.toLowerCase() === wanted);
  return exact ?? candidates[0];
}
