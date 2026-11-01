/**
 * Qobuz API client.
 *
 * Wires the pieces together: extract bundle tokens, validate an app secret,
 * sign in, and make authenticated requests. The HTTP boundary (`fetch`) and the
 * clock (`now`) are injectable so the client can be tested deterministically
 * without live network access.
 */

import { parseLoginResponse, type UserSession } from "./auth.js";
import { fetchBundleTokens, type BundleTokens } from "./bundle.js";
import { buildUrl, paths } from "./endpoints.js";
import { QobuzError } from "./errors.js";
import {
  parseAlbumReleaseDate,
  parseAlbums,
  parseAlbumsPage,
  parseArtistPageTracks,
  parseArtists,
  parseArtistsPage,
  parsePlaylist,
  parsePlaylistsPage,
  parseAlbumTracks,
  parseTracks,
  parseTracksPage,
  type Album,
  type Artist,
  type Playlist,
  type Track,
  type TracksPage,
} from "./models.js";
import { signGetFileUrl, signRequest, signSearch } from "./signing.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

/** A known public track used to probe whether an app secret is valid. */
const SECRET_PROBE_TRACK_ID = 5966783;

/**
 * Maximum number of track ids to send in a single playlist/favourites mutation.
 * Qobuz rejects a request that carries too many ids at once (the signed GET URL
 * grows too long), so bulk add/remove operations are split into batches of this
 * size. Chosen conservatively; the web player batches similarly.
 */
const MAX_TRACK_IDS_PER_REQUEST = 50;

/**
 * How many times a request rejected with HTTP 400 is retried before giving up.
 * Qobuz throttles bursts of signed requests with a 400, so a short exponential
 * backoff usually rides it out. Auth/validation 400s that are not throttling
 * simply exhaust the retries and surface as before.
 */
const MAX_RETRIES = 5;

/** Base backoff in milliseconds, doubled each retry (500, 1000, 2000, ...). */
const RETRY_BASE_MS = 500;

/** Split an array into consecutive slices of at most `size` items (size >= 1). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * The validated credentials a client resolves during {@link QobuzClient.init}:
 * the app id, the single app secret that proved valid, and (when the bundle
 * carries one) the OAuth private key. Small and serialisable so it can be
 * cached locally and replayed via {@link QobuzClient.initFromCache}.
 */
export interface ResolvedCredentials {
  appId: string;
  secret: string;
  privateKey?: string;
}

/** The debug logging the client needs (satisfied structurally by the CLI logger). */
export interface RequestLogger {
  debug(message: string): void;
}

export interface QobuzClientOptions {
  /** HTTP implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Unix-seconds clock; defaults to the real clock. Injectable for tests. */
  now?: () => number;
  /**
   * Sleep for the given number of milliseconds; used for retry backoff.
   * Defaults to a real `setTimeout` delay, injectable so tests need not wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /** User-Agent header sent on every request. */
  userAgent?: string;
  /**
   * Optional logger receiving one `debug` line per HTTP request (method, API
   * path and response status). Only the path is logged, never the query, so
   * signed tokens and secrets stay out of the logs.
   */
  logger?: RequestLogger;
}

