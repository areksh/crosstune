import { describe, expect, it, vi } from "vitest";

import type { Album, Playlist, Track } from "../qobuz/index.js";
import {
  buildPlaylistFromAlbums,
  fetchAlbumTracks,
  parseAlbumEntry,
  parseAlbumLine,
  resolveAlbumVersions,
  selectAlbumVersion,
  type AlbumPlaylistBuilderClient,
} from "./playlist-from-albums.js";
import { seededRandom } from "./combine.js";
import { SongPicker } from "./song-picker.js";
import { compileTrackFilter } from "./track-filter.js";

/** Build an album, overriding just the fields a test cares about. */
function album(overrides: Partial<Album> & { id: string }): Album {
  return { title: "Album", artist: "Artist", ...overrides };
}

/** A configurable stub of the client surface the album builder depends on. */
function stubClient(config: {
  albumsByQuery?: Record<string, Album[]>;
  tracksByAlbum?: Record<string, Track[]>;
  playlist?: Playlist;
  favourites?: Track[];
}): AlbumPlaylistBuilderClient & {
  searchAlbums: ReturnType<typeof vi.fn>;
  getAlbum: ReturnType<typeof vi.fn>;
  getAlbumTracks: ReturnType<typeof vi.fn>;
  createPlaylist: ReturnType<typeof vi.fn>;
  addTracksToPlaylist: ReturnType<typeof vi.fn>;
} {
  return {
    getFavoriteTracks: vi.fn(async () => config.favourites ?? []),
    getAlbum: vi.fn(async (albumId: string): Promise<Album> => album({ id: albumId })),
    searchAlbums: vi.fn(async (query: string) => config.albumsByQuery?.[query] ?? []),
    getAlbumTracks: vi.fn(async (albumId: string) => config.tracksByAlbum?.[albumId] ?? []),
    createPlaylist: vi.fn(async (name: string) => config.playlist ?? { id: 1, name }),
    addTracksToPlaylist: vi.fn(async () => {}),
  };
}

describe("parseAlbumEntry", () => {
  it("splits an 'Artist - Album' line into its parts", () => {
    expect(parseAlbumEntry("Radiohead - OK Computer")).toEqual({
      artist: "Radiohead",
      album: "OK Computer",
    });
  });

  it("splits on the first separator so album titles keep their hyphens", () => {
    expect(parseAlbumEntry("Godspeed You! - F# A# - Infinity")).toEqual({
      artist: "Godspeed You!",
      album: "F# A# - Infinity",
    });
  });

  it("trims whitespace around each side", () => {
    expect(parseAlbumEntry("  Daft Punk   -   Discovery  ")).toEqual({
      artist: "Daft Punk",
      album: "Discovery",
    });
  });

  it("returns undefined when the separator is missing or a side is empty", () => {
    expect(parseAlbumEntry("Radiohead OK Computer")).toBeUndefined();
    expect(parseAlbumEntry(" - Discovery")).toBeUndefined();
    expect(parseAlbumEntry("Daft Punk - ")).toBeUndefined();
  });
});

describe("selectAlbumVersion", () => {
  const versions = [
    album({ id: "cd", bitDepth: 16, samplingRate: 44.1, releaseDate: "1997-05-21" }),
    album({ id: "hires", bitDepth: 24, samplingRate: 96, releaseDate: "2017-06-23" }),
    album({ id: "mid", bitDepth: 24, samplingRate: 48, releaseDate: "2009-01-01" }),
  ];

  it("picks the highest bit depth, then sampling rate, for highest-quality", () => {
    expect(selectAlbumVersion(versions, "highest-quality")?.id).toBe("hires");
  });

  it("picks the earliest release for oldest", () => {
    expect(selectAlbumVersion(versions, "oldest")?.id).toBe("cd");
  });

  it("picks the latest release for newest", () => {
    expect(selectAlbumVersion(versions, "newest")?.id).toBe("hires");
  });

  it("prefers a known release date over an unknown one", () => {
    const withUnknown = [album({ id: "dated", releaseDate: "2000-01-01" }), album({ id: "undated" })];
    expect(selectAlbumVersion(withUnknown, "oldest")?.id).toBe("dated");
    expect(selectAlbumVersion(withUnknown, "newest")?.id).toBe("dated");
  });

  it("keeps the first version on a tie", () => {
    const tied = [album({ id: "a", bitDepth: 24 }), album({ id: "b", bitDepth: 24 })];
    expect(selectAlbumVersion(tied, "highest-quality")?.id).toBe("a");
  });

  it("returns undefined for an empty list", () => {
    expect(selectAlbumVersion([], "highest-quality")).toBeUndefined();
  });
});

