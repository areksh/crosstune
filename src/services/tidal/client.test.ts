import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../errors.js";
import { authorizeUrl, exchangeCode } from "../oauth.js";
import type { TokenSource } from "../tokens.js";
import { route, TidalClient } from "./client.js";
import { TIDAL_SCOPES, tidalOAuthConfig } from "./oauth-config.js";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A client over a list of answers (the last one repeats), noting every call and wait. */
function setup(answers: Answer[] | ((call: Call) => Answer), tokens: Partial<TokenSource> = {}) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const answer =
      typeof answers === "function" ? answers(call) : answers[Math.min(calls.length, answers.length) - 1]!;
    if (answer instanceof Error) {
      throw answer;
    }
    const { body } = answer;
    const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status: answer.status ?? 200, headers: answer.headers });
  }) as typeof fetch;
  const client = new TidalClient({
    tokens: {
      accessToken: tokens.accessToken ?? (async () => "T1"),
      renewedToken: tokens.renewedToken ?? (async () => "T2"),
    },
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    logger: { debug: (line) => lines.push(line) },
  });
  return { client, calls, waits, lines };
}

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

describe("route", () => {
  it("encodes every id", () => {
    expect(route`/playlists/${"a/b?c#d e%"}/relationships/items`).toBe(
      "/playlists/a%2Fb%3Fc%23d%20e%25/relationships/items",
    );
  });

  it("refuses ids a URL would resolve away", () => {
    for (const id of [".", "..", ""]) {
      expect(() => route`/playlists/${id}`).toThrow(expect.objectContaining({ kind: "bad-id" }));
    }
  });
});

