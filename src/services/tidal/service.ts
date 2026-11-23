/**
 * TIDAL as a {@link MusicService}, over its official API (OpenAPI document
 * 1.10.258, read 2026-11-23). Written from the document alone.
 *
 * To confirm with a live probe (the document does not settle these):
 *
 * Access
 *  1. Which of these a third-party app gets with a user's token. `GET /tracks`
 *     (so finding by ISRC) lists only the INTERNAL scope `r_usr` for signed-in
 *     users; `GET /playlists`, search and the collections list it beside the
 *     third-party scopes, read here as "either". 401 and 403 are not listed at
 *     all.
 *  2. Rate limits; whether a 429 carries `Retry-After` (seconds or a date).
 *  3. Whether `Idempotency-Key` also replays a *failed* answer (429 or 5xx): a
 *     retry with the same key could then never succeed within the hour.
 * Reading
 *  4. Nested includes on relationship endpoints to three levels
 *     (`items.albums.coverArt`), unqualified where tracks and videos both have
 *     the relationship; sent comma-separated.
 *  5. An empty list is `data: []` (the schema does not require `data`); without
 *     it the read fails rather than call the playlist empty.
 *  6. `links.next` without a base path, and with the cursor alone enough to go
 *     on from our own path and parameters. Page sizes.
 *  7. How a track that is not available in the user's country appears: taken to
 *     stay in the list, without an included resource (it then keeps its place
 *     as "Unavailable track", playability unknown).
 *  8. `availability` (deprecated for `usageRules`, but simpler): that it is
 *     sent, and that a list without STREAM means "cannot be played".
 *  9. The `mediaTags` values (see models.ts).
 * 10. The first of a track's or album's `artists` is its main one, and a track's
 *     first album the one to show. `externalLinks` hold a TIDAL_SHARING https
 *     link. Artwork hosts (for the page's content policy).
 * 11. Order of an artist's `tracks`: hoped to be by popularity (each track has a
 *     `popularity` to sort by if not). `collapseBy=FINGERPRINT` folds copies.
 * 12. An artist's `albums`: their order (sorted here) and whether they include
 *     albums the artist only appears on.
 * 13. Search results come in order of relevance, and their first page within
 *     `/searchResults` itself, with a `next` link when there is more.
 * 14. `filter[isrc]` matches upper-case codes without hyphens, and answers an
 *     unknown one with an empty list (404 is taken the same way).
 * 15. `filter[owners.id]=me` lists every playlist the user owns, those in
 *     folders too. Playlists they only collaborate on are not listed.
 * Writing
 * 16. An add without `positionBefore` appends, in the order given, and with
 *     `onDuplicates: ADD` keeps repeats within one request.
 * 17. A move puts the entries in the order of the request, not of the playlist.
 * 18. Item ids stay the same through other edits and moves, and are unique at
 *     least within a playlist. An itemId sent with another resource's id is
 *     refused.
 * 19. What removing an entry that is already gone does: whether it fails the
 *     batch or is ignored (both are handled).
 * 20. `accessType` UNLISTED is the least public a playlist can be made, and is
 *     what `isPublic: false` gives; a new playlist without one may be PUBLIC, so
 *     it is always sent. An empty `description` clears it. Names are at most
 *     250 characters and descriptions 500; longer ones are refused.
 * 21. The most items a playlist holds (409 TOO_MANY_ITEMS_IN_PLAYLIST).
 * 22. Favourites: adding again what is there already changes nothing.
 */

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../../features/concurrency.js";
import { isNotFound, ServiceError } from "../errors.js";
import { nativeOf, type AnyId } from "../ids.js";
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
} from "../model.js";
import { CAN, type Account, type Capabilities, type MusicService, type PlaylistChanges, type PlaylistOptions } from "../service.js";
import { nextCursor, route, type TidalClient } from "./client.js";
import {
  identifiersOf,
  indexIncluded,
  parseAccount,
  parseAlbum,
  parseArtist,
  parsePlaylist,
  parseRelease,
  parseTrack,
  pick,
  refOf,
  relatedOf,
  relationshipOf,
  resourceOf,
  resourcesOf,
  toAlbum,
  toArtist,
  toItem,
  type Identifier,
  type Index,
  type ResourceRef,
} from "./models.js";

/** The document's limits for one request. */
const MAX_ADD = 50;
const MAX_REMOVE = 50;
const MAX_MOVE = 20;
const MAX_QUERY = 256;

