/**
 * Spotify as a {@link MusicService}, over its official Web API as development
 * mode apps see it (February to November 2026).
 *
 * Probed live on 2026-11-23 (development mode, scratch playlists only):
 *
 *  - A read names a stale snapshot: the one of the playlist's last change of
 *    name or description, never of its items (5, 6). A DELETE naming an older
 *    snapshot spares every copy added after it (2) -- so against a read's
 *    snapshot it removed nothing, and taking out one copy of a repeated song
 *    added one instead. Now the first write after a read names no snapshot and
 *    later ones name our last write's answer (./playlists.ts).
 *  - Confirmed: DELETE removes every copy of a song (1); a range move naming an
 *    older snapshot is worked out against the playlist as it is (4); a read
 *    holds the first items with the playlist (`items.items[].item`, 5) and
 *    shows a write straight after it (6); search gives 10 a page (8);
 *    `DELETE /me/library?uris=` takes a playlist out, and with it out of the
 *    user's playlists (9, 10); `isrc:` search finds every copy, with
 *    `external_ids.isrc` (11); `is_playable` comes without a market (12): read
 *    into `streamable`, so a sync takes a removed song that still plays as
 *    removed, but playability is not claimed, so no tidy-up removes by it;
 *    the library and follows read (14).
 *  - Found: an empty description is ignored (a space clears it, and is read
 *    back as none); `public: false` works (the user saw the playlist kept off
 *    their profile), but every read says true, so it is not read: a playlist's
 *    visibility is what was last set here, else unknown.
 *  - Not seen: local files (3); a null item (7); relinking (13); a 429 or
 *    QUOTA_EXCEEDED (15); an added song no longer offered (16); saving songs,
 *    albums or artists to the library (9, not probed: it writes to the user's).
 */

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../../features/concurrency.js";
import { nativeOf } from "../ids.js";
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
  Track,
  TrackId,
} from "../model.js";
import {
  CAN,
  cannot,
  type Account,
  type Capabilities,
  type Capability,
  type MusicService,
  type PlaylistChanges,
  type PlaylistOptions,
} from "../service.js";
import { SpotifyError, type SpotifyClient } from "./client.js";
import {
  isRecord,
  parseAccount,
  parseAlbum,
  parseArtist,
  parsePlaylist,
  parseRelease,
  parseTrack,
  text,
} from "./models.js";
import { PlaylistEditor } from "./playlists.js";
import { isLocal, isSong, plainId, uriOf } from "./uris.js";

const SEARCH_PAGE = 10;
/** Spotify pages a search no further. */
const SEARCH_END = 1000;
const ARTIST_ALBUMS_PAGE = 10;
const PAGE = 50;
const LIBRARY_URIS_PER_REQUEST = 40;
const DEFAULT_MAX_RELEASES = 500;

const OTHERS_PLAYLISTS = "Spotify shows the songs only of playlists you own or share in";

const CAPABILITIES: Capabilities = {
  topTracks: cannot("Spotify no longer gives apps an artist's most played songs"),
  similarArtists: cannot("Spotify no longer gives apps similar artists"),
  artistReleases: CAN,
  readOthersPlaylists: cannot(OTHERS_PLAYLISTS),
  editorialPlaylists: cannot("Spotify no longer gives apps its own playlists"),
  movePlaylistEntries: CAN,
  deletePlaylist: CAN,
  playlistVisibility: CAN,
  searchByIsrc: CAN,
  playability: cannot("Spotify does not tell apps whether a song can be played"),
  favouritedDates: CAN,
  quality: "none",
  entryIds: "positional",
};

/** What a playlist is, without its songs. */
const PLAYLIST_FIELDS = "id,name,description,public,collaborative,owner,external_urls,items(total)";

/** @throws {SpotifyError} kind `unsupported`, always: for what is declared "no". */
function unsupported(capability: Capability): never {
  throw new SpotifyError("unsupported", capability.ok ? "Spotify cannot do this" : capability.reason);
}

function understood<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new SpotifyError("api-response", `Spotify's answer held no ${what}`);
  }
  return value;
}

/** What `parse` makes of each item, without those it cannot read. */
function read<T>(items: readonly unknown[], parse: (item: unknown) => T | undefined): T[] {
  return items.flatMap((item) => parse(item) ?? []);
}

function field(item: unknown, name: string): unknown {
  return isRecord(item) ? item[name] : undefined;
}

/** A library item of the kind `name`, with when it was added. */
function savedTrack(item: unknown): Track | undefined {
  const track = parseTrack(field(item, "track"));
  const favouritedAt = text(field(item, "added_at"));
  return track === undefined || favouritedAt === undefined ? track : { ...track, favouritedAt };
}

