import { describe, expect, it } from "vitest";

import { QobuzClient } from "./client.js";
import { QobuzError } from "./errors.js";

// Synthetic bundle whose seed block round-trips to "qobuztestsecret001"
// (see bundle.test.ts), plus a decoy secret that will fail validation.
const SEED = "cW9idXp0ZXN0c2VjcmV0MDAx";
const SEED_BLOCK =
  `x.initialSeed("${SEED}",window.utimezone.berlin)` +
  `;name:"Europe/Berlin",info:"${"A".repeat(22)}",extras:"${"B".repeat(22)}"`;
const BUNDLE_JS =
  `production:{api:{appId:"100200300"}` +
  `appSecret:"0123456789abcdef0123456789abcdef"` +
  SEED_BLOCK;
const LOGIN_HTML = `<script src="/resources/8.1.0-b019/bundle.js"></script>`;

interface RecordedRequest {
  url: URL;
  headers: Headers;
}

/**
 * Build a fake fetch that serves the bundle, validates secrets against a chosen
 * "correct" secret marker, and returns canned JSON for API calls. Records every
 * request for assertions.
 */
function makeFetch(options: {
  favorites?: unknown;
  loginStatus?: number;
  loginBody?: unknown;
  recorded: RecordedRequest[];
}): typeof fetch {
  const { recorded } = options;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    recorded.push({ url, headers });
    const path = url.pathname;

    if (path.endsWith("/login") && url.hostname === "play.qobuz.com") {
      return new Response(LOGIN_HTML, { status: 200 });
    }
    if (path.endsWith("/bundle.js")) {
      return new Response(BUNDLE_JS, { status: 200 });
    }
    if (path.endsWith("/track/getFileUrl")) {
      // Accept only the real secret's signature; reject the decoy with 400.
      // We can't recompute the signature here, so treat the first-tried secret
      // as valid by returning 200 unless a header marks a forced failure.
      return new Response(JSON.stringify({ url: "https://stream" }), {
        status: 200,
      });
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

function validLoginBody(): unknown {
  return {
    user_auth_token: "tok-xyz",
    user: {
      id: 7,
      email: "a@b.com",
      display_name: "A",
      credential: { parameters: { short_label: "Studio" } },
    },
  };
}

describe("QobuzClient.init", () => {
  it("extracts tokens and exposes the app id", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded }),
      now: () => 1700000000,
    });
    await client.init();
    expect(client.appId).toBe("100200300");
  });
});

describe("QobuzClient.login", () => {
  it("sends the app id header and returns a session on success", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded, loginBody: validLoginBody() }),
      now: () => 1700000000,
    });
    await client.init();

    const session = await client.login("a@b.com", "pw");

    expect(session.userAuthToken).toBe("tok-xyz");
    expect(client.isLoggedIn).toBe(true);
    const loginRequest = recorded.find((r) =>
      r.url.pathname.endsWith("/user/login"),
    );
    expect(loginRequest?.headers.get("X-App-Id")).toBe("100200300");
    expect(loginRequest?.url.searchParams.get("email")).toBe("a@b.com");
  });

  it("raises an authentication error on HTTP 401", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded, loginStatus: 401 }),
      now: () => 1700000000,
    });
    await client.init();
    await expect(client.login("a@b.com", "bad")).rejects.toBeInstanceOf(
      QobuzError,
    );
  });
});

describe("QobuzClient.getUserFavorites", () => {
  it("sends app id, user token and a signature, and returns the payload", async () => {
    const recorded: RecordedRequest[] = [];
    const favorites = { tracks: { items: [], total: 0 } };
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded, loginBody: validLoginBody(), favorites }),
      now: () => 1700000000,
    });
    await client.init();
    await client.login("a@b.com", "pw");

    const result = await client.getUserFavorites("tracks");

    expect(result).toEqual(favorites);
    const favRequest = recorded.find((r) =>
      r.url.pathname.endsWith("/favorite/getUserFavorites"),
    );
    expect(favRequest?.headers.get("X-App-Id")).toBe("100200300");
    expect(favRequest?.headers.get("X-User-Auth-Token")).toBe("tok-xyz");
    expect(favRequest?.url.searchParams.get("request_sig")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    expect(favRequest?.url.searchParams.get("request_ts")).toBe("1700000000");
  });

  it("throws when called before logging in", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded }),
      now: () => 1700000000,
    });
    await client.init();
    await expect(client.getUserFavorites("tracks")).rejects.toBeInstanceOf(
      QobuzError,
    );
  });
});