describe("resolveAlbumVersions", () => {
  it("returns the album versions matching the requested artist and title", async () => {
    const client = stubClient({
      albumsByQuery: {
        "radiohead ok computer": [
          album({ id: "orig", title: "OK Computer", artist: "Radiohead" }),
          album({ id: "rem", title: "OK Computer (2017 Remaster)", artist: "Radiohead" }),
          album({ id: "other", title: "OK Computer OKNOTOK 1997 2017", artist: "Radiohead" }),
          album({ id: "wrong", title: "Kid A", artist: "Radiohead" }),
        ],
      },
    });

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "radiohead", album: "ok computer" }],
    });

    expect(result.unresolvedAlbums).toEqual([]);
    expect(result.resolvedAlbums).toHaveLength(1);
    const [resolved] = result.resolvedAlbums;
    // Case-insensitive match; remaster noise folds to the same title, but a
    // genuinely different title (OKNOTOK, Kid A) is excluded.
    expect(resolved?.versions.map((v) => v.id)).toEqual(["orig", "rem"]);
    expect(resolved?.query).toBe("radiohead - ok computer");
  });

  it("matches releases despite edition suffixes, artist prefixes, ampersands and number words", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Meshuggah Destroy Erase Improve": [
          album({ id: "reloaded", title: "Destroy Erase Improve (Reloaded)", artist: "Meshuggah" }),
        ],
        "Rainbow Rising": [
          album({ id: "rising", title: "Rising", artist: "Ritchie Blackmore's Rainbow" }),
        ],
        "Sunn O))) Monoliths & Dimensions": [
          album({ id: "md", title: "Monoliths And Dimensions", artist: "Sunn O)))" }),
        ],
        "White Zombie La Sexorcisto Volume One": [
          album({ id: "wz", title: "La Sexorcisto Volume 1", artist: "White Zombie" }),
        ],
      },
    });

    const result = await resolveAlbumVersions(client, {
      entries: [
        { artist: "Meshuggah", album: "Destroy Erase Improve" },
        { artist: "Rainbow", album: "Rising" },
        { artist: "Sunn O)))", album: "Monoliths & Dimensions" },
        { artist: "White Zombie", album: "La Sexorcisto Volume One" },
      ],
    });

    expect(result.unresolvedAlbums).toEqual([]);
    expect(result.resolvedAlbums.map((r) => r.versions[0]?.id)).toEqual([
      "reloaded",
      "rising",
      "md",
      "wz",
    ]);
  });

  it("does not conflate a self-titled album with its numbered sequels", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Danzig Danzig": [
          album({ id: "ii", title: "Danzig II: Lucifuge", artist: "Danzig" }),
          album({ id: "debut", title: "Danzig", artist: "Danzig" }),
          album({ id: "four", title: "Danzig 4", artist: "Danzig" }),
        ],
      },
    });

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "Danzig", album: "Danzig" }],
    });

    expect(result.resolvedAlbums[0]?.versions.map((v) => v.id)).toEqual(["debut"]);
  });

  it("falls back to an album-only search when the combined query finds nothing", async () => {
    const queries: string[] = [];
    const client = {
      searchAlbums: async (query: string): Promise<Album[]> => {
        queries.push(query);
        // The combined "artist album" query misses; album-only recall succeeds.
        return query === "Fallen"
          ? [album({ id: "ok", title: "Fallen", artist: "Evanescence" })]
          : [];
      },
      getAlbumTracks: async (): Promise<never[]> => [],
      createPlaylist: async (name: string) => ({ id: 1, name }),
      addTracksToPlaylist: async (): Promise<void> => {},
    };

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "Evanescence", album: "Fallen" }],
    });

    expect(queries).toEqual(["Evanescence Fallen", "Fallen"]);
    expect(result.resolvedAlbums[0]?.versions.map((v) => v.id)).toEqual(["ok"]);
  });

  it("reports albums with no matching version as unresolved", async () => {
    const client = stubClient({ albumsByQuery: {} });

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "Nonexistent", album: "Nothing" }],
    });

    expect(result.resolvedAlbums).toEqual([]);
    expect(result.unresolvedAlbums).toEqual(["Nonexistent - Nothing"]);
    expect(result.excludedAlbums).toEqual([]);
  });

  it("drops versions whose title or version matches an album term", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Portishead Dummy": [
          album({ id: "studio", title: "Dummy", artist: "Portishead" }),
          album({ id: "live", title: "Dummy", artist: "Portishead", version: "Live" }),
        ],
      },
    });

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "Portishead", album: "Dummy" }],
      filter: compileTrackFilter({ excludeAlbums: ["live"] }),
    });

    expect(result.resolvedAlbums[0]?.versions.map((v) => v.id)).toEqual(["studio"]);
    expect(result.excludedAlbums).toEqual([]);
  });

  it("reports an album whose every version is excluded, apart from unresolved ones", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Portishead Dummy": [
          album({ id: "live", title: "Dummy", artist: "Portishead", version: "Live" }),
        ],
      },
    });

    const result = await resolveAlbumVersions(client, {
      entries: [{ artist: "Portishead", album: "Dummy" }],
      filter: compileTrackFilter({ excludeAlbums: ["live"] }),
    });

    expect(result.resolvedAlbums).toEqual([]);
    expect(result.unresolvedAlbums).toEqual([]);
    expect(result.excludedAlbums).toEqual(["Portishead - Dummy"]);
  });
});

