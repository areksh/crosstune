import { describe, expect, it } from "vitest";

import { QobuzClient } from "./client.js";
import { classifyRelease, parseReleasesPage } from "./releases.js";

/** An item as the web player's artist/getReleasesList is believed to return it. */
function listItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rel1",
    title: "Third",
    version: null,
    tracks_count: 11,
    artist: { id: 42, name: { display: "Portishead" } },
    image: { small: "https://static.qobuz.com/rel1_230.jpg", large: "https://x/l.jpg" },
    release_type: "album",
    dates: { original: "2008-04-28", download: "2008-04-28" },
    audio_info: { maximum_bit_depth: 24, maximum_sampling_rate: 96 },
    ...overrides,
  };
}

/** An album as the older artist/get?extra=albums returns it. */
function getAlbumItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alb1",
    title: "Dummy",
    version: "Remastered",
    tracks_count: 11,
    artist: { id: 42, name: "Portishead" },
    image: { small: "https://static.qobuz.com/alb1_230.jpg" },
    product_type: "album",
    release_date_original: "1994-08-22",
    maximum_bit_depth: 16,
    maximum_sampling_rate: 44.1,
    hires_streamable: false,
    ...overrides,
  };
}

describe("parseReleasesPage", () => {
  it("parses the releases-list shape", () => {
    const page = parseReleasesPage({ has_more: true, items: [listItem()] });

    expect(page).toEqual({
      hasMore: true,
      returned: 1,
      releases: [
        {
          id: "rel1",
          title: "Third",
          artist: "Portishead",
          artistId: 42,
          releaseDate: "2008-04-28",
          bitDepth: 24,
          samplingRate: 96,
          trackCount: 11,
          image: "https://static.qobuz.com/rel1_230.jpg",
          releaseType: "album",
        },
      ],
    });
  });

  it("parses the older artist/get albums shape, paging by total", () => {
    const page = parseReleasesPage({
      id: 42,
      name: "Portishead",
      albums: { total: 3, offset: 0, limit: 2, items: [getAlbumItem(), getAlbumItem({ id: "alb2" })] },
    });

    expect(page.hasMore).toBe(true);
    expect(page.releases[0]).toEqual({
      id: "alb1",
      title: "Dummy",
      artist: "Portishead",
      artistId: 42,
      version: "Remastered",
      releaseDate: "1994-08-22",
      bitDepth: 16,
      samplingRate: 44.1,
      hires: false,
      trackCount: 11,
      image: "https://static.qobuz.com/alb1_230.jpg",
      releaseType: "album",
    });
    expect(
      parseReleasesPage({ albums: { total: 3, offset: 2, items: [getAlbumItem()] } }).hasMore,
    ).toBe(false);
  });

  it("maps Qobuz's type labels", () => {
    const types = ["live", "compilation", "epSingle", "single", "ep", "other", "album"].map(
      (type) => parseReleasesPage({ items: [listItem({ release_type: type })] }).releases[0]
        ?.releaseType,
    );
    expect(types).toEqual([
      "live",
      "compilation",
      "ep-single",
      "ep-single",
      "ep-single",
      "other",
      "album",
    ]);
  });

  it("skips malformed items and tolerates junk", () => {
    const page = parseReleasesPage({ items: [{ id: 5, title: "x" }, null, listItem()] });
    expect(page.releases).toHaveLength(1);
    // Every item Qobuz returned counts towards the next offset, read or not.
    expect(page.returned).toBe(3);
    expect(parseReleasesPage(null)).toEqual({ releases: [], hasMore: false, returned: 0 });
    expect(parseReleasesPage({ items: "nope" })).toEqual({ releases: [], hasMore: false, returned: 0 });
  });

  it("reads a released_at timestamp when no date string is given", () => {
    const item = listItem({ dates: undefined, released_at: 1700000000 });
    expect(parseReleasesPage({ items: [item] }).releases[0]?.releaseDate).toBe("2023-11-14");
  });

  it("ignores non-https covers", () => {
    const item = listItem({ image: { small: "http://insecure/x.jpg" } });
    expect(parseReleasesPage({ items: [item] }).releases[0]?.image).toBeUndefined();
  });
});

