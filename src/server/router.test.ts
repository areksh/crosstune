import { describe, expect, it, vi } from "vitest";

import {
  QobuzError,
  type Album,
  type Artist,
  type Playlist,
  type Release,
  type Track,
} from "../qobuz/index.js";
import { FakeAccount, MemoryStore } from "../features/fake-account.test-support.js";
import { Journal, recordingClient } from "../features/journal.js";
import { emptyJobState, type JobsFile, type JobState } from "../jobs/model.js";
import type { RefreshPreview } from "../jobs/refresh.js";
import type { AcceptOutcome, RunSummary } from "../jobs/run-due.js";
import { jobsService } from "../jobs/service.js";
import { handleApi, type ApiDeps, type QobuzApiService } from "./router.js";

const NONCE = "test-nonce";
const PORT = 4747;

function service(overrides: Partial<QobuzApiService> = {}): QobuzApiService {
  return {
    searchArtists: vi.fn(async () => [] as Artist[]),
    getArtist: vi.fn(async (id: number) => ({ id, name: `Artist ${id}` })),
    getAlbum: vi.fn(async (id: string): Promise<Album> => ({ id, title: "Album", artist: "Artist" })),
    getArtistTopTracks: vi.fn(async () => [] as Track[]),
    getSimilarArtists: vi.fn(async () => [] as Artist[]),
    getArtistReleases: vi.fn(async () => ({ releases: [] as Release[], truncated: false })),
    getUserPlaylists: vi.fn(async () => [] as Playlist[]),
    getPlaylistTracks: vi.fn(async () => [] as Track[]),
    getFavoriteTracks: vi.fn(async () => [] as Track[]),
    getAlbumReleaseDate: vi.fn(async () => undefined),
    searchAlbums: vi.fn(async () => [] as Album[]),
    searchTracks: vi.fn(async () => [] as Track[]),
    getAlbumTracks: vi.fn(async () => [] as Track[]),
    getFavoriteAlbums: vi.fn(async () => [] as Album[]),
    getFavoriteArtists: vi.fn(async () => [] as Artist[]),
    addFavoriteTracks: vi.fn(async () => {}),
    addFavoriteAlbums: vi.fn(async () => {}),
    addFavoriteArtists: vi.fn(async () => {}),
    createPlaylist: vi.fn(async (name: string) => ({ id: 1, name })),
    addTracksToPlaylist: vi.fn(async () => {}),
    removeTracksFromPlaylist: vi.fn(async () => {}),
    removeFavoriteTracks: vi.fn(async () => {}),
    removeFavoriteAlbums: vi.fn(async () => {}),
    removeFavoriteArtists: vi.fn(async () => {}),
    deletePlaylist: vi.fn(async () => {}),
    ...overrides,
  };
}

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    service: service(),
    session: { displayName: "Arek", subscriptionLabel: "Studio" },
    nonce: NONCE,
    port: PORT,
    ...overrides,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
) {
  return {
    method,
    path,
    headers: {
      host: `127.0.0.1:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
      nonce: NONCE,
      ...headers,
    },
    body,
  };
}

describe("handleApi security", () => {
  it("rejects a request without the nonce", async () => {
    const res = await handleApi(request("GET", "/api/session", undefined, { nonce: undefined }), deps());
    expect(res.status).toBe(403);
  });
});

describe("GET /api/session", () => {
  it("returns the signed-in user", async () => {
    const res = await handleApi(request("GET", "/api/session"), deps());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: "Arek", subscriptionLabel: "Studio" });
  });
});

describe("GET /api/playlists", () => {
  it("returns the user's playlists", async () => {
    const playlists = [{ id: 1, name: "Road Trip", trackCount: 5 }];
    const res = await handleApi(
      request("GET", "/api/playlists"),
      deps({ service: service({ getUserPlaylists: vi.fn(async () => playlists) }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playlists });
  });
});

describe("POST /api/resolve", () => {
  it("resolves artists to their tracks", async () => {
    const svc = service({
      searchArtists: vi.fn(async (q: string) => [{ id: 5, name: q }]),
      getArtistTopTracks: vi.fn(async () => [{ id: 100, title: "Roads" }]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", { artists: ["Portishead"], tracksPerArtist: 3 }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resolvedArtists: [
        {
          query: "Portishead",
          artist: { id: 5, name: "Portishead" },
          tracks: [{ id: 100, title: "Roads" }],
          excluded: [],
        },
      ],
      unresolvedArtists: [],
      emptyArtists: [],
      // One of three requested tracks came back, so Portishead is under-filled.
      partialArtists: [
        { query: "Portishead", artist: { id: 5, name: "Portishead" }, trackCount: 1, requested: 3 },
      ],
    });
    expect(svc.getArtistTopTracks).toHaveBeenCalledWith(5, 3);
  });

  it("flags matched artists that return no tracks and excludes them", async () => {
    const svc = service({
      searchArtists: vi.fn(async (q: string) => [{ id: 7, name: q }]),
      getArtistTopTracks: vi.fn(async () => []),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", { artists: ["Restricted"], tracksPerArtist: 5 }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resolvedArtists: [],
      unresolvedArtists: [],
      emptyArtists: [
        { query: "Restricted", artist: { id: 7, name: "Restricted" }, trackCount: 0, requested: 5 },
      ],
      partialArtists: [],
    });
  });

  it("trims and drops blank artist lines", async () => {
    const svc = service({ searchArtists: vi.fn(async (q: string) => [{ id: 1, name: q }]) });
    const res = await handleApi(
      request("POST", "/api/resolve", { artists: ["  Wire  ", "", "   "] }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(svc.searchArtists).toHaveBeenCalledTimes(1);
    expect(svc.searchArtists).toHaveBeenCalledWith("Wire", 5);
  });

  it("rejects an empty artist list", async () => {
    const res = await handleApi(request("POST", "/api/resolve", { artists: [] }), deps());
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer or out-of-range tracksPerArtist", async () => {
    expect(
      (await handleApi(request("POST", "/api/resolve", { artists: ["A"], tracksPerArtist: 0 }), deps())).status,
    ).toBe(400);
    expect(
      (await handleApi(request("POST", "/api/resolve", { artists: ["A"], tracksPerArtist: 1000 }), deps())).status,
    ).toBe(400);
  });
});

describe("POST /api/commit", () => {
  it("creates a new playlist from the chosen tracks", async () => {
    const svc = service({ createPlaylist: vi.fn(async () => ({ id: 9, name: "New" })) });
    const res = await handleApi(
      request("POST", "/api/commit", {
        target: { type: "new", name: "New", isPublic: true },
        trackIds: [1, 2, 3],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playlist: { id: 9, name: "New" }, added: [1, 2, 3], skipped: [] });
    expect(svc.createPlaylist).toHaveBeenCalledWith("New", { isPublic: true });
    expect(svc.addTracksToPlaylist).toHaveBeenCalledWith(9, [1, 2, 3]);
  });

  it("adds to an existing playlist, skipping tracks already present", async () => {
    const svc = service({
      getPlaylistTracks: vi.fn(async () => [{ id: 1, title: "present" }]),
    });
    const res = await handleApi(
      request("POST", "/api/commit", {
        target: { type: "existing", playlistId: 55 },
        trackIds: [1, 2, 3],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playlistId: 55, added: [2, 3], skipped: [1] });
    expect(svc.addTracksToPlaylist).toHaveBeenCalledWith(55, [2, 3]);
  });

  it("rejects a new playlist with a blank name", async () => {
    const res = await handleApi(
      request("POST", "/api/commit", { target: { type: "new", name: "  " }, trackIds: [1] }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty track list", async () => {
    const res = await handleApi(
      request("POST", "/api/commit", { target: { type: "existing", playlistId: 1 }, trackIds: [] }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown target type", async () => {
    const res = await handleApi(
      request("POST", "/api/commit", { target: { type: "nope" }, trackIds: [1] }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("filter in playlist requests", () => {
  it("applies a track filter when resolving artists", async () => {
    const svc = service({
      searchArtists: vi.fn(async (q: string) => [{ id: 5, name: q }]),
      getArtistTopTracks: vi.fn(async () => [
        { id: 100, title: "Roads", version: "Live" },
        { id: 101, title: "Sour Times" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", {
        artists: ["Portishead"],
        tracksPerArtist: 1,
        filter: { excludeTracks: ["live"] },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      resolvedArtists: Array<{ tracks: Track[]; excluded: Array<{ track: Track }> }>;
    };
    expect(body.resolvedArtists[0]?.tracks.map((t) => t.id)).toEqual([101]);
    expect(body.resolvedArtists[0]?.excluded.map((e) => e.track.id)).toEqual([100]);
  });

  it("applies an artist filter to the tracks' performers", async () => {
    const svc = service({
      searchArtists: vi.fn(async (q: string) => [{ id: 5, name: q }]),
      getArtistTopTracks: vi.fn(async () => [
        { id: 100, title: "Duet", artist: "Björk" },
        { id: 101, title: "Sour Times", artist: "Portishead" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", {
        artists: ["Portishead"],
        tracksPerArtist: 1,
        filter: { excludeArtists: ["bjork"] },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      resolvedArtists: Array<{ tracks: Track[]; excluded: Array<{ exclusion: unknown }> }>;
    };
    expect(body.resolvedArtists[0]?.tracks.map((t) => t.id)).toEqual([101]);
    expect(body.resolvedArtists[0]?.excluded.map((e) => e.exclusion)).toEqual([
      { kind: "artist", term: "bjork" },
    ]);
  });

  it("drops excluded releases when resolving albums and reports fully excluded ones", async () => {
    const svc = service({
      searchAlbums: vi.fn(async () => [
        { id: "live", title: "Dummy", artist: "Portishead", version: "Live" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve-albums", {
        entries: ["Portishead - Dummy"],
        filter: { excludeAlbums: ["live"] },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resolvedAlbums: [],
      unresolvedAlbums: [],
      excludedAlbums: ["Portishead - Dummy"],
    });
  });

  it("marks tracks outside the disc list when fetching album tracks", async () => {
    const svc = service({
      getAlbumTracks: vi.fn(async () => [
        { id: 1, title: "One", discNumber: 1 },
        { id: 2, title: "Two", discNumber: 2 },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["a"], filter: { discs: "1" } }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fetched: [
        {
          albumId: "a",
          tracks: [
            { track: { id: 1, title: "One", discNumber: 1 } },
            { track: { id: 2, title: "Two", discNumber: 2 }, exclusion: { kind: "disc", disc: 2 } },
          ],
        },
      ],
      failedAlbumIds: [],
    });
  });

  it.each([
    ["a non-object filter", "live"],
    ["non-array terms", { excludeTracks: "live" }],
    ["non-string terms", { excludeAlbums: [1] }],
    ["non-array artist terms", { excludeArtists: "Drake" }],
    ["non-string artist terms", { excludeArtists: [null] }],
    ["a non-string disc list", { discs: [1] }],
  ])("rejects %s", async (_label, filter) => {
    const res = await handleApi(
      request("POST", "/api/resolve", { artists: ["A"], filter }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid regex term with a message naming it", async () => {
    const res = await handleApi(
      request("POST", "/api/resolve-albums", {
        entries: ["A - B"],
        filter: { excludeTracks: ["/(oops/"] },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("/(oops/");
  });

  it("rejects an invalid regex artist term with a message naming it", async () => {
    const res = await handleApi(
      request("POST", "/api/resolve", { artists: ["A"], filter: { excludeArtists: ["/[/"] } }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("/[/");
  });

  it("rejects a malformed disc list", async () => {
    const res = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["a"], filter: { discs: "two" } }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/disc/i);
  });
});

const similarService = () =>
  service({
    searchArtists: vi.fn(async (q: string) => [{ id: 1, name: q }]),
    getSimilarArtists: vi.fn(async (id: number) =>
      id === 1 ? [{ id: 11, name: "Mudhoney" }, { id: 12, name: "Hole" }] : [],
    ),
    getArtistTopTracks: vi.fn(async (id: number, limit?: number) =>
      Array.from({ length: 10 }, (_v, i) => ({ id: id * 100 + i, title: `t${i}` })).slice(
        0,
        limit,
      ),
    ),
    getPlaylistTracks: vi.fn(async () => [
      { id: 5, title: "Lithium", artistId: 1, artist: "Nirvana" },
    ]),
  });

describe("POST /api/similar/walk", () => {
  it("walks from typed artists with the default counts, fetching only seed tracks", async () => {
    const svc = similarService();
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "artists", artists: ["Nirvana", "  "] },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      seeds: Array<{ artist: Artist; tracks: Track[] }>;
      found: Array<{ artist: Artist; level: number }>;
      truncated: boolean;
    };
    // Defaults: 5 seed tracks, 3 similar per artist, depth 1.
    expect(body.seeds.map((s) => [s.artist.id, s.tracks.length])).toEqual([[1, 5]]);
    expect(body.found.map((f) => [f.artist.id, f.level])).toEqual([
      [11, 1],
      [12, 1],
    ]);
    expect(svc.getSimilarArtists).toHaveBeenCalledWith(1, 500);
    expect(svc.getArtistTopTracks).not.toHaveBeenCalledWith(11, expect.anything());
    expect(body.truncated).toBe(false);
  });

  it("walks from a playlist, honouring depth", async () => {
    const svc = similarService();
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "playlist", playlistId: 42, maxSeeds: 5 },
        similarPerArtist: 1,
        depth: 2,
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      seeds: Array<{ artist: Artist; tracks: Track[] }>;
      found: Array<{ artist: Artist }>;
    };
    expect(svc.getPlaylistTracks).toHaveBeenCalledWith(42);
    expect(body.seeds).toEqual([
      { query: "Nirvana", artist: { id: 1, name: "Nirvana" }, tracks: [], excluded: [] },
    ]);
    expect(body.found.map((f) => f.artist.id)).toEqual([11]);
    // Depth 2 looked up the level-1 artist too.
    expect(svc.getSimilarArtists).toHaveBeenCalledWith(11, 500);
  });

  it("accepts large counts, deep walks and a chosen artist cap", async () => {
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "artists", artists: ["Nirvana"] },
        similarPerArtist: 70,
        depth: 6,
        maxArtists: 1,
      }),
      deps({ service: similarService() }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { found: unknown[]; truncated: boolean };
    expect(body.found).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  it("keeps each artist to its own top N unless told to replace repeats", async () => {
    // Nirvana and Hole both list Mudhoney first.
    const svc = similarService();
    svc.getSimilarArtists = vi.fn(async (id: number) =>
      id === 1
        ? [{ id: 11, name: "Mudhoney" }]
        : [{ id: 11, name: "Mudhoney" }, { id: 13, name: "Tad" }],
    );
    svc.searchArtists = vi.fn(async (q: string) => [{ id: q === "Nirvana" ? 1 : 2, name: q }]);
    const walk = async (replaceRepeats?: boolean) =>
      (
        await handleApi(
          request("POST", "/api/similar/walk", {
            source: { type: "artists", artists: ["Nirvana", "Hole"], tracksPerSeed: 0 },
            similarPerArtist: 1,
            ...(replaceRepeats !== undefined && { replaceRepeats }),
          }),
          deps({ service: svc }),
        )
      ).body as {
        found: Array<{ artist: Artist }>;
        appearances: Array<{ artist: Artist; seed: Artist }>;
      };

    const strict = await walk();
    expect(strict.found.map((f) => f.artist.id)).toEqual([11]);
    expect(strict.appearances.map((a) => [a.seed.id, a.artist.id])).toEqual([
      [1, 11],
      [2, 11],
    ]);
    const replacing = await walk(true);
    expect(replacing.found.map((f) => f.artist.id)).toEqual([11, 13]);
  });

  it("leaves out similar artists the filter excludes and reports them", async () => {
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "artists", artists: ["Nirvana"], tracksPerSeed: 0 },
        similarPerArtist: 1,
        filter: { excludeArtists: ["mudhoney"] },
      }),
      deps({ service: similarService() }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { found: Array<{ artist: Artist }>; excludedArtists: Artist[] };
    expect(body.found.map((f) => f.artist.id)).toEqual([12]);
    expect(body.excludedArtists).toEqual([{ id: 11, name: "Mudhoney" }]);
  });

  it("accepts zero seed tracks", async () => {
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "artists", artists: ["Nirvana"], tracksPerSeed: 0 },
      }),
      deps({ service: similarService() }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { seeds: Array<{ tracks: Track[] }> }).seeds[0]?.tracks).toEqual([]);
  });

  it.each([
    ["no source", {}],
    ["an unknown source type", { source: { type: "favourites" } }],
    ["no artists", { source: { type: "artists", artists: [" "] } }],
    ["a non-array artist list", { source: { type: "artists", artists: "Nirvana" } }],
    ["a bad playlist id", { source: { type: "playlist", playlistId: "x" } }],
    ["too many seed tracks", { source: { type: "artists", artists: ["A"], tracksPerSeed: 101 } }],
    ["negative seed tracks", { source: { type: "artists", artists: ["A"], tracksPerSeed: -1 } }],
    ["zero seeds", { source: { type: "playlist", playlistId: 1, maxSeeds: 0 } }],
    ["too many seeds", { source: { type: "playlist", playlistId: 1, maxSeeds: 51 } }],
    ["depth 0", { source: { type: "artists", artists: ["A"] }, depth: 0 }],
    ["0 similar per artist", { source: { type: "artists", artists: ["A"] }, similarPerArtist: 0 }],
    ["an artist cap of 0", { source: { type: "artists", artists: ["A"] }, maxArtists: 0 }],
    ["a fractional count", { source: { type: "artists", artists: ["A"] }, similarPerArtist: 1.5 }],
    ["31 tracks per similar artist", { source: { type: "artists", artists: ["A"] }, tracksPerSimilar: 31 }],
    ["a bad filter", { source: { type: "artists", artists: ["A"] }, filter: { discs: 1 } }],
    ["a non-boolean replaceRepeats", { source: { type: "artists", artists: ["A"] }, replaceRepeats: "yes" }],
  ])("rejects %s", async (_label, body) => {
    const res = await handleApi(request("POST", "/api/similar/walk", body), deps());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/similar/tracks", () => {
  it("fetches a batch of artists' top tracks with the filter, flagging empty ones", async () => {
    const svc = similarService();
    svc.getArtistTopTracks = vi.fn(async (id: number, limit?: number) =>
      id === 12
        ? []
        : Array.from({ length: 10 }, (_v, i) => ({ id: id * 100 + i, title: `t${i}` })).slice(
            0,
            limit,
          ),
    );
    const res = await handleApi(
      request("POST", "/api/similar/tracks", {
        artists: [
          { id: 11, name: "Mudhoney" },
          { id: 12, name: "Restricted" },
        ],
        tracksPerSimilar: 2,
        filter: { excludeTracks: ["t0"] },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      fetched: Array<{ artist: Artist; tracks: Track[]; excluded: unknown[] }>;
      emptyArtists: Array<{ artist: Artist }>;
    };
    expect(body.fetched.map((f) => [f.artist.id, f.tracks.map((t) => t.id)])).toEqual([
      [11, [1101, 1102]],
    ]);
    expect(body.fetched[0]?.excluded).toHaveLength(1);
    expect(body.emptyArtists.map((a) => a.artist.id)).toEqual([12]);
  });

  it.each([
    ["no artists", { artists: [] }],
    ["a malformed artist", { artists: [{ id: "x", name: "A" }] }],
    ["too many artists", { artists: Array.from({ length: 51 }, (_v, i) => ({ id: i + 1, name: "A" })) }],
    ["31 tracks", { artists: [{ id: 1, name: "A" }], tracksPerSimilar: 31 }],
    ["a bad filter", { artists: [{ id: 1, name: "A" }], filter: "live" }],
  ])("rejects %s", async (_label, body) => {
    const res = await handleApi(request("POST", "/api/similar/tracks", body), deps());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/similar/estimate", () => {
  it("estimates from the settings without calling Qobuz", async () => {
    const svc = service();
    const res = await handleApi(
      request("POST", "/api/similar/estimate", {
        source: { type: "artists", artists: ["A", "B"], tracksPerSeed: 5 },
        similarPerArtist: 3,
        depth: 2,
        tracksPerSimilar: 3,
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ artists: 24, tracks: 82, large: false });
    expect((res.body as { summary: string }).summary).toMatch(/^up to 24 similar artists/);
    expect(svc.searchArtists).not.toHaveBeenCalled();
    expect(svc.getSimilarArtists).not.toHaveBeenCalled();
  });

  it("uses the seed cap as the seed count for a playlist, and flags a large run", async () => {
    const res = await handleApi(
      request("POST", "/api/similar/estimate", {
        source: { type: "playlist", playlistId: 1, maxSeeds: 50 },
        similarPerArtist: 20,
        depth: 3,
        maxArtists: 5000,
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ artists: 5000, large: true });
  });

  it("rejects invalid settings", async () => {
    const res = await handleApi(
      request("POST", "/api/similar/estimate", { source: { type: "artists", artists: [] } }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/resolve-albums", () => {
  it("resolves 'Artist - Album' lines to their matching versions", async () => {
    const svc = service({
      searchAlbums: vi.fn(async () => [
        { id: "cd", title: "OK Computer", artist: "Radiohead", bitDepth: 16 },
        { id: "hr", title: "OK Computer", artist: "Radiohead", bitDepth: 24 },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve-albums", { entries: ["Radiohead - OK Computer"] }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      resolvedAlbums: Array<{ query: string; versions: Album[] }>;
      unresolvedAlbums: string[];
    };
    expect(body.resolvedAlbums).toHaveLength(1);
    expect(body.resolvedAlbums[0]?.versions.map((v) => v.id)).toEqual(["cd", "hr"]);
    expect(body.unresolvedAlbums).toEqual([]);
    expect(svc.searchAlbums).toHaveBeenCalledWith("Radiohead OK Computer", 20);
  });

  it("reports malformed lines as unresolved", async () => {
    const svc = service({
      searchAlbums: vi.fn(async () => [
        { id: "d", title: "Discovery", artist: "Daft Punk" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve-albums", {
        entries: ["Daft Punk - Discovery", "no separator here"],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { unresolvedAlbums: string[] };
    expect(body.unresolvedAlbums).toEqual(["no separator here"]);
  });

  it("rejects a body with no parseable album lines", async () => {
    const res = await handleApi(
      request("POST", "/api/resolve-albums", { entries: ["", "  "] }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/album-tracks", () => {
  it("returns each album's tracks in request order, fetching without writing", async () => {
    const svc = service({
      getAlbumTracks: vi.fn(async (id: string) =>
        id === "a"
          ? [{ id: 1, title: "One" }, { id: 2, title: "Two" }]
          : [{ id: 3, title: "Three" }],
      ),
    });
    const res = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["a", "b"] }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fetched: [
        {
          albumId: "a",
          tracks: [{ track: { id: 1, title: "One" } }, { track: { id: 2, title: "Two" } }],
        },
        { albumId: "b", tracks: [{ track: { id: 3, title: "Three" } }] },
      ],
      failedAlbumIds: [],
    });
    // Fetching must not write anything to a playlist.
    expect(svc.createPlaylist).not.toHaveBeenCalled();
    expect(svc.addTracksToPlaylist).not.toHaveBeenCalled();
  });

  it("passes cover URLs through to the page", async () => {
    const image = "https://static.qobuz.com/images/covers/a_230.jpg";
    const svc = service({
      getAlbumTracks: vi.fn(async () => [{ id: 1, title: "One", image }]),
      searchAlbums: vi.fn(async () => [
        { id: "a", title: "OK Computer", artist: "Radiohead", image },
      ]),
    });
    const tracks = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["a"] }),
      deps({ service: svc }),
    );
    expect(tracks.body).toMatchObject({
      fetched: [{ albumId: "a", tracks: [{ track: { id: 1, title: "One", image } }] }],
    });
    const albums = await handleApi(
      request("POST", "/api/resolve-albums", { entries: ["Radiohead - OK Computer"] }),
      deps({ service: svc }),
    );
    expect(albums.body).toMatchObject({ resolvedAlbums: [{ versions: [{ id: "a", image }] }] });
  });

  it("reports albums whose tracks could not be fetched", async () => {
    const svc = service({
      getAlbumTracks: vi.fn(async (id: string) => {
        if (id === "bad") {
          throw new Error("album/get failed with HTTP 404");
        }
        return [{ id: 1, title: "One" }];
      }),
    });
    const res = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["a", "bad"] }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fetched: [{ albumId: "a", tracks: [{ track: { id: 1, title: "One" } }] }],
      failedAlbumIds: ["bad"],
    });
  });

  it("rejects an empty album id list", async () => {
    const res = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: [] }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deduplicate/scan", () => {
  const dupes: Track[] = [
    { id: 1, title: "Paranoid", artist: "Black Sabbath", isrc: "AAA", playlistTrackId: 11 },
    { id: 2, title: "Paranoid", artist: "Black Sabbath", isrc: "AAA", playlistTrackId: 12 },
    { id: 3, title: "Iron Man", artist: "Black Sabbath" },
  ];

  it("returns resolved duplicate groups for a playlist", async () => {
    const svc = service({ getPlaylistTracks: vi.fn(async () => dupes) });
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", {
        source: { type: "playlist", playlistId: 55 },
        keep: "first-added",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { groups: Array<{ tracks: Track[]; keepId: number }> };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.keepId).toBe(1);
    expect(body.groups[0]?.tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(svc.getPlaylistTracks).toHaveBeenCalledWith(55);
  });

  it("scans favourites when the source is favourites", async () => {
    const svc = service({ getFavoriteTracks: vi.fn(async () => dupes) });
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", {
        source: { type: "favourites" },
        keep: "first-added",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(svc.getFavoriteTracks).toHaveBeenCalledOnce();
  });

  it("enriches release dates for date-based strategies", async () => {
    const withAlbums: Track[] = [
      { id: 1, title: "Paranoid", artist: "Black Sabbath", isrc: "AAA", albumId: "a1" },
      { id: 2, title: "Paranoid", artist: "Black Sabbath", isrc: "AAA", albumId: "a2" },
    ];
    const dates: Record<string, string> = { a1: "1970-01-01", a2: "2000-01-01" };
    const svc = service({
      getPlaylistTracks: vi.fn(async () => withAlbums),
      getAlbumReleaseDate: vi.fn(async (id: string) => dates[id]),
    });
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", {
        source: { type: "playlist", playlistId: 1 },
        keep: "oldest",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { groups: Array<{ keepId: number }> };
    expect(body.groups[0]?.keepId).toBe(1); // a1 is older
    expect(svc.getAlbumReleaseDate).toHaveBeenCalled();
  });

  it("rejects an unknown keep strategy", async () => {
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", {
        source: { type: "favourites" },
        keep: "cheapest",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid source", async () => {
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", { source: { type: "album" }, keep: "first-added" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deduplicate/scan (extras)", () => {
  it("breaks ties with a keep chain (array or comma string)", async () => {
    const tracks: Track[] = [
      { id: 1, title: "Paranoid", artist: "Black Sabbath", bitDepth: 16, samplingRate: 44.1 },
      { id: 2, title: "Paranoid", artist: "Black Sabbath", bitDepth: 24, samplingRate: 96 },
      { id: 3, title: "Paranoid", artist: "Black Sabbath", bitDepth: 24, samplingRate: 96 },
    ];
    for (const keep of [["highest-quality", "last-added"], "highest-quality,last-added"]) {
      const svc = service({ getFavoriteTracks: vi.fn(async () => tracks) });
      const res = await handleApi(
        request("POST", "/api/deduplicate/scan", { source: { type: "favourites" }, keep }),
        deps({ service: svc }),
      );
      expect(res.status).toBe(200);
      expect((res.body as { groups: Array<{ keepId: number }> }).groups[0]?.keepId).toBe(3);
    }
  });

  it("rejects a chain with an unknown or no strategy", async () => {
    for (const keep of [["highest-quality", "cheapest"], [], "oldest,", 5]) {
      const res = await handleApi(
        request("POST", "/api/deduplicate/scan", { source: { type: "favourites" }, keep }),
        deps(),
      );
      expect(res.status).toBe(400);
    }
  });

  it("scans all playlists: duplicates within each, and songs across them", async () => {
    const svc = service({
      getUserPlaylists: vi.fn(async () => [
        { id: 1, name: "One" },
        { id: 2, name: "Two" },
      ]),
      getPlaylistTracks: vi.fn(async (id: number) => [
        { id: 7, title: "Iron Man", artist: "Black Sabbath", playlistTrackId: id * 10 },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/deduplicate/scan", { source: { type: "all-playlists" } }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      within: unknown[];
      across: Array<{ playlists: Array<{ playlist: { id: number } }> }>;
      playlistCount: number;
    };
    expect(body.within).toEqual([]);
    expect(body.playlistCount).toBe(2);
    expect(body.across[0]?.playlists.map((p) => p.playlist.id)).toEqual([1, 2]);
  });
});

describe("POST /api/deduplicate/apply (all playlists)", () => {
  it("removes entries from each playlist", async () => {
    const svc = service();
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "all-playlists" },
        removals: [
          { id: 7, playlistId: 1, playlistTrackId: 10 },
          { id: 7, playlistId: 2, playlistTrackId: 20 },
          { id: 8, playlistId: 1, playlistTrackId: 11 },
        ],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 3 });
    expect(svc.removeTracksFromPlaylist).toHaveBeenCalledWith(1, [10, 11]);
    expect(svc.removeTracksFromPlaylist).toHaveBeenCalledWith(2, [20]);
  });

  it("rejects a removal without its playlist", async () => {
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "all-playlists" },
        removals: [{ id: 7, playlistTrackId: 10 }],
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deduplicate/apply", () => {
  it("removes the given playlist-track ids from a playlist", async () => {
    const svc = service();
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "playlist", playlistId: 55 },
        removals: [
          { id: 2, playlistTrackId: 12 },
          { id: 3, playlistTrackId: 13 },
        ],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect(svc.removeTracksFromPlaylist).toHaveBeenCalledWith(55, [12, 13]);
  });

  it("removes favourite tracks by track id", async () => {
    const svc = service();
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "favourites" },
        removals: [{ id: 7 }, { id: 8 }],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect(svc.removeFavoriteTracks).toHaveBeenCalledWith([7, 8]);
  });

  it("rejects an empty removal list", async () => {
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "favourites" },
        removals: [],
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/upgrade/resolve", () => {
  const cdTrack: Track = {
    id: 1,
    title: "Teardrop",
    artist: "Massive Attack",
    isrc: "GBAAA9800001",
    streamable: true,
    bitDepth: 16,
    samplingRate: 44.1,
    playlistTrackId: 11,
  };
  const hires: Track = { ...cdTrack, id: 2, bitDepth: 24, samplingRate: 96 };

  it("returns a plan for a playlist", async () => {
    const svc = service({
      getPlaylistTracks: vi.fn(async () => [cdTrack]),
      searchTracks: vi.fn(async () => [hires]),
    });
    const res = await handleApi(
      request("POST", "/api/upgrade/resolve", { source: { type: "playlist", playlistId: 55 } }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ kind: string; replacementId?: number; location: unknown }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: "upgrade",
      replacementId: 2,
      location: { type: "playlist", playlistId: 55, playlistTrackId: 11 },
    });
    expect(svc.getPlaylistTracks).toHaveBeenCalledWith(55);
  });

  it("scans every playlist and passes the options through", async () => {
    const gone: Track = { ...cdTrack, streamable: false, isrc: "GONE" };
    const svc = service({
      getUserPlaylists: vi.fn(async () => [{ id: 1, name: "A" }]),
      getPlaylistTracks: vi.fn(async () => [gone]),
    });
    const res = await handleApi(
      request("POST", "/api/upgrade/resolve", {
        source: { type: "all-playlists" },
        allowSignatureMatch: true,
        removeUnplayable: true,
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ kind: string; action: string }> };
    expect(body.items[0]).toMatchObject({ kind: "unplayable", action: "remove" });
  });

  it("rejects an invalid source or option", async () => {
    for (const body of [
      {},
      { source: { type: "album" } },
      { source: { type: "playlist" } },
      { source: { type: "favourites" }, allowSignatureMatch: "yes" },
    ]) {
      const res = await handleApi(request("POST", "/api/upgrade/resolve", body), deps());
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/upgrade/commit", () => {
  it("writes favourite replacements and removals", async () => {
    const svc = service();
    const res = await handleApi(
      request("POST", "/api/upgrade/commit", {
        changes: [
          { action: "replace", location: { type: "favourites" }, trackId: 1, newTrackId: 2 },
          { action: "remove", location: { type: "favourites" }, trackId: 3 },
        ],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replaced: 1, removed: 1, failed: [], movedToEnd: 0 });
    expect(svc.addFavoriteTracks).toHaveBeenCalledWith([2]);
    expect(svc.removeFavoriteTracks).toHaveBeenCalledWith([1, 3]);
  });

  it("removes a playlist entry by its playlist-track id", async () => {
    const svc = service({
      getPlaylistTracks: vi.fn(async () => [{ id: 3, title: "T", playlistTrackId: 33 }]),
    });
    const res = await handleApi(
      request("POST", "/api/upgrade/commit", {
        changes: [
          {
            action: "remove",
            location: { type: "playlist", playlistId: 9, playlistTrackId: 33 },
            trackId: 3,
          },
        ],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(svc.removeTracksFromPlaylist).toHaveBeenCalledWith(9, [33]);
  });

  it("rejects an empty list or any malformed change", async () => {
    const fav = { type: "favourites" };
    for (const changes of [
      [],
      [{ action: "replace", location: fav, trackId: 1 }],
      [{ action: "replace", location: fav, trackId: 1, newTrackId: 1 }],
      [{ action: "remove", location: { type: "playlist", playlistId: 9 }, trackId: 1 }],
      [{ action: "leave", location: fav, trackId: 1 }],
      [{ action: "remove", location: fav, trackId: 1 }, "junk"],
    ]) {
      const res = await handleApi(request("POST", "/api/upgrade/commit", { changes }), deps());
      expect(res.status).toBe(400);
    }
  });
});

describe("error handling", () => {
  it("maps a QobuzError to 502", async () => {
    const svc = service({
      getUserPlaylists: vi.fn(async () => {
        throw new QobuzError("api-response", "HTTP 503");
      }),
    });
    const res = await handleApi(request("GET", "/api/playlists"), deps({ service: svc }));
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "HTTP 503" });
  });

  it("returns 404 for an unknown route", async () => {
    const res = await handleApi(request("GET", "/api/nope"), deps());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/export", () => {
  it("exports favourite tracks as CSV with a filename", async () => {
    const svc = service({
      getFavoriteTracks: vi.fn(async () => [
        { id: 1, title: "Roads", artist: "Portishead" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/export", {
        source: { type: "favourite-tracks" },
        format: "csv",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ filename: "qobuz-favourite-tracks.csv" });
    expect((res.body as { content: string }).content).toContain("Roads");
  });

  it("exports a playlist to M3U", async () => {
    const svc = service({
      getPlaylistTracks: vi.fn(async () => [{ id: 9, title: "T", artist: "A" }]),
    });
    const res = await handleApi(
      request("POST", "/api/export", {
        source: { type: "playlist", playlistId: 7 },
        format: "m3u",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { content: string }).content).toContain("qobuz://track/9");
    expect(res.body).toMatchObject({ filename: "qobuz-playlist-7.m3u" });
  });

  it("rejects M3U for a non-track collection", async () => {
    const res = await handleApi(
      request("POST", "/api/export", {
        source: { type: "favourite-albums" },
        format: "m3u",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("exports the whole account as a JSON backup", async () => {
    const svc = service({
      getFavoriteTracks: vi.fn(async () => [{ id: 1, title: "R" }]),
      getUserPlaylists: vi.fn(async () => [{ id: 3, name: "P" }]),
    });
    const res = await handleApi(
      request("POST", "/api/export", { source: { type: "account" } }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { filename: string; content: string };
    expect(body.filename).toMatch(/^qobuz-backup-\d{4}-\d\d-\d\d\.json$/);
    expect(JSON.parse(body.content)).toMatchObject({ formatVersion: 1 });
  });

  it("rejects an unknown source type", async () => {
    const res = await handleApi(
      request("POST", "/api/export", { source: { type: "nope" }, format: "csv" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("exports every playlist as one zip download, a file per playlist", async () => {
    const svc = service({
      getUserPlaylists: vi.fn(async () => [
        { id: 3, name: "Chill/Out" },
        { id: 4, name: "chill/out" },
      ]),
      getPlaylistTracks: vi.fn(async (id: number) => [
        { id: id * 10, title: "T", artist: "A" },
      ]),
    });
    const res = await handleApi(
      request("POST", "/api/export", { source: { type: "all-playlists" }, format: "m3u" }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.file?.contentType).toBe("application/zip");
    expect(res.file?.filename).toMatch(/^qobuz-playlists-\d{4}-\d\d-\d\d\.zip$/);
    const bytes = res.file!.bytes;
    // A zip starts with a local file header and names each playlist's file.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain("Chill_Out.m3u");
    expect(raw).toContain("chill_out (2).m3u");
  });

  it("requires a valid format for every-playlist exports", async () => {
    const res = await handleApi(
      request("POST", "/api/export", { source: { type: "all-playlists" }, format: "xml" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/import/resolve", () => {
  it("resolves text tracks to a plan by search", async () => {
    const svc = service({
      searchTracks: vi.fn(async () => [{ id: 1, title: "Roads", artist: "Portishead" }]),
    });
    const res = await handleApi(
      request("POST", "/api/import/resolve", {
        format: "text",
        kind: "tracks",
        content: "Portishead - Roads\nNobody - Nothing",
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "tracks",
      matched: [{ label: "Portishead - Roads", id: 1 }],
    });
  });

  it("reads an Exportify CSV as a Spotify export, matching by ISRC", async () => {
    const searchTracks = vi.fn(async (query: string) =>
      query === "GBAAA0000001"
        ? [{ id: 1, title: "Roads", artist: "Portishead", isrc: "GBAAA0000001" }]
        : [],
    );
    const res = await handleApi(
      request("POST", "/api/import/resolve", {
        format: "csv",
        kind: "tracks",
        content: "Track Name,Artist Name(s),Album Name,ISRC\nRoads,Portishead,Dummy,GBAAA0000001\n",
      }),
      deps({ service: service({ searchTracks }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      format: "spotify",
      matched: [{ label: "Portishead - Roads", id: 1, via: "isrc" }],
    });
  });

  it("refuses a Spotify export for album favourites", async () => {
    const res = await handleApi(
      request("POST", "/api/import/resolve", {
        format: "spotify",
        kind: "albums",
        content: "Track Name,Artist Name(s)\nRoads,Portishead\n",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/tracks/) });
  });

  it("rejects an unknown format", async () => {
    const res = await handleApi(
      request("POST", "/api/import/resolve", {
        format: "xml",
        kind: "tracks",
        content: "x",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON content with 400", async () => {
    const res = await handleApi(
      request("POST", "/api/import/resolve", {
        format: "json",
        kind: "tracks",
        content: "not json",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/import/commit", () => {
  it("adds matched tracks to favourites", async () => {
    const addFavoriteTracks = vi.fn(async () => {});
    const res = await handleApi(
      request("POST", "/api/import/commit", {
        plan: { kind: "tracks", matched: [{ label: "a", id: 1 }, { label: "b", id: 2 }] },
        target: { type: "favourites" },
      }),
      deps({ service: service({ addFavoriteTracks }) }),
    );
    expect(res.status).toBe(200);
    expect(addFavoriteTracks).toHaveBeenCalledWith([1, 2]);
    expect(res.body).toMatchObject({ written: 2 });
  });

  it("rejects putting an album plan into a playlist with 400", async () => {
    const res = await handleApi(
      request("POST", "/api/import/commit", {
        plan: { kind: "albums", matched: [{ label: "a", id: "x" }] },
        target: { type: "playlist-new", name: "P" },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty plan", async () => {
    const res = await handleApi(
      request("POST", "/api/import/commit", {
        plan: { kind: "tracks", matched: [] },
        target: { type: "favourites" },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/restore", () => {
  it("restores a backup document", async () => {
    const addFavoriteTracks = vi.fn(async () => {});
    const createPlaylist = vi.fn(async (name: string) => ({ id: 5, name }));
    const backup = {
      formatVersion: 1,
      exportedAt: "2026-07-07T00:00:00.000Z",
      favourites: {
        tracks: [{ id: 1, title: "a" }],
        albums: [],
        artists: [],
      },
      playlists: [{ name: "P", tracks: [{ id: 9, title: "c" }] }],
    };
    const res = await handleApi(
      request("POST", "/api/restore", { content: JSON.stringify(backup) }),
      deps({ service: service({ addFavoriteTracks, createPlaylist }) }),
    );
    expect(res.status).toBe(200);
    expect(addFavoriteTracks).toHaveBeenCalledWith([1]);
    expect(createPlaylist).toHaveBeenCalledWith("P", { isPublic: false });
    expect(res.body).toMatchObject({ favouriteTracks: 1 });
  });

  it("rejects content that is not a backup", async () => {
    const res = await handleApi(
      request("POST", "/api/restore", { content: '{"tracks":[]}' }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/combine/resolve", () => {
  const roads = { id: 1, title: "Roads", artist: "Portishead" };
  const glory = { id: 2, title: "Glory Box", artist: "Portishead" };
  const angel = { id: 3, title: "Angel", artist: "Massive Attack" };

  function combineService() {
    return service({
      getUserPlaylists: vi.fn(async () => [{ id: 7, name: "Road Trip" }]),
      getPlaylistTracks: vi.fn(async () => [roads, glory]),
      getFavoriteTracks: vi.fn(async () => [glory, angel]),
    });
  }

  it("returns the plan for the chosen sources and mode", async () => {
    const res = await handleApi(
      request("POST", "/api/combine/resolve", {
        sources: [{ type: "playlist", playlistId: 7 }, { type: "favourites" }],
        mode: "common",
      }),
      deps({ service: combineService() }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      labels: ["Road Trip", "Favourites"],
      tracks: [{ track: glory, inputs: [0, 1] }],
      counts: { onlyIn: [1, 1], shared: 1, result: 1 },
      suggestedName: "Road Trip + Favourites",
    });
  });

  it("merges by default, in input order", async () => {
    const res = await handleApi(
      request("POST", "/api/combine/resolve", {
        sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }],
      }),
      deps({ service: combineService() }),
    );
    const body = res.body as { tracks: { track: { id: number } }[] };
    expect(body.tracks.map((t) => t.track.id)).toEqual([2, 3, 1]);
  });

  it("shuffles reproducibly with a seed", async () => {
    const body = {
      sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }],
      order: "shuffle",
      seed: 123,
    };
    const first = await handleApi(request("POST", "/api/combine/resolve", body), deps({ service: combineService() }));
    const second = await handleApi(request("POST", "/api/combine/resolve", body), deps({ service: combineService() }));
    expect(first.body).toEqual(second.body);
  });

  it.each([
    [{ sources: [{ type: "favourites" }] }, /at least two/],
    [{ sources: [{ type: "favourites" }, { type: "favourites" }] }, /only once/],
    [{ sources: [{ type: "playlist" }, { type: "favourites" }] }, /each source/],
    [{ sources: "x" }, /sources must be an array/],
    [{ sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }], mode: "x" }, /mode/],
    [{ sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }], order: 1 }, /order/],
    [{ sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }], keep: "x" }, /keep/],
    [{ sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }], matchSongs: "no" }, /matchSongs/],
    [{ sources: [{ type: "favourites" }, { type: "playlist", playlistId: 7 }], seed: 1.5 }, /seed/],
  ])("rejects invalid input %#", async (body, error) => {
    const res = await handleApi(request("POST", "/api/combine/resolve", body), deps());
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(error);
  });
});

describe("POST /api/stats", () => {
  const tracks = [
    { id: 1, title: "Roads", artist: "Portishead", releaseDate: "1994-08-22", duration: 300 },
    { id: 2, title: "Angel", artist: "Massive Attack", releaseDate: "1998-04-20", bitDepth: 24, samplingRate: 96 },
  ];

  it("returns the stats of favourites, with each bucket's track ids", async () => {
    const res = await handleApi(
      request("POST", "/api/stats", { source: { type: "favourites" } }),
      deps({ service: service({ getFavoriteTracks: vi.fn(async () => tracks) }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      label: "Favourites",
      trackCount: 2,
      artistCount: 2,
      quality: { hires: 1, cd: 0, unknown: 1 },
      decades: [{ key: "1990s", count: 2, trackIds: [1, 2], suggestedName: "Favourites: 1990s" }],
      headline: "2 favourite tracks by 2 artists. 5 minutes of music.",
    });
  });

  it("reads a playlist under its name", async () => {
    const getPlaylistTracks = vi.fn(async () => tracks);
    const res = await handleApi(
      request("POST", "/api/stats", { source: { type: "playlist", playlistId: 7 } }),
      deps({
        service: service({
          getPlaylistTracks,
          getUserPlaylists: vi.fn(async () => [{ id: 7, name: "Road Trip" }]),
        }),
      }),
    );
    expect(getPlaylistTracks).toHaveBeenCalledWith(7);
    expect(res.body).toMatchObject({ label: "Road Trip", trackCount: 2 });
  });

  it("reads everything, each track once", async () => {
    const res = await handleApi(
      request("POST", "/api/stats", { source: { type: "everything" } }),
      deps({
        service: service({
          getFavoriteTracks: vi.fn(async () => tracks),
          getUserPlaylists: vi.fn(async () => [{ id: 7, name: "Road Trip" }]),
          getPlaylistTracks: vi.fn(async () => [tracks[0]!, { id: 3, title: "New" }]),
        }),
      }),
    );
    expect(res.body).toMatchObject({ label: "Library", trackCount: 3 });
  });

  it.each([undefined, {}, { source: { type: "albums" } }, { source: { type: "playlist" } }])(
    "rejects an invalid source %#",
    async (body) => {
      const res = await handleApi(request("POST", "/api/stats", body), deps());
      expect(res.status).toBe(400);
    },
  );
});

describe("POST /api/word-play/resolve", () => {
  it("splits a sentence into song titles", async () => {
    const titles: Record<string, Track> = {
      lazy: { id: 1, title: "Lazy", artist: "Deep Purple" },
      dog: { id: 2, title: "Dog.", artist: "Band" },
    };
    const searchTracks = vi.fn(async (query: string) => {
      const hit = titles[query];
      return hit === undefined ? [] : [hit];
    });
    const res = await handleApi(
      request("POST", "/api/word-play/resolve", {
        mode: "sentence",
        text: "lazy dog",
        split: "words",
      }),
      deps({ service: service({ searchTracks }) }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      splits: { slots: { label: string; chosen?: { track: Track } }[] }[];
      suggestedName: string;
    };
    expect(body.splits[0]!.slots.map((s) => [s.label, s.chosen?.track.id])).toEqual([
      ["lazy", 1],
      ["dog", 2],
    ]);
    expect(body.suggestedName).toBe("Lazy Dog");
  });

  it("passes the match options and filter through", async () => {
    const searchTracks = vi.fn(async () => [
      { id: 1, title: "Jump", artist: "Van Halen" },
      { id: 2, title: "Jump", artist: "Kris Kross" },
    ]);
    const res = await handleApi(
      request("POST", "/api/word-play/resolve", {
        mode: "exact",
        text: "jumped",
        match: { closeForms: true },
        filter: { excludeArtists: ["Van Halen"] },
      }),
      deps({ service: service({ searchTracks }) }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      splits: { slots: { chosen?: { track: Track; closeForm: boolean } }[] }[];
      excludedCount: number;
    };
    expect(body.splits[0]!.slots.map((s) => s.chosen?.track.id)).toEqual([2]);
    expect(body.splits[0]!.slots[0]!.chosen?.closeForm).toBe(true);
    expect(body.excludedCount).toBe(1);
  });

  it("reads an acrostic's source playlist", async () => {
    const getPlaylistTracks = vi.fn(async () => [{ id: 7, title: "Hello", artist: "Adele" }]);
    const res = await handleApi(
      request("POST", "/api/word-play/resolve", {
        mode: "acrostic",
        text: "hi",
        source: { type: "playlist", playlistId: 42 },
      }),
      deps({ service: service({ getPlaylistTracks }) }),
    );
    expect(res.status).toBe(200);
    expect(getPlaylistTracks).toHaveBeenCalledWith(42);
    expect((res.body as { splits: { unmatched: string[] }[] }).splits[0]!.unmatched).toEqual([
      "I",
    ]);
  });

  it.each([
    [{ mode: "riddle", text: "x" }, /mode/],
    [{ mode: "sentence" }, /sentence is required/],
    [{ mode: "contains", text: "x", count: 0 }, /count/],
    [{ mode: "sentence", text: "x", split: "longest" }, /split/],
    [{ mode: "sentence", text: "x", maxSpan: 99 }, /maxSpan/],
    [{ mode: "a-to-z" }, /source/],
    [{ mode: "acrostic", text: "x", source: { type: "playlist", playlistId: -1 } }, /playlistId/],
    [{ mode: "exact", text: "x", match: { closeForms: "yes" } }, /closeForms/],
    [{ mode: "exact", text: "x", filter: { excludeTracks: "live" } }, /filter/],
    [{ mode: "acrostic", text: "--", source: { type: "favourites" } }, /word/],
    [{ mode: "sentence", text: Array.from({ length: 31 }, () => "la").join(" ") }, /at most 30/],
  ])("rejects %j", async (body, error) => {
    const res = await handleApi(request("POST", "/api/word-play/resolve", body), deps());
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(error);
  });

  it("maps a Qobuz failure to 502", async () => {
    const searchTracks = vi.fn(async () => {
      throw new QobuzError("api-response", "boom");
    });
    const res = await handleApi(
      request("POST", "/api/word-play/resolve", { mode: "exact", text: "home" }),
      deps({ service: service({ searchTracks }) }),
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /api/word-play/commit", () => {
  it("creates a playlist with the songs in order", async () => {
    const createPlaylist = vi.fn(async (name: string) => ({ id: 3, name }));
    const addTracksToPlaylist = vi.fn(async () => {});
    const res = await handleApi(
      request("POST", "/api/word-play/commit", {
        target: { type: "new", name: "Lazy Dog" },
        trackIds: [2, 1, 2],
      }),
      deps({ service: service({ createPlaylist, addTracksToPlaylist }) }),
    );
    expect(res.status).toBe(200);
    expect(addTracksToPlaylist).toHaveBeenCalledWith(3, [2, 1]);
    expect(res.body).toMatchObject({ playlistId: 3, added: [2, 1], skipped: [2] });
  });

  it("adds to an existing playlist", async () => {
    const addTracksToPlaylist = vi.fn(async () => {});
    const res = await handleApi(
      request("POST", "/api/word-play/commit", {
        target: { type: "existing", playlistId: 8 },
        trackIds: [5],
      }),
      deps({ service: service({ addTracksToPlaylist }) }),
    );
    expect(res.status).toBe(200);
    expect(addTracksToPlaylist).toHaveBeenCalledWith(8, [5]);
  });

  it("rejects a commit without tracks or a name", async () => {
    const noTracks = await handleApi(
      request("POST", "/api/word-play/commit", { target: { type: "new", name: "x" }, trackIds: [] }),
      deps(),
    );
    expect(noTracks.status).toBe(400);
    const noName = await handleApi(
      request("POST", "/api/word-play/commit", { target: { type: "new" }, trackIds: [1] }),
      deps(),
    );
    expect(noName.status).toBe(400);
  });
});

describe("POST /api/resolve-discography", () => {
  const releases: Release[] = [
    { id: "d25", title: "Dummy (Deluxe)", artist: "Portishead", artistId: 42, releaseType: "album", releaseDate: "2019-01-01" },
    { id: "live", title: "Roseland NYC Live", artist: "Portishead", artistId: 42, releaseType: "live", releaseDate: "1998-11-02" },
    { id: "d", title: "Dummy", artist: "Portishead", artistId: 42, releaseType: "album", releaseDate: "1994-08-22" },
  ];
  const svc = () =>
    service({
      searchArtists: vi.fn(async () => [{ id: 42, name: "Portishead" }]),
      getArtistReleases: vi.fn(async () => ({ releases, truncated: false })),
    });

  it("resolves an artist's studio albums into album groups, editions together", async () => {
    const res = await handleApi(
      request("POST", "/api/resolve-discography", { artist: "Portishead" }),
      deps({ service: svc() }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artist: { id: 42, name: "Portishead" },
      resolvedAlbums: [{ query: "Portishead - Dummy", versions: [{ id: "d" }, { id: "d25" }] }],
      unresolvedAlbums: [],
      excludedAlbums: [],
      truncated: false,
    });
  });

  it("takes the kinds to include and every version on request", async () => {
    const res = await handleApi(
      request("POST", "/api/resolve-discography", {
        artist: "Portishead",
        include: ["album", "live"],
        oneVersion: false,
      }),
      deps({ service: svc() }),
    );
    const body = res.body as { resolvedAlbums: { versions: { id: string }[] }[] };
    expect(body.resolvedAlbums.map((album) => album.versions[0]?.id)).toEqual(["d", "live", "d25"]);
  });

  it("validates its input", async () => {
    for (const body of [
      {},
      { artist: "  " },
      { artist: "A", include: [] },
      { artist: "A", include: ["bootleg"] },
      { artist: "A", oneVersion: "yes" },
      { artist: "A", filter: { excludeAlbums: ["/(/"] } },
    ]) {
      const res = await handleApi(request("POST", "/api/resolve-discography", body), deps());
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/new-releases", () => {
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  const svc = () =>
    service({
      getFavoriteArtists: vi.fn(async () => [{ id: 1, name: "Tricky" }]),
      getArtistReleases: vi.fn(async () => ({
        releases: [
          { id: "ep", title: "Hell EP", artist: "Tricky", artistId: 1, releaseType: "ep-single", releaseDate: recent },
          { id: "live", title: "Live", artist: "Tricky", artistId: 1, releaseType: "live", releaseDate: recent },
          { id: "old", title: "Maxinquaye", artist: "Tricky", artistId: 1, releaseType: "album", releaseDate: "1995-02-20" },
        ] as Release[],
        truncated: false,
      })),
    });

  it("finds the recent releases of favourite artists (default window and kinds)", async () => {
    const res = await handleApi(
      request("POST", "/api/new-releases", { source: { type: "favourites" } }),
      deps({ service: svc() }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      releases: [{ id: "ep" }],
      checkedArtists: 1,
      capped: false,
      hidden: { favourites: 0, reissues: 0 },
    });
  });

  it("takes a playlist source, a start date and kinds", async () => {
    const service_ = svc();
    service_.getPlaylistTracks = vi.fn(async () => [
      { id: 5, title: "x", artistId: 1, artist: "Tricky" },
    ]);
    const res = await handleApi(
      request("POST", "/api/new-releases", {
        source: { type: "playlist", playlistId: 9 },
        since: "1990-01-01",
        include: ["album", "live"],
      }),
      deps({ service: service_ }),
    );
    const body = res.body as { releases: { id: string }[]; since: string };
    expect(body.since).toBe("1990-01-01");
    expect(body.releases.map((r) => r.id)).toEqual(["live", "old"]);
    expect(service_.getPlaylistTracks).toHaveBeenCalledWith(9);
  });

  it("validates its input", async () => {
    for (const body of [
      {},
      { source: { type: "radio" } },
      { source: { type: "playlist", playlistId: -1 } },
      { source: { type: "favourites" }, since: "last week" },
      { source: { type: "favourites" }, include: ["bootleg"] },
      { source: { type: "favourites" }, filter: { excludeArtists: "Drake" } },
    ]) {
      const res = await handleApi(request("POST", "/api/new-releases", body), deps());
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/new-releases/commit", () => {
  it("creates a playlist of the releases' tracks", async () => {
    const addTracksToPlaylist = vi.fn(async () => {});
    const svc = service({
      getAlbumTracks: vi.fn(async (id: string) => [{ id: id === "a" ? 1 : 2, title: id }]),
      addTracksToPlaylist,
    });
    const res = await handleApi(
      request("POST", "/api/new-releases/commit", {
        albumIds: ["b", "a"],
        target: { type: "playlist", name: "Fresh" },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "playlist", trackCount: 2, failedAlbumIds: [] });
    expect(addTracksToPlaylist).toHaveBeenCalledWith(1, [2, 1]);
  });

  it("adds the releases to favourite albums", async () => {
    const addFavoriteAlbums = vi.fn(async () => {});
    const res = await handleApi(
      request("POST", "/api/new-releases/commit", {
        albumIds: ["a"],
        target: { type: "favourite-albums" },
      }),
      deps({ service: service({ addFavoriteAlbums }) }),
    );
    expect(res.body).toEqual({ type: "favourite-albums", added: 1 });
    expect(addFavoriteAlbums).toHaveBeenCalledWith(["a"]);
  });

  it("validates its input", async () => {
    for (const body of [
      { target: { type: "favourite-albums" } },
      { albumIds: [], target: { type: "favourite-albums" } },
      { albumIds: [5], target: { type: "favourite-albums" } },
      { albumIds: ["a"] },
      { albumIds: ["a"], target: { type: "playlist", name: " " } },
      { albumIds: ["a"], target: { type: "playlist", name: "x", isPublic: "no" } },
      { albumIds: ["a"], target: { type: "elsewhere" } },
    ]) {
      const res = await handleApi(request("POST", "/api/new-releases/commit", body), deps());
      expect(res.status).toBe(400);
    }
  });
});

describe("playlist plan options", () => {
  const fav: Track = { id: 100, title: "Roads", artist: "Portishead" };

  it("skips favourites and repeats when resolving artists, fetching favourites once", async () => {
    const svc = service({
      searchArtists: vi.fn(async (q: string) => [{ id: q === "A" ? 1 : 2, name: q }]),
      getArtistTopTracks: vi.fn(async (id: number) =>
        id === 1
          ? [fav, { id: 101, title: "Glory Box", artist: "Portishead", isrc: "G" }]
          : [
              { id: 201, title: "Glory Box (Live)", artist: "Other", isrc: "G" },
              { id: 202, title: "Teardrop", artist: "Other" },
            ],
      ),
      getFavoriteTracks: vi.fn(async () => [fav]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", {
        artists: ["A", "B"],
        tracksPerArtist: 1,
        skipFavourites: true,
        oneCopy: true,
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      resolvedArtists: Array<{ tracks: Track[]; excluded: Array<{ exclusion: unknown }> }>;
    };
    expect(body.resolvedArtists.map((r) => r.tracks.map((t) => t.id))).toEqual([[101], [202]]);
    expect(body.resolvedArtists.map((r) => r.excluded.map((e) => e.exclusion))).toEqual([
      [{ kind: "favourite" }],
      [{ kind: "repeat", of: "Glory Box" }],
    ]);
    expect(svc.getFavoriteTracks).toHaveBeenCalledTimes(1);
  });

  it("does not fetch favourites unless asked", async () => {
    const svc = similarService();
    await handleApi(request("POST", "/api/resolve", { artists: ["A"] }), deps({ service: svc }));
    expect(svc.getFavoriteTracks).not.toHaveBeenCalled();
  });

  it("returns the picker from a similar walk and carries it through track batches", async () => {
    const svc = similarService();
    svc.getFavoriteTracks = vi.fn(async () => [{ id: 1100, title: "t0" }]);
    svc.getFavoriteArtists = vi.fn(async () => [{ id: 11, name: "Mudhoney" }]);
    const walk = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "artists", artists: ["Nirvana"], tracksPerSeed: 1 },
        similarPerArtist: 1,
        replaceRepeats: true,
        skipFavourites: true,
        oneCopy: true,
        skipFavouriteArtists: true,
      }),
      deps({ service: svc }),
    );
    expect(walk.status).toBe(200);
    const walked = walk.body as { found: Array<{ artist: Artist }>; picker: unknown };
    // Mudhoney is a favourite artist, so Hole takes its place.
    expect(walked.found.map((f) => f.artist.id)).toEqual([12]);
    expect(walked.picker).toMatchObject({ oneCopy: true });

    const batch = await handleApi(
      request("POST", "/api/similar/tracks", {
        artists: [{ id: 11, name: "Mudhoney" }],
        tracksPerSimilar: 1,
        picker: walked.picker,
      }),
      deps({ service: svc }),
    );
    expect(batch.status).toBe(200);
    const fetched = batch.body as {
      fetched: Array<{ tracks: Track[]; excluded: Array<{ exclusion: unknown }> }>;
      picker: { seen: unknown[] };
    };
    // 1100 is a favourite (from the walk's state), so 1101 replaces it.
    expect(fetched.fetched[0]?.tracks.map((t) => t.id)).toEqual([1101]);
    expect(fetched.fetched[0]?.excluded.map((e) => e.exclusion)).toEqual([{ kind: "favourite" }]);
    expect(fetched.picker.seen.length).toBeGreaterThan(0);
    // Favourites were fetched once, by the walk.
    expect(svc.getFavoriteTracks).toHaveBeenCalledTimes(1);
  });

  it("marks favourites and repeats in album tracks and returns the picker", async () => {
    const svc = service({
      getAlbumTracks: vi.fn(async (id: string) =>
        id === "a"
          ? [fav, { id: 2, title: "Song", artist: "X" }]
          : [{ id: 3, title: "Song", artist: "X" }],
      ),
      getFavoriteTracks: vi.fn(async () => [fav]),
    });
    const res = await handleApi(
      request("POST", "/api/album-tracks", {
        albumIds: ["a", "b"],
        skipFavourites: true,
        oneCopy: true,
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      fetched: Array<{ tracks: Array<{ exclusion?: unknown }> }>;
      picker: unknown;
    };
    expect(body.fetched.map((f) => f.tracks.map((t) => t.exclusion))).toEqual([
      [{ kind: "favourite" }, undefined],
      [{ kind: "repeat", of: "Song" }],
    ]);

    // A retry carries the picker on: "Song" is still a repeat.
    const retry = await handleApi(
      request("POST", "/api/album-tracks", { albumIds: ["b"], picker: body.picker }),
      deps({ service: svc }),
    );
    const retried = retry.body as { fetched: Array<{ tracks: Array<{ exclusion?: unknown }> }> };
    expect(retried.fetched[0]?.tracks[0]?.exclusion).toEqual({ kind: "repeat", of: "Song" });
    expect(svc.getFavoriteTracks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/api/resolve", { artists: ["A"], skipFavourites: "yes" }],
    ["/api/resolve", { artists: ["A"], oneCopy: 1 }],
    ["/api/album-tracks", { albumIds: ["a"], picker: { oneCopy: "no" } }],
    ["/api/similar/tracks", { artists: [{ id: 1, name: "A" }], picker: [] }],
    [
      "/api/similar/walk",
      { source: { type: "artists", artists: ["A"] }, skipFavouriteArtists: "on" },
    ],
  ])("rejects malformed plan options on %s", async (path, body) => {
    const res = await handleApi(request("POST", path, body), deps());
    expect(res.status).toBe(400);
  });
});

describe("Qobuz links in lists", () => {
  it("resolves an artist link by id and reports a link of another kind", async () => {
    const svc = service({
      getArtist: vi.fn(async (id: number) => ({ id, name: "Portishead" })),
      getArtistTopTracks: vi.fn(async () => [{ id: 1, title: "Roads" }]),
    });
    const res = await handleApi(
      request("POST", "/api/resolve", {
        artists: ["https://play.qobuz.com/artist/41259", "https://play.qobuz.com/playlist/5"],
        tracksPerArtist: 1,
      }),
      deps({ service: svc }),
    );
    const body = res.body as {
      resolvedArtists: Array<{ artist: Artist; fromLink?: boolean }>;
      unresolvedArtists: string[];
    };
    expect(body.resolvedArtists.map((r) => [r.artist.name, r.fromLink])).toEqual([
      ["Portishead", true],
    ]);
    expect(body.unresolvedArtists).toEqual([
      "https://play.qobuz.com/playlist/5 (a playlist link, not an artist)",
    ]);
    expect(svc.searchArtists).not.toHaveBeenCalled();
  });

  it("resolves album links by id alongside 'Artist - Album' lines", async () => {
    const svc = service({
      getAlbum: vi.fn(async (id: string) => ({ id, title: "Mezzanine", artist: "Massive Attack" })),
    });
    const res = await handleApi(
      request("POST", "/api/resolve-albums", {
        entries: [
          "https://www.qobuz.com/gb-en/album/mezzanine-massive-attack/pvsb64n704d0b",
          "https://play.qobuz.com/artist/41259",
        ],
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      resolvedAlbums: Array<{ query: string; versions: Album[] }>;
      unresolvedAlbums: string[];
    };
    expect(body.resolvedAlbums.map((r) => [r.query, r.versions.map((v) => v.id)])).toEqual([
      ["Massive Attack - Mezzanine", ["pvsb64n704d0b"]],
    ]);
    expect(body.unresolvedAlbums).toEqual([
      "https://play.qobuz.com/artist/41259 (an artist link, not an album)",
    ]);
  });

  it("walks similar artists from a pasted playlist link", async () => {
    const svc = similarService();
    const res = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "playlist", playlistId: "https://play.qobuz.com/playlist/777" },
      }),
      deps({ service: svc }),
    );
    expect(res.status).toBe(200);
    expect(svc.getPlaylistTracks).toHaveBeenCalledWith(777);

    const bad = await handleApi(
      request("POST", "/api/similar/walk", {
        source: { type: "playlist", playlistId: "https://play.qobuz.com/album/x" },
      }),
      deps({ service: svc }),
    );
    expect(bad.status).toBe(400);
  });
});

/** A web journal over an in-memory account, as `qobuz-helper ui` wires it. */
function historyDeps() {
  const store = new MemoryStore();
  let n = 0;
  let minute = 0;
  const journal = new Journal({
    store,
    source: "web",
    now: () => new Date(Date.UTC(2026, 10, 2, 20, minute++)),
    newId: () => `w${++n}`,
  });
  const account = new FakeAccount();
  const svc = service({
    createPlaylist: (name, options) => account.createPlaylist(name, options),
    getPlaylistTracks: (id) => account.getPlaylistTracks(id),
    addTracksToPlaylist: (id, ids) => account.addTracksToPlaylist(id, ids),
    removeTracksFromPlaylist: (id, ids) => account.removeTracksFromPlaylist(id, ids),
    deletePlaylist: (id) => account.deletePlaylist(id),
    addFavoriteTracks: (ids) => account.addFavoriteTracks(ids),
    removeFavoriteTracks: (ids) => account.removeFavoriteTracks(ids),
  });
  return {
    journal,
    account,
    deps: deps({ service: recordingClient(svc, journal), history: { journal } }),
  };
}

describe("history of web commits", () => {
  it("records each write route as one entry named after its tool", async () => {
    const { journal, account, deps: d } = historyDeps();
    account.favourites.tracks = [1, 2];
    const res = await handleApi(
      request("POST", "/api/deduplicate/apply", {
        source: { type: "favourites" },
        removals: [{ id: 2 }],
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(journal.items()).toEqual([
      expect.objectContaining({
        tool: "deduplicate",
        source: "web",
        label: "Removed 1 duplicate from Favourites",
      }),
    ]);
  });

  it("names a playlist commit after the tool that sent it", async () => {
    const { journal, deps: d } = historyDeps();
    const res = await handleApi(
      request("POST", "/api/commit", {
        tool: "combine",
        target: { type: "new", name: "A + B" },
        trackIds: [5, 6],
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(journal.items()[0]).toMatchObject({ tool: "combine", label: "Created A + B with 2 tracks" });
  });

  it("rejects an unknown tool name", async () => {
    const res = await handleApi(
      request("POST", "/api/commit", {
        tool: "rm -rf",
        target: { type: "new", name: "x" },
        trackIds: [5],
      }),
      historyDeps().deps,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/history", () => {
  it("is not found without a history", async () => {
    const res = await handleApi(request("GET", "/api/history"), deps());
    expect(res.status).toBe(404);
  });

  it("lists entries newest first, as summaries", async () => {
    const { journal, deps: d } = historyDeps();
    journal.record({ kind: "add-favourites", type: "tracks", ids: [1, 2] });
    journal.record({ kind: "remove-favourites", type: "tracks", ids: [3] });
    const res = await handleApi(request("GET", "/api/history"), d);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entries: [
        {
          id: "w2",
          at: "2026-11-02T20:01:00.000Z",
          tool: "other",
          toolName: "Other",
          source: "web",
          label: "Removed 1 track from Favourites",
          added: 0,
          removed: 1,
        },
        expect.objectContaining({ id: "w1", added: 2, removed: 0 }),
      ],
    });
  });
});

describe("POST /api/history/plan and /api/history/undo", () => {
  async function created() {
    const h = historyDeps();
    await handleApi(
      request("POST", "/api/commit", {
        tool: "playlist-from-artists",
        target: { type: "new", name: "Road Trip" },
        trackIds: [5, 6],
      }),
      h.deps,
    );
    return { ...h, id: h.journal.items()[0]!.id };
  }

  it("shows what undoing would reverse, changing nothing", async () => {
    const { account, deps: d, id } = await created();
    const res = await handleApi(request("POST", "/api/history/plan", { id }), d);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entry: expect.objectContaining({ id, label: "Created Road Trip with 2 tracks" }),
      steps: ["Delete the playlist Road Trip (2 tracks)"],
      notes: [],
      warnings: [],
    });
    expect(account.playlists.size).toBe(1);
  });

  it("undoes an entry, records the undo, and refuses to undo it twice", async () => {
    const { journal, account, deps: d, id } = await created();
    const res = await handleApi(request("POST", "/api/history/undo", { id }), d);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entryId: expect.any(String),
      undone: true,
      done: ["Delete the playlist Road Trip (2 tracks)"],
      failed: [],
      notes: [],
    });
    expect(account.playlists.size).toBe(0);
    expect(journal.items()[0]).toMatchObject({ tool: "undo", source: "web", undoes: id });

    const again = await handleApi(request("POST", "/api/history/undo", { id }), d);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: expect.stringMatching(/^Already undone/) });
  });

  it("validates the id", async () => {
    const { deps: d } = historyDeps();
    expect((await handleApi(request("POST", "/api/history/plan", {}), d)).status).toBe(400);
    expect((await handleApi(request("POST", "/api/history/plan", { id: "nope" }), d)).status).toBe(404);
    expect((await handleApi(request("POST", "/api/history/undo", { id: 7 }), d)).status).toBe(400);
  });
});

describe("job routes", () => {
  const input = {
    name: "Fresh",
    kind: "playlist",
    schedule: { every: "day" },
    target: { type: "created" },
    source: {
      type: "new-releases",
      artists: { type: "list", artists: [{ id: 1, name: "Air" }] },
      window: { type: "last-days", days: 30 },
    },
  };
  const summary = { status: "ran" as const, reports: [], invalid: [] };
  const preview = { createsPlaylist: true, add: [], remove: [], newlyDismissed: [], withheldRemovals: 0, complete: true, notes: [], findings: [] };

  function jobDeps(overrides: Partial<NonNullable<ApiDeps["jobs"]>> = {}) {
    let file: JobsFile = { version: 2, jobs: [] };
    const states = new Map<string, JobState>();
    let n = 0;
    const jobsSvc = jobsService({
      jobs: { load: () => ({ file, invalid: [] }), save: (f) => void (file = f) },
      state: {
        load: (id) => states.get(id) ?? emptyJobState(),
        save: (id, s) => void states.set(id, s),
        remove: (id) => void states.delete(id),
      },
      runs: { append: () => {}, read: () => [] },
      global: { load: () => ({}), save: () => {} },
      newId: () => `0000000${++n}`,
    });
    const history = historyDeps();
    const jobs = {
      service: jobsSvc,
      runNow: vi.fn(async () => summary as RunSummary),
      preview: vi.fn(async () => preview as RefreshPreview),
      accept: vi.fn(async () => ({ status: "accepted" as const, applied: 1, stale: 0, replaced: 1, removed: 0, notes: [] }) as AcceptOutcome),
      ...overrides,
    };
    return { jobs, states, account: history.account, journal: history.journal, d: { ...history.deps, jobs } };
  }

  it("answers 404 when jobs are not available", async () => {
    const res = await handleApi(request("GET", "/api/jobs"), deps());
    expect(res.status).toBe(404);
  });

  it("creates, lists, edits and deletes a job", async () => {
    const { d } = jobDeps();
    const created = await handleApi(request("POST", "/api/jobs", { job: input }), d);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ job: { id: "00000001", name: "Fresh" } });

    const listed = await handleApi(request("GET", "/api/jobs"), d);
    expect(listed.body).toMatchObject({ jobs: [{ job: { id: "00000001" } }], invalid: [], flags: {} });

    const edited = await handleApi(request("PUT", "/api/jobs/00000001", { job: { ...input, name: "Renamed" } }), d);
    expect(edited.body).toMatchObject({ job: { name: "Renamed" } });

    const deleted = await handleApi(request("DELETE", "/api/jobs/00000001", {}), d);
    expect(deleted.status).toBe(200);
    expect((await handleApi(request("GET", "/api/jobs"), d)).body).toMatchObject({ jobs: [] });
  });

  it("rejects an invalid job with 400", async () => {
    const { d } = jobDeps();
    const res = await handleApi(request("POST", "/api/jobs", { job: { ...input, schedule: { every: "never" } } }), d);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/every/) });
  });

  it("answers 404 for an unknown job", async () => {
    const { d } = jobDeps();
    for (const req of [
      request("PUT", "/api/jobs/ffffffff", { job: input }),
      request("DELETE", "/api/jobs/ffffffff", {}),
      request("POST", "/api/jobs/ffffffff/enabled", { enabled: false }),
      request("POST", "/api/jobs/ffffffff/resume", {}),
      request("POST", "/api/jobs/ffffffff/run", {}),
      request("GET", "/api/jobs/ffffffff/runs"),
    ]) {
      const res = await handleApi(req, d);
      expect([req.method, req.path, res.status]).toEqual([req.method, req.path, 404]);
    }
  });

  it("pauses, resumes and runs a job", async () => {
    const { d, jobs } = jobDeps();
    await handleApi(request("POST", "/api/jobs", { job: input }), d);
    const paused = await handleApi(request("POST", "/api/jobs/00000001/enabled", { enabled: false }), d);
    expect(paused.body).toMatchObject({ job: { enabled: false } });
    expect((await handleApi(request("POST", "/api/jobs/00000001/enabled", {}), d)).status).toBe(400);
    const resumed = await handleApi(request("POST", "/api/jobs/00000001/resume", {}), d);
    expect(resumed.status).toBe(200);
    const ran = await handleApi(request("POST", "/api/jobs/00000001/run", { dryRun: true }), d);
    expect(ran.body).toEqual({ summary });
    expect(jobs.runNow).toHaveBeenCalledWith("00000001", true);
    const runs = await handleApi(request("GET", "/api/jobs/00000001/runs"), d);
    expect(runs.body).toEqual({ runs: [] });
  });

  it("answers 409 while another runner is busy", async () => {
    const { d } = jobDeps({ runNow: vi.fn(async () => ({ status: "busy" as const, reports: [], invalid: [], message: "busy" })) });
    await handleApi(request("POST", "/api/jobs", { job: input }), d);
    const res = await handleApi(request("POST", "/api/jobs/00000001/run", {}), d);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "busy" });
  });

  it("previews a definition that is not saved yet", async () => {
    const { d, jobs } = jobDeps();
    const res = await handleApi(request("POST", "/api/jobs/preview", { job: input }), d);
    expect(res.body).toEqual({ preview });
    expect(jobs.preview).toHaveBeenCalledWith(input);
    const bad = await handleApi(request("POST", "/api/jobs/preview", {}), d);
    expect(bad.status).toBe(400);
  });

  it("looks up artists for a job", async () => {
    const { d } = jobDeps();
    d.service.searchArtists = vi.fn(async (q: string) => (q === "Air" ? [{ id: 1, name: "Air" }] : []));
    const res = await handleApi(request("POST", "/api/jobs/artists", { queries: ["Air", "Nobody"] }), d);
    expect(res.body).toEqual({ artists: [{ id: 1, name: "Air" }], problems: ["Nobody"] });
  });

  it("accepts and ignores suggestions", async () => {
    const { d, jobs, states } = jobDeps();
    await handleApi(request("POST", "/api/jobs", { job: { ...input, tidy: { upgrade: { mode: "suggest" } } } }), d);
    states.set("00000001", {
      ...emptyJobState(),
      suggestions: [{ key: "upgrade:1>2", tidy: "upgrade", summary: "s", change: { type: "replace", trackId: 1, newTrackId: 2 }, foundAt: "x" }],
    });
    const accepted = await handleApi(request("POST", "/api/jobs/00000001/suggestions", { accept: ["upgrade:1>2"] }), d);
    expect(accepted.body).toMatchObject({ outcome: { status: "accepted", applied: 1 } });
    expect(jobs.accept).toHaveBeenCalledWith("00000001", ["upgrade:1>2"]);
    const ignored = await handleApi(request("POST", "/api/jobs/00000001/suggestions", { ignore: "all" }), d);
    expect(ignored.body).toMatchObject({ state: { suggestions: [], ignored: ["upgrade:1>2"] } });
    expect((await handleApi(request("POST", "/api/jobs/00000001/suggestions", {}), d)).status).toBe(400);
    expect((await handleApi(request("POST", "/api/jobs/00000001/suggestions", { accept: 3 }), d)).status).toBe(400);
    expect((await handleApi(request("POST", "/api/jobs/ffffffff/suggestions", { accept: "all" }), d)).status).toBe(404);
  });

  it("answers 409 when accepting while another runner is busy", async () => {
    const { d } = jobDeps({ accept: vi.fn(async () => ({ status: "busy" as const, message: "busy" })) });
    await handleApi(request("POST", "/api/jobs", { job: input }), d);
    const res = await handleApi(request("POST", "/api/jobs/00000001/suggestions", { accept: "all" }), d);
    expect(res.status).toBe(409);
  });

  it("never deletes a playlist the job adopted", async () => {
    const { d, account } = jobDeps();
    const playlistId = account.seedPlaylist("Mine", [1]);
    const created = await handleApi(request("POST", "/api/jobs", { job: { ...input, target: { type: "adopted", playlistId } } }), d);
    expect(created.status).toBe(200);
    const res = await handleApi(request("DELETE", "/api/jobs/00000001", { deletePlaylist: true }), d);
    expect(res.body).toMatchObject({ playlistDeleted: false });
    expect(account.playlists.has(playlistId)).toBe(true);
  });

  it("deletes the playlist too when asked, as a history entry", async () => {
    const { d, states, account, journal } = jobDeps();
    await handleApi(request("POST", "/api/jobs", { job: input }), d);
    const playlistId = account.seedPlaylist("Fresh", [1, 2]);
    states.set("00000001", { ...emptyJobState(), playlistId });
    const res = await handleApi(request("DELETE", "/api/jobs/00000001", { deletePlaylist: true }), d);
    expect(res.body).toMatchObject({ playlistId, playlistDeleted: true });
    expect(account.playlists.has(playlistId)).toBe(false);
    expect(journal.items()[0]).toMatchObject({ tool: "managed" });
  });
});

describe("POST /api/deduplicate/scan with versions", () => {
  const tracks = [
    { id: 1, title: "Roads", artist: "Portishead" },
    { id: 2, title: "Roads", artist: "Portishead", version: "Live" },
  ];
  const scan = (body: unknown) =>
    handleApi(request("POST", "/api/deduplicate/scan", body), deps({ service: service({ getFavoriteTracks: vi.fn(async () => tracks) }) }));

  it("points versions out, or counts them as duplicates when asked", async () => {
    const source = { type: "favourites" };
    expect((await scan({ source })).body).toMatchObject({ groups: [], versions: [[{ id: 1 }, { id: 2, version: "Live" }]] });
    expect((await scan({ source, includeVersions: true })).body).toMatchObject({
      groups: [{ tracks: [{ id: 1 }, { id: 2 }], keepId: 1 }],
      versions: [],
    });
    expect((await scan({ source, includeVersions: "yes" })).status).toBe(400);
  });
});
