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
import { signGetFileUrl, signRequest } from "./signing.js";

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
   * Sign in with email and password.
   *
   * @throws {QobuzError} kind `authentication` on invalid credentials, or
   *   `ineligible-user` if the account has no active subscription.
   */
  async login(email: string, password: string): Promise<UserSession> {
    const response = await this.#get(paths.userLogin, {
      query: { email, password },
      headers: this.#appIdHeaders(),
    });

    if (response.status === 401) {
      throw new QobuzError("authentication", "Invalid credentials");
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

    const response = await this.#get(paths.favoriteGetUserFavorites, {
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
      const response = await this.#get(paths.trackGetFileUrl, {
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

  async #get(
    path: string,
    options: { query: Record<string, string>; headers: Record<string, string> },
  ): Promise<Response> {
    const url = new URL(buildUrl(path));
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
    return this.#fetch(url, {
      method: "GET",
      headers: { "User-Agent": this.#userAgent, ...options.headers },
    });
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