describe("fetchAlbumTracks", () => {
  it("returns each album's tracks in request order, fetching each album once", async () => {
    const client = stubClient({
      tracksByAlbum: {
        a: [{ id: 1, title: "One" }, { id: 2, title: "Two" }],
        b: [{ id: 2, title: "Two again" }, { id: 3, title: "Three" }],
      },
    });

    const result = await fetchAlbumTracks(client, ["a", "b", "a"]);

    // Per-album tracks are kept separate (dups across albums are the caller's
    // to resolve when it assembles the final ordered list).
    expect(result.fetched).toEqual([
      { albumId: "a", tracks: [{ track: { id: 1, title: "One" } }, { track: { id: 2, title: "Two" } }] },
      {
        albumId: "b",
        tracks: [{ track: { id: 2, title: "Two again" } }, { track: { id: 3, title: "Three" } }],
      },
    ]);
    expect(result.failedAlbumIds).toEqual([]);
    expect(client.getAlbumTracks).toHaveBeenCalledTimes(2);
  });

  it("skips albums whose tracks cannot be fetched and reports their ids", async () => {
    const client: AlbumPlaylistBuilderClient = {
      searchAlbums: vi.fn(async () => []),
      getAlbumTracks: vi.fn(async (id: string) => {
        if (id === "bad") {
          throw new Error("album/get failed with HTTP 404");
        }
        return [{ id: id === "a" ? 1 : 3, title: id }];
      }),
      createPlaylist: vi.fn(async (name: string) => ({ id: 1, name })),
      addTracksToPlaylist: vi.fn(async () => {}),
    };

    const result = await fetchAlbumTracks(client, ["a", "bad", "b"]);

    expect(result.fetched).toEqual([
      { albumId: "a", tracks: [{ track: { id: 1, title: "a" } }] },
      { albumId: "b", tracks: [{ track: { id: 3, title: "b" } }] },
    ]);
    expect(result.failedAlbumIds).toEqual(["bad"]);
  });
});

describe("fetchAlbumTracks with a filter", () => {
  it("marks excluded tracks in album order instead of dropping them", async () => {
    const tracks: Track[] = [
      { id: 1, title: "In the Flesh?", discNumber: 1 },
      { id: 2, title: "Hey You", discNumber: 2 },
      { id: 3, title: "Demo", discNumber: 1, version: "Demo" },
    ];
    const client = stubClient({ tracksByAlbum: { wall: tracks } });

    const result = await fetchAlbumTracks(
      client,
      ["wall"],
      compileTrackFilter({ excludeTracks: ["demo"], discs: [1] }),
    );

    expect(result.fetched).toEqual([
      {
        albumId: "wall",
        tracks: [
          { track: tracks[0] },
          { track: tracks[1], exclusion: { kind: "disc", disc: 2 } },
          { track: tracks[2], exclusion: { kind: "track", term: "demo" } },
        ],
      },
    ]);
  });
});

