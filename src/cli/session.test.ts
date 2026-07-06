import { describe, expect, it, vi } from "vitest";

import { QobuzError, type UserSession } from "../qobuz/index.js";
import { restoreOrLogin, type TokenStore } from "./session.js";

function session(token: string): UserSession {
  return {
    userAuthToken: token,
    userId: 1,
    email: "a@b.com",
    displayName: "Arek",
    subscriptionLabel: "Studio",
  };
}

function memoryStore(initial?: string): TokenStore {
  let token = initial;
  return {
    load: vi.fn(() => token),
    save: vi.fn((t: string) => {
      token = t;
    }),
    clear: vi.fn(() => {
      token = undefined;
    }),
  };
}

describe("restoreOrLogin", () => {
  it("signs in via the browser and saves the token when none is stored", async () => {
    const store = memoryStore(undefined);
    const client = { loginWithToken: vi.fn() };
    const browserLogin = vi.fn(async () => session("fresh"));

    const result = await restoreOrLogin(client, store, browserLogin);

    expect(result.restored).toBe(false);
    expect(browserLogin).toHaveBeenCalledOnce();
    expect(client.loginWithToken).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledWith("fresh");
  });

  it("resumes from a saved token without the browser", async () => {
    const store = memoryStore("saved");
    const client = { loginWithToken: vi.fn(async () => session("saved")) };
    const browserLogin = vi.fn();

    const result = await restoreOrLogin(client, store, browserLogin);

    expect(result.restored).toBe(true);
    expect(client.loginWithToken).toHaveBeenCalledWith("saved");
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("clears an expired token and signs in again", async () => {
    const store = memoryStore("expired");
    const client = {
      loginWithToken: vi.fn(async () => {
        throw new QobuzError("authentication", "Auth token rejected");
      }),
    };
    const browserLogin = vi.fn(async () => session("new"));

    const result = await restoreOrLogin(client, store, browserLogin);

    expect(result.restored).toBe(false);
    expect(store.clear).toHaveBeenCalledOnce();
    expect(browserLogin).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalledWith("new");
  });

  it("propagates non-auth failures and keeps the saved token", async () => {
    const store = memoryStore("saved");
    const client = {
      loginWithToken: vi.fn(async () => {
        throw new QobuzError("api-response", "HTTP 503");
      }),
    };
    const browserLogin = vi.fn();

    await expect(restoreOrLogin(client, store, browserLogin)).rejects.toThrow(
      QobuzError,
    );
    expect(store.clear).not.toHaveBeenCalled();
    expect(browserLogin).not.toHaveBeenCalled();
  });
});
