/**
 * Qobuz as a {@link MusicService}: the client's own ids in, tagged ids out.
 *
 * The client (./client.ts) and its models keep Qobuz's numbers; this adapter is
 * the only thing between them and the rest of the app.
 */

import { ServiceError } from "../errors.js";
import { nativeOf, tagId, type AnyId } from "../ids.js";
import type {
  Album,
  AlbumId,
  Artist,
  ArtistId,
  ArtistReleases,
  EntryId,
  Playlist,
  PlaylistId,
  Release,
  Track,
  TrackId,
  UserId,
} from "../model.js";
import { CAN, type Account, type Capabilities, type MusicService, type PlaylistChanges, type PlaylistOptions } from "../service.js";
import type { QobuzClient } from "./client.js";
import type * as Native from "./models.js";
import type { Release as NativeRelease } from "./releases.js";

const CAPABILITIES: Capabilities = {
  topTracks: CAN,
  similarArtists: CAN,
  artistReleases: CAN,
  readOthersPlaylists: CAN,
  editorialPlaylists: CAN,
  movePlaylistEntries: CAN,
  deletePlaylist: CAN,
  playlistVisibility: CAN,
  searchByIsrc: CAN,
  playability: CAN,
  favouritedDates: CAN,
  quality: "exact",
  entryIds: "stable",
};

const tag = <T extends AnyId>(native: string | number): T => tagId<T>("qobuz", native);

/** A tagged id as Qobuz's number. */
function num(id: AnyId): number {
  const value = Number(nativeOf("qobuz", id));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError("qobuz", "bad-id", `not a Qobuz id: ${String(id)}`);
  }
  return value;
}

const nums = (ids: readonly AnyId[]): number[] => ids.map(num);
const albumNative = (id: AlbumId): string => nativeOf("qobuz", id);

function toTrack(track: Native.Track): Track {
  const { id, artistId, albumId, playlistTrackId, ...rest } = track;
  return {
    ...rest,
    id: tag<TrackId>(id),
    ...(artistId !== undefined && { artistId: tag<ArtistId>(artistId) }),
    ...(albumId !== undefined && albumId.length > 0 && { albumId: tag<AlbumId>(albumId) }),
    ...(playlistTrackId !== undefined && { playlistTrackId: tag<EntryId>(playlistTrackId) }),
  };
}

const toArtist = (artist: Native.Artist): Artist => ({ ...artist, id: tag<ArtistId>(artist.id) });
const toAlbum = (album: Native.Album): Album => ({ ...album, id: tag<AlbumId>(album.id) });

function toPlaylist(playlist: Native.Playlist): Playlist {
  const { id, ownerId, ...rest } = playlist;
  return { ...rest, id: tag<PlaylistId>(id), ...(ownerId !== undefined && { ownerId: tag<UserId>(ownerId) }) };
}

function toRelease(release: NativeRelease): Release {
  const { id, artistId, ...rest } = release;
  return {
    ...rest,
    id: tag<AlbumId>(id),
    ...(artistId !== undefined && { artistId: tag<ArtistId>(artistId) }),
  };
}

export class QobuzService implements MusicService {
  readonly name = "qobuz" as const;
  readonly capabilities = CAPABILITIES;
  readonly #client: QobuzClient;

  constructor(client: QobuzClient) {
    this.#client = client;
  }

  account(): Account | undefined {
    const session = this.#client.session;
    return session === undefined
      ? undefined
      : { id: tag<UserId>(session.userId), displayName: session.displayName, plan: session.subscriptionLabel };
  }

  async searchArtists(query: string, limit?: number, offset?: number): Promise<Artist[]> {
    return (await this.#client.searchArtists(query, limit, offset)).map(toArtist);
  }

  async searchAlbums(query: string, limit?: number, offset?: number): Promise<Album[]> {
    return (await this.#client.searchAlbums(query, limit, offset)).map(toAlbum);
  }

  async searchTracks(query: string, limit?: number, offset?: number): Promise<Track[]> {
    return (await this.#client.searchTracks(query, limit, offset)).map(toTrack);
  }

  async getArtist(artistId: ArtistId): Promise<Artist> {
    return toArtist(await this.#client.getArtist(num(artistId)));
  }

  async getArtistTopTracks(artistId: ArtistId, limit?: number): Promise<Track[]> {
    return (await this.#client.getArtistTopTracks(num(artistId), limit)).map(toTrack);
  }

  async getSimilarArtists(artistId: ArtistId, limit: number): Promise<Artist[]> {
    return (await this.#client.getSimilarArtists(num(artistId), limit)).map(toArtist);
  }

  async getArtistReleases(artistId: ArtistId, maxReleases?: number): Promise<ArtistReleases> {
    const { releases, truncated } = await this.#client.getArtistReleases(num(artistId), maxReleases);
    return { releases: releases.map(toRelease), truncated };
  }

  async getAlbum(albumId: AlbumId): Promise<Album> {
    return toAlbum(await this.#client.getAlbum(albumNative(albumId)));
  }

  async getAlbumTracks(albumId: AlbumId): Promise<Track[]> {
    return (await this.#client.getAlbumTracks(albumNative(albumId))).map(toTrack);
  }

  async getAlbumReleaseDate(albumId: AlbumId): Promise<string | undefined> {
    return this.#client.getAlbumReleaseDate(albumNative(albumId));
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    return (await this.#client.getUserPlaylists()).map(toPlaylist);
  }

  async getPlaylist(playlistId: PlaylistId): Promise<Playlist> {
    return toPlaylist(await this.#client.getPlaylist(num(playlistId)));
  }

  async getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> {
    return (await this.#client.getPlaylistTracks(num(playlistId))).map(toTrack);
  }

  async getFavoriteTracks(): Promise<Track[]> {
    return (await this.#client.getFavoriteTracks()).map(toTrack);
  }

  async getFavoriteAlbums(): Promise<Album[]> {
    return (await this.#client.getFavoriteAlbums()).map(toAlbum);
  }

  async getFavoriteArtists(): Promise<Artist[]> {
    return (await this.#client.getFavoriteArtists()).map(toArtist);
  }

  async createPlaylist(name: string, options?: PlaylistOptions): Promise<Playlist> {
    return toPlaylist(await this.#client.createPlaylist(name, options));
  }

  async updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges): Promise<Playlist> {
    return toPlaylist(await this.#client.updatePlaylist(num(playlistId), changes));
  }

  async deletePlaylist(playlistId: PlaylistId): Promise<void> {
    await this.#client.deletePlaylist(num(playlistId));
  }

  async addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void> {
    await this.#client.addTracksToPlaylist(num(playlistId), nums(trackIds));
  }

  async removeTracksFromPlaylist(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<void> {
    await this.#client.removeTracksFromPlaylist(num(playlistId), nums(entryIds));
  }

  async movePlaylistTracks(
    playlistId: PlaylistId,
    entryIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void> {
    await this.#client.movePlaylistTracks(num(playlistId), nums(entryIds), insertBefore);
  }

  async addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    await this.#client.addFavoriteTracks(nums(trackIds));
  }

  async addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#client.addFavoriteAlbums(albumIds.map(albumNative));
  }

  async addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#client.addFavoriteArtists(nums(artistIds));
  }

  async removeFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    await this.#client.removeFavoriteTracks(nums(trackIds));
  }

  async removeFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#client.removeFavoriteAlbums(albumIds.map(albumNative));
  }

  async removeFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#client.removeFavoriteArtists(nums(artistIds));
  }
}
