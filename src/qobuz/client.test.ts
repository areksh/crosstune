import { describe, expect, it } from "vitest";

import { QobuzClient } from "./client.js";
import { QobuzError } from "./errors.js";

// Synthetic bundle whose seed block round-trips to "qobuztestsecret001"
// (see bundle.test.ts), with an app id and an OAuth private key.
const SEED = "cW9idXp0ZXN0c2VjcmV0MDAx";
const SEED_BLOCK =
  `x.initialSeed("${SEED}",window.utimezone.berlin)` +
  `;name:"Europe/Berlin",info:"${"A".repeat(22)}",extras:"${"B".repeat(22)}"`;
const BUNDLE_WITH_KEY =
  `production:{api:{appId:"100200300"}` +
  SEED_BLOCK +
  `;privateKey:"testPrivKey01"`;
const BUNDLE_WITHOUT_KEY = `production:{api:{appId:"100200300"}` + SEED_BLOCK;
const LOGIN_HTML = `<script src="/resources/8.1.0-b019/bundle.js"></script>`;

interface RecordedRequest {
  url: URL;
  headers: Headers;
  method: string;
  body: string | undefined;
}

interface FetchOptions {
  recorded: RecordedRequest[];
  bundleJs?: string;
  oauthToken?: string;
  callbackStatus?: number;
  loginBody?: unknown;
  loginStatus?: number;
  favorites?: unknown;
}

/**
 * Build a fake fetch serving the bundle, the OAuth code exchange, and the
 * favourites call, recording every request for assertions.
 */
function makeFetch(options: FetchOptions): typeof fetch {
  const { recorded } = options;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    recorded.push({
      url,
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const path = url.pathname;

    if (path.endsWith("/login") && url.hostname === "play.qobuz.com") {
      return new Response(LOGIN_HTML, { status: 200 });
    }
    if (path.endsWith("/bundle.js")) {
      return new Response(options.bundleJs ?? BUNDLE_WITH_KEY, { status: 200 });
    }
    if (path.endsWith("/track/getFileUrl")) {
      return new Response(JSON.stringify({ url: "https://stream" }), {
        status: 200,
      });
    }
    if (path.endsWith("/oauth/callback")) {
      return new Response(
        JSON.stringify({ token: options.oauthToken ?? "tok-oauth" }),
        { status: options.callbackStatus ?? 200 },
      );
    }
    if (path.endsWith("/user/login")) {
      return new Response(JSON.stringify(options.loginBody ?? {}), {
        status: options.loginStatus ?? 200,
      });
    }
    if (path.endsWith("/favorite/getUserFavorites")) {
      return new Response(JSON.stringify(options.favorites ?? {}), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function validSessionBody(): unknown {
  return {
    user_auth_token: "tok-session",
    user: {
      id: 7,
      email: "a@b.com",
      display_name: "A",
      credential: { parameters: { short_label: "Studio" } },
    },
  };
}

async function initedClient(options: Omit<FetchOptions, "recorded">) {
  const recorded: RecordedRequest[] = [];
  const client = new QobuzClient({
    fetchImpl: makeFetch({ recorded, ...options }),
    now: () => 1700000000,
  });
  await client.init();
  return { client, recorded };
}

describe("QobuzClient.init", () => {
  it("extracts tokens and exposes the app id", async () => {
    const { client } = await initedClient({});
    expect(client.appId).toBe("100200300");
  });
});

describe("QobuzClient.loginWithOAuthCode", () => {
  it("exchanges the code for a token, then a session", async () => {
    const { client, recorded } = await initedClient({
      oauthToken: "tok-oauth",
      loginBody: validSessionBody(),
    });

    const session = await client.loginWithOAuthCode("auth-code-1");

    expect(session.userAuthToken).toBe("tok-session");
    expect(client.isLoggedIn).toBe(true);

    // Step 1: the /oauth/callback exchange carries code, private key and app id.
    const callback = recorded.find((r) =>
      r.url.pathname.endsWith("/oauth/callback"),
    );
    expect(callback?.headers.get("X-App-Id")).toBe("100200300");
    expect(callback?.url.searchParams.get("code")).toBe("auth-code-1");
    expect(callback?.url.searchParams.get("private_key")).toBe("testPrivKey01");
    expect(callback?.url.searchParams.get("app_id")).toBe("100200300");

    // Step 2: /user/login is a POST carrying the exchanged token.
    const login = recorded.find((r) => r.url.pathname.endsWith("/user/login"));
    expect(login?.method).toBe("POST");
    expect(login?.headers.get("X-User-Auth-Token")).toBe("tok-oauth");
    expect(login?.body).toBe("extra=partner");
  });

  it("raises an authentication error when the token is rejected", async () => {
    const { client } = await initedClient({ loginStatus: 401 });
    await expect(client.loginWithOAuthCode("bad-code")).rejects.toBeInstanceOf(
      QobuzError,
    );
  });

  it("raises a bundle-extraction error when the bundle has no private key", async () => {
    const { client } = await initedClient({ bundleJs: BUNDLE_WITHOUT_KEY });
    try {
      await client.loginWithOAuthCode("code");
      throw new Error("expected loginWithOAuthCode to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QobuzError);
      expect((error as QobuzError).kind).toBe("bundle-extraction");
    }
  });
});

describe("QobuzClient.getUserFavorites", () => {
  it("sends app id, user token and a signature, and returns the payload", async () => {
    const favorites = { tracks: { items: [], total: 0 } };
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
      favorites,
    });
    await client.loginWithOAuthCode("code");

    const result = await client.getUserFavorites("tracks");

    expect(result).toEqual(favorites);
    const favRequest = recorded.find((r) =>
      r.url.pathname.endsWith("/favorite/getUserFavorites"),
    );
    expect(favRequest?.headers.get("X-App-Id")).toBe("100200300");
    expect(favRequest?.headers.get("X-User-Auth-Token")).toBe("tok-session");
    expect(favRequest?.url.searchParams.get("request_sig")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    expect(favRequest?.url.searchParams.get("request_ts")).toBe("1700000000");
  });

  it("throws when called before logging in", async () => {
    const { client } = await initedClient({});
    await expect(client.getUserFavorites("tracks")).rejects.toBeInstanceOf(
      QobuzError,
    );
  });
});
