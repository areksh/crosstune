import { describe, expect, it, vi } from "vitest";

import type { TokenSource } from "../tokens.js";
import { MAX_AT_ONCE, SpotifyClient } from "./client.js";

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that gives `answers` in turn (the last one for ever). */
function scripted(...answers: Answer[]) {
  const seen: { method: string; url: URL; auth: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    seen.push({
      method: init.method ?? "GET",
      url: new URL(url),
      auth: headers["Authorization"] ?? "",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[Math.min(seen.length, answers.length) - 1]!;
    if (answer instanceof Error) {
      throw answer;
    }
    const { status = 200, body, headers: out } = answer;
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: out ?? {} });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const tokens = (): TokenSource & { renewed: string[] } => {
  const renewed: string[] = [];
  return {
    renewed,
    accessToken: async () => (renewed.length === 0 ? "A" : "B"),
    renewedToken: async (rejected) => {
      renewed.push(rejected);
      return "B";
    },
  };
};

function client(...answers: Answer[]) {
  const { seen, fetchImpl } = scripted(...answers);
  const sleeps: number[] = [];
  const lines: string[] = [];
  const source = tokens();
  return {
    seen,
    sleeps,
    lines,
    source,
    api: new SpotifyClient({
      tokens: source,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      logger: { debug: (line) => void lines.push(line) },
    }),
  };
}

const quota = { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } };

describe("SpotifyClient requests", () => {
  it("sends the token, the query and the body", async () => {
    const { api, seen } = client({ body: { ok: 1 } });
    expect(await api.get("/search", { q: "a b&c", limit: 10 })).toEqual({ ok: 1 });
    await api.send("POST", "/me/playlists", { body: { name: "x" } });
    expect(seen[0]!.url.toString()).toBe("https://api.spotify.com/v1/search?q=a+b%26c&limit=10");
    expect(seen[0]!.auth).toBe("Bearer A");
    expect(seen[1]).toMatchObject({ method: "POST", body: { name: "x" } });
  });

  it("answers undefined for an empty body", async () => {
    expect(await client({ status: 200 }).api.send("PUT", "/me/library", { query: { uris: "x" } })).toBeUndefined();
  });

  it("logs method, path and status, and never the query, body or token", async () => {
    const { api, lines } = client({ body: {} });
    await api.get("/search", { q: "secret" });
    await api.send("POST", "/me/playlists", { body: { name: "secret" } });
    expect(lines).toEqual(["GET /search -> 200", "POST /me/playlists -> 200"]);
  });

  it("renews a token that is not accepted, once", async () => {
    const { api, seen, source } = client({ status: 401 }, { body: { ok: 1 } });
    expect(await api.get("/me")).toEqual({ ok: 1 });
    expect(source.renewed).toEqual(["A"]);
    expect(seen.map((r) => r.auth)).toEqual(["Bearer A", "Bearer B"]);
  });

  it("gives up when the renewed token is not accepted either", async () => {
    const { api, seen } = client({ status: 401 });
    await expect(api.get("/me")).rejects.toMatchObject({ service: "spotify", kind: "authentication" });
    expect(seen).toHaveLength(2);
  });

  it("waits as long as it is told to when that is short, then goes on", async () => {
    const { api, sleeps } = client({ status: 429, headers: { "Retry-After": "3" } }, { body: { ok: 1 } });
    expect(await api.get("/me")).toEqual({ ok: 1 });
    expect(sleeps).toEqual([3000]);
  });

  it("repeats even a write that was told to wait, as it was not made", async () => {
    const { api, seen } = client({ status: 429, headers: { "Retry-After": "1" } }, { body: {} });
    await api.send("POST", "/playlists/p/items", { body: { uris: [] } });
    expect(seen).toHaveLength(2);
  });

  it("says how long to wait when that is long", async () => {
    const { api, sleeps } = client({ status: 429, headers: { "Retry-After": "68167" } });
    await expect(api.get("/me")).rejects.toMatchObject({ kind: "rate-limited", retryAfterSeconds: 68167 });
    expect(sleeps).toEqual([]);
  });

  it("stops waiting after a few times", async () => {
    const { api, seen } = client({ status: 429, headers: { "Retry-After": "1" } });
    await expect(api.get("/me")).rejects.toMatchObject({ kind: "rate-limited", retryAfterSeconds: 1 });
    expect(seen.length).toBeLessThan(6);
  });

  it("holds every request back while one is told to wait", async () => {
    let resume = () => {};
    const { seen, fetchImpl } = scripted({ status: 429, headers: { "Retry-After": "2" } }, { body: {} });
    const api = new SpotifyClient({
      tokens: tokens(),
      fetchImpl,
      sleep: () => new Promise<void>((resolve) => (resume = resolve)),
    });
    const first = api.get("/one");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = api.get("/two");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    resume();
    await Promise.all([first, second]);
    expect(seen.map((r) => r.url.pathname).sort()).toEqual(["/v1/one", "/v1/one", "/v1/two"]);
  });

  it("stops at once when the quota is used up", async () => {
    const { api, seen, sleeps } = client({ status: 429, body: quota, headers: { "Retry-After": "1" } });
    await expect(api.get("/me")).rejects.toMatchObject({ kind: "quota", message: expect.stringMatching(/quota/i) });
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("names what is missing and what is not allowed", async () => {
    await expect(client({ status: 404 }).api.get("/tracks/x")).rejects.toMatchObject({ kind: "not-found" });
    await expect(client({ status: 403 }).api.get("/me")).rejects.toMatchObject({
      kind: "forbidden",
      message: expect.stringMatching(/users.*Premium/),
    });
    await expect(
      client({ status: 400, body: { error: { status: 400, message: "Invalid limit" } } }).api.get("/me"),
    ).rejects.toMatchObject({ kind: "api-response", message: expect.stringMatching(/400.*Invalid limit/) });
  });

  it("tries a failing server again for a read, and then says so", async () => {
    const once = client({ status: 503 }, { body: { ok: 1 } });
    expect(await once.api.get("/me")).toEqual({ ok: 1 });
    expect(once.sleeps).toHaveLength(1);
    const always = client({ status: 502 });
    await expect(always.api.get("/me")).rejects.toMatchObject({ kind: "api-response", status: 502 });
    expect(always.seen).toHaveLength(3);
  });

  it("repeats a failed write only when twice is the same as once", async () => {
    const add = client({ status: 502 }, { body: {} });
    await expect(add.api.send("POST", "/playlists/p/items", { body: {} })).rejects.toMatchObject({ status: 502 });
    expect(add.seen).toHaveLength(1);
    const save = client({ status: 502 }, { body: {} });
    await save.api.send("PUT", "/me/library", { query: { uris: "x" }, repeatable: true });
    expect(save.seen).toHaveLength(2);
  });

  it("reports a network failure, without the address", async () => {
    const { api } = client(new TypeError("fetch failed"));
    const error = await api.get("/search", { q: "secret" }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).message).not.toContain("secret");
  });

  it("reports an answer that is not JSON", async () => {
    const api = new SpotifyClient({
      tokens: tokens(),
      fetchImpl: (async () => new Response("<html>")) as unknown as typeof fetch,
    });
    await expect(api.get("/me")).rejects.toMatchObject({ kind: "api-response" });
  });

  it("does not take a write for failed because of its answer", async () => {
    const api = new SpotifyClient({
      tokens: tokens(),
      fetchImpl: (async () => new Response("done")) as unknown as typeof fetch,
    });
    expect(await api.send("POST", "/playlists/p/items", { body: {} })).toBeUndefined();
  });

  it("has few requests open at once", async () => {
    let open = 0;
    let most = 0;
    const api = new SpotifyClient({
      tokens: tokens(),
      fetchImpl: (async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await Promise.all(Array.from({ length: 20 }, () => api.get("/me")));
    expect(most).toBe(MAX_AT_ONCE);
  });
});

describe("SpotifyClient paging", () => {
  const page = (items: unknown[], next: string | null, total = 5) => ({ body: { items, next, total, limit: 2 } });

  it("reads every page by offset, counting items it was given as null", async () => {
    const { api, seen } = client(page([1, null], "n"), page([3, 4], "n"), page([5], null));
    expect(await api.pages("/me/tracks", {}, { size: 2 })).toEqual({ items: [1, null, 3, 4, 5], total: 5, more: false });
    expect(seen.map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "2", "4"]);
    expect(seen[0]!.url.searchParams.get("limit")).toBe("2");
  });

  it("stops at a cap, and says there is more", async () => {
    const { api, seen } = client(page([1, 2], "n"), page([3, 4], "n"));
    expect(await api.pages("/x", {}, { size: 2, max: 3 })).toEqual({ items: [1, 2, 3], total: 5, more: true });
    expect(seen).toHaveLength(2);
  });

  it("reads pages that are inside a named field", async () => {
    const { api } = client({ body: { tracks: { items: [1], next: null, total: 1 } } });
    expect((await api.pages("/search", { type: "track" }, { size: 10, inside: "tracks" })).items).toEqual([1]);
  });

  it("does not take an empty page for the end when there is said to be more", async () => {
    await expect(client(page([], "n")).api.pages("/x", {}, { size: 2 })).rejects.toMatchObject({
      kind: "api-response",
    });
    await expect(client({ body: {} }).api.pages("/x", {}, { size: 2 })).rejects.toMatchObject({
      kind: "api-response",
    });
  });

  it("does not page for ever", async () => {
    await expect(client(page([1, 2], "n")).api.pages("/x", {}, { size: 2 })).rejects.toThrow(/never ended/);
  });

  it("reads every page by cursor, and stops at one it has seen", async () => {
    const at = (items: unknown[], after: string | null) => ({
      body: { artists: { items, next: after === null ? null : "n", cursors: { after } } },
    });
    const { api, seen } = client(at([1], "a"), at([2], "b"), at([3], null));
    expect(await api.cursorPages("/me/following", { type: "artist" }, { size: 50, inside: "artists" })).toEqual([1, 2, 3]);
    expect(seen.map((r) => r.url.searchParams.get("after"))).toEqual([null, "a", "b"]);
    await expect(
      client(at([1], "a"), at([2], "a")).api.cursorPages("/f", {}, { size: 50, inside: "artists" }),
    ).rejects.toThrow(/never ended/);
  });
});
