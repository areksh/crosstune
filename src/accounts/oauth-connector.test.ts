import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../services/errors.js";
import { tagId, type UserId } from "../services/ids.js";
import type { Tokens } from "../services/oauth.js";
import type { MusicService } from "../services/service.js";
import type { TokenSource, TokenVault } from "../services/tokens.js";
import { oauthConnector } from "./oauth-connector.js";

const DAY = 86_400_000;

function setup(options: { saved?: Tokens; lifetimeMs?: number; fail?: boolean } = {}) {
  let saved = options.saved;
  const vault: TokenVault = {
    load: () => saved,
    save: (tokens) => void (saved = tokens),
    exclusive: async (fn) => fn(),
  };
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const grant = new URLSearchParams(String(init.body)).get("grant_type");
    return new Response(
      JSON.stringify({ access_token: grant === "refresh_token" ? "refreshed" : "fresh", refresh_token: "R", expires_in: 3600 }),
    );
  });
  const sources: TokenSource[] = [];
  const connector = oauthConnector({
    service: "spotify",
    authorizeUrl: "https://a.example/authorize",
    tokenUrl: "https://a.example/token",
    scopes: ["one"],
    redirectUri: "http://127.0.0.1:53683/callback/spotify",
    clientId: () => "cid",
    vault,
    dropTokens: () => void (saved = undefined),
    ...(options.lifetimeMs !== undefined && { lifetimeMs: options.lifetimeMs }),
    load: async (tokens) => {
      sources.push(tokens);
      await tokens.accessToken();
      if (options.fail === true) {
        throw new ServiceError("spotify", "network", "offline");
      }
      return {
        name: "spotify",
        account: () => ({ id: tagId<UserId>("spotify", "u"), displayName: "U" }),
      } as unknown as MusicService;
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => 1000,
  });
  return { connector, fetchImpl, sources, saved: () => saved };
}

describe("oauthConnector", () => {
  it("opens the service's page for the user's app", async () => {
    const url = new URL(await setup().connector.startUrl({ state: "s", challenge: "c" }));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("s");
  });

  it("saves the tokens only when the sign-in is kept", async () => {
    const { connector, saved } = setup();
    const { music, keep } = await connector.finish({ code: "c", verifier: "v" });
    expect(music.account()?.displayName).toBe("U");
    expect(saved()).toBeUndefined();
    keep();
    expect(saved()?.accessToken).toBe("fresh");
  });

  it("leaves the earlier tokens alone when the new sign-in is not kept", async () => {
    const old: Tokens = { accessToken: "old", refreshToken: "r", expiresAt: 9e15, authorisedAt: 0, scopes: [] };
    const { connector, saved } = setup({ saved: old });
    await connector.finish({ code: "c", verifier: "v" });
    expect(saved()).toEqual(old);
  });

  it("after keeping, its token source follows the saved tokens", async () => {
    const { connector, sources, saved } = setup();
    const { keep } = await connector.finish({ code: "c", verifier: "v" });
    keep();
    expect(await sources[0]!.renewedToken("fresh")).toBe("refreshed");
    expect(saved()?.accessToken).toBe("refreshed");
  });

  it("resumes from saved tokens, and has nothing to resume without", async () => {
    expect(await setup().connector.resume()).toBeUndefined();
    const { connector } = setup({ saved: { accessToken: "a", expiresAt: 9e15, authorisedAt: 0, scopes: [] } });
    expect((await connector.resume())?.name).toBe("spotify");
  });

  it("passes on why it could not resume, keeping the tokens", async () => {
    const tokens: Tokens = { accessToken: "a", expiresAt: 9e15, authorisedAt: 0, scopes: [] };
    const { connector, saved } = setup({ saved: tokens, fail: true });
    await expect(connector.resume()).rejects.toMatchObject({ kind: "network" });
    expect(saved()).toEqual(tokens);
  });

  it("knows when the sign-in ends, where the service fixes that", () => {
    const tokens: Tokens = { accessToken: "a", expiresAt: 5, authorisedAt: 7, scopes: [] };
    expect(setup({ saved: tokens, lifetimeMs: 180 * DAY }).connector.endsAt?.()).toBe(7 + 180 * DAY);
    expect(setup({ saved: tokens }).connector.endsAt?.()).toBeUndefined();
    expect(setup({ lifetimeMs: DAY }).connector.endsAt?.()).toBeUndefined();
  });

  it("signs out by dropping the tokens", () => {
    const { connector, saved } = setup({ saved: { accessToken: "a", expiresAt: 5, authorisedAt: 7, scopes: [] } });
    connector.signOut();
    expect(saved()).toBeUndefined();
  });
});
