/**
 * Test support (not shipped; excluded from the build): an in-memory Qobuz
 * account with playlists and favourites, implementing the client's playlist
 * and favourite methods with the live API's semantics -- adding appends (a
 * track id repeated within one request lands once, as checked live in
 * November 2026), entries get fresh playlist-track ids, adding an unplayable track answers
 * normally but adds nothing, and a move is {@link applyMove}. Used to check that recording a change and undoing it restores the account.
 */

import { shortId, tagId, type AlbumId, type AnyId, type ArtistId, type EntryId, type PlaylistId, type TrackId } from "../services/ids.js";
import { type Playlist, type Track } from "../services/model.js";
import { QobuzError } from "../services/qobuz/index.js";
import { applyMove } from "./playlist-order.js";

interface FakeEntry {
  trackId: TrackId;
  playlistTrackId: EntryId;
}

interface FakePlaylist {
  name: string;
  isPublic: boolean;
  description?: string;
  entries: FakeEntry[];
}

export class FakeAccount {
  readonly playlists = new Map<PlaylistId, FakePlaylist>();
  readonly favourites = {
    tracks: [] as TrackId[],
    albums: [] as AlbumId[],
    artists: [] as ArtistId[],
  };
  /** Track ids Qobuz silently refuses to add (no longer playable). */
  readonly unplayable = new Set<TrackId>();
  /** Every call, as "method:arg0", in order. */
  readonly calls: string[] = [];
  #nextPlaylistId = 100;
  #nextEntryId = 1000;
  /** Method name -> how many more calls succeed before the next one fails. */
  readonly #failAfter = new Map<string, number>();

