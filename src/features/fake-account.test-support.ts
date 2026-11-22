/**
 * Test support (not shipped; excluded from the build): an in-memory Qobuz
 * account with playlists and favourites, implementing the client's playlist
 * and favourite methods with the live API's semantics -- adding appends (a
 * track id repeated within one request lands once, as checked live in
 * November 2026), entries get fresh playlist-track ids, adding an unplayable track answers
 * normally but adds nothing, and a move is {@link applyMove}. Used to check that recording a change and undoing it restores the account.
 */

import { QobuzError, type Playlist, type Track } from "../qobuz/index.js";
import { applyMove } from "./playlist-order.js";

interface FakeEntry {
  trackId: number;
  playlistTrackId: number;
}

interface FakePlaylist {
  name: string;
  isPublic: boolean;
  description?: string;
  entries: FakeEntry[];
}

export class FakeAccount {
  readonly playlists = new Map<number, FakePlaylist>();
  readonly favourites = {
    tracks: [] as number[],
    albums: [] as string[],
    artists: [] as number[],
  };
  /** Track ids Qobuz silently refuses to add (no longer playable). */
  readonly unplayable = new Set<number>();
  /** Every call, as "method:arg0", in order. */
  readonly calls: string[] = [];
  #nextPlaylistId = 100;
  #nextEntryId = 1000;
  /** Method name -> how many more calls succeed before the next one fails. */
  readonly #failAfter = new Map<string, number>();

  /** Seed a playlist holding `trackIds`; returns its id. */
  seedPlaylist(name: string, trackIds: readonly number[]): number {
    const id = this.#nextPlaylistId++;
    this.playlists.set(id, {
      name,
      isPublic: false,
      entries: trackIds.map((trackId) => ({ trackId, playlistTrackId: this.#nextEntryId++ })),
    });
    return id;
  }

  /** The track ids of a playlist, in order. */
  trackIds(playlistId: number): number[] {
    return this.#playlist(playlistId).entries.map((e) => e.trackId);
  }

  /** The entry ids of a playlist, in order. */
  entryIds(playlistId: number): number[] {
    return this.#playlist(playlistId).entries.map((e) => e.playlistTrackId);
  }

  /** Make `method` fail after `succeed` more successful calls. */
  failAfter(method: string, succeed = 0): void {
    this.#failAfter.set(method, succeed);
  }

  #call(method: string, arg: unknown): void {
    this.calls.push(`${method}:${String(arg)}`);
    const left = this.#failAfter.get(method);
    if (left !== undefined) {
      if (left <= 0) {
        this.#failAfter.delete(method);
        throw new QobuzError("api-response", `${method} failed with HTTP 500`);
      }
      this.#failAfter.set(method, left - 1);
    }
  }

  #playlist(id: number): FakePlaylist {
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
    const id = this.#nextPlaylistId++;
    this.playlists.set(id, { name, isPublic: options.isPublic ?? false, entries: [] });
    return { id, name, trackCount: 0 };
  }

  async deletePlaylist(playlistId: number): Promise<void> {
    this.#call("deletePlaylist", playlistId);
    this.#playlist(playlistId);
    this.playlists.delete(playlistId);
  }

  async getPlaylist(playlistId: number): Promise<Playlist> {
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
    playlistId: number,
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

  async getPlaylistTracks(playlistId: number): Promise<Track[]> {
    this.#call("getPlaylistTracks", playlistId);
    return this.#playlist(playlistId).entries.map((e) => ({
      id: e.trackId,
      title: `Track ${e.trackId}`,
      playlistTrackId: e.playlistTrackId,
    }));
  }

  async addTracksToPlaylist(playlistId: number, trackIds: readonly number[]): Promise<void> {
    this.#call("addTracksToPlaylist", playlistId);
    const playlist = this.#playlist(playlistId);
    // Like Qobuz: a track repeated within one request is added once (a track
    // already in the playlist is added again).
    for (const trackId of new Set(trackIds)) {
      if (this.unplayable.has(trackId)) {
        continue;
      }
      playlist.entries.push({ trackId, playlistTrackId: this.#nextEntryId++ });
    }
  }

  async removeTracksFromPlaylist(
    playlistId: number,
    playlistTrackIds: readonly number[],
  ): Promise<void> {
    this.#call("removeTracksFromPlaylist", playlistId);
    const playlist = this.#playlist(playlistId);
    const gone = new Set(playlistTrackIds);
    playlist.entries = playlist.entries.filter((e) => !gone.has(e.playlistTrackId));
  }

  async movePlaylistTracks(
    playlistId: number,
    playlistTrackIds: readonly number[],
    insertBefore: number,
  ): Promise<void> {
    this.#call("movePlaylistTracks", playlistId);
    const playlist = this.#playlist(playlistId);
    const byId = new Map(playlist.entries.map((e) => [e.playlistTrackId, e]));
    playlist.entries = applyMove([...byId.keys()], playlistTrackIds, insertBefore).map((id) => byId.get(id)!);
  }

  async addFavoriteTracks(ids: readonly number[]): Promise<void> {
    this.#call("addFavoriteTracks", ids.join(","));
    this.favourites.tracks = [...this.favourites.tracks.filter((id) => !ids.includes(id)), ...ids];
  }

  async addFavoriteAlbums(ids: readonly string[]): Promise<void> {
    this.#call("addFavoriteAlbums", ids.join(","));
    this.favourites.albums = [...this.favourites.albums.filter((id) => !ids.includes(id)), ...ids];
  }

  async addFavoriteArtists(ids: readonly number[]): Promise<void> {
    this.#call("addFavoriteArtists", ids.join(","));
    this.favourites.artists = [...this.favourites.artists.filter((id) => !ids.includes(id)), ...ids];
  }

  async removeFavoriteTracks(ids: readonly number[]): Promise<void> {
    this.#call("removeFavoriteTracks", ids.join(","));
    this.favourites.tracks = this.favourites.tracks.filter((id) => !ids.includes(id));
  }

  async removeFavoriteAlbums(ids: readonly string[]): Promise<void> {
    this.#call("removeFavoriteAlbums", ids.join(","));
    this.favourites.albums = this.favourites.albums.filter((id) => !ids.includes(id));
  }

  async removeFavoriteArtists(ids: readonly number[]): Promise<void> {
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
