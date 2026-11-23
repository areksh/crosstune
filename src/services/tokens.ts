/**
 * Keeping a service's access token fresh, for one process or several: the web
 * server and a scheduled `run-due` may refresh at once, and a service may
 * answer a refresh with a new refresh token that voids the old one.
 */

import { labelOf, ServiceError } from "./errors.js";
import type { ServiceName } from "./names.js";
import type { Tokens } from "./oauth.js";

/** What a service's client needs to make requests. */
export interface TokenSource {
  accessToken(): Promise<string>;
  /** A token other than `rejected`, which the service no longer accepts. */
  renewedToken(rejected: string): Promise<string>;
}

/** Where the tokens are kept. */
export interface TokenVault {
  load(): Tokens | undefined;
  save(tokens: Tokens): void;
  /** Run `fn` while no other process refreshes. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TokenKeeperOptions {
  service: ServiceName;
  vault: TokenVault;
  refresh(tokens: Tokens): Promise<Tokens>;
  now?: () => number;
}

/** Refresh when less than this is left (ms). */
const MARGIN_MS = 60_000;

export class TokenKeeper implements TokenSource {
  readonly #options: TokenKeeperOptions;
  readonly #now: () => number;
  #refreshing: Promise<string> | undefined;

  constructor(options: TokenKeeperOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async accessToken(): Promise<string> {
    return this.#usable((tokens) => tokens.expiresAt - this.#now() > MARGIN_MS);
  }

  async renewedToken(rejected: string): Promise<string> {
    return this.#usable((tokens) => tokens.accessToken !== rejected);
  }

  async #usable(good: (tokens: Tokens) => boolean): Promise<string> {
    const tokens = this.#load();
    if (good(tokens)) {
      return tokens.accessToken;
    }
    this.#refreshing ??= this.#refresh(good).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(good: (tokens: Tokens) => boolean): Promise<string> {
    const { vault, refresh } = this.#options;
    return vault.exclusive(async () => {
      // Another process may have refreshed while this one waited.
      const tokens = this.#load();
      if (good(tokens)) {
        return tokens.accessToken;
      }
      const next = await refresh(tokens);
      vault.save(next);
      return next.accessToken;
    });
  }

  #load(): Tokens {
    const tokens = this.#options.vault.load();
    if (tokens === undefined) {
      const { service } = this.#options;
      throw new ServiceError(service, "authentication", `${labelOf(service)} is not signed in`);
    }
    return tokens;
  }
}
