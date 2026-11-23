/**
 * What a music service offers the tools (ADR-0010).
 *
 * A service is one folder here that implements {@link MusicService}: its API,
 * its sign-in and what it can do. A tool asks for the few methods it needs
 * (its own small client interface); a whole service, or the hub over all of
 * them (./hub.ts), satisfies it.
 */

import type { ServiceName } from "./names.js";
import type {
  Album,
  AlbumId,
  Artist,
  ArtistId,
  ArtistReleases,
  EntryId,
  Playlist,
  PlaylistId,
  Track,
  TrackId,
  UserId,
} from "./model.js";

/** Whether a service can do something, and if not, why (shown to the user). */
/** `from`: the service that answers for it (see ./gap-filler.ts). */
export type Capability = { ok: true; from?: ServiceName } | { ok: false; reason: string };

export const CAN: Capability = { ok: true };

export function cannot(reason: string): Capability {
  return { ok: false, reason };
}

/** The capabilities that differ between services. */
export interface Capabilities {
  topTracks: Capability;
  similarArtists: Capability;
  artistReleases: Capability;
  /** Reading the songs of playlists that are not the user's. */
  readOthersPlaylists: Capability;
  editorialPlaylists: Capability;
  movePlaylistEntries: Capability;
  deletePlaylist: Capability;
  playlistVisibility: Capability;
  searchByIsrc: Capability;
  /** Whether a track says if it can be played. */
  playability: Capability;
  /** Whether favourites carry when they were added. */
  favouritedDates: Capability;
  /** How quality is known: bit depth and rate, a tier, or not at all. */
  quality: "exact" | "tier" | "none";
  /** Whether an entry's id survives other edits of its playlist. */
  entryIds: "stable" | "positional";
}

/** The capabilities that are yes or no. */
export type CapabilityName = {
  [K in keyof Capabilities]: Capabilities[K] extends Capability ? K : never;
}[keyof Capabilities];

/** Who is signed in. */
export interface Account {
  id: UserId;
  displayName: string;
  /** The subscription, when the service says. */
  plan?: string;
}

export interface PlaylistOptions {
  description?: string;
  isPublic?: boolean;
}

export interface PlaylistChanges {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

/** The reads every service answers. */
export interface MusicReads {
  searchArtists(query: string, limit?: number, offset?: number): Promise<Artist[]>;
  searchAlbums(query: string, limit?: number, offset?: number): Promise<Album[]>;
  searchTracks(query: string, limit?: number, offset?: number): Promise<Track[]>;
  /** @throws a not-found error when the service no longer has it. */
  getTrack(trackId: TrackId): Promise<Track>;
  /** Tracks by ISRC (normalised, see ./isrc.ts); an ISRC nothing has is left out. */
  findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>>;
  getArtist(artistId: ArtistId): Promise<Artist>;
  getArtistTopTracks(artistId: ArtistId, limit?: number): Promise<Track[]>;
  getSimilarArtists(artistId: ArtistId, limit: number): Promise<Artist[]>;
  getArtistReleases(artistId: ArtistId, maxReleases?: number): Promise<ArtistReleases>;
  getAlbum(albumId: AlbumId): Promise<Album>;
  getAlbumTracks(albumId: AlbumId): Promise<Track[]>;
  getAlbumReleaseDate(albumId: AlbumId): Promise<string | undefined>;
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylist(playlistId: PlaylistId): Promise<Playlist>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
  getFavoriteTracks(): Promise<Track[]>;
  getFavoriteAlbums(): Promise<Album[]>;
  getFavoriteArtists(): Promise<Artist[]>;
}

/** The writes every service makes; each one is recorded (features/journal.ts). */
export interface MusicWrites {
  createPlaylist(name: string, options?: PlaylistOptions): Promise<Playlist>;
  updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges): Promise<Playlist>;
  deletePlaylist(playlistId: PlaylistId): Promise<void>;
  addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void>;
  removeTracksFromPlaylist(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<void>;
  /**
   * Move entries, in the order given, in front of the entry at `insertBefore`
   * (1-based, in the list as it is); one past the end moves to the end.
   */
  movePlaylistTracks(
    playlistId: PlaylistId,
    entryIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void>;
  addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void>;
  addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void>;
  removeFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  removeFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void>;
  removeFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void>;
}

/** The names of every read and write, for wrappers that go through them all. */
export const MUSIC_READS = [
  "searchArtists",
  "searchAlbums",
  "searchTracks",
  "getTrack",
  "findByIsrc",
  "getArtist",
  "getArtistTopTracks",
  "getSimilarArtists",
  "getArtistReleases",
  "getAlbum",
  "getAlbumTracks",
  "getAlbumReleaseDate",
  "getUserPlaylists",
  "getPlaylist",
  "getPlaylistTracks",
  "getFavoriteTracks",
  "getFavoriteAlbums",
  "getFavoriteArtists",
] as const satisfies ReadonlyArray<keyof MusicReads>;

export const MUSIC_WRITES = [
  "createPlaylist",
  "updatePlaylist",
  "deletePlaylist",
  "addTracksToPlaylist",
  "removeTracksFromPlaylist",
  "movePlaylistTracks",
  "addFavoriteTracks",
  "addFavoriteAlbums",
  "addFavoriteArtists",
  "removeFavoriteTracks",
  "removeFavoriteAlbums",
  "removeFavoriteArtists",
] as const satisfies ReadonlyArray<keyof MusicWrites>;

export interface MusicService extends MusicReads, MusicWrites {
  readonly name: ServiceName;
  readonly capabilities: Capabilities;
  /** Who is signed in, or undefined. */
  account(): Account | undefined;
}
