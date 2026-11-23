import { describe, expect, it, vi } from "vitest";

import { authorizeUrl, exchangeCode, newPkce, refreshTokens, type OAuthConfig, type Tokens } from "./oauth.js";

const NOW = Date.parse("2026-11-23T12:00:00Z");

function config(fetchImpl: unknown = vi.fn()): OAuthConfig {
  return {
    service: "tidal",
    authorizeUrl: "https://login.example/authorize",
    tokenUrl: "https://auth.example/token",
    clientId: "client-1",
    redirectUri: "http://127.0.0.1:53683/callback/tidal",
    scopes: ["a.read", "a.write"],
    fetchImpl: fetchImpl as typeof fetch,
    now: () => NOW,
  };
}

const answer = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));

const bodyOf = (mock: ReturnType<typeof answer>) =>
  Object.fromEntries(new URLSearchParams(String(mock.mock.calls[0]![1].body)));

describe("newPkce", () => {
  it("makes a verifier and its S256 challenge, different each time", () => {
    const a = newPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPkce().verifier).not.toBe(a.verifier);
  });

  it("derives the challenge as RFC 7636 does", () => {
    expect(newPkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").challenge).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("authorizeUrl", () => {
  it("asks for a code with the challenge and state, never the verifier", () => {
    const url = new URL(authorizeUrl(config(), { state: "s1", challenge: "c1" }));
    expect(url.origin + url.pathname).toBe("https://login.example/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:53683/callback/tidal",
      scope: "a.read a.write",
      code_challenge_method: "S256",
      code_challenge: "c1",
      state: "s1",
    });
  });
});

describe("exchangeCode", () => {
  it("sends the code and verifier, and reads the tokens", async () => {
    const fetchImpl = answer(200, { access_token: "A", refresh_token: "R", expires_in: 3600, scope: "a.read" });
    const tokens = await exchangeCode(config(fetchImpl), "code-1", "ver-1");
    expect(bodyOf(fetchImpl)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://127.0.0.1:53683/callback/tidal",
      client_id: "client-1",
      code_verifier: "ver-1",
    });
    expect(tokens).toEqual({
      accessToken: "A",
      refreshToken: "R",
      expiresAt: NOW + 3_600_000,
      authorisedAt: NOW,
      scopes: ["a.read"],
    });
  });

  it("raises an authentication error without the code in it", async () => {
    const error = await exchangeCode(config(answer(400, { error: "invalid_grant", error_description: "code-1 bad" })), "code-1", "ver-1").catch((e: unknown) => e);
    expect(error).toMatchObject({ service: "tidal", kind: "authentication" });
    expect(String(error)).not.toContain("code-1");
    expect(String(error)).not.toContain("ver-1");
  });

  it.each([[{}], [{ access_token: "" }], ["nonsense"]])("refuses an answer without a token: %j", async (body) => {
    await expect(exchangeCode(config(answer(200, body)), "c", "v")).rejects.toMatchObject({ kind: "authentication" });
  });

  it("reports an unreachable service as a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(exchangeCode(config(fetchImpl), "c", "v")).rejects.toMatchObject({ kind: "network" });
  });

  it("treats a server error as temporary, not as a rejected sign-in", async () => {
    await expect(exchangeCode(config(answer(503, {})), "c", "v")).rejects.toMatchObject({ kind: "api-response" });
  });
});

describe("refreshTokens", () => {
  const old: Tokens = { accessToken: "A", refreshToken: "R", expiresAt: 0, authorisedAt: 5, scopes: ["a.read"] };

  it("keeps the time of authorising, and the refresh token when none comes back", async () => {
    const fetchImpl = answer(200, { access_token: "B", expires_in: 60 });
    expect(await refreshTokens(config(fetchImpl), old)).toEqual({
      accessToken: "B",
      refreshToken: "R",
      expiresAt: NOW + 60_000,
      authorisedAt: 5,
      scopes: ["a.read"],
    });
    expect(bodyOf(fetchImpl)).toEqual({ grant_type: "refresh_token", refresh_token: "R", client_id: "client-1" });
  });

  it("takes a rotated refresh token", async () => {
    const tokens = await refreshTokens(config(answer(200, { access_token: "B", refresh_token: "R2", expires_in: 60 })), old);
    expect(tokens.refreshToken).toBe("R2");
  });

  it("needs a refresh token", async () => {
    const { refreshToken: _gone, ...none } = old;
    await expect(refreshTokens(config(), none)).rejects.toMatchObject({ kind: "authentication" });
  });
});
