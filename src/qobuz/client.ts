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
  parseArtists,
  parsePlaylist,
  parseTracks,
  parseTracksPage,
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

export interface QobuzClientOptions {
  /** HTTP implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Unix-seconds clock; defaults to the real clock. Injectable for tests. */
  now?: () => number;
  /** User-Agent header sent on every request. */
  userAgent?: string;
}

export class QobuzClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #userAgent: string;

  #tokens?: BundleTokens;
  #validatedSecret?: string;
  #session?: UserSession;

  constructor(options: QobuzClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
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
    const token = callbackJson.token;

    // Step 2: exchange the token for a full session.
    const loginResponse = await this.#request("POST", paths.userLogin, {
      headers: {
        ...this.#appIdHeaders(),
        "X-User-Auth-Token": token,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: "extra=partner",
    });
    if (loginResponse.status === 401) {
      throw new QobuzError("authentication", "OAuth token rejected");
    }
    if (!loginResponse.ok) {
      throw new QobuzError(
        "api-response",
        `Login failed with HTTP ${loginResponse.status}`,
      );
    }

    const session = parseLoginResponse(await loginResponse.json());
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
   * Fetch an artist's top tracks.
   *
   * @param artistId The Qobuz artist id.
   * @param limit Maximum tracks (default 10).
   */
  async getArtistTopTracks(artistId: number, limit = 10): Promise<Track[]> {
    const response = await this.#signedGet("artistget", paths.artistGet, [
      ["artist_id", String(artistId)],
      ["extra", "tracks"],
      ["limit", String(limit)],
      ["offset", "0"],
    ]);
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `artist/get failed with HTTP ${response.status}`,
      );
    }
    return parseTracks(await response.json());
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
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void> {
    if (trackIds.length === 0) {
      return;
    }
    const response = await this.#signedGet(
      "playlistaddTracks",
      paths.playlistAddTracks,
      [
        ["playlist_id", String(playlistId)],
        ["track_ids", trackIds.join(",")],
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
   * Remove tracks from a playlist by their playlist-track ids. No-op for an
   * empty list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async removeTracksFromPlaylist(
    playlistId: number,
    playlistTrackIds: readonly number[],
  ): Promise<void> {
    if (playlistTrackIds.length === 0) {
      return;
    }
    const response = await this.#signedGet(
      "playlistdeleteTracks",
      paths.playlistDeleteTracks,
      [
        ["playlist_id", String(playlistId)],
        ["playlist_track_ids", playlistTrackIds.join(",")],
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

  /**
   * Remove tracks from the user's favourites by track id. No-op for an empty
   * list.
   *
   * @throws {QobuzError} kind `authentication` if not signed in.
   */
  async removeFavoriteTracks(trackIds: readonly number[]): Promise<void> {
    if (trackIds.length === 0) {
      return;
    }
    const response = await this.#signedGet(
      "favoritedelete",
      paths.favoriteDelete,
      [["track_ids", trackIds.join(",")]],
      { requireAuth: true },
    );
    if (!response.ok) {
      throw new QobuzError(
        "api-response",
        `favorite/delete failed with HTTP ${response.status}`,
      );
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
    return this.#fetch(url, init);
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
