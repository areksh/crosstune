/**
 * Qobuz as a {@link MusicService}: the client's own ids in, tagged ids out.
 *
 * The client (./client.ts) and its models keep Qobuz's numbers; this adapter is
 * the only thing between them and the rest of the app.
 */

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../../features/concurrency.js";
import { ServiceError } from "../errors.js";
import { nativeOf, tagId, type AnyId } from "../ids.js";
import { normaliseIsrc } from "../isrc.js";
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

/** Results to weigh for an ISRC: one recording is often on many releases. */
const ISRC_RESULTS = 20;

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
  const native = nativeOf("qobuz", id);
  const value = Number(native);
  if (!/^[1-9]\d*$/.test(native) || !Number.isSafeInteger(value)) {
    throw new ServiceError("qobuz", "bad-id", `not a Qobuz id: ${String(id)}`);
  }
  return value;
}

const nums = (ids: readonly AnyId[]): number[] => ids.map(num);
const albumNative = (id: AlbumId): string => nativeOf("qobuz", id);

/** Each conversion overwrites in place, so the fields keep their order. */
function toTrack(track: Native.Track): Track {
  const out: Record<string, unknown> = { ...track, id: tag<TrackId>(track.id) };
  if (track.artistId !== undefined) {
    out["artistId"] = tag<ArtistId>(track.artistId);
  }
  if (track.albumId === "") {
    delete out["albumId"];
  } else if (track.albumId !== undefined) {
    out["albumId"] = tag<AlbumId>(track.albumId);
  }
  if (track.playlistTrackId !== undefined) {
    out["playlistTrackId"] = tag<EntryId>(track.playlistTrackId);
  }
  return out as unknown as Track;
}

const hasId = (album: { id: string }): boolean => album.id.length > 0;
const toArtist = (artist: Native.Artist): Artist => ({ ...artist, id: tag<ArtistId>(artist.id) });
const toAlbum = (album: Native.Album): Album => ({ ...album, id: tag<AlbumId>(album.id) });

function toPlaylist(playlist: Native.Playlist): Playlist {
  const { ownerId } = playlist;
  return {
    ...playlist,
    id: tag<PlaylistId>(playlist.id),
    ...(ownerId !== undefined && { ownerId: tag<UserId>(ownerId) }),
  } as Playlist;
}

function toRelease(release: NativeRelease): Release {
  const { artistId } = release;
  return {
    ...release,
    id: tag<AlbumId>(release.id),
    ...(artistId !== undefined && { artistId: tag<ArtistId>(artistId) }),
  } as Release;
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
    return (await this.#client.searchAlbums(query, limit, offset)).filter(hasId).map(toAlbum);
  }

  async searchTracks(query: string, limit?: number, offset?: number): Promise<Track[]> {
    return (await this.#client.searchTracks(query, limit, offset)).map(toTrack);
  }

  async getTrack(trackId: TrackId): Promise<Track> {
    return toTrack(await this.#client.getTrack(num(trackId)));
  }

  /** Qobuz's search takes an ISRC as its query; only results that carry it count. */
  async findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>> {
    const wanted = [...new Set(isrcs.map(normaliseIsrc))].filter((isrc) => isrc.length > 0);
    const results = await mapWithConcurrency(wanted, DEFAULT_CONCURRENCY, async (isrc) => ({
      isrc,
      tracks: (await this.#client.searchTracks(isrc, ISRC_RESULTS)).filter(
        (track) => track.isrc !== undefined && normaliseIsrc(track.isrc) === isrc,
      ),
    }));
    return new Map(
      results.filter(({ tracks }) => tracks.length > 0).map(({ isrc, tracks }) => [isrc, tracks.map(toTrack)]),
    );
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
    return { releases: releases.filter(hasId).map(toRelease), truncated };
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
    return (await this.#client.getFavoriteAlbums()).filter(hasId).map(toAlbum);
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
