import { describe, expect, it, vi } from "vitest";

import { QobuzError, type QobuzClient } from "../services/qobuz/index.js";
import { qobuzConnector } from "./qobuz-connector.js";

function setup(client: Record<string, unknown> = {}, saved?: string) {
  let token = saved;
  const tokens = { load: () => token, save: vi.fn((t: string) => void (token = t)), clear: vi.fn(() => void (token = undefined)) };
  const credentials = { load: () => ({ appId: "1", secret: "s" }), save: vi.fn(), clear: vi.fn() };
  const newClient = vi.fn(
    () =>
      ({
        appId: "1",
        initFromCache: () => {},
        session: { userId: 8, displayName: "Arek", subscriptionLabel: "Studio", userAuthToken: "T" },
        loginWithOAuthCode: async () => ({ userAuthToken: "T" }),
        loginWithToken: async () => ({}),
        ...client,
      }) as unknown as QobuzClient,
  );
  return { connector: qobuzConnector({ newClient, credentials, tokens, port: 53683 }), tokens, credentials, newClient };
}

describe("qobuzConnector", () => {
  it("opens Qobuz's page, to come back to localhost", async () => {
    const url = new URL(await setup().connector.startUrl({ state: "s", challenge: "c" }));
    expect(url.searchParams.get("redirect_url")).toBe("http://localhost:53683");
  });

  it("saves the token only when the sign-in is kept", async () => {
    const { connector, tokens } = setup();
    const { music, keep } = await connector.finish({ code: "c", verifier: "v" });
    expect(music.account()).toMatchObject({ id: "qobuz:8", displayName: "Arek" });
    expect(tokens.save).not.toHaveBeenCalled();
    keep();
    expect(tokens.save).toHaveBeenCalledWith("T");
  });

  it("resumes a saved session; without one there is nothing to resume and no request", async () => {
    expect((await setup({}, "T").connector.resume())?.name).toBe("qobuz");
    const none = setup();
    expect(await none.connector.resume()).toBeUndefined();
    expect(none.newClient).not.toHaveBeenCalled();
  });

  it("drops a token Qobuz rejects, but keeps it when Qobuz is down", async () => {
    const rejected = setup({ loginWithToken: async () => Promise.reject(new QobuzError("authentication", "no")) }, "T");
    await expect(rejected.connector.resume()).rejects.toThrow("no");
    expect(rejected.tokens.clear).toHaveBeenCalled();
    const down = setup({ loginWithToken: async () => Promise.reject(new QobuzError("api-response", "503")) }, "T");
    await expect(down.connector.resume()).rejects.toThrow("503");
    expect(down.tokens.clear).not.toHaveBeenCalled();
  });

  it("reads the bundle afresh next time when the cached credentials fail", async () => {
    const { connector, credentials } = setup({
      initFromCache: () => {
        throw new QobuzError("bundle-extraction", "changed");
      },
    }, "T");
    await expect(connector.resume()).rejects.toThrow("changed");
    expect(credentials.clear).toHaveBeenCalled();
  });
});