export class QobuzClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;
  readonly #logger: RequestLogger;

  #tokens?: BundleTokens;
  #validatedSecret?: string;
  #session?: UserSession;

  constructor(options: QobuzClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#logger = options.logger ?? { debug: () => {} };
  }

  /** The extracted app id, once {@link init} has run. */
  get appId(): string {
    return this.#requireTokens().appId;
  }

  /** Whether a user session is currently held. */
  get isLoggedIn(): boolean {
    return this.#session !== undefined;
  }

  /**
   * Extract bundle tokens and validate an app secret. Must be called before any
   * signed request.
   *
   * @throws {QobuzError} if extraction fails or no candidate secret validates.
   */
  async init(): Promise<void> {
    this.#tokens = await fetchBundleTokens(this.#fetch);
    this.#validatedSecret = await this.#validateSecret(this.#tokens.secrets);
  }

  /**
   * The credentials resolved by {@link init}, ready to be cached.
   *
   * @throws {QobuzError} if the client has not been initialised.
   */
  get credentials(): ResolvedCredentials {
    const tokens = this.#requireTokens();
    const secret = this.#requireSecret();
    return tokens.privateKey === undefined
      ? { appId: tokens.appId, secret }
      : { appId: tokens.appId, secret, privateKey: tokens.privateKey };
  }

  /**
   * Prime the client from previously cached {@link ResolvedCredentials},
   * skipping the bundle fetch and secret-probe that {@link init} performs.
   *
   * The cached secret is trusted as-is (it validated when first cached); if
   * Qobuz has since rotated its credentials the cached values become stale and
   * later requests will fail, so callers should discard the cache and fall back
   * to {@link init} on such failures.
   */
  initFromCache(credentials: ResolvedCredentials): void {
    this.#tokens =
      credentials.privateKey === undefined
        ? { appId: credentials.appId, secrets: [credentials.secret] }
        : {
            appId: credentials.appId,
            secrets: [credentials.secret],
            privateKey: credentials.privateKey,
          };
    this.#validatedSecret = credentials.secret;
  }

  /**
   * Complete sign-in with an OAuth authorization code.
   *
   * Qobuz no longer accepts email/password against `/user/login`; the user
   * authenticates in a browser on Qobuz's site, which yields an authorization
   * code (see the `oauth` module and the CLI's browser flow). This exchanges
   * that code in two steps: `/oauth/callback` returns a user auth token, then a
   * POST to `/user/login` with that token returns the full session.
   *
   * @throws {QobuzError} kind `bundle-extraction` if the bundle carried no OAuth
   *   private key; `authentication` if the code/token is rejected; or
   *   `ineligible-user` if the account has no active subscription.
   */
  async loginWithOAuthCode(code: string): Promise<UserSession> {
    const tokens = this.#requireTokens();
    if (tokens.privateKey === undefined) {
      throw new QobuzError(
        "bundle-extraction",
        "OAuth private key not available in bundle",
      );
    }

    // Step 1: exchange the authorization code for a user auth token.
    const callbackResponse = await this.#request("GET", paths.oauthCallback, {
      query: {
        code,
        private_key: tokens.privateKey,
        app_id: tokens.appId,
      },
      headers: this.#appIdHeaders(),
    });
    if (!callbackResponse.ok) {
      throw new QobuzError(
        "authentication",
        `OAuth callback failed with HTTP ${callbackResponse.status}`,
      );
    }
    const callbackJson = (await callbackResponse.json()) as { token?: unknown };
    if (typeof callbackJson.token !== "string") {
      throw new QobuzError("authentication", "OAuth callback returned no token");
    }

    // Step 2: exchange the token for a full session.
    return this.#establishSession(callbackJson.token);
  }

  /**
   * Restore a session from a previously saved user auth token.
   *
   * Used to resume a persisted login without the browser flow. Qobuz validates
   * the token; an expired or revoked token raises an `authentication` error so
   * the caller can fall back to a fresh sign-in.
   *
   * @throws {QobuzError} kind `authentication` if the token is rejected.
   */
  async loginWithToken(token: string): Promise<UserSession> {
    return this.#establishSession(token);
  }

  /** Exchange a user auth token for a full session via POST /user/login. */
  async #establishSession(token: string): Promise<UserSession> {
    const response = await this.#request("POST", paths.userLogin, {
      headers: {
        ...this.#appIdHeaders(),
        "X-User-Auth-Token": token,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: "extra=partner",
    });
    if (response.status === 401) {
      throw new QobuzError("authentication", "Auth token rejected");
    }
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `Login failed with HTTP ${response.status}`,
      );
    }

    const session = parseLoginResponse(await response.json());
    this.#session = session;
    return session;
  }

  /**
   * Fetch the signed-in user's favourites of a given type (e.g. `tracks`,
   * `albums`, `artists`). Returns the raw JSON payload.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async getUserFavorites(
    type: "tracks" | "albums" | "artists",
    limit = 50,
    offset = 0,
  ): Promise<unknown> {
    const session = this.#requireSession();
    const timestamp = this.#now();
    const signature = signRequest(
      "favoritegetUserFavorites",
      [],
      timestamp,
      this.#requireSecret(),
    );

    const response = await this.#request("GET", paths.favoriteGetUserFavorites, {
      query: {
        type,
        limit: String(limit),
        offset: String(offset),
        request_ts: String(timestamp),
        request_sig: signature,
      },
      headers: {
        ...this.#appIdHeaders(),
        "X-User-Auth-Token": session.userAuthToken,
      },
    });

    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `getUserFavorites failed with HTTP ${response.status}`,
      );
    }
    return response.json();
  }

  /**
   * Search for artists by name, most relevant first.
   *
   * @param query The artist name to search for.
   * @param limit Maximum results (default 10).
   * @param offset Result offset (default 0).
   */
  async searchArtists(query: string, limit = 10, offset = 0): Promise<Artist[]> {
    const timestamp = this.#now();
    const signature = signSearch(
      "artistsearch",
      query,
      limit,
      offset,
      undefined,
      timestamp,
      this.#requireSecret(),
    );
    const response = await this.#request("GET", paths.artistSearch, {
      query: {
        query,
        limit: String(limit),
        offset: String(offset),
        request_ts: String(timestamp),
        request_sig: signature,
      },
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `artist search failed with HTTP ${response.status}`,
      );
    }
    return parseArtists(await response.json());
  }

  /**
   * Search for albums by name, most relevant first.
   *
   * A query combining the artist and album name (e.g. "radiohead ok computer")
   * gives the best matches; the caller filters the results to the ones it wants.
   *
   * @param query The album (and artist) name to search for.
   * @param limit Maximum results (default 20).
   * @param offset Result offset (default 0).
   */
  async searchAlbums(query: string, limit = 20, offset = 0): Promise<Album[]> {
    const timestamp = this.#now();
    const signature = signSearch(
      "albumsearch",
      query,
      limit,
      offset,
      "album",
      timestamp,
      this.#requireSecret(),
    );
    const response = await this.#request("GET", paths.albumSearch, {
      query: {
        query,
        limit: String(limit),
        offset: String(offset),
        type: "album",
        request_ts: String(timestamp),
        request_sig: signature,
      },
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `album search failed with HTTP ${response.status}`,
      );
    }
    return parseAlbums(await response.json());
  }

  /**
   * Search for tracks by name, most relevant first.
   *
   * A query combining the artist and track title (e.g. "portishead roads")
   * gives the best matches; the caller filters the results to the ones it wants.
   *
   * @param query The track (and artist) name to search for.
   * @param limit Maximum results (default 20).
   * @param offset Result offset (default 0).
   */
  async searchTracks(query: string, limit = 20, offset = 0): Promise<Track[]> {
    const timestamp = this.#now();
    const signature = signSearch(
      "tracksearch",
      query,
      limit,
      offset,
      undefined,
      timestamp,
      this.#requireSecret(),
    );
    const response = await this.#request("GET", paths.trackSearch, {
      query: {
        query,
        limit: String(limit),
        offset: String(offset),
        request_ts: String(timestamp),
        request_sig: signature,
      },
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `track search failed with HTTP ${response.status}`,
      );
    }
    return parseTracks(await response.json());
  }

  /**
   * Fetch the artists Qobuz lists as similar to an artist, most similar first.
   *
   * Uses `/artist/getSimilarArtists`, which is paginated and runs far deeper
   * than the five similar artists embedded in `/artist/page` (dozens for a
   * well-known artist). Only the first page of `limit` is requested.
   *
   * @param artistId The Qobuz artist id.
   * @param limit Maximum artists to return.
   */
  async getSimilarArtists(artistId: number, limit: number): Promise<Artist[]> {
    const response = await this.#signedGet(
      "artistgetSimilarArtists",
      paths.artistGetSimilarArtists,
      [
        ["artist_id", String(artistId)],
        ["limit", String(limit)],
        ["offset", "0"],
      ],
    );
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `artist/getSimilarArtists failed with HTTP ${response.status}`,
      );
    }
    return parseArtists(await response.json());
  }

  /**
   * Fetch an artist's most popular tracks.
   *
   * Uses `/artist/page`, whose `top_tracks` are ordered by popularity (the same
   * "Popular tracks" the Qobuz web player shows) rather than by release date.
   * The endpoint returns a fixed set, so the requested `limit` is applied
   * client-side.
   *
   * The `top_tracks` also include covers of the artist's songs recorded by
   * *other* performers (e.g. Johnny Cash's take on Bob Dylan surfaces on
   * Dylan's page). Those are dropped -- by comparing each track's main artist
   * id to `artistId` -- before the limit is applied, so covers do not crowd out
   * the artist's own recordings. Tracks whose artist id is missing are kept.
   *
   * @param artistId The Qobuz artist id.
   * @param limit Maximum tracks to return, taken from the top (default 10).
   */
  async getArtistTopTracks(artistId: number, limit = 10): Promise<Track[]> {
    const response = await this.#signedGet("artistpage", paths.artistPage, [
      ["artist_id", String(artistId)],
    ]);
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `artist/page failed with HTTP ${response.status}`,
      );
    }
    const tracks = parseArtistPageTracks(await response.json());
    const ownTracks = tracks.filter(
      (track) => track.artistId === undefined || track.artistId === artistId,
    );
    return ownTracks.slice(0, limit);
  }

  /**
   * Create a new playlist owned by the signed-in user.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async createPlaylist(
    name: string,
    options: { description?: string; isPublic?: boolean } = {},
  ): Promise<Playlist> {
    const kvPairs: Array<[string, string]> = [
      ["name", name],
      ["is_public", String(options.isPublic ?? false)],
    ];
    if (options.description !== undefined) {
      kvPairs.push(["description", options.description]);
    }
    const response = await this.#signedGet(
      "playlistcreate",
      paths.playlistCreate,
      kvPairs,
      { requireAuth: true },
    );
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `playlist/create failed with HTTP ${response.status}`,
      );
    }
    return parsePlaylist(await response.json());
  }

  /**
   * Add tracks to a playlist. A no-op for an empty list.
   *
   * Large lists are added in batches (see {@link MAX_TRACK_IDS_PER_REQUEST}),
   * as Qobuz rejects a single request carrying too many ids.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void> {
    for (const batch of chunk(trackIds, MAX_TRACK_IDS_PER_REQUEST)) {
      const response = await this.#signedGet(
        "playlistaddTracks",
        paths.playlistAddTracks,
        [
          ["playlist_id", String(playlistId)],
          ["track_ids", batch.join(",")],
        ],
        { requireAuth: true },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `playlist/addTracks failed with HTTP ${response.status}`,
        );
      }
    }
  }

  /**
   * Fetch all of the signed-in user's favourite tracks (all pages).
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async getFavoriteTracks(): Promise<Track[]> {
    const session = this.#requireSession();
    return this.#collectAllTracks(async (limit, offset) => {
      const timestamp = this.#now();
      const signature = signRequest(
        "favoritegetUserFavorites",
        [],
        timestamp,
        this.#requireSecret(),
      );
      const response = await this.#request(
        "GET",
        paths.favoriteGetUserFavorites,
        {
          query: {
            type: "tracks",
            limit: String(limit),
            offset: String(offset),
            request_ts: String(timestamp),
            request_sig: signature,
          },
          headers: {
            ...this.#appIdHeaders(),
            "X-User-Auth-Token": session.userAuthToken,
          },
        },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `getUserFavorites failed with HTTP ${response.status}`,
        );
      }
      return parseTracksPage(await response.json());
    });
  }

  /**
   * Fetch all of the signed-in user's favourite albums (all pages).
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async getFavoriteAlbums(): Promise<Album[]> {
    return this.#collectFavorites("albums", (json) => {
      const page = parseAlbumsPage(json);
      return { items: page.albums, total: page.total };
    });
  }

  /**
   * Fetch all of the signed-in user's favourite artists (all pages).
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async getFavoriteArtists(): Promise<Artist[]> {
    return this.#collectFavorites("artists", (json) => {
      const page = parseArtistsPage(json);
      return { items: page.artists, total: page.total };
    });
  }

  /**
   * Add tracks to the user's favourites by track id. No-op for an empty list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async addFavoriteTracks(trackIds: readonly number[]): Promise<void> {
    await this.#createFavorites("track_ids", trackIds.map(String));
  }

  /**
   * Add albums to the user's favourites by album id. No-op for an empty list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async addFavoriteAlbums(albumIds: readonly string[]): Promise<void> {
    await this.#createFavorites("album_ids", [...albumIds]);
  }

  /**
   * Add artists to the user's favourites by artist id. No-op for an empty list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async addFavoriteArtists(artistIds: readonly number[]): Promise<void> {
    await this.#createFavorites("artist_ids", artistIds.map(String));
  }

  /**
   * Fetch all playlists owned by the signed-in user (all pages).
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async getUserPlaylists(): Promise<Playlist[]> {
    const pageSize = 500;
    const all: Playlist[] = [];
    let offset = 0;
    for (;;) {
      const response = await this.#signedGet(
        "playlistgetUserPlaylists",
        paths.playlistGetUserPlaylists,
        [
          ["limit", String(pageSize)],
          ["offset", String(offset)],
        ],
        { requireAuth: true },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `playlist/getUserPlaylists failed with HTTP ${response.status}`,
        );
      }
      const page = parsePlaylistsPage(await response.json());
      all.push(...page.playlists);
      offset += page.playlists.length;
      if (page.playlists.length === 0 || all.length >= page.total) {
        return all;
      }
    }
  }

  /** Fetch all tracks of a playlist (all pages). */
  async getPlaylistTracks(playlistId: number): Promise<Track[]> {
    return this.#collectAllTracks(async (limit, offset) => {
      const response = await this.#signedGet("playlistget", paths.playlistGet, [
        ["playlist_id", String(playlistId)],
        ["limit", String(limit)],
        ["offset", String(offset)],
        ["extra", "tracks"],
      ]);
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `playlist/get failed with HTTP ${response.status}`,
        );
      }
      return parseTracksPage(await response.json());
    });
  }

  /** Look up an album's original release date (YYYY-MM-DD), if Qobuz has one. */
  async getAlbumReleaseDate(albumId: string): Promise<string | undefined> {
    const response = await this.#signedGet("albumget", paths.albumGet, [
      ["album_id", albumId],
    ]);
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `album/get failed with HTTP ${response.status}`,
      );
    }
    return parseAlbumReleaseDate(await response.json());
  }

  /**
   * Fetch an album's full track list.
   *
   * `album/get` embeds the album's tracks under `tracks.items` by default, so no
   * `extra` parameter is needed (and passing one makes Qobuz reject the request).
   */
  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const response = await this.#signedGet("albumget", paths.albumGet, [
      ["album_id", albumId],
    ]);
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `album/get failed with HTTP ${response.status}`,
      );
    }
    return parseAlbumTracks(await response.json());
  }

  /**
   * Remove tracks from a playlist by their playlist-track ids. No-op for an
   * empty list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async removeTracksFromPlaylist(
    playlistId: number,
    playlistTrackIds: readonly number[],
  ): Promise<void> {
    for (const batch of chunk(playlistTrackIds, MAX_TRACK_IDS_PER_REQUEST)) {
      const response = await this.#signedGet(
        "playlistdeleteTracks",
        paths.playlistDeleteTracks,
        [
          ["playlist_id", String(playlistId)],
          ["playlist_track_ids", batch.join(",")],
        ],
        { requireAuth: true },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `playlist/deleteTracks failed with HTTP ${response.status}`,
        );
      }
    }
  }

  /**
   * Remove tracks from the user's favourites by track id. No-op for an empty
   * list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async removeFavoriteTracks(trackIds: readonly number[]): Promise<void> {
    for (const batch of chunk(trackIds, MAX_TRACK_IDS_PER_REQUEST)) {
      const response = await this.#signedGet(
        "favoritedelete",
        paths.favoriteDelete,
        [["track_ids", batch.join(",")]],
        { requireAuth: true },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `favorite/delete failed with HTTP ${response.status}`,
        );
      }
    }
  }

  /**
   * Page through a favourites list (albums or artists) until every item has
   * been collected. Mirrors {@link getFavoriteTracks}' pagination for the item
   * types whose favourites parse into full domain models.
   */
  async #collectFavorites<T>(
    type: "albums" | "artists",
    parse: (json: unknown) => { items: T[]; total: number },
  ): Promise<T[]> {
    const session = this.#requireSession();
    const pageSize = 500;
    const all: T[] = [];
    let offset = 0;
    for (;;) {
      const timestamp = this.#now();
      const signature = signRequest(
        "favoritegetUserFavorites",
        [],
        timestamp,
        this.#requireSecret(),
      );
      const response = await this.#request(
        "GET",
        paths.favoriteGetUserFavorites,
        {
          query: {
            type,
            limit: String(pageSize),
            offset: String(offset),
            request_ts: String(timestamp),
            request_sig: signature,
          },
          headers: {
            ...this.#appIdHeaders(),
            "X-User-Auth-Token": session.userAuthToken,
          },
        },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `getUserFavorites failed with HTTP ${response.status}`,
        );
      }
      const page = parse(await response.json());
      all.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || all.length >= page.total) {
        return all;
      }
    }
  }

  /**
   * Add favourites of one type via `favorite/create`, batching the ids as
   * bulk mutations are split (see {@link MAX_TRACK_IDS_PER_REQUEST}). No-op for
   * an empty list.
   */
  async #createFavorites(
    key: "track_ids" | "album_ids" | "artist_ids",
    ids: readonly string[],
  ): Promise<void> {
    for (const batch of chunk(ids, MAX_TRACK_IDS_PER_REQUEST)) {
      const response = await this.#signedGet(
        "favoritecreate",
        paths.favoriteCreate,
        [[key, batch.join(",")]],
        { requireAuth: true },
      );
      if (!response.ok) {
        throw new QobuzError(
          "api-response",
          `favorite/create failed with HTTP ${response.status}`,
        );
      }
    }
  }

  /** Page through a track source until every track has been collected. */
  async #collectAllTracks(
    fetchPage: (limit: number, offset: number) => Promise<TracksPage>,
  ): Promise<Track[]> {
    const pageSize = 500;
    const all: Track[] = [];
    let offset = 0;
    for (;;) {
      const page = await fetchPage(pageSize, offset);
      all.push(...page.tracks);
      offset += page.tracks.length;
      if (page.tracks.length === 0 || all.length >= page.total) {
        return all;
      }
    }
  }

  /**
   * Issue a signed GET: sign the (key-sorted) parameters, append request_ts and
   * request_sig, and send with the app id header (plus the user token when
   * signed in, or required when `requireAuth` is set).
   */
  async #signedGet(
    methodName: string,
    path: string,
    kvPairs: ReadonlyArray<readonly [string, string]>,
    options: { requireAuth?: boolean } = {},
  ): Promise<Response> {
    const timestamp = this.#now();
    const signature = signRequest(
      methodName,
      kvPairs,
      timestamp,
      this.#requireSecret(),
    );
    const query: Record<string, string> = {};
    for (const [key, value] of kvPairs) {
      query[key] = value;
    }
    query["request_ts"] = String(timestamp);
    query["request_sig"] = signature;

    const headers = options.requireAuth
      ? {
          ...this.#appIdHeaders(),
          "X-User-Auth-Token": this.#requireSession().userAuthToken,
        }
      : this.#headers();

    return this.#request("GET", path, { query, headers });
  }

  /** App id header, plus the user token when signed in (optional auth). */
  #headers(): Record<string, string> {
    const headers = this.#appIdHeaders();
    if (this.#session !== undefined) {
      headers["X-User-Auth-Token"] = this.#session.userAuthToken;
    }
    return headers;
  }

  /** Try each candidate secret against a signed probe; return the first valid one. */
  async #validateSecret(secrets: readonly string[]): Promise<string> {
    for (const secret of secrets) {
      const timestamp = this.#now();
      const signature = signGetFileUrl(
        SECRET_PROBE_TRACK_ID,
        5,
        timestamp,
        secret,
      );
      const response = await this.#request("GET", paths.trackGetFileUrl, {
        query: {
          track_id: String(SECRET_PROBE_TRACK_ID),
          format_id: "5",
          intent: "stream",
          request_ts: String(timestamp),
          request_sig: signature,
        },
        headers: this.#appIdHeaders(),
        // A 400 here means "wrong secret, try the next candidate", not
        // throttling, so it must not trigger the backoff-and-retry loop.
        retryOn400: false,
      });
      // A wrong secret is rejected with 400; anything else means it was accepted.
      if (response.status !== 400) {
        return secret;
      }
    }
    throw new QobuzError(
      "bundle-extraction",
      "No valid app secret found among bundle candidates",
    );
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    options: {
      query?: Record<string, string>;
      headers: Record<string, string>;
      body?: string;
      /** Retry an HTTP 400 with exponential backoff (default true). */
      retryOn400?: boolean;
    },
  ): Promise<Response> {
    const url = new URL(buildUrl(path));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const init: RequestInit = {
      method,
      headers: { "User-Agent": this.#userAgent, ...options.headers },
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }

    const retryOn400 = options.retryOn400 ?? true;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(url, init);
      this.#logger.debug(`${method} ${path} -> ${response.status}`);
      if (response.status === 400 && retryOn400 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** attempt;
        this.#logger.debug(
          `${method} ${path} -> 400, backing off ${delay}ms ` +
            `(retry ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.#sleep(delay);
        continue;
      }
      return response;
    }
  }

  #appIdHeaders(): Record<string, string> {
    return { "X-App-Id": this.#requireTokens().appId };
  }

  #requireTokens(): BundleTokens {
    if (this.#tokens === undefined) {
      throw new QobuzError("bundle-extraction", "Client not initialised; call init() first");
    }
    return this.#tokens;
  }

  #requireSecret(): string {
    if (this.#validatedSecret === undefined) {
      throw new QobuzError("bundle-extraction", "Client not initialised; call init() first");
    }
    return this.#validatedSecret;
  }

  #requireSession(): UserSession {
    if (this.#session === undefined) {
      throw new QobuzError("authentication", "Not signed in; call login() first");
    }
    return this.#session;
  }
}