describe("classifyRelease", () => {
  it("trusts a specific type label", () => {
    expect(classifyRelease({ type: "live", title: "Dummy" })).toBe("live");
    expect(classifyRelease({ type: "epSingle", title: "Glory Box (Live)" })).toBe("ep-single");
    expect(classifyRelease({ type: "compilation", title: "Roads" })).toBe("compilation");
  });

  // Qobuz labels live albums plain "album" (seen on the live API, Nov 2026).
  it.each([
    [{ title: "Roseland NYC Live", version: "25 Remastered 2023" }],
    [{ title: "Live in Paris 1997" }],
    [{ title: "Hail to the Thief Live Recordings 2003-2009" }],
    [{ title: "Dummy", version: "Live" }],
  ])("reads an 'album' labelled %j as live from its title", (info) => {
    expect(classifyRelease({ type: "album", ...info })).toBe("live");
  });

  it("reads an 'album' with a greatest-hits title as a compilation", () => {
    expect(classifyRelease({ type: "album", title: "The Best Of Tricky" })).toBe("compilation");
    expect(classifyRelease({ type: "album", title: "Greatest Hits" })).toBe("compilation");
  });

  it("keeps an 'album' an album on weaker title hints", () => {
    expect(classifyRelease({ type: "album", title: "Alive" })).toBe("album");
    expect(classifyRelease({ type: "album", title: "The Collection" })).toBe("album");
    expect(classifyRelease({ type: "album", title: "Hits", trackCount: 2 })).toBe("album");
    expect(classifyRelease({ type: "album", title: "OK Computer OKNOTOK 1997 2017" })).toBe("album");
  });

  it("falls back to the title and version without a usable type", () => {
    expect(classifyRelease({ title: "Roseland NYC Live" })).toBe("live");
    expect(classifyRelease({ title: "Dummy", version: "Live" })).toBe("live");
    expect(classifyRelease({ title: "Greatest Hits" })).toBe("compilation");
    expect(classifyRelease({ type: "weird", title: "The Best Of Tricky" })).toBe("compilation");
    expect(classifyRelease({ title: "Glory Box EP" })).toBe("ep-single");
    expect(classifyRelease({ title: "Sour Times", trackCount: 2 })).toBe("ep-single");
    expect(classifyRelease({ title: "Dummy", trackCount: 11 })).toBe("album");
    // "Alive" is not live.
    expect(classifyRelease({ title: "Alive", trackCount: 10 })).toBe("album");
  });
});

interface Recorded {
  url: URL;
}

/** A client primed from cached credentials, served by `pages` in turn. */
function releasesClient(pages: unknown[], status = 200) {
  const recorded: Recorded[] = [];
  let served = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    recorded.push({ url });
    const body = pages[Math.min(served, pages.length - 1)];
    served += 1;
    return new Response(JSON.stringify(body ?? {}), { status });
  }) as typeof fetch;
  const client = new QobuzClient({ fetchImpl, now: () => 1700000000, sleep: async () => {} });
  client.initFromCache({ appId: "100200300", secret: "qobuztestsecret001" });
  return { client, recorded };
}

describe("QobuzClient.getArtistReleases", () => {
  it("signs the request and asks for every type, newest first", async () => {
    const { client, recorded } = releasesClient([{ has_more: false, items: [listItem()] }]);

    const result = await client.getArtistReleases(42);

    expect(result.truncated).toBe(false);
    expect(result.releases.map((r) => r.id)).toEqual(["rel1"]);
    const url = recorded[0]!.url;
    expect(url.pathname).toBe("/api.json/0.2/artist/getReleasesList");
    expect(url.searchParams.get("artist_id")).toBe("42");
    expect(url.searchParams.get("release_type")).toBe("all");
    expect(url.searchParams.get("sort")).toBe("release_date");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("request_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("pages until Qobuz reports no more", async () => {
    const { client, recorded } = releasesClient([
      { has_more: true, items: [listItem({ id: "a" }), listItem({ id: "b" })] },
      { has_more: false, items: [listItem({ id: "c" })] },
    ]);

    const result = await client.getArtistReleases(42);

    expect(result.releases.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(recorded.map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "2"]);
  });

  it("pages the older albums shape by its total", async () => {
    const { client, recorded } = releasesClient([
      { albums: { total: 2, offset: 0, items: [getAlbumItem({ id: "a" })] } },
      { albums: { total: 2, offset: 1, items: [getAlbumItem({ id: "b" })] } },
    ]);

    const result = await client.getArtistReleases(42);

    expect(result.releases.map((r) => r.id)).toEqual(["a", "b"]);
    expect(recorded).toHaveLength(2);
  });

  it("stops at the cap and says so", async () => {
    const { client, recorded } = releasesClient([
      { has_more: true, items: [listItem({ id: "a" }), listItem({ id: "b" })] },
    ]);

    const result = await client.getArtistReleases(42, 2);

    expect(result).toMatchObject({ truncated: true });
    expect(result.releases).toHaveLength(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url.searchParams.get("limit")).toBe("2");
  });

  it("raises an api-response error on failure", async () => {
    const { client } = releasesClient([{}], 500);
    await expect(client.getArtistReleases(42)).rejects.toMatchObject({ kind: "api-response" });
  });
});
