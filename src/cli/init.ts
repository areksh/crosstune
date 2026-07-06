/**
 * Client bootstrap with a local credentials cache.
 *
 * Extracting the Qobuz bundle credentials is slow, so this resumes them from a
 * local cache when possible and only falls back to a full extraction on a cache
 * miss, saving the freshly validated credentials for next time. The store is
 * injected so the decision logic stays free of I/O and can be unit-tested.
 */

import type { ResolvedCredentials } from "../qobuz/index.js";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type LoadOptions,
} from "./bundle-store.js";

/** Persistence for the validated bundle credentials. */
export interface CredentialStore {
  load(): ResolvedCredentials | undefined;
  save(credentials: ResolvedCredentials): void;
  clear(): void;
}

/** The client capability needed to bootstrap, with or without a cache. */
export interface InitClient {
  init(): Promise<void>;
  initFromCache(credentials: ResolvedCredentials): void;
  readonly credentials: ResolvedCredentials;
}

export interface InitResult {
  /** True if primed from the cache, false if a full extraction was needed. */
  fromCache: boolean;
}

/** A credential store backed by the local bundle-cache file. */
export function fileCredentialStore(
  filePath?: string,
  loadOptions?: LoadOptions,
): CredentialStore {
  return {
    load: () => loadCredentials(filePath, loadOptions),
    save: (credentials) => saveCredentials(credentials, filePath),
    clear: () => clearCredentials(filePath),
  };
}

/**
 * Initialise the client from cached credentials, or extract them fresh and
 * cache the result.
 */
export async function initClientWithCache(
  client: InitClient,
  store: CredentialStore,
): Promise<InitResult> {
  const cached = store.load();
  if (cached !== undefined) {
    client.initFromCache(cached);
    return { fromCache: true };
  }
  await client.init();
  store.save(client.credentials);
  return { fromCache: false };
}