describe("fetchAlbumTracks with an artist filter", () => {
  it("marks a compilation track performed by an excluded artist", async () => {
    const tracks: Track[] = [
      { id: 1, title: "Joga", artist: "Bj\u00f6rk" },
      { id: 2, title: "Teardrop", artist: "Massive Attack" },
    ];
    const client = stubClient({ tracksByAlbum: { comp: tracks } });

    const result = await fetchAlbumTracks(
      client,
      ["comp"],
      compileTrackFilter({ excludeArtists: ["bjork"] }),
    );

    expect(result.fetched).toEqual([
      {
        albumId: "comp",
        tracks: [
          { track: tracks[0], exclusion: { kind: "artist", term: "bjork" } },
          { track: tracks[1] },
        ],
      },
    ]);
  });
});

describe("buildPlaylistFromAlbums with a filter", () => {
  it("skips excluded versions and tracks and reports what was left out", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Pink Floyd The Wall": [
          album({ id: "cd", title: "The Wall", artist: "Pink Floyd", bitDepth: 16 }),
          album({
            id: "live",
            title: "The Wall",
            artist: "Pink Floyd",
            version: "Live",
            bitDepth: 24,
          }),
        ],
        "Pink Floyd Pulse": [
          album({ id: "pulse", title: "Pulse", artist: "Pink Floyd", version: "Live" }),
        ],
      },
      tracksByAlbum: {
        cd: [
          { id: 1, title: "In the Flesh?", discNumber: 1 },
          { id: 2, title: "Hey You", discNumber: 2 },
        ],
      },
    });

    const result = await buildPlaylistFromAlbums(client, {
      entries: [
        { artist: "Pink Floyd", album: "The Wall" },
        { artist: "Pink Floyd", album: "Pulse" },
      ],
      playlistName: "Floyd",
      preference: "highest-quality",
      filter: compileTrackFilter({ excludeAlbums: ["live"], discs: [1] }),
    });

    // The hi-res "Live" release would win on quality, but it is excluded.
    expect(client.getAlbumTracks).toHaveBeenCalledWith("cd");
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [1]);
    expect(result.resolvedAlbums.map((r) => [r.album.id, r.trackCount, r.excludedCount])).toEqual([
      ["cd", 1, 1],
    ]);
    expect(result.excludedAlbums).toEqual(["Pink Floyd - Pulse"]);
  });
});

describe("album links", () => {
  it("parses a line as an album entry, an album link, or a problem", () => {
    expect(parseAlbumLine("Portishead - Dummy")).toEqual({
      entry: { artist: "Portishead", album: "Dummy" },
    });
    expect(parseAlbumLine("https://open.qobuz.com/album/pvsb64n704d0b")).toEqual({
      entry: { link: "https://open.qobuz.com/album/pvsb64n704d0b", albumId: "pvsb64n704d0b" },
    });
    expect(parseAlbumLine("https://play.qobuz.com/artist/41259")).toEqual({
      problem: "https://play.qobuz.com/artist/41259 (an artist link, not an album)",
    });
    expect(parseAlbumLine("Portishead")).toEqual({ problem: "Portishead" });
  });

  it("resolves an album link by id, in input order, without searching", async () => {
    const mezzanine = album({ id: "pvsb64n704d0b", title: "Mezzanine", artist: "Massive Attack" });
    const client = stubClient({
      albumsByQuery: { "Portishead Dummy": [album({ id: "d", title: "Dummy", artist: "Portishead" })] },
    });
    client.getAlbum = vi.fn(async () => mezzanine);
    const link = "https://open.qobuz.com/album/pvsb64n704d0b";

    const result = await resolveAlbumVersions(client, {
      entries: [{ link, albumId: "pvsb64n704d0b" }, { artist: "Portishead", album: "Dummy" }],
    });

    expect(client.getAlbum).toHaveBeenCalledWith("pvsb64n704d0b");
    expect(client.searchAlbums).not.toHaveBeenCalledWith(expect.stringContaining("Mezzanine"), expect.anything());
    expect(result.resolvedAlbums.map((r) => [r.query, r.fromLink, r.versions.map((v) => v.id)])).toEqual([
      ["Massive Attack - Mezzanine", true, ["pvsb64n704d0b"]],
      ["Portishead - Dummy", undefined, ["d"]],
    ]);
  });

  it("reports a link to no album, and an excluded linked release", async () => {
    const client = stubClient({});
    client.getAlbum = vi.fn(async (id: string) => {
      if (id === "live") {
        return album({ id, title: "Live at Roseland", artist: "Portishead" });
      }
      throw new Error("album/get failed with HTTP 404");
    });

    const result = await resolveAlbumVersions(client, {
      entries: [
        { link: "https://play.qobuz.com/album/zzz", albumId: "zzz" },
        { link: "https://play.qobuz.com/album/live", albumId: "live" },
      ],
      filter: compileTrackFilter({ excludeAlbums: ["live"] }),
    });

    expect(result.unresolvedAlbums).toEqual([
      "https://play.qobuz.com/album/zzz (no Qobuz album has this id)",
    ]);
    expect(result.excludedAlbums).toEqual(["Portishead - Live at Roseland"]);
  });
});