describe("TidalClient requests", () => {
  it("sends the token and asks for JSON:API", async () => {
    const { client, calls } = setup([{ body: { data: { id: "1" } } }]);
    expect(await client.get("/users/me", { countryCode: "NO", include: undefined })).toEqual({ data: { id: "1" } });
    expect(calls[0]!.url.toString()).toBe("https://openapi.tidal.com/v2/users/me?countryCode=NO");
    expect(calls[0]!.headers).toMatchObject({
      Authorization: "Bearer T1",
      Accept: "application/vnd.api+json",
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("sends includes comma-separated", async () => {
    const { client, calls } = setup([{ body: {} }]);
    await client.get("/x", { include: ["items.artists", "items.tracks:albums"] });
    expect(calls[0]!.url.searchParams.getAll("include")).toEqual(["items.artists,items.tracks:albums"]);
  });

  it("sends a mutation's body with a key of its own", async () => {
    const { client, calls } = setup([{ body: { links: {} } }]);
    await client.send("POST", "/playlists", { data: 1 });
    await client.send("POST", "/playlists", { data: 1 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { data: 1 } });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/vnd.api+json");
    const keys = calls.map((call) => call.headers["Idempotency-Key"]!);
    expect(keys[0]!.length).toBeGreaterThan(20);
    expect(keys[0]!.length).toBeLessThanOrEqual(128);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("takes a write's empty answer", async () => {
    const { client } = setup([{ status: 204 }]);
    expect(await client.send("DELETE", "/playlists/1")).toBeUndefined();
  });

  it("logs the method, path and status only", async () => {
    const { client, lines } = setup([{ body: {} }]);
    await client.get("/searchResults", { "filter[query]": "secret words" });
    expect(lines).toEqual(["GET /searchResults -> 200"]);
  });

  it("calls an unreadable answer an error", async () => {
    const { client } = setup([{ body: "<html>" }]);
    expect((await failure(client.get("/x"))).kind).toBe("api-response");
  });
});

describe("TidalClient sign-in", () => {
  it("renews a rejected token once, and repeats the request with the same key", async () => {
    const renewedToken = vi.fn(async (_rejected: string) => "T2");
    const { client, calls } = setup(
      (call) => (call.headers["Authorization"] === "Bearer T2" ? { body: { ok: true } } : { status: 401 }),
      { renewedToken },
    );
    await client.send("POST", "/playlists", {});
    expect(renewedToken.mock.calls).toEqual([["T1"]]);
    expect(calls.map((call) => call.headers["Authorization"])).toEqual(["Bearer T1", "Bearer T2"]);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(calls[0]!.headers["Idempotency-Key"]);
  });

  it("gives up when the renewed token is rejected too", async () => {
    const renewedToken = vi.fn(async () => "T2");
    const { client, calls } = setup([{ status: 401 }], { renewedToken });
    const error = await failure(client.get("/users/me"));
    expect(error).toMatchObject({ service: "tidal", kind: "authentication" });
    expect(error.message).not.toMatch(/T1|T2/);
    expect(calls).toHaveLength(2);
    expect(renewedToken).toHaveBeenCalledTimes(1);
  });

  it("passes on a failure to renew", async () => {
    const { client } = setup([{ status: 401 }], {
      renewedToken: async () => {
        throw new ServiceError("tidal", "authentication", "connect again");
      },
    });
    expect((await failure(client.get("/x"))).message).toBe("connect again");
  });

  it("renews for each of several requests at once", async () => {
    let current = "T1";
    const { client, calls } = setup(
      (call) => (call.headers["Authorization"] === "Bearer T2" ? { body: {} } : { status: 401 }),
      {
        accessToken: async () => current,
        renewedToken: async (rejected) => {
          if (rejected === current) {
            current = "T2";
          }
          return current;
        },
      },
    );
    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    expect(calls).toHaveLength(6);
  });
});

describe("TidalClient waiting", () => {
  it("waits as long as a 429 says, then goes on", async () => {
    const { client, calls, waits } = setup([
      { status: 429, headers: { "Retry-After": "7" } },
      { status: 429, headers: { "retry-after": "2" } },
      { body: { ok: true } },
    ]);
    expect(await client.get("/x")).toEqual({ ok: true });
    expect(waits).toEqual([7000, 2000]);
    expect(calls).toHaveLength(3);
  });

  it("reads a Retry-After that is a date", async () => {
    const at = new Date(Date.now() + 20_000).toUTCString();
    const { client, waits } = setup([{ status: 429, headers: { "Retry-After": at } }, { body: {} }]);
    await client.get("/x");
    expect(waits[0]).toBeGreaterThan(15_000);
    expect(waits[0]).toBeLessThanOrEqual(21_000);
  });

  it("waits longer each time when a 429 does not say", async () => {
    const { client, waits } = setup([{ status: 429 }, { status: 429 }, { body: {} }]);
    await client.get("/x");
    expect(waits).toEqual([1000, 2000]);
  });

  it("gives up after a few, saying how long to wait", async () => {
    const { client, calls } = setup([{ status: 429, headers: { "Retry-After": "3" } }]);
    expect(await failure(client.get("/x"))).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 3 });
    expect(calls).toHaveLength(5);
  });

  it("does not wait for an hour", async () => {
    const { client, calls, waits } = setup([{ status: 429, headers: { "Retry-After": "3600" } }]);
    expect(await failure(client.get("/x"))).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 3600 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("holds other requests back while one waits", async () => {
    const order: string[] = [];
    let wake: () => void = () => {};
    let limited = true;
    const client = new TidalClient({
      tokens: { accessToken: async () => "T", renewedToken: async () => "T" },
      fetchImpl: (async (url: string) => {
        order.push(new URL(url).pathname);
        if (limited) {
          limited = false;
          return new Response(null, { status: 429, headers: { "Retry-After": "5" } });
        }
        return new Response("{}");
      }) as typeof fetch,
      sleep: () =>
        new Promise((resolve) => {
          wake = resolve;
        }),
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const first = client.get("/a");
    await tick();
    const second = client.get("/b");
    await tick();
    expect(order).toEqual(["/v2/a"]);
    wake();
    await Promise.all([first, second]);
    expect([...order].sort()).toEqual(["/v2/a", "/v2/a", "/v2/b"]);
  });

  it("repeats a request TIDAL failed on, with the same key", async () => {
    const { client, calls, waits } = setup([{ status: 503 }, { status: 500 }, { body: { ok: true } }]);
    expect(await client.send("PATCH", "/x", {})).toEqual({ ok: true });
    expect(waits).toEqual([500, 1000]);
    expect(new Set(calls.map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
  });

  it("gives up on one that keeps failing", async () => {
    const { client, calls } = setup([{ status: 502 }]);
    const error = await failure(client.get("/x"));
    expect(error.kind).toBe("api-response");
    expect(error.message).toContain("502");
    expect(calls).toHaveLength(3);
  });

  it("waits while the same request is still being worked on", async () => {
    const busy = { errors: [{ status: "409", code: "IDEMPOTENT_REQUEST_IN_PROGRESS" }] };
    const { client, calls } = setup([{ status: 500 }, { status: 409, body: busy }, { body: { done: 1 } }]);
    expect(await client.send("POST", "/x", {})).toEqual({ done: 1 });
    expect(new Set(calls.map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
  });
});

describe("TidalClient errors", () => {
  it("says what the answer means", async () => {
    const kindOf = async (status: number, body?: unknown) =>
      (await failure(setup([{ status, body }]).client.get("/playlists/1"))).kind;
    expect(await kindOf(404)).toBe("not-found");
    expect(await kindOf(403)).toBe("forbidden");
    expect(await kindOf(400)).toBe("api-response");
    expect(await kindOf(409, { errors: [{ code: "TOO_MANY_ITEMS_IN_PLAYLIST" }] })).toBe("playlist-full");
  });

  it("says that the app lacks access", async () => {
    const error = await failure(setup([{ status: 403 }]).client.get("/playlists/1"));
    expect(error.message).toMatch(/app.*access/i);
  });

  it("names TIDAL's error code but repeats none of its text", async () => {
    const body = { errors: [{ status: "400", code: "INVALID_INCLUDE", detail: "your secret query" }] };
    const error = await failure(setup([{ status: 400, body }]).client.get("/x", { "filter[query]": "secret" }));
    expect(error.message).toContain("INVALID_INCLUDE");
    expect(error.message).not.toContain("secret");
  });

  it("calls an unreachable TIDAL a network error", async () => {
    const error = await failure(setup([new TypeError("fetch failed")]).client.get("/x"));
    expect(error).toMatchObject({ service: "tidal", kind: "network" });
  });

  it("calls an answer that breaks off a network error", async () => {
    const client = new TidalClient({
      tokens: { accessToken: async () => "T", renewedToken: async () => "T" },
      fetchImpl: (async () => {
        const broken = new Response("{}");
        Object.defineProperty(broken, "text", { value: () => Promise.reject(new TypeError("terminated")) });
        return broken;
      }) as unknown as typeof fetch,
    });
    expect((await failure(client.get("/x"))).kind).toBe("network");
  });
});

describe("TidalClient.pages", () => {
  const page = (data: string[], next?: string, nextCursor?: string) => ({
    body: {
      data,
      links: {
        self: "/x",
        ...(next !== undefined && { next }),
        ...(nextCursor !== undefined && { meta: { nextCursor } }),
      },
    },
  });

  async function all(client: TidalClient): Promise<unknown[]> {
    const got: unknown[] = [];
    const query = { include: ["tracks"], countryCode: "NO" };
    for await (const document of client.pages("/artists/1/relationships/tracks", query)) {
      got.push((document as { data: unknown }).data);
    }
    return got;
  }

  it("follows the cursor, keeping its own path and parameters", async () => {
    const { client, calls } = setup([
      page(["a"], "/artists/1/relationships/tracks?page[cursor]=zy%2Bx", "zy+x"),
      page(["b"], "https://elsewhere.example/steal?page%5Bcursor%5D=last"),
      page(["c"]),
    ]);
    expect(await all(client)).toEqual([["a"], ["b"], ["c"]]);
    expect(calls.map((call) => call.url.searchParams.get("page[cursor]"))).toEqual([null, "zy+x", "last"]);
    for (const { url } of calls) {
      expect(url.origin + url.pathname).toBe("https://openapi.tidal.com/v2/artists/1/relationships/tracks");
      expect(url.searchParams.get("include")).toBe("tracks");
      expect(url.searchParams.get("countryCode")).toBe("NO");
    }
  });

  it("stops where there is no next page", async () => {
    const { client, calls } = setup([page(["a"], undefined, "leftover")]);
    expect(await all(client)).toEqual([["a"]]);
    expect(calls).toHaveLength(1);
  });

  it("does not go round for ever, nor pass off a part as the whole", async () => {
    const { client, calls } = setup([page(["a"], "/x?page[cursor]=same")]);
    expect((await failure(all(client))).kind).toBe("api-response");
    expect(calls).toHaveLength(2);
  });

  it("calls a next link it cannot read an error", async () => {
    const { client } = setup([page(["a"], "/x?offset=2")]);
    expect((await failure(all(client))).kind).toBe("api-response");
  });
});

describe("TIDAL sign-in", () => {
  it("asks for the scopes the tools need, at TIDAL's addresses", async () => {
    const config = tidalOAuthConfig("my-app", "http://127.0.0.1:53683/callback");
    const url = new URL(authorizeUrl(config, { state: "S", challenge: "C" }));
    expect(url.origin + url.pathname).toBe("https://login.tidal.com/authorize");
    expect(url.searchParams.get("scope")).toBe(TIDAL_SCOPES.join(" "));
    expect([...TIDAL_SCOPES].sort()).toEqual([
      "collection.read",
      "collection.write",
      "playlists.read",
      "playlists.write",
      "search.read",
      "user.read",
    ]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "A", expires_in: 60 })));
    await exchangeCode({ ...config, fetchImpl: fetchImpl as never }, "code", "verifier");
    expect((fetchImpl.mock.calls as unknown[][])[0]![0]).toBe("https://auth.tidal.com/v1/oauth2/token");
  });
});