export class SpotifyService implements MusicService {
  readonly name = "spotify" as const;
  readonly capabilities = CAPABILITIES;
  readonly #client: SpotifyClient;
  readonly #playlists: PlaylistEditor;
  #account: Account | undefined;

  constructor(client: SpotifyClient) {
    this.#client = client;
    this.#playlists = new PlaylistEditor(client, OTHERS_PLAYLISTS);
  }

  /** Who is signed in, once {@link load} has asked. */
  account(): Account | undefined {
    return this.#account;
  }

  /** Ask Spotify who is signed in. */
  async load(): Promise<Account> {
    this.#account = understood(parseAccount(await this.#client.get("/me")), "account");
    return this.#account;
  }

  // -- Reads --------------------------------------------------------------

  searchArtists(query: string, limit = SEARCH_PAGE, offset = 0): Promise<Artist[]> {
    return this.#search("artist", parseArtist, query, limit, offset);
  }

  searchAlbums(query: string, limit = SEARCH_PAGE, offset = 0): Promise<Album[]> {
    return this.#search("album", parseAlbum, query, limit, offset);
  }

  searchTracks(query: string, limit = SEARCH_PAGE, offset = 0): Promise<Track[]> {
    return this.#search("track", parseTrack, query, limit, offset);
  }

  async #search<T>(
    type: "artist" | "album" | "track",
    parse: (item: unknown) => T | undefined,
    query: string,
    limit: number,
    offset: number,
  ): Promise<T[]> {
    const max = Math.min(limit, SEARCH_END - offset);
    if (max <= 0) {
      return [];
    }
    const { items } = await this.#client.pages(
      "/search",
      { q: query, type },
      { size: SEARCH_PAGE, max, inside: `${type}s`, from: offset },
    );
    return read(items, parse);
  }

  async getTrack(trackId: TrackId): Promise<Track> {
    uriOf(trackId);
    if (!isSong(trackId)) {
      throw new SpotifyError("unsupported", "Spotify can look up songs only, not episodes or local files");
    }
    const answer = await this.#client.get(`/tracks/${nativeOf("spotify", trackId)}`);
    return understood(parseTrack(answer), "song");
  }

  /** One search per ISRC; only results that carry it count. */
  async findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>> {
    const wanted = [...new Set(isrcs.map(normaliseIsrc))].filter((isrc) => isrc.length > 0);
    const results = await mapWithConcurrency(wanted, DEFAULT_CONCURRENCY, async (isrc) => {
      const found = await this.searchTracks(`isrc:${isrc}`);
      return [isrc, found.filter((track) => track.isrc !== undefined && normaliseIsrc(track.isrc) === isrc)] as const;
    });
    return new Map(results.filter(([, tracks]) => tracks.length > 0));
  }

  async getArtist(artistId: ArtistId): Promise<Artist> {
    return understood(parseArtist(await this.#client.get(`/artists/${plainId(artistId)}`)), "artist");
  }

  async getArtistTopTracks(): Promise<Track[]> {
    return unsupported(CAPABILITIES.topTracks);
  }

  async getSimilarArtists(): Promise<Artist[]> {
    return unsupported(CAPABILITIES.similarArtists);
  }

  async getArtistReleases(artistId: ArtistId, maxReleases = DEFAULT_MAX_RELEASES): Promise<ArtistReleases> {
    const { items, more } = await this.#client.pages(
      `/artists/${plainId(artistId)}/albums`,
      { include_groups: "album,single,compilation" },
      { size: ARTIST_ALBUMS_PAGE, max: maxReleases },
    );
    return { releases: read(items, parseRelease), truncated: more };
  }

  async getAlbum(albumId: AlbumId): Promise<Album> {
    return understood(parseAlbum(await this.#client.get(`/albums/${plainId(albumId)}`)), "album");
  }

  /** Without ISRCs: Spotify gives them song by song only. */
  async getAlbumTracks(albumId: AlbumId): Promise<Track[]> {
    const path = `/albums/${plainId(albumId)}`;
    const album = await this.#client.get(path);
    const page = field(album, "tracks");
    const first = field(page, "items");
    const items: unknown[] = Array.isArray(first) ? [...first] : [];
    if (!Array.isArray(first) || text(field(page, "next")) !== undefined) {
      items.push(...(await this.#client.pages(`${path}/tracks`, {}, { size: PAGE, from: items.length })).items);
    }
    return read(items, (item) => parseTrack(isRecord(item) ? { ...item, album } : item));
  }

  async getAlbumReleaseDate(albumId: AlbumId): Promise<string | undefined> {
    return (await this.getAlbum(albumId)).releaseDate;
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    return read((await this.#client.pages("/me/playlists", {}, { size: PAGE })).items, parsePlaylist);
  }

  async getPlaylist(playlistId: PlaylistId): Promise<Playlist> {
    const answer = await this.#client.get(`/playlists/${plainId(playlistId)}`, { fields: PLAYLIST_FIELDS });
    return understood(parsePlaylist(answer), "playlist");
  }

  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> {
    return this.#playlists.read(playlistId);
  }

  async getFavoriteTracks(): Promise<Track[]> {
    return read((await this.#client.pages("/me/tracks", {}, { size: PAGE })).items, savedTrack);
  }

  async getFavoriteAlbums(): Promise<Album[]> {
    const { items } = await this.#client.pages("/me/albums", {}, { size: PAGE });
    return read(items, (item) => parseAlbum(field(item, "album")));
  }

  /** The artists the user follows. */
  async getFavoriteArtists(): Promise<Artist[]> {
    return read(
      await this.#client.cursorPages("/me/following", { type: "artist" }, { size: PAGE, inside: "artists" }),
      parseArtist,
    );
  }

  // -- Playlists ----------------------------------------------------------

  async createPlaylist(name: string, options: PlaylistOptions = {}): Promise<Playlist> {
    const { description, isPublic = false } = options;
    const answer = await this.#client.send("POST", "/me/playlists", {
      body: {
        name,
        public: isPublic,
        ...(description !== undefined && description !== "" && { description }),
      },
    });
    // What was asked for: Spotify's reads say "public" of every playlist.
    return { ...understood(parsePlaylist(answer), "playlist"), isPublic };
  }

  async updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges): Promise<Playlist> {
    const { name, description, isPublic } = changes;
    await this.#client.send("PUT", `/playlists/${plainId(playlistId)}`, {
      body: {
        ...(name !== undefined && { name }),
        // An empty description is ignored; a space clears it (seen live).
        ...(description !== undefined && { description: description === "" ? " " : description }),
        ...(isPublic !== undefined && { public: isPublic }),
      },
      repeatable: true,
    });
    const playlist = await this.getPlaylist(playlistId);
    return isPublic === undefined ? playlist : { ...playlist, isPublic };
  }

  /** Spotify deletes no playlists: it is taken out of the user's library. */
  async deletePlaylist(playlistId: PlaylistId): Promise<void> {
    await this.#library("DELETE", [`spotify:playlist:${plainId(playlistId)}`]);
  }

  addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void> {
    return this.#playlists.add(playlistId, trackIds);
  }

  /**
   * Where a copy of a song stays, the song is taken out and that copy added
   * again, with a new added date: ask {@link removesByReAdding} first.
   *
   * @throws {RemovalInterrupted} if a copy that stays may be missing.
   */
  removeTracksFromPlaylist(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<void> {
    return this.#playlists.remove(playlistId, entryIds);
  }

  /** The songs whose other copies removing these entries would take out and add again. */
  removesByReAdding(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<TrackId[]> {
    return this.#playlists.readdedBy(playlistId, entryIds);
  }

  movePlaylistTracks(playlistId: PlaylistId, entryIds: readonly EntryId[], insertBefore: number): Promise<void> {
    return this.#playlists.move(playlistId, entryIds, insertBefore);
  }

  // -- Favourites ---------------------------------------------------------

  async addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    const uris = trackIds.map(uriOf);
    if (trackIds.some(isLocal)) {
      throw new SpotifyError("unsupported", "Spotify's API cannot add local files to the favourites");
    }
    await this.#library("PUT", uris);
  }

  async addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#library("PUT", albumIds.map((id) => `spotify:album:${plainId(id)}`));
  }

  async addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#library("PUT", artistIds.map((id) => `spotify:artist:${plainId(id)}`));
  }

  async removeFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    await this.#library("DELETE", trackIds.map(uriOf));
  }

  async removeFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#library("DELETE", albumIds.map((id) => `spotify:album:${plainId(id)}`));
  }

  async removeFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#library("DELETE", artistIds.map((id) => `spotify:artist:${plainId(id)}`));
  }

  async #library(method: "PUT" | "DELETE", uris: readonly string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += LIBRARY_URIS_PER_REQUEST) {
      await this.#client.send(method, "/me/library", {
        query: { uris: uris.slice(i, i + LIBRARY_URIS_PER_REQUEST).join(",") },
        repeatable: true,
      });
    }
  }
}