describe("fetchAlbumTracks with a song picker", () => {
  it("marks favourites and later copies of a song, in request order", async () => {
    const client = stubClient({
      tracksByAlbum: {
        // The second album's lookup finishes first; the first still wins.
        a: [
          { id: 1, title: "Song", artist: "X", isrc: "I1" },
          { id: 2, title: "Fav", artist: "X" },
        ],
        b: [{ id: 3, title: "Song", version: "2011 Remaster", artist: "X" }],
      },
    });
    client.getAlbumTracks.mockImplementation(async (albumId: string) => {
      await new Promise((resolve) => setTimeout(resolve, albumId === "a" ? 20 : 0));
      return albumId === "a"
        ? [
            { id: 1, title: "Song", artist: "X", isrc: "I1" },
            { id: 2, title: "Fav", artist: "X" },
          ]
        : [{ id: 3, title: "Song", version: "2011 Remaster", artist: "X" }];
    });
    const picker = SongPicker.fromFavourites([{ id: 2, title: "Fav" }], { oneCopy: true });

    const result = await fetchAlbumTracks(client, ["a", "b"], undefined, picker);

    expect(result.fetched.map((f) => f.tracks.map((t) => [t.track.id, t.exclusion]))).toEqual([
      [
        [1, undefined],
        [2, { kind: "favourite" }],
      ],
      [[3, { kind: "repeat", of: "Song" }]],
    ]);
  });
});

