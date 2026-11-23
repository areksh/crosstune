/**
 * The {@link Connector} of a service with an ordinary OAuth sign-in (an
 * authorization code and PKCE, through the user's own app).
 */

import { labelOf, ServiceError } from "../services/errors.js";
import type { ServiceName } from "../services/names.js";
import { authorizeUrl, exchangeCode, refreshTokens, type OAuthConfig, type Tokens } from "../services/oauth.js";
import type { MusicService } from "../services/service.js";
import { TokenKeeper, type TokenSource, type TokenVault } from "../services/tokens.js";
import type { Connector } from "./accounts.js";

export interface OAuthConnectorOptions {
  service: ServiceName;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  redirectUri: string;
  clientId(): string | undefined;
  vault: TokenVault;
  dropTokens(): void;
  /** How long after authorising a sign-in ends for good, where that is fixed. */
  lifetimeMs?: number;
  /** The service over these tokens, with its account read. */
  load(tokens: TokenSource): Promise<MusicService>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function oauthConnector(options: OAuthConnectorOptions): Connector {
  const { service, vault } = options;
  const config = (): OAuthConfig => {
    const clientId = options.clientId();
    if (clientId === undefined) {
      throw new ServiceError(service, "authentication", `${labelOf(service)} has no client id yet`);
    }
    return {
      service,
      authorizeUrl: options.authorizeUrl,
      tokenUrl: options.tokenUrl,
      clientId,
      redirectUri: options.redirectUri,
      scopes: options.scopes,
      ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
      ...(options.now !== undefined && { now: options.now }),
    };
  };
  const keeperOf = (from: TokenVault): TokenSource =>
    new TokenKeeper({
      service,
      vault: from,
      refresh: (tokens) => refreshTokens(config(), tokens),
      ...(options.now !== undefined && { now: options.now }),
    });

  return {
    service,
    needsClientId: true,
    startUrl: async (request) => authorizeUrl(config(), request),
    finish: async ({ code, verifier }) => {
      // Held apart from the saved tokens until the account is accepted.
      let held: Tokens | undefined = await exchangeCode(config(), code, verifier);
      const music = await options.load(
        keeperOf({
          load: () => held ?? vault.load(),
          save: (tokens) => {
            if (held === undefined) {
              vault.save(tokens);
            } else {
              held = tokens;
            }
          },
          exclusive: (fn) => vault.exclusive(fn),
        }),
      );
      return {
        music,
        keep: () => {
          if (held !== undefined) {
            vault.save(held);
            held = undefined;
          }
        },
      };
    },
    resume: async () => (vault.load() === undefined ? undefined : options.load(keeperOf(vault))),
    signOut: () => options.dropTokens(),
    endsAt: () => {
      const tokens = vault.load();
      return tokens === undefined || options.lifetimeMs === undefined ? undefined : tokens.authorisedAt + options.lifetimeMs;
    },
  };
}
