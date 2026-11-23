import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "./errors.js";
import type { Tokens } from "./oauth.js";
import { TokenKeeper, type TokenVault } from "./tokens.js";

const NOW = 1_000_000;
const tokens = (accessToken: string, expiresAt: number): Tokens => ({
  accessToken,
  refreshToken: "R",
  expiresAt,
  authorisedAt: 0,
  scopes: [],
});

function vault(start: Tokens | undefined): TokenVault & { value: Tokens | undefined; saves: number } {
  return {
    value: start,
    saves: 0,
    load() {
      return this.value;
    },
    save(next) {
      this.value = next;
      this.saves += 1;
    },
    exclusive: async (fn) => fn(),
  };
}

const keeper = (store: TokenVault, refresh: (t: Tokens) => Promise<Tokens>) =>
  new TokenKeeper({ service: "spotify", vault: store, refresh, now: () => NOW });

describe("TokenKeeper", () => {
  it("gives the stored token while it has time left", async () => {
    const refresh = vi.fn();
    expect(await keeper(vault(tokens("A", NOW + 120_000)), refresh).accessToken()).toBe("A");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes a little before the end, and stores the result", async () => {
    const store = vault(tokens("A", NOW + 30_000));
    const refresh = vi.fn(async () => tokens("B", NOW + 3_600_000));
    expect(await keeper(store, refresh).accessToken()).toBe("B");
    expect(store.value?.accessToken).toBe("B");
  });

  it("refreshes once for callers at the same time", async () => {
    const refresh = vi.fn(async () => tokens("B", NOW + 3_600_000));
    const k = keeper(vault(tokens("A", 0)), refresh);
    expect(await Promise.all([k.accessToken(), k.accessToken(), k.accessToken()])).toEqual(["B", "B", "B"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses what another process refreshed while it waited for the lock", async () => {
    const store = vault(tokens("A", 0));
    store.exclusive = async (fn) => {
      store.value = tokens("theirs", NOW + 3_600_000);
      return fn();
    };
    const refresh = vi.fn();
    expect(await keeper(store, refresh).accessToken()).toBe("theirs");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renews a token the service rejected, though it had time left", async () => {
    const refresh = vi.fn(async () => tokens("B", NOW + 3_600_000));
    expect(await keeper(vault(tokens("A", NOW + 900_000)), refresh).renewedToken("A")).toBe("B");
  });

  it("does not renew again when the rejected token is already replaced", async () => {
    const refresh = vi.fn();
    expect(await keeper(vault(tokens("B", NOW + 900_000)), refresh).renewedToken("A")).toBe("B");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks for a sign-in when there is no token", async () => {
    await expect(keeper(vault(undefined), vi.fn()).accessToken()).rejects.toMatchObject({ kind: "authentication" });
  });

  it("keeps the stored token when refreshing fails, so a later try can work", async () => {
    const store = vault(tokens("A", 0));
    const k = keeper(store, async () => {
      throw new ServiceError("spotify", "network", "offline");
    });
    await expect(k.accessToken()).rejects.toMatchObject({ kind: "network" });
    expect(store.value?.accessToken).toBe("A");
    expect(store.saves).toBe(0);
  });

  it("tries again after a failure rather than repeating it", async () => {
    const refresh = vi
      .fn(async () => tokens("B", NOW + 3_600_000))
      .mockRejectedValueOnce(new ServiceError("spotify", "network", "offline"));
    const k = keeper(vault(tokens("A", 0)), refresh);
    await expect(k.accessToken()).rejects.toThrow();
    expect(await k.accessToken()).toBe("B");
  });
});