describe("buildPlaylistFromAlbums with plan options", () => {
  const albumsByQuery = {
    "A One": [album({ id: "one", title: "One", artist: "A" })],
    "B Two": [album({ id: "two", title: "Two", artist: "B" })],
  };
  const tracksByAlbum: Record<string, Track[]> = {
    one: [
      { id: 1, title: "s1", artist: "A", duration: 200 },
      { id: 2, title: "s2", artist: "A", duration: 200 },
    ],
    two: [
      { id: 3, title: "s1", artist: "A", duration: 200 },
      { id: 4, title: "t2", artist: "B", duration: 200 },
      { id: 5, title: "t3", artist: "B", duration: 200 },
    ],
  };
  const entries = [
    { artist: "A", album: "One" },
    { artist: "B", album: "Two" },
  ];

  it("skips repeats and favourites, then trims the end of the list to fit", async () => {
    const client = stubClient({
      albumsByQuery,
      tracksByAlbum,
      favourites: [{ id: 2, title: "s2", artist: "A" }],
    });
    const result = await buildPlaylistFromAlbums(client, {
      entries,
      playlistName: "P",
      skipFavourites: true,
      oneCopy: true,
      fitMinutes: 7,
    });
    // Left: 1, 4, 5 (600s); 7 minutes trims the last track.
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [1, 4]);
    expect(result.resolvedAlbums.map((r) => [r.trackCount, r.excludedCount])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(result.droppedToFit).toBe(1);
    expect(result.durationSeconds).toBe(400);
  });

  it("shuffles when asked", async () => {
    const client = stubClient({ albumsByQuery, tracksByAlbum });
    await buildPlaylistFromAlbums(client, {
      entries,
      playlistName: "P",
      order: "shuffle",
      random: seededRandom(5),
    });
    const written = client.addTracksToPlaylist.mock.calls[0]![1] as number[];
    expect([...written].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(client.getFavoriteTracks).not.toHaveBeenCalled();
  });
});

describe("buildPlaylistFromAlbums", () => {
  it("resolves albums, picks a version, creates the playlist and adds its tracks", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Radiohead OK Computer": [
          album({ id: "cd", title: "OK Computer", artist: "Radiohead", bitDepth: 16 }),
          album({ id: "hires", title: "OK Computer", artist: "Radiohead", bitDepth: 24 }),
        ],
        "Daft Punk Discovery": [
          album({ id: "disc", title: "Discovery", artist: "Daft Punk", bitDepth: 16 }),
        ],
      },
      tracksByAlbum: {
        hires: [{ id: 1, title: "Airbag" }, { id: 2, title: "Paranoid Android" }],
        disc: [{ id: 10, title: "One More Time" }],
      },
      playlist: { id: 777, name: "Albums" },
    });

    const result = await buildPlaylistFromAlbums(client, {
      entries: [
        { artist: "Radiohead", album: "OK Computer" },
        { artist: "Daft Punk", album: "Discovery" },
      ],
      playlistName: "Albums",
      preference: "highest-quality",
    });

    expect(result.playlist).toEqual({ id: 777, name: "Albums" });
    expect(result.trackCount).toBe(3);
    expect(result.unresolvedAlbums).toEqual([]);
    expect(result.failedAlbums).toEqual([]);
    // Highest quality wins the OK Computer versions.
    expect(result.resolvedAlbums.map((r) => r.album.id)).toEqual(["hires", "disc"]);
    expect(result.resolvedAlbums.map((r) => r.trackCount)).toEqual([2, 1]);
    expect(client.getAlbumTracks).toHaveBeenCalledWith("hires");
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(777, [1, 2, 10]);
  });

  it("reports unresolved entries and still builds from the rest", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Daft Punk Discovery": [album({ id: "disc", title: "Discovery", artist: "Daft Punk" })],
      },
      tracksByAlbum: { disc: [{ id: 10, title: "One More Time" }] },
      playlist: { id: 5, name: "Mix" },
    });

    const result = await buildPlaylistFromAlbums(client, {
      entries: [
        { artist: "Daft Punk", album: "Discovery" },
        { artist: "Ghost", album: "Missing" },
      ],
      playlistName: "Mix",
    });

    expect(result.trackCount).toBe(1);
    expect(result.unresolvedAlbums).toEqual(["Ghost - Missing"]);
  });

  it("skips an album whose tracks fail to fetch and reports it", async () => {
    const client = stubClient({
      albumsByQuery: {
        "Daft Punk Discovery": [album({ id: "disc", title: "Discovery", artist: "Daft Punk" })],
        "Radiohead OK Computer": [album({ id: "okc", title: "OK Computer", artist: "Radiohead" })],
      },
      tracksByAlbum: { disc: [{ id: 10, title: "One More Time" }] },
      playlist: { id: 5, name: "Mix" },
    });
    // The chosen OK Computer version 404s on album/get; Discovery still succeeds.
    client.getAlbumTracks.mockImplementation(async (id: string) => {
      if (id === "okc") {
        throw new Error("album/get failed with HTTP 404");
      }
      return [{ id: 10, title: "One More Time" }];
    });

    const result = await buildPlaylistFromAlbums(client, {
      entries: [
        { artist: "Daft Punk", album: "Discovery" },
        { artist: "Radiohead", album: "OK Computer" },
      ],
      playlistName: "Mix",
    });

    expect(result.trackCount).toBe(1);
    expect(result.resolvedAlbums.map((r) => r.album.id)).toEqual(["disc"]);
    expect(result.failedAlbums).toEqual(["Radiohead - OK Computer"]);
    expect(result.unresolvedAlbums).toEqual([]);
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(5, [10]);
  });

  it("throws when no albums are given", async () => {
    const client = stubClient({});
    await expect(
      buildPlaylistFromAlbums(client, { entries: [], playlistName: "Empty" }),
    ).rejects.toThrow(/at least one album/i);
  });
});
