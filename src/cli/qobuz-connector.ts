/**
 * Qobuz's {@link Connector}: credentials from the web player's bundle, and a
 * session token. A sign-in uses a client of its own, so one that is not
 * accepted leaves the connected one as it was.
 */

import type { Connector } from "../accounts/accounts.js";
import { ServiceError } from "../services/errors.js";
import { QobuzClient } from "../services/qobuz/index.js";
import { buildOAuthUrl } from "../services/qobuz/oauth.js";
import { QobuzService } from "../services/qobuz/service.js";
import { initClientWithCache, type CredentialStore } from "./init.js";
import type { TokenStore } from "./session.js";

export interface QobuzConnectorOptions {
  newClient(): QobuzClient;
  credentials: CredentialStore;
  tokens: TokenStore;
  port: number;
}

export function qobuzConnector(options: QobuzConnectorOptions): Connector {
  const ready = async (): Promise<QobuzClient> => {
    const client = options.newClient();
    try {
      await initClientWithCache(client, options.credentials);
    } catch (error) {
      // The cached credentials may be what is wrong: read the bundle next time.
      options.credentials.clear();
      throw error;
    }
    return client;
  };
  return {
    service: "qobuz",
    needsClientId: false,
    startUrl: async () => buildOAuthUrl((await ready()).appId, `http://localhost:${options.port}`),
    finish: async ({ code }) => {
      const client = await ready();
      const session = await client.loginWithOAuthCode(code);
      return { music: new QobuzService(client), keep: () => options.tokens.save(session.userAuthToken) };
    },
    resume: async () => {
      const token = options.tokens.load();
      if (token === undefined) {
        return undefined;
      }
      const client = await ready();
      try {
        await client.loginWithToken(token);
      } catch (error) {
        if (error instanceof ServiceError && error.kind === "authentication") {
          options.tokens.clear();
        }
        throw error;
      }
      return new QobuzService(client);
    },
    signOut: () => options.tokens.clear(),
  };
}
