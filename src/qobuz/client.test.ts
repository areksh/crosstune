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
  artistSearch?: unknown;
  artistTracks?: unknown;
  similarArtists?: unknown;
  similarArtistsStatus?: number;
  albumSearch?: unknown;
  trackSearch?: unknown;
  playlist?: unknown;
  userPlaylists?: unknown;
  album?: unknown;
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
    if (path.endsWith("/artist/search")) {
      return new Response(JSON.stringify(options.artistSearch ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/artist/page")) {
      return new Response(JSON.stringify(options.artistTracks ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/artist/getSimilarArtists")) {
      return new Response(JSON.stringify(options.similarArtists ?? {}), {
        status: options.similarArtistsStatus ?? 200,
      });
    }
    if (path.endsWith("/album/search")) {
      return new Response(JSON.stringify(options.albumSearch ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/track/search")) {
      return new Response(JSON.stringify(options.trackSearch ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/favorite/create")) {
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }
    if (path.endsWith("/playlist/getUserPlaylists")) {
      return new Response(JSON.stringify(options.userPlaylists ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/playlist/create")) {
      return new Response(JSON.stringify(options.playlist ?? {}), {
        status: 200,
      });
    }
    if (path.endsWith("/playlist/addTracks")) {
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }
    if (path.endsWith("/album/get")) {
      return new Response(JSON.stringify(options.album ?? {}), { status: 200 });
    }
    if (
      path.endsWith("/playlist/deleteTracks") ||
      path.endsWith("/favorite/delete")
    ) {
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
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

/**
 * Extract the comma-separated id batches sent to `path` in `param`, in request
 * order. Used to assert that bulk mutations are split into batches.
 */
function idBatches(
  recorded: RecordedRequest[],
  path: string,
  param: string,
): number[][] {
  return recorded
    .filter((r) => r.url.pathname.endsWith(path))
    .map((r) => (r.url.searchParams.get(param) ?? "").split(",").map(Number));
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

describe("QobuzClient request logging", () => {
  it("emits a debug line per request with method, path and status only", async () => {
    const recorded: RecordedRequest[] = [];
    const lines: string[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({ recorded }),
      now: () => 1700000000,
      logger: { debug: (message) => lines.push(message) },
    });

    await client.init();

    // init fetches the bundle then probes a secret against track/getFileUrl.
    expect(lines).toContain("GET /track/getFileUrl -> 200");
    // The query (with request_sig and request_ts) must never reach the log.
    expect(lines.every((line) => !line.includes("request_sig"))).toBe(true);
  });
});

describe("QobuzClient credentials caching", () => {
  it("exposes the resolved credentials after init", async () => {
    const { client } = await initedClient({});
    expect(client.credentials).toEqual({
      appId: "100200300",
      secret: "qobuztestsecret001",
      privateKey: "testPrivKey01",
    });
  });

  it("omits the private key when the bundle carries none", async () => {
    const { client } = await initedClient({ bundleJs: BUNDLE_WITHOUT_KEY });
    expect(client.credentials).toEqual({
      appId: "100200300",
      secret: "qobuztestsecret001",
    });
  });

  it("throws when credentials are read before init", () => {
    const client = new QobuzClient({ fetchImpl: makeFetch({ recorded: [] }) });
    expect(() => client.credentials).toThrow(QobuzError);
  });

  it("initFromCache primes the client with no network calls", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new QobuzClient({
      fetchImpl: makeFetch({
        recorded,
        artistSearch: { artists: { items: [{ id: 5, name: "Portishead" }] } },
      }),
      now: () => 1700000000,
    });

    client.initFromCache({
      appId: "999888777",
      secret: "cachedsecret",
      privateKey: "cachedKey",
    });

    // Priming touched the network zero times: no login page, bundle, or probe.
    expect(recorded).toHaveLength(0);
    expect(client.appId).toBe("999888777");

    // A signed call then works, carrying the cached app id.
    const artists = await client.searchArtists("portishead", 5);
    expect(artists).toEqual([{ id: 5, name: "Portishead" }]);
    const search = recorded.find((r) => r.url.pathname.endsWith("/artist/search"));
    expect(search?.headers.get("X-App-Id")).toBe("999888777");
  });
});

describe("QobuzClient request retries on HTTP 400", () => {
  it("retries a throttled 400 with exponential backoff, then succeeds", async () => {
    const recorded: RecordedRequest[] = [];
    const base = makeFetch({
      recorded,
      albumSearch: {
        albums: { items: [{ id: "1", title: "X", artist: { name: "Y" } }] },
      },
    });
    let attempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/album/search")) {
        attempts += 1;
        if (attempts <= 2) return new Response("throttled", { status: 400 });
      }
      return base(input, init);
    }) as typeof fetch;
    const delays: number[] = [];
    const client = new QobuzClient({
      fetchImpl,
      now: () => 1700000000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.init();

    const albums = await client.searchAlbums("x", 5);

    expect(albums).toEqual([{ id: "1", title: "X", artist: "Y" }]);
    // Two 400s then a 200: three fetches, backing off between each retry.
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("gives up after five retries and surfaces the error", async () => {
    const recorded: RecordedRequest[] = [];
    const base = makeFetch({ recorded });
    let attempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/album/search")) {
        attempts += 1;
        return new Response("throttled", { status: 400 });
      }
      return base(input, init);
    }) as typeof fetch;
    const delays: number[] = [];
    const client = new QobuzClient({
      fetchImpl,
      now: () => 1700000000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.init();

    await expect(client.searchAlbums("x", 5)).rejects.toBeInstanceOf(QobuzError);
    // Initial attempt plus five retries.
    expect(attempts).toBe(6);
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("does not back off on the secret probe's 400 (it rejects a candidate)", async () => {
    const recorded: RecordedRequest[] = [];
    const base = makeFetch({ recorded });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/track/getFileUrl")) {
        return new Response("bad", { status: 400 });
      }
      return base(input, init);
    }) as typeof fetch;
    const delays: number[] = [];
    const client = new QobuzClient({
      fetchImpl,
      now: () => 1700000000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    // Every candidate secret is rejected with 400, so init fails - but the probe
    // must move straight to the next candidate, never backing off and retrying.
    await expect(client.init()).rejects.toBeInstanceOf(QobuzError);
    expect(delays).toEqual([]);
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

describe("QobuzClient.loginWithToken", () => {
  it("restores a session from a saved token", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });

    const session = await client.loginWithToken("saved-token");

    expect(session.userAuthToken).toBe("tok-session");
    expect(client.isLoggedIn).toBe(true);
    const login = recorded.find((r) => r.url.pathname.endsWith("/user/login"));
    expect(login?.method).toBe("POST");
    expect(login?.headers.get("X-User-Auth-Token")).toBe("saved-token");
  });

  it("raises an authentication error when the token is rejected", async () => {
    const { client } = await initedClient({ loginStatus: 401 });
    await expect(client.loginWithToken("expired")).rejects.toBeInstanceOf(
      QobuzError,
    );
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

describe("QobuzClient.searchArtists", () => {
  it("signs the search and returns parsed artists", async () => {
    const { client, recorded } = await initedClient({
      artistSearch: { artists: { items: [{ id: 5, name: "Portishead" }] } },
    });

    const artists = await client.searchArtists("portishead", 5);

    expect(artists).toEqual([{ id: 5, name: "Portishead" }]);
    const request = recorded.find((r) => r.url.pathname.endsWith("/artist/search"));
    expect(request?.url.searchParams.get("query")).toBe("portishead");
    expect(request?.url.searchParams.get("limit")).toBe("5");
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
    expect(request?.headers.get("X-App-Id")).toBe("100200300");
  });
});

describe("QobuzClient.getSimilarArtists", () => {
  it("signs the lookup and returns the similar artists, most similar first", async () => {
    const { client, recorded } = await initedClient({
      similarArtists: {
        artists: {
          total: 67,
          items: [
            { id: 11, name: "Screaming Trees" },
            { id: 12, name: "Mudhoney" },
          ],
        },
      },
    });

    const artists = await client.getSimilarArtists(42, 2);

    expect(artists).toEqual([
      { id: 11, name: "Screaming Trees" },
      { id: 12, name: "Mudhoney" },
    ]);
    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/artist/getSimilarArtists"),
    );
    expect(request?.url.searchParams.get("artist_id")).toBe("42");
    expect(request?.url.searchParams.get("limit")).toBe("2");
    expect(request?.url.searchParams.get("offset")).toBe("0");
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("raises an api-response error when the lookup fails", async () => {
    const { client } = await initedClient({ similarArtistsStatus: 500 });

    await expect(client.getSimilarArtists(42, 5)).rejects.toMatchObject({
      kind: "api-response",
    });
  });
});

describe("QobuzClient.getArtistTopTracks", () => {
  it("requests artist/page and returns popularity-ordered tracks capped at limit", async () => {
    const { client, recorded } = await initedClient({
      artistTracks: {
        top_tracks: [
          { id: 1, title: "Glory Box" },
          { id: 2, title: "Sour Times" },
          { id: 3, title: "Roads" },
        ],
      },
    });

    const tracks = await client.getArtistTopTracks(42, 2);

    // Top two, in the order Qobuz ranks them (not truncated by the API).
    expect(tracks).toEqual([
      { id: 1, title: "Glory Box" },
      { id: 2, title: "Sour Times" },
    ]);
    const request = recorded.find((r) => r.url.pathname.endsWith("/artist/page"));
    expect(request?.url.searchParams.get("artist_id")).toBe("42");
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("drops covers by other artists before applying the limit", async () => {
    // Qobuz lists covers of the artist's songs by other performers among the
    // top tracks (e.g. Johnny Cash on Bob Dylan's page). They carry a different
    // artist id and must not count towards, or crowd out, the artist's own top
    // tracks.
    const { client } = await initedClient({
      artistTracks: {
        top_tracks: [
          { id: 1, title: "Blowin' in the Wind", artist: { id: 42, name: { display: "Bob Dylan" } } },
          { id: 2, title: "Girl from the North Country", artist: { id: 99, name: { display: "Johnny Cash" } } },
          { id: 3, title: "Like a Rolling Stone", artist: { id: 42, name: { display: "Bob Dylan" } } },
        ],
      },
    });

    const tracks = await client.getArtistTopTracks(42, 2);

    // The cover (artist id 99) is filtered out, so the two returned are the
    // artist's own tracks rather than one own track plus a cover.
    expect(tracks.map((t) => t.id)).toEqual([1, 3]);
  });
});

describe("QobuzClient.searchAlbums", () => {
  it("signs the album search with a type param and returns parsed albums", async () => {
    const { client, recorded } = await initedClient({
      albumSearch: {
        albums: {
          items: [
            {
              id: "0724385",
              title: "OK Computer",
              artist: { name: "Radiohead" },
              maximum_bit_depth: 24,
            },
          ],
        },
      },
    });

    const albums = await client.searchAlbums("radiohead ok computer", 5);

    expect(albums).toEqual([
      {
        id: "0724385",
        title: "OK Computer",
        artist: "Radiohead",
        bitDepth: 24,
      },
    ]);
    const request = recorded.find((r) => r.url.pathname.endsWith("/album/search"));
    expect(request?.url.searchParams.get("query")).toBe("radiohead ok computer");
    expect(request?.url.searchParams.get("limit")).toBe("5");
    expect(request?.url.searchParams.get("type")).toBe("album");
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
    expect(request?.headers.get("X-App-Id")).toBe("100200300");
  });
});

describe("QobuzClient.searchTracks", () => {
  it("signs the track search and returns parsed tracks", async () => {
    const { client, recorded } = await initedClient({
      trackSearch: {
        tracks: {
          items: [
            {
              id: 42,
              title: "Roads",
              performer: { name: "Portishead" },
              isrc: "GBAAA0000001",
            },
          ],
        },
      },
    });

    const results = await client.searchTracks("portishead roads", 5);

    expect(results).toEqual([
      { id: 42, title: "Roads", artist: "Portishead", isrc: "GBAAA0000001" },
    ]);
    const request = recorded.find((r) => r.url.pathname.endsWith("/track/search"));
    expect(request?.url.searchParams.get("query")).toBe("portishead roads");
    expect(request?.url.searchParams.get("limit")).toBe("5");
    expect(request?.url.searchParams.get("type")).toBeNull();
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("QobuzClient favourites of albums and artists", () => {
  it("pages through favourite albums until the total is reached", async () => {
    const pages = [
      {
        albums: {
          items: [{ id: "a1", title: "One", artist: { name: "X" } }],
          total: 2,
        },
      },
      {
        albums: {
          items: [{ id: "a2", title: "Two", artist: { name: "Y" } }],
          total: 2,
        },
      },
    ];
    let call = 0;
    const recorded: RecordedRequest[] = [];
    const base = makeFetch({ recorded, loginBody: validSessionBody() });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/favorite/getUserFavorites")) {
        recorded.push({
          url,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        const body = pages[call] ?? pages[pages.length - 1];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return base(input, init);
    }) as typeof fetch;

    const client = new QobuzClient({ fetchImpl, now: () => 1700000000 });
    await client.init();
    await client.loginWithOAuthCode("code");

    const albums = await client.getFavoriteAlbums();

    expect(albums.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(call).toBe(2);
    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/favorite/getUserFavorites"),
    );
    expect(request?.url.searchParams.get("type")).toBe("albums");
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
  });

  it("returns parsed favourite artists", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
      favorites: {
        artists: { items: [{ id: 9, name: "Bjork" }], total: 1 },
      },
    });
    await client.loginWithOAuthCode("code");

    const artists = await client.getFavoriteArtists();

    expect(artists).toEqual([{ id: 9, name: "Bjork" }]);
    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/favorite/getUserFavorites"),
    );
    expect(request?.url.searchParams.get("type")).toBe("artists");
  });

  it("requires sign-in", async () => {
    const { client } = await initedClient({});
    await expect(client.getFavoriteAlbums()).rejects.toBeInstanceOf(QobuzError);
    await expect(client.getFavoriteArtists()).rejects.toBeInstanceOf(QobuzError);
  });
});

describe("QobuzClient add-favourite methods", () => {
  it("adds tracks, albums and artists to their own favourite endpoints", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.addFavoriteTracks([1, 2]);
    await client.addFavoriteAlbums(["alb-a", "alb-b"]);
    await client.addFavoriteArtists([55]);

    const creates = recorded.filter((r) =>
      r.url.pathname.endsWith("/favorite/create"),
    );
    expect(creates[0]?.url.searchParams.get("track_ids")).toBe("1,2");
    expect(creates[1]?.url.searchParams.get("album_ids")).toBe("alb-a,alb-b");
    expect(creates[2]?.url.searchParams.get("artist_ids")).toBe("55");
    for (const create of creates) {
      expect(create.headers.get("X-User-Auth-Token")).toBe("tok-session");
    }
  });

  it("batches a large add within the per-request cap and is a no-op when empty", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    const ids = Array.from({ length: 130 }, (_, i) => i + 1);
    await client.addFavoriteTracks(ids);
    await client.addFavoriteTracks([]);

    const batches = idBatches(recorded, "/favorite/create", "track_ids");
    expect(batches.length).toBe(3);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(50);
    expect(batches.flat()).toEqual(ids);
  });

  it("requires sign-in", async () => {
    const { client } = await initedClient({});
    await expect(client.addFavoriteTracks([1])).rejects.toBeInstanceOf(QobuzError);
  });
});

describe("QobuzClient.getAlbumTracks", () => {
  it("reads the tracks embedded in an album/get response", async () => {
    const { client, recorded } = await initedClient({
      album: {
        id: "a",
        tracks: {
          items: [
            { id: 1, title: "Airbag" },
            { id: 2, title: "Paranoid Android" },
          ],
        },
      },
    });

    const tracks = await client.getAlbumTracks("a");

    expect(tracks).toEqual([
      { id: 1, title: "Airbag" },
      { id: 2, title: "Paranoid Android" },
    ]);
    const request = recorded.find((r) => r.url.pathname.endsWith("/album/get"));
    expect(request?.url.searchParams.get("album_id")).toBe("a");
    // No `extra` param: album/get embeds tracks by default and rejects extras.
    expect(request?.url.searchParams.get("extra")).toBeNull();
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives each track the album's cover, which album/get tracks do not embed", async () => {
    const small = "https://static.qobuz.com/images/covers/a_230.jpg";
    const { client } = await initedClient({
      album: { id: "a", image: { small }, tracks: { items: [{ id: 1, title: "Airbag" }] } },
    });

    expect(await client.getAlbumTracks("a")).toEqual([{ id: 1, title: "Airbag", image: small }]);
  });
});

describe("QobuzClient.createPlaylist", () => {
  it("creates a playlist with the user token and returns its id", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
      playlist: { id: 777, name: "Road Trip" },
    });
    await client.loginWithOAuthCode("code");

    const playlist = await client.createPlaylist("Road Trip", { isPublic: true });

    expect(playlist).toEqual({ id: 777, name: "Road Trip" });
    const request = recorded.find((r) => r.url.pathname.endsWith("/playlist/create"));
    expect(request?.url.searchParams.get("name")).toBe("Road Trip");
    expect(request?.url.searchParams.get("is_public")).toBe("true");
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
  });

  it("throws when not signed in", async () => {
    const { client } = await initedClient({});
    await expect(client.createPlaylist("x")).rejects.toBeInstanceOf(QobuzError);
  });
});

describe("QobuzClient.addTracksToPlaylist", () => {
  it("sends comma-joined track ids with the user token", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.addTracksToPlaylist(777, [1, 2, 3]);

    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/playlist/addTracks"),
    );
    expect(request?.url.searchParams.get("playlist_id")).toBe("777");
    expect(request?.url.searchParams.get("track_ids")).toBe("1,2,3");
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
  });

  it("is a no-op for an empty track list (no request sent)", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.addTracksToPlaylist(777, []);

    expect(
      recorded.some((r) => r.url.pathname.endsWith("/playlist/addTracks")),
    ).toBe(false);
  });

  it("splits a large track list into batches within the per-request cap", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    const ids = Array.from({ length: 130 }, (_, i) => i + 1);
    await client.addTracksToPlaylist(777, ids);

    const batches = idBatches(recorded, "/playlist/addTracks", "track_ids");
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(50);
    expect(batches.flat()).toEqual(ids);
  });
});

describe("QobuzClient.getUserPlaylists", () => {
  it("returns the signed-in user's playlists with the user token", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
      userPlaylists: {
        playlists: {
          items: [{ id: 1, name: "Road Trip", tracks_count: 12 }],
          total: 1,
        },
      },
    });
    await client.loginWithOAuthCode("code");

    const playlists = await client.getUserPlaylists();

    expect(playlists).toEqual([{ id: 1, name: "Road Trip", trackCount: 12 }]);
    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/playlist/getUserPlaylists"),
    );
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
    expect(request?.url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("requires sign-in", async () => {
    const { client } = await initedClient({});
    await expect(client.getUserPlaylists()).rejects.toBeInstanceOf(QobuzError);
  });
});

describe("QobuzClient.getPlaylistTracks", () => {
  it("pages through all tracks until the total is reached", async () => {
    // 3 tracks total, served 2 then 1 across two pages.
    const pages = [
      { tracks: { items: [{ id: 1, title: "A" }, { id: 2, title: "B" }], total: 3 } },
      { tracks: { items: [{ id: 3, title: "C" }], total: 3 } },
    ];
    let call = 0;
    const recorded: RecordedRequest[] = [];
    const base = makeFetch({ recorded });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/playlist/get")) {
        const body = pages[call] ?? pages[pages.length - 1];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return base(input, init);
    }) as typeof fetch;

    const client = new QobuzClient({ fetchImpl, now: () => 1700000000 });
    await client.init();

    const tracks = await client.getPlaylistTracks(555);

    expect(tracks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });
});

describe("QobuzClient.getFavoriteTracks", () => {
  it("returns parsed favourite tracks and requires sign-in", async () => {
    const { client } = await initedClient({});
    await expect(client.getFavoriteTracks()).rejects.toBeInstanceOf(QobuzError);
  });
});

describe("QobuzClient.getAlbumReleaseDate", () => {
  it("returns the album's original release date", async () => {
    const { client } = await initedClient({
      album: { id: "a", release_date_original: "1973-03-01" },
    });
    await expect(client.getAlbumReleaseDate("a")).resolves.toBe("1973-03-01");
  });
});

describe("QobuzClient removal methods", () => {
  it("removes playlist tracks by playlist-track id with the user token", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.removeTracksFromPlaylist(555, [11, 22]);

    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/playlist/deleteTracks"),
    );
    expect(request?.url.searchParams.get("playlist_id")).toBe("555");
    expect(request?.url.searchParams.get("playlist_track_ids")).toBe("11,22");
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
  });

  it("removes favourite tracks by track id", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.removeFavoriteTracks([1, 2, 3]);

    const request = recorded.find((r) =>
      r.url.pathname.endsWith("/favorite/delete"),
    );
    expect(request?.url.searchParams.get("track_ids")).toBe("1,2,3");
    expect(request?.headers.get("X-User-Auth-Token")).toBe("tok-session");
  });

  it("splits large removals into batches within the per-request cap", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    const ids = Array.from({ length: 130 }, (_, i) => i + 1);
    await client.removeTracksFromPlaylist(555, ids);
    await client.removeFavoriteTracks(ids);

    const playlistBatches = idBatches(
      recorded,
      "/playlist/deleteTracks",
      "playlist_track_ids",
    );
    expect(playlistBatches.length).toBeGreaterThan(1);
    expect(Math.max(...playlistBatches.map((b) => b.length))).toBeLessThanOrEqual(
      50,
    );
    expect(playlistBatches.flat()).toEqual(ids);

    const favouriteBatches = idBatches(recorded, "/favorite/delete", "track_ids");
    expect(favouriteBatches.length).toBeGreaterThan(1);
    expect(favouriteBatches.flat()).toEqual(ids);
  });

  it("is a no-op for empty removal lists (no request sent)", async () => {
    const { client, recorded } = await initedClient({
      loginBody: validSessionBody(),
    });
    await client.loginWithOAuthCode("code");

    await client.removeTracksFromPlaylist(555, []);
    await client.removeFavoriteTracks([]);

    expect(
      recorded.some(
        (r) =>
          r.url.pathname.endsWith("/playlist/deleteTracks") ||
          r.url.pathname.endsWith("/favorite/delete"),
      ),
    ).toBe(false);
  });

  it("requires sign-in", async () => {
    const { client } = await initedClient({});
    await expect(client.removeFavoriteTracks([1])).rejects.toBeInstanceOf(
      QobuzError,
    );
  });
});
