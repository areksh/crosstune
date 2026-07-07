import { describe, expect, it, vi } from "vitest";

import {
  QobuzError,
  type Album,
  type Artist,
  type Playlist,
  type Track,
} from "../qobuz/index.js";
import { handleApi, type ApiDeps, type QobuzApiService } from "./router.js";

const NONCE = "test-nonce";
const PORT = 4747;

function service(overrides: Partial<QobuzApiService> = {}): QobuzApiService {
  return {
    searchArtists: vi.fn(async () => [] as Artist[]),
    getArtistTopTracks: vi.fn(async () => [] as Track[]),
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
        { query: "Portishead", artist: { id: 5, name: "Portishead" }, tracks: [{ id: 100, title: "Roads" }] },
      ],
      unresolvedArtists: [],
    });
    expect(svc.getArtistTopTracks).toHaveBeenCalledWith(5, 3);
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
  it("returns each album's track ids in request order, fetching without writing", async () => {
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
        { albumId: "a", trackIds: [1, 2] },
        { albumId: "b", trackIds: [3] },
      ],
      failedAlbumIds: [],
    });
    // Fetching must not write anything to a playlist.
    expect(svc.createPlaylist).not.toHaveBeenCalled();
    expect(svc.addTracksToPlaylist).not.toHaveBeenCalled();
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
      fetched: [{ albumId: "a", trackIds: [1] }],
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