const DEFAULT_TOP_TRACKS = 10;
/** Give up on an artist's own tracks after passing over this many of others'. */
const MAX_PASSED_OVER = 200;
const DEFAULT_MAX_RELEASES = 500;
/** Copies of one recording to weigh. */
const MAX_COPIES = 50;

/** How many playlists' entries, and how many searches, to remember. */
const MAX_KNOWN_PLAYLISTS = 100;
const MAX_WALKS = 100;

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
  quality: "tier",
  entryIds: "stable",
};

/** What is needed to read tracks (and videos), albums and artists whole. */
const TRACK_INCLUDES = ["artists", "albums.coverArt"];
const ALBUM_INCLUDES = ["artists", "coverArt"];
const under = (relationship: string, includes: readonly string[]): string[] =>
  includes.map((include) => `${relationship}.${include}`);

const native = (id: AnyId): string => nativeOf("tidal", id);
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Keep the newest `max` of a map. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    map.delete(map.keys().next().value!);
  }
}

/** A list read a page at a time as it is needed, by any number of readers. */
class Walk<T> {
  readonly #items: T[] = [];
  readonly #pages: AsyncGenerator<T[]>;
  #done = false;
  #failure: { error: unknown } | undefined;

  constructor(pages: AsyncGenerator<T[]>) {
    this.#pages = pages;
  }

  async slice(offset: number, limit: number): Promise<T[]> {
    while (!this.#done && this.#items.length < offset + limit) {
      try {
        // A generator answers its callers in turn.
        const { done, value } = await this.#pages.next();
        this.#done ||= done === true;
        this.#items.push(...(value ?? []));
      } catch (error) {
        this.#failure = { error };
      }
      if (this.#failure !== undefined) {
        throw this.#failure.error;
      }
    }
    return this.#items.slice(offset, offset + limit);
  }
}

type SearchKind = "tracks" | "albums" | "artists";

const COLLECTIONS = {
  tracks: "userCollectionTracks",
  albums: "userCollectionAlbums",
  artists: "userCollectionArtists",
} as const;

export class TidalService implements MusicService {
  readonly name = "tidal" as const;
  readonly capabilities = CAPABILITIES;
  readonly #client: TidalClient;
  #who: { account: Account; countryCode?: string } | undefined;
  #loading: Promise<{ account: Account; countryCode?: string }> | undefined;
  /** Per playlist, what each entry is: TIDAL wants both to move or remove it. */
  readonly #entries = new Map<string, Map<string, ResourceRef>>();
  /** Searches that may go on. */
  readonly #walks = new Map<string, Walk<unknown>>();

  constructor(client: TidalClient) {
    this.#client = client;
  }

  // ---- The account ----

  /** Who is signed in, once {@link load} (or anything else) has asked. */
  account(): Account | undefined {
    return this.#who?.account;
  }

