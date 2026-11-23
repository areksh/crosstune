/**
 * Session restore/login orchestration.
 *
 * On each run the CLI tries to resume a persisted session; only if there is no
 * saved token, or the saved token is rejected, does it fall back to the browser
 * sign-in. The decision logic here is kept free of I/O (the store and the
 * browser login are injected) so it can be unit-tested.
 */

import { QobuzError, type UserSession } from "../services/qobuz/index.js";
import {
  clearToken,
  loadToken,
  saveToken,
} from "./session-store.js";

/** Persistence for the session token. */
export interface TokenStore {
  load(): string | undefined;
  save(token: string): void;
  clear(): void;
}

/** The client capability needed to resume a session from a token. */
export interface SessionClient {
  loginWithToken(token: string): Promise<UserSession>;
}

export interface RestoreResult {
  session: UserSession;
  /** True if restored from a saved token, false if a fresh sign-in was needed. */
  restored: boolean;
}

/** A token store backed by the local session file. */
export function fileTokenStore(filePath?: string): TokenStore {
  return {
    load: () => loadToken(filePath),
    save: (token) => saveToken(token, filePath),
    clear: () => clearToken(filePath),
  };
}

/**
 * Resume a saved session, or sign in via `browserLogin` and persist the result.
 *
 * A saved token that Qobuz rejects (an `authentication` error) is cleared and
 * replaced by a fresh sign-in. Other failures (network, server) propagate so
 * the saved token is kept for a later retry.
 *
 * `accept` may refuse who signed in (throwing): another account than the one
 * known here (ADR-0011). A refused sign-in's token is not saved.
 */
export async function restoreOrLogin(
  client: SessionClient,
  store: TokenStore,
  browserLogin: () => Promise<UserSession>,
  log: (message: string) => void = () => {},
  accept: (session: UserSession) => void = () => {},
): Promise<RestoreResult> {
  const saved = store.load();
  if (saved !== undefined) {
    try {
      const session = await client.loginWithToken(saved);
      accept(session);
      return { session, restored: true };
    } catch (error) {
      if (error instanceof QobuzError && error.kind === "authentication") {
        log("Saved session has expired; signing in again.");
        store.clear();
      } else {
        throw error;
      }
    }
  }

  const session = await browserLogin();
  accept(session);
  store.save(session.userAuthToken);
  return { session, restored: false };
}
