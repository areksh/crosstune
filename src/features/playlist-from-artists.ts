/**
 * Build a playlist from a list of artist names.
 *
 * Each name is resolved to a Qobuz artist, the artist's top tracks are
 * collected, and a new playlist is created and filled with those tracks
 * (de-duplicated). Names that cannot be resolved are reported rather than
 * failing the whole operation.
 *
 * The builder depends only on the small {@link PlaylistBuilderClient} surface,
 * so it can be unit-tested against a stub; QobuzClient satisfies it structurally.
 */

import type { Artist, Playlist, Track } from "../qobuz/index.js";

/** The subset of the Qobuz client this feature needs. */
export interface PlaylistBuilderClient {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void>;
}

export interface BuildPlaylistOptions {
  /** Artist names to include. */
  artists: string[];
  /** Name for the new playlist. */
  playlistName: string;
  /** Top tracks to take per artist (default 10). */
  tracksPerArtist?: number;
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
}

export interface BuildPlaylistResult {
  playlist: Playlist;
  resolvedArtists: ResolvedArtist[];
  unresolvedArtists: string[];
  trackCount: number;
}

/** How many search results to consider when looking for an exact-name match. */
const ARTIST_SEARCH_LIMIT = 5;
const DEFAULT_TRACKS_PER_ARTIST = 10;

/**
 * Resolve artists, then create and fill a playlist with their top tracks.
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
  const tracksPerArtist = options.tracksPerArtist ?? DEFAULT_TRACKS_PER_ARTIST;

  const resolvedArtists: ResolvedArtist[] = [];
  const unresolvedArtists: string[] = [];
  const trackIds: number[] = [];
  const seen = new Set<number>();

  for (const query of options.artists) {
    const candidates = await client.searchArtists(query, ARTIST_SEARCH_LIMIT);
    const artist = pickArtist(candidates, query);
    if (artist === undefined) {
      unresolvedArtists.push(query);
      continue;
    }

    const tracks = await client.getArtistTopTracks(artist.id, tracksPerArtist);
    let added = 0;
    for (const track of tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        trackIds.push(track.id);
        added += 1;
      }
    }
    resolvedArtists.push({ query, artist, trackCount: added });
  }

  const playlist = await client.createPlaylist(options.playlistName, {
    ...(options.description !== undefined && { description: options.description }),
    isPublic: options.isPublic ?? false,
  });
  await client.addTracksToPlaylist(playlist.id, trackIds);

  return {
    playlist,
    resolvedArtists,
    unresolvedArtists,
    trackCount: trackIds.length,
  };
}

/** Prefer an exact (case-insensitive) name match, else the first (most relevant) result. */
function pickArtist(candidates: Artist[], query: string): Artist | undefined {
  const wanted = query.trim().toLowerCase();
  const exact = candidates.find((a) => a.name.toLowerCase() === wanted);
  return exact ?? candidates[0];
}