  /** Ask who is signed in; asked once. */
  async load(): Promise<Account> {
    return (await this.#whoever()).account;
  }

  async #whoever(): Promise<{ account: Account; countryCode?: string }> {
    this.#loading ??= this.#client
      .get("/users/me")
      .then((document) => (this.#who = parseAccount(document)))
      .catch((error: unknown) => {
        this.#loading = undefined;
        throw error;
      });
    return this.#loading;
  }

  /** Whose catalogue to look in, where an endpoint takes it. */
  async #country(): Promise<{ countryCode: string | undefined }> {
    return { countryCode: (await this.#whoever()).countryCode };
  }

  // ---- The catalogue ----

  async searchArtists(query: string, limit = 10, offset = 0): Promise<Artist[]> {
    return this.#search("artists", query, limit, offset, [], parseArtist);
  }

  async searchAlbums(query: string, limit = 20, offset = 0): Promise<Album[]> {
    return this.#search("albums", query, limit, offset, ALBUM_INCLUDES, parseAlbum);
  }

  async searchTracks(query: string, limit = 20, offset = 0): Promise<Track[]> {
    return this.#search("tracks", query, limit, offset, TRACK_INCLUDES, parseTrack);
  }

  /**
   * A stretch of a search's results. TIDAL pages by cursor only, so a search
   * asked for further on goes on from where it was; one from the start is new.
   */
  async #search<T>(
    kind: SearchKind,
    query: string,
    limit: number,
    offset: number,
    includes: readonly string[],
    parse: (resource: unknown, index: Index) => T | undefined,
  ): Promise<T[]> {
    const text = query.trim().slice(0, MAX_QUERY);
    if (text.length === 0 || limit <= 0) {
      return [];
    }
    const key = `${kind} ${text}`;
    const known = offset > 0 ? (this.#walks.get(key) as Walk<T> | undefined) : undefined;
    if (known !== undefined) {
      try {
        return await known.slice(offset, limit);
      } catch (error) {
        if (!isRefusal(error)) {
          throw error;
        }
        // Perhaps it can no longer be gone on with: start over.
      }
    }
    const walk = new Walk(this.#searchPages(kind, text, includes, parse));
    remember(this.#walks, key, walk, MAX_WALKS);
    try {
      return await walk.slice(offset, limit);
    } catch (error) {
      this.#walks.delete(key);
      throw error;
    }
  }

  async *#searchPages<T>(
    kind: SearchKind,
    query: string,
    includes: readonly string[],
    parse: (resource: unknown, index: Index) => T | undefined,
  ): AsyncGenerator<T[]> {
    const common = { ...(await this.#country()), include: [kind, ...under(kind, includes)] };
    const document = await this.#client.get("/searchResults", { "filter[query]": query, ...common });
    const [result] = resourcesOf(document);
    yield pick(relatedOf(result, kind), indexIncluded(document), parse);
    const cursor = nextCursor(relationshipOf(result, kind));
    const [found] = identifiersOf(document);
    if (cursor === undefined || found === undefined) {
      return;
    }
    const path = route`/searchResults/${found.id}/relationships/${kind}`;
    for await (const page of this.#client.pages(path, common, cursor)) {
      yield pick(identifiersOf(page), indexIncluded(page), parse);
    }
  }

  async getTrack(trackId: TrackId): Promise<Track> {
    const ref = refOf(trackId);
    if (ref.type !== "tracks" && ref.type !== "videos") {
      return found<Track>(undefined);
    }
    const path = route`/${ref.type}/${ref.id}`;
    const document = await this.#client.get(path, { ...(await this.#country()), include: TRACK_INCLUDES });
    return found(parseTrack(resourceOf(document), indexIncluded(document)));
  }

  /**
   * One request per ISRC: for several at once TIDAL gives one track each, and
   * the caller is to choose between the copies.
   */
  async findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>> {
    const wanted = unique(isrcs.map(normaliseIsrc)).filter((isrc) => isrc.length > 0);
    const results = await mapWithConcurrency(wanted, DEFAULT_CONCURRENCY, async (isrc) => ({
      isrc,
      tracks: await this.#copies(isrc),
    }));
    return new Map(results.filter(({ tracks }) => tracks.length > 0).map(({ isrc, tracks }) => [isrc, tracks]));
  }

  async #copies(isrc: string): Promise<Track[]> {
    const query = { "filter[isrc]": isrc, ...(await this.#country()), include: TRACK_INCLUDES };
    const tracks: Track[] = [];
    try {
      for await (const document of this.#client.pages("/tracks", query)) {
        const index = indexIncluded(document);
        tracks.push(...resourcesOf(document).flatMap((resource) => parseTrack(resource, index) ?? []));
        if (tracks.length >= MAX_COPIES) {
          break;
        }
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    return tracks.filter((track) => track.isrc !== undefined && normaliseIsrc(track.isrc) === isrc);
  }

  async getArtist(artistId: ArtistId): Promise<Artist> {
    const path = route`/artists/${native(artistId)}`;
    return found(parseArtist(resourceOf(await this.#client.get(path, await this.#country()))));
  }

  /**
   * The artist's own tracks, as TIDAL orders them (whether by popularity is
   * unverified); those they only take part in are passed over.
   */
  async getArtistTopTracks(artistId: ArtistId, limit = DEFAULT_TOP_TRACKS): Promise<Track[]> {
    const path = route`/artists/${native(artistId)}/relationships/tracks`;
    const tracks: Track[] = [];
    let seen = 0;
    if (limit <= 0) {
      return tracks;
    }
    const query = {
      ...(await this.#country()),
      collapseBy: "FINGERPRINT",
      include: ["tracks", ...under("tracks", TRACK_INCLUDES)],
    };
    for await (const document of this.#client.pages(path, query)) {
      const page = pick(identifiersOf(document), indexIncluded(document), parseTrack);
      seen += page.length;
      tracks.push(...page.filter((track) => track.artistId === undefined || track.artistId === artistId));
      if (tracks.length >= limit || seen - tracks.length >= MAX_PASSED_OVER) {
        break;
      }
    }
    return tracks.slice(0, limit);
  }

  async getSimilarArtists(artistId: ArtistId, limit: number): Promise<Artist[]> {
    const path = route`/artists/${native(artistId)}/relationships/similarArtists`;
    const artists: Artist[] = [];
    if (limit <= 0) {
      return artists;
    }
    const query = { ...(await this.#country()), include: ["similarArtists"] };
    for await (const document of this.#client.pages(path, query)) {
      artists.push(...pick(identifiersOf(document), indexIncluded(document), parseArtist));
      if (artists.length >= limit) {
        break;
      }
    }
    return artists.slice(0, limit);
  }

  async getArtistReleases(artistId: ArtistId, maxReleases = DEFAULT_MAX_RELEASES): Promise<ArtistReleases> {
    const path = route`/artists/${native(artistId)}/relationships/albums`;
    const query = { ...(await this.#country()), include: ["albums", ...under("albums", ALBUM_INCLUDES)] };
    const releases: Release[] = [];
    let truncated = false;
    for await (const document of this.#client.pages(path, query)) {
      const page = pick(identifiersOf(document), indexIncluded(document), parseRelease);
      const room = maxReleases - releases.length;
      releases.push(...page.slice(0, room));
      if (releases.length >= maxReleases) {
        truncated = page.length > room || nextCursor(document) !== undefined;
        break;
      }
    }
    const date = (release: Release): string => release.releaseDate ?? "";
    releases.sort((a, b) => (date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : 0));
    return { releases, truncated };
  }

  async getAlbum(albumId: AlbumId): Promise<Album> {
    const path = route`/albums/${native(albumId)}`;
    const document = await this.#client.get(path, { ...(await this.#country()), include: ALBUM_INCLUDES });
    return found(parseAlbum(resourceOf(document), indexIncluded(document)));
  }

  /** An album's songs; its videos and unavailable tracks are left out. */
  async getAlbumTracks(albumId: AlbumId): Promise<Track[]> {
    const path = route`/albums/${native(albumId)}/relationships/items`;
    const query = { ...(await this.#country()), include: ["items", "items.artists"] };
    const [album, tracks] = await Promise.all([
      this.getAlbum(albumId),
      this.#items(path, query, (item, index) =>
        item.type === "tracks" && pick([item], index, parseTrack).length > 0 ? toItem(item, index, "album") : undefined,
      ),
    ]);
    return tracks.map((track) => ({
      ...track,
      album: album.title,
      albumId: album.id,
      ...(album.releaseDate !== undefined && { releaseDate: album.releaseDate }),
      ...(album.image !== undefined && { image: album.image }),
    }));
  }

  async getAlbumReleaseDate(albumId: AlbumId): Promise<string | undefined> {
    return (await this.getAlbum(albumId)).releaseDate;
  }

  /** Every item of a relationship, all pages; undefined ones are left out. */
  async #items<T>(
    path: string,
    query: Parameters<TidalClient["pages"]>[1],
    read: (item: Identifier, index: Index) => T | undefined,
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const document of this.#client.pages(path, query)) {
      const index = indexIncluded(document);
      items.push(...identifiersOf(document).flatMap((item) => read(item, index) ?? []));
    }
    return items;
  }

  // ---- Playlists ----

  /** The playlists the user owns. */
  async getUserPlaylists(): Promise<Playlist[]> {
    const { account, countryCode } = await this.#whoever();
    const playlists: Playlist[] = [];
    for await (const document of this.#client.pages("/playlists", { "filter[owners.id]": "me", countryCode })) {
      playlists.push(...resourcesOf(document).map((resource) => ({ ...parsePlaylist(resource), ownerId: account.id })));
    }
    return playlists;
  }

  async getPlaylist(playlistId: PlaylistId): Promise<Playlist> {
    const path = route`/playlists/${native(playlistId)}`;
    const document = await this.#client.get(path, { ...(await this.#country()), include: ["owners"] });
    return parsePlaylist(resourceOf(document));
  }

  async getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> {
    const playlist = native(playlistId);
    return (await this.#readPlaylist(playlist, ["items", ...under("items", TRACK_INCLUDES)])).map(({ item, index }) =>
      toItem(item, index, "playlist"),
    );
  }

  /** A playlist's items in order, noting what each entry is. */
  async #readPlaylist(
    playlist: string,
    include?: readonly string[],
  ): Promise<Array<{ item: Identifier; index: Index }>> {
    const path = route`/playlists/${playlist}/relationships/items`;
    const query = { ...(await this.#country()), include };
    const items = await this.#items(path, query, (item, index) => ({ item, index }));
    const entries = new Map<string, ResourceRef>();
    for (const { item } of items) {
      const itemId = item.meta["itemId"];
      if (typeof itemId === "string") {
        entries.set(itemId, { type: item.type, id: item.id });
      }
    }
    remember(this.#entries, playlist, entries, MAX_KNOWN_PLAYLISTS);
    return items;
  }

  async createPlaylist(name: string, options: PlaylistOptions = {}): Promise<Playlist> {
    const { account } = await this.#whoever();
    const { description } = options;
    const document = await this.#client.send("POST", "/playlists", {
      data: {
        type: "playlists",
        attributes: {
          name,
          accessType: accessTypeOf(options.isPublic ?? false),
          ...(description !== undefined && { description }),
        },
      },
    });
    return { ...parsePlaylist(resourceOf(document)), ownerId: account.id };
  }

  async updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges): Promise<Playlist> {
    const id = native(playlistId);
    const { name, description, isPublic } = changes;
    const attributes = {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(isPublic !== undefined && { accessType: accessTypeOf(isPublic) }),
    };
    if (Object.keys(attributes).length > 0) {
      await this.#client.send("PATCH", route`/playlists/${id}`, { data: { type: "playlists", id, attributes } });
    }
    return this.getPlaylist(playlistId);
  }

  async deletePlaylist(playlistId: PlaylistId): Promise<void> {
    const id = native(playlistId);
    await this.#client.send("DELETE", route`/playlists/${id}`);
    this.#entries.delete(id);
  }

  /** Tracks TIDAL does not have (any more) are skipped, as by every service. */
  async addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void> {
    const playlist = native(playlistId);
    const path = route`/playlists/${playlist}/relationships/items`;
    const refs = trackIds.map(refOf);
    for (const data of chunk(refs, MAX_ADD)) {
      const document = await this.#client.send("POST", path, { data, meta: { onDuplicates: "ADD" } });
      this.#noteAdded(playlist, document);
    }
  }

  /** The answer to an add names the new entries; a playlist not read yet stays so. */
  #noteAdded(playlist: string, document: unknown): void {
    const entries = this.#entries.get(playlist) ?? new Map<string, ResourceRef>();
    for (const item of relatedOf({ relationships: { items: document } }, "items")) {
      const itemId = item.meta["itemId"];
      if (typeof itemId === "string") {
        entries.set(itemId, { type: item.type, id: item.id });
      }
    }
    remember(this.#entries, playlist, entries, MAX_KNOWN_PLAYLISTS);
  }

  /** Entries that are not in the playlist (any more) are passed over. */
  async removeTracksFromPlaylist(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<void> {
    const playlist = native(playlistId);
    const path = route`/playlists/${playlist}/relationships/items`;
    const itemIds = unique(entryIds.map(native));
    if (itemIds.some((itemId) => this.#entries.get(playlist)?.has(itemId) !== true)) {
      await this.#readPlaylist(playlist);
    }
    const remove = async (data: readonly unknown[]): Promise<void> => {
      if (data.length > 0) {
        await this.#client.send("DELETE", path, { data });
      }
    };
    for (const batch of chunk(this.#named(playlist, itemIds), MAX_REMOVE)) {
      try {
        await remove(batch);
      } catch (error) {
        if (!isRefusal(error)) {
          throw error;
        }
        // Perhaps some were removed elsewhere since the playlist was read.
        await this.#readPlaylist(playlist);
        const left = this.#named(playlist, batch.map(({ meta }) => meta.itemId));
        if (left.length === batch.length) {
          throw error;
        }
        await remove(left);
      }
      batch.forEach(({ meta }) => this.#entries.get(playlist)?.delete(meta.itemId));
    }
  }

  async movePlaylistTracks(
    playlistId: PlaylistId,
    entryIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void> {
    const playlist = native(playlistId);
    const path = route`/playlists/${playlist}/relationships/items`;
    const itemIds = unique(entryIds.map(native));
    if (itemIds.length === 0) {
      return;
    }
    // TIDAL takes the entry to go in front of, not a place: look who is there,
    // or is next of those that stay.
    const order = (await this.#readPlaylist(playlist)).map(({ item }) => item.meta["itemId"]);
    const moving = new Set<unknown>(itemIds);
    const anchorAt = order.findIndex((itemId, i) => i >= insertBefore - 1 && !moving.has(itemId));
    const positionBefore = order[anchorAt];
    if (anchorAt >= 0 && typeof positionBefore !== "string") {
      throw new ServiceError("tidal", "api-response", "TIDAL did not say which entry to move in front of");
    }
    // Every batch goes directly in front of the same entry (or to the end), so
    // each lands behind the one before it.
    for (const data of chunk(this.#named(playlist, itemIds), MAX_MOVE)) {
      await this.#client.send("PATCH", path, { data, ...(anchorAt >= 0 && { meta: { positionBefore } }) });
    }
  }

  /** The entries a write names, of those known to be in the playlist. */
  #named(playlist: string, itemIds: readonly string[]): Array<ResourceRef & { meta: { itemId: string } }> {
    const entries = this.#entries.get(playlist);
    return itemIds.flatMap((itemId) => {
      const ref = entries?.get(itemId);
      return ref === undefined ? [] : [{ ...ref, meta: { itemId } }];
    });
  }

  // ---- Favourites ----

  async getFavoriteTracks(): Promise<Track[]> {
    return this.#favourites("tracks", TRACK_INCLUDES, (item, index) => toItem(item, index, "favourites"));
  }

  async getFavoriteAlbums(): Promise<Album[]> {
    return this.#favourites("albums", ALBUM_INCLUDES, toAlbum);
  }

  async getFavoriteArtists(): Promise<Artist[]> {
    return this.#favourites("artists", [], toArtist);
  }

  async #favourites<T>(
    kind: keyof typeof COLLECTIONS,
    includes: readonly string[],
    read: (item: Identifier, index: Index) => T,
  ): Promise<T[]> {
    return this.#items(collectionPath(kind), { include: ["items", ...under("items", includes)] }, read);
  }

  async addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    await this.#changeFavourites("POST", "tracks", trackIds.map(favouriteTrack));
  }

  async addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#changeFavourites("POST", "albums", albumIds.map(native));
  }

  async addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#changeFavourites("POST", "artists", artistIds.map(native));
  }

  async removeFavoriteTracks(trackIds: readonly TrackId[]): Promise<void> {
    await this.#changeFavourites("DELETE", "tracks", trackIds.map(favouriteTrack));
  }

  async removeFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void> {
    await this.#changeFavourites("DELETE", "albums", albumIds.map(native));
  }

  async removeFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void> {
    await this.#changeFavourites("DELETE", "artists", artistIds.map(native));
  }

  async #changeFavourites(
    method: "POST" | "DELETE",
    kind: keyof typeof COLLECTIONS,
    ids: readonly string[],
  ): Promise<void> {
    for (const batch of chunk(unique(ids), method === "POST" ? MAX_ADD : MAX_REMOVE)) {
      await this.#client.send(method, collectionPath(kind), { data: batch.map((id) => ({ type: kind, id })) });
    }
  }
}

const collectionPath = (kind: keyof typeof COLLECTIONS): string =>
  route`/${COLLECTIONS[kind]}/me/relationships/items`;

const accessTypeOf = (isPublic: boolean): string => (isPublic ? "PUBLIC" : "UNLISTED");

/** TIDAL keeps favourite videos apart from favourite tracks. */
function favouriteTrack(id: TrackId): string {
  const ref = refOf(id);
  if (ref.type !== "tracks") {
    throw new ServiceError("tidal", "unsupported", "A TIDAL video cannot be a favourite track");
  }
  return ref.id;
}

/** TIDAL answered, but did not do it, or did not say that it did. */
function isRefusal(error: unknown): boolean {
  return error instanceof ServiceError && (error.kind === "not-found" || error.kind === "api-response");
}

/** A resource TIDAL answered with; one it says nothing about might as well not be there. */
function found<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new ServiceError("tidal", "not-found", "TIDAL says nothing about it");
  }
  return value;
}