  /** Seed a playlist holding `trackIds`; returns its id. */
  seedPlaylist(name: string, trackIds: readonly TrackId[]): PlaylistId {
    const id = this.#newPlaylistId();
    this.playlists.set(id, {
      name,
      isPublic: false,
      entries: trackIds.map((trackId) => ({ trackId, playlistTrackId: this.#newEntryId() })),
    });
    return id;
  }

  /** The track ids of a playlist, in order. */
  trackIds(playlistId: PlaylistId): TrackId[] {
    return this.#playlist(playlistId).entries.map((e) => e.trackId);
  }

  /** The entry ids of a playlist, in order. */
  entryIds(playlistId: PlaylistId): EntryId[] {
    return this.#playlist(playlistId).entries.map((e) => e.playlistTrackId);
  }

  #newPlaylistId(): PlaylistId {
    return tagId<PlaylistId>("qobuz", this.#nextPlaylistId++);
  }

  #newEntryId(): EntryId {
    return tagId<EntryId>("qobuz", this.#nextEntryId++);
  }

  /** Make `method` fail after `succeed` more successful calls. */
  failAfter(method: string, succeed = 0): void {
    this.#failAfter.set(method, succeed);
  }

  #call(method: string, arg: unknown): void {
    this.calls.push(`${method}:${String(arg).split(",").map((part) => shortId(part as AnyId)).join(",")}`);
    const left = this.#failAfter.get(method);
    if (left !== undefined) {
      if (left <= 0) {
        this.#failAfter.delete(method);
        throw new QobuzError("api-response", `${method} failed with HTTP 500`);
      }
      this.#failAfter.set(method, left - 1);
    }
  }

  #playlist(id: PlaylistId): FakePlaylist {
    const playlist = this.playlists.get(id);
    if (playlist === undefined) {
      throw new QobuzError("api-response", "playlist/get failed with HTTP 404");
    }
    return playlist;
  }

  async createPlaylist(
    name: string,
    options: { description?: string; isPublic?: boolean } = {},
  ): Promise<Playlist> {
    this.#call("createPlaylist", name);
    const id = this.#newPlaylistId();
    this.playlists.set(id, { name, isPublic: options.isPublic ?? false, entries: [] });
    return { id, name, trackCount: 0 };
  }

  async deletePlaylist(playlistId: PlaylistId): Promise<void> {
    this.#call("deletePlaylist", playlistId);
    this.#playlist(playlistId);
    this.playlists.delete(playlistId);
  }

  async getPlaylist(playlistId: PlaylistId): Promise<Playlist> {
    this.#call("getPlaylist", playlistId);
    const playlist = this.#playlist(playlistId);
    return {
      id: playlistId,
      name: playlist.name,
      trackCount: playlist.entries.length,
      isPublic: playlist.isPublic,
      ...(playlist.description !== undefined && { description: playlist.description }),
    };
  }

  async updatePlaylist(
    playlistId: PlaylistId,
    changes: { name?: string; description?: string; isPublic?: boolean },
  ): Promise<Playlist> {
    this.#call("updatePlaylist", playlistId);
    Object.assign(this.#playlist(playlistId), changes);
    return this.getPlaylist(playlistId);
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    this.#call("getUserPlaylists", "");
    return [...this.playlists].map(([id, p]) => ({ id, name: p.name, trackCount: p.entries.length }));
  }

  async getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> {
    this.#call("getPlaylistTracks", playlistId);
    return this.#playlist(playlistId).entries.map((e) => ({
      id: e.trackId,
      title: `Track ${shortId(e.trackId)}`,
      playlistTrackId: e.playlistTrackId,
    }));
  }

  async addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void> {
    this.#call("addTracksToPlaylist", playlistId);
    const playlist = this.#playlist(playlistId);
    // Like Qobuz: a track repeated within one request is added once (a track
    // already in the playlist is added again).
    for (const trackId of new Set(trackIds)) {
      if (this.unplayable.has(trackId)) {
        continue;
      }
      playlist.entries.push({ trackId, playlistTrackId: this.#newEntryId() });
    }
  }

  async removeTracksFromPlaylist(
    playlistId: PlaylistId,
    playlistTrackIds: readonly EntryId[],
  ): Promise<void> {
    this.#call("removeTracksFromPlaylist", playlistId);
    const playlist = this.#playlist(playlistId);
    const gone = new Set(playlistTrackIds);
    playlist.entries = playlist.entries.filter((e) => !gone.has(e.playlistTrackId));
  }

  async movePlaylistTracks(
    playlistId: PlaylistId,
    playlistTrackIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void> {
    this.#call("movePlaylistTracks", playlistId);
    const playlist = this.#playlist(playlistId);
    const byId = new Map(playlist.entries.map((e) => [e.playlistTrackId, e]));
    playlist.entries = applyMove([...byId.keys()], playlistTrackIds, insertBefore).map((id) => byId.get(id)!);
  }

  async addFavoriteTracks(ids: readonly TrackId[]): Promise<void> {
    this.#call("addFavoriteTracks", ids.join(","));
    this.favourites.tracks = [...this.favourites.tracks.filter((id) => !ids.includes(id)), ...ids];
  }

  async addFavoriteAlbums(ids: readonly AlbumId[]): Promise<void> {
    this.#call("addFavoriteAlbums", ids.join(","));
    this.favourites.albums = [...this.favourites.albums.filter((id) => !ids.includes(id)), ...ids];
  }

  async addFavoriteArtists(ids: readonly ArtistId[]): Promise<void> {
    this.#call("addFavoriteArtists", ids.join(","));
    this.favourites.artists = [...this.favourites.artists.filter((id) => !ids.includes(id)), ...ids];
  }

  async removeFavoriteTracks(ids: readonly TrackId[]): Promise<void> {
    this.#call("removeFavoriteTracks", ids.join(","));
    this.favourites.tracks = this.favourites.tracks.filter((id) => !ids.includes(id));
  }

  async removeFavoriteAlbums(ids: readonly AlbumId[]): Promise<void> {
    this.#call("removeFavoriteAlbums", ids.join(","));
    this.favourites.albums = this.favourites.albums.filter((id) => !ids.includes(id));
  }

  async removeFavoriteArtists(ids: readonly ArtistId[]): Promise<void> {
    this.#call("removeFavoriteArtists", ids.join(","));
    this.favourites.artists = this.favourites.artists.filter((id) => !ids.includes(id));
  }
}

/** An in-memory history file. */
export class MemoryStore {
  text = "";
  appends = 0;
  replaces = 0;

  read(): string {
    return this.text;
  }

  append(text: string): void {
    this.appends += 1;
    this.text += text;
  }

  replace(text: string): void {
    this.replaces += 1;
    this.text = text;
  }
}
