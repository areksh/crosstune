/**
 * Spotify as a {@link MusicService}, over its official Web API as development
 * mode apps see it (February to November 2026).
 *
 * To confirm with a live probe (nothing here has been run against Spotify):
 *
 *  1. DELETE /playlists/{id}/items removes every copy of a song, and cannot name
 *     one by position. If it can, single copies need no re-adding
 *     (./playlists.ts).
 *  2. Whether a DELETE that names an older snapshot spares copies added after
 *     it. If so, kept copies can be added first and nothing is ever missing.
 *  3. Local files: that they can be moved by range, and whether they can be
 *     removed at all (refused here; the guide says by position, which the
 *     reference no longer has).
 *  4. A range move against an older snapshot is merged, not refused; and
 *     `range_length` has a limit, if it has (100 assumed).
 *  5. GET /playlists/{id} holds `snapshot_id` and the first items together
 *     (`items.items[].item`, 100 of them), `items` is absent for others'
 *     playlists, and `fields` works. Any size of first page will do.
 *  6. A read straight after a write shows it, and a snapshot id does not change
 *     on its own. If not, moves fail as "changed meanwhile" and a finished
 *     re-adding may be reported as interrupted.
 *  7. An unreadable item is `null` in its place and counts in `total` and in
 *     positions.
 *  8. Limits: 100 items per add and removal, 50 items a page, 40 URIs per library
 *     request, 10 results per search and per page of an artist's albums.
 *  9. PUT and DELETE /me/library take `uris` in the query (as the reference
 *     says; the migration guide shows a JSON body), and take artists, which the
 *     reference leaves out, and playlists.
 * 10. Taking an own playlist out of the library deletes it as the app does, and
 *     putting it back undoes that.
 * 11. `isrc:` searches find a recording, with `external_ids.isrc` in the results.
 * 12. Whether `is_playable` comes without a market (playability is declared
 *     "no", and it is not read).
 * 13. Whether songs are relinked without `linked_from` saying so: a URI read
 *     from a playlist must be the one DELETE knows.
 * 14. GET /me/following, /me/albums and /artists/{id}/albums page as documented,
 *     and what an app without Premium or a user off its list is told (403
 *     assumed).
 * 15. QUOTA_EXCEEDED comes as `error.reason`, and whether with `Retry-After`.
 * 16. An added item Spotify no longer offers: refused (400, the whole batch) or
 *     silently left out.
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
    return understood(parsePlaylist(answer), "playlist");
  }

  async updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges): Promise<Playlist> {
    const { name, description, isPublic } = changes;
    await this.#client.send("PUT", `/playlists/${plainId(playlistId)}`, {
      body: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(isPublic !== undefined && { public: isPublic }),
      },
      repeatable: true,
    });
    return this.getPlaylist(playlistId);
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
