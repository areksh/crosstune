import { describe, expect, it, vi } from "vitest";

import { QobuzError, type Artist, type Playlist, type Track } from "../qobuz/index.js";
import { handleApi, type ApiDeps, type PlaylistService } from "./router.js";

const NONCE = "test-nonce";
const PORT = 4747;

function service(overrides: Partial<PlaylistService> = {}): PlaylistService {
  return {
    searchArtists: vi.fn(async () => [] as Artist[]),
    getArtistTopTracks: vi.fn(async () => [] as Track[]),
    getUserPlaylists: vi.fn(async () => [] as Playlist[]),
    getPlaylistTracks: vi.fn(async () => [] as Track[]),
    createPlaylist: vi.fn(async (name: string) => ({ id: 1, name })),
    addTracksToPlaylist: vi.fn(async () => {}),
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
