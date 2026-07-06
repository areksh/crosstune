import { describe, expect, it, vi } from "vitest";

import type { ResolvedCredentials } from "../qobuz/index.js";
import { initClientWithCache, type CredentialStore } from "./init.js";

const CREDS: ResolvedCredentials = {
  appId: "100200300",
  secret: "secret",
  privateKey: "key",
};

function memoryStore(initial?: ResolvedCredentials): CredentialStore {
  let cached = initial;
  return {
    load: vi.fn(() => cached),
    save: vi.fn((c: ResolvedCredentials) => {
      cached = c;
    }),
    clear: vi.fn(() => {
      cached = undefined;
    }),
  };
}

describe("initClientWithCache", () => {
  it("primes from cache without hitting the network", async () => {
    const store = memoryStore(CREDS);
    const client = {
      init: vi.fn(),
      initFromCache: vi.fn(),
      get credentials(): ResolvedCredentials {
        throw new Error("should not read credentials on a cache hit");
      },
    };

    const result = await initClientWithCache(client, store);

    expect(result.fromCache).toBe(true);
    expect(client.initFromCache).toHaveBeenCalledWith(CREDS);
    expect(client.init).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("extracts and caches the credentials on a cache miss", async () => {
    const store = memoryStore(undefined);
    const client = {
      init: vi.fn(async () => {}),
      initFromCache: vi.fn(),
      credentials: CREDS,
    };

    const result = await initClientWithCache(client, store);

    expect(result.fromCache).toBe(false);
    expect(client.init).toHaveBeenCalledOnce();
    expect(client.initFromCache).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledWith(CREDS);
  });
});
