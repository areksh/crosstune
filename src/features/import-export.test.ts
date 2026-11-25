import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../services/errors.js";
import { qid } from "../services/ids.test-support.js";
import { tagId, type AlbumId, type ArtistId, type TrackId } from "../services/ids.js";
import type { Album, Artist, Playlist, Track } from "../services/model.js";
import {
  buildBackup,
  collectCollection,
  commitImport,
  countMatchMethods,
  describeMatchCounts,
  effectiveImportFormat,
  exportAllPlaylists,
  formatFromFilename,
  isSpotifyExport,
  looksLikeBackup,
  parseBackup,
  parseCollection,
  playlistFilenames,
  resolveImport,
  restoreBackup,
  serializeBackup,
  serializeCollection,
  type Collection,
  type ExportClient,
  type ImportResolverClient,
  type ImportWriterClient,
  type LibraryBackup,
} from "./import-export.js";
import { FakeAccount } from "./fake-account.test-support.js";

const tracks: Collection = {
  kind: "tracks",
  items: [
    { id: qid(1), title: "Roads", artist: "Portishead", album: "Dummy", isrc: "GBAAA0000001" },
    { id: qid(2), title: "Teardrop, live", artist: "Massive Attack" },
  ],
};

describe("serializeCollection", () => {
  it("writes tracks as JSON keyed by kind", () => {
    const out = serializeCollection(tracks, "json");
    expect(JSON.parse(out)).toEqual({ tracks: tracks.items.map((item, i) => ({ ...item, id: i + 1 })) });
  });

  it("writes CSV with a header and quotes fields containing commas", () => {
    const out = serializeCollection(tracks, "csv");
    const lines = out.trimEnd().split("\r\n");
    expect(lines[0]).toBe("title,artist,album,isrc,id");
    expect(lines[1]).toBe("Roads,Portishead,Dummy,GBAAA0000001,1");
    // The second title has a comma, so it is quoted.
    expect(lines[2]).toBe('"Teardrop, live",Massive Attack,,,2');
  });

  it("writes plain text as 'Artist - Title' lines", () => {
    const out = serializeCollection(tracks, "text");
    expect(out).toBe("Portishead - Roads\nMassive Attack - Teardrop, live\n");
  });

  it("writes M3U with EXTINF and a qobuz track URI per entry", () => {
    const out = serializeCollection(tracks, "m3u");
    expect(out).toBe(
      "#EXTM3U\n" +
        "#EXTINF:-1,Portishead - Roads\n" +
        "qobuz://track/1\n" +
        "#EXTINF:-1,Massive Attack - Teardrop, live\n" +
        "qobuz://track/2\n",
    );
  });

  it("refuses M3U for a non-track collection", () => {
    const albums: Collection = { kind: "albums", items: [{ id: "a", title: "X" }] };
    expect(() => serializeCollection(albums, "m3u")).toThrow(/only hold tracks/);
  });

  it("renders artists by name in text and csv", () => {
    const artists: Collection = {
      kind: "artists",
      items: [{ id: qid(7), name: "Aphex Twin" }],
    };
    expect(serializeCollection(artists, "text")).toBe("Aphex Twin\n");
    expect(serializeCollection(artists, "csv")).toBe("name,id\r\nAphex Twin,7\r\n");
  });
});

describe("parseCollection", () => {
  it("round-trips tracks through JSON", () => {
    const out = serializeCollection(tracks, "json");
    const parsed = parseCollection(out, "json", "tracks");
    expect(parsed).toEqual({ kind: "tracks", items: tracks.items });
  });

  it("round-trips tracks through CSV, recovering the quoted comma", () => {
    const out = serializeCollection(tracks, "csv");
    const parsed = parseCollection(out, "csv", "tracks");
    expect(parsed.items).toEqual([
      { title: "Roads", artist: "Portishead", album: "Dummy", isrc: "GBAAA0000001", id: qid(1) },
      { title: "Teardrop, live", artist: "Massive Attack", id: qid(2) },
    ]);
  });

  it("reads plain-text tracks as artist/title, keeping title-only lines", () => {
    const parsed = parseCollection("Portishead - Roads\nInstrumental\n", "text", "tracks");
    expect(parsed.items).toEqual([
      { artist: "Portishead", title: "Roads" },
      { title: "Instrumental" },
    ]);
  });

  it("recovers track ids from M3U URIs", () => {
    const out = serializeCollection(tracks, "m3u");
    const parsed = parseCollection(out, "m3u", "tracks");
    expect(parsed.items).toEqual([
      { id: qid(1), artist: "Portishead", title: "Roads" },
      { id: qid(2), artist: "Massive Attack", title: "Teardrop, live" },
    ]);
  });

  it("detects the kind from JSON regardless of the fallback", () => {
    const parsed = parseCollection('{"artists":[{"id":3,"name":"Bjork"}]}', "json", "tracks");
    expect(parsed).toEqual({ kind: "artists", items: [{ id: qid(3), name: "Bjork" }] });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseCollection("not json", "json", "tracks")).toThrow();
  });
});

// A resolver that matches tracks/albums/artists from small in-memory catalogues.
function fakeResolver(overrides: Partial<ImportResolverClient> = {}): ImportResolverClient {
  return {
    searchTracks: async (query) => {
      if (query.includes("Roads")) {
        return [{ id: qid(1), title: "Roads", artist: "Portishead", isrc: "GBAAA0000001" }];
      }
      return [];
    },
    searchAlbums: async (query) => {
      if (query.toLowerCase().includes("dummy")) {
        return [
          { id: "alb-lo", title: "Dummy", artist: "Portishead", bitDepth: 16 },
          { id: "alb-hi", title: "Dummy", artist: "Portishead", bitDepth: 24 },
        ];
      }
      return [];
    },
    searchArtists: async (query) =>
      query.toLowerCase().includes("portishead")
        ? [{ id: qid(55), name: "Portishead" }]
        : [],
    ...overrides,
  };
}

describe("resolveImport", () => {
  it("keeps items that already carry an id without searching", async () => {
    let searched = false;
    const client = fakeResolver({
      searchTracks: async () => {
        searched = true;
        return [];
      },
    });
    const plan = await resolveImport(client, {
      kind: "tracks",
      items: [{ id: qid(99), title: "Known" }],
    });
    expect(searched).toBe(false);
    expect(plan.matched).toEqual([{ label: "Known", id: qid(99), via: "id" }]);
  });

  it("resolves tracks by search and reports the rest as unmatched", async () => {
    const plan = await resolveImport(fakeResolver(), {
      kind: "tracks",
      items: [
        { title: "Roads", artist: "Portishead" },
        { title: "Nonexistent", artist: "Nobody" },
      ],
    });
    expect(plan.matched).toEqual([{ label: "Portishead - Roads", id: qid(1), via: "search" }]);
    expect(plan.unmatched).toEqual(["Nobody - Nonexistent"]);
  });

  it("de-duplicates ids matched from more than one item", async () => {
    const plan = await resolveImport(fakeResolver(), {
      kind: "tracks",
      items: [
        { title: "Roads", artist: "Portishead" },
        { id: qid(1), title: "Roads again" },
      ],
    });
    expect(plan.matched).toEqual([{ label: "Portishead - Roads", id: qid(1), via: "search" }]);
  });

  it("resolves an album to its highest-quality version", async () => {
    const plan = await resolveImport(fakeResolver(), {
      kind: "albums",
      items: [{ title: "Dummy", artist: "Portishead" }],
    });
    expect(plan.matched).toEqual([{ label: "Portishead - Dummy", id: "alb-hi", via: "search" }]);
  });

  it("resolves an artist by exact name", async () => {
    const plan = await resolveImport(fakeResolver(), {
      kind: "artists",
      items: [{ name: "Portishead" }],
    });
    expect(plan.matched).toEqual([{ label: "Portishead", id: qid(55), via: "search" }]);
  });

  it("does not guess whose song a title-only line is", async () => {
    const searchTracks = vi.fn(async (query: string): Promise<Track[]> =>
      query === "GBAYE6300001"
        ? [{ id: qid(81), title: "Yesterday", artist: "The Beatles", isrc: "GBAYE6300001" }]
        : [{ id: qid(80), title: "Yesterday", artist: "A Cover Band" }],
    );
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [{ title: "Yesterday" }, { title: "Yesterday", isrc: "GBAYE6300001" }],
    });
    // By its ISRC a title-only line is still the same recording.
    expect(plan.matched).toEqual([{ label: "Yesterday", id: qid(81), via: "isrc" }]);
    expect(plan.unmatched).toEqual(["Yesterday (no artist given)"]);
    expect(searchTracks.mock.calls.map((call) => call[0])).toEqual(["GBAYE6300001"]);
  });

  it("takes an artist only by name, never the first search hit", async () => {
    const searchArtists = vi.fn(async (query: string): Promise<Artist[]> =>
      query === "Bjork"
        ? [
            { id: qid(70), name: "Björk Tribute Band" },
            { id: qid(71), name: "Björk" },
          ]
        : query === "Guns N Roses"
          ? [{ id: qid(72), name: "Guns N' Roses" }]
          : [{ id: qid(73), name: "Someone Qobuz Does Have" }],
    );
    const plan = await resolveImport(fakeResolver({ searchArtists }), {
      kind: "artists",
      items: [{ name: "Bjork" }, { name: "Guns N Roses" }, { name: "An Artist Qobuz Lacks" }],
    });
    expect(plan.matched).toEqual([
      { label: "Bjork", id: qid(71), via: "search" },
      { label: "Guns N Roses", id: qid(72), via: "search" },
    ]);
    expect(plan.unmatched).toEqual(["An Artist Qobuz Lacks"]);
  });

  it("reports an item whose search failed as unmatched and carries on with the rest", async () => {
    const searchTracks = vi.fn(async (query: string): Promise<Track[]> => {
      if (query.includes("Broken")) {
        throw new Error("HTTP 500");
      }
      return query.includes("Roads") ? [{ id: qid(1), title: "Roads", artist: "Portishead" }] : [];
    });
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [
        { title: "Broken", artist: "Somebody" },
        { title: "Roads", artist: "Portishead" },
      ],
    });
    expect(plan.matched).toEqual([{ label: "Portishead - Roads", id: qid(1), via: "search" }]);
    expect(plan.unmatched).toEqual(["Somebody - Broken (could not be looked up)"]);

    const albums = await resolveImport(
      fakeResolver({
        searchAlbums: async () => {
          throw new Error("HTTP 502");
        },
      }),
      { kind: "albums", items: [{ title: "Dummy", artist: "Portishead" }] },
    );
    expect(albums.unmatched).toEqual(["Portishead - Dummy (could not be looked up)"]);

    const artists = await resolveImport(
      fakeResolver({
        searchArtists: async (query) => {
          if (query === "Tricky") throw new Error("timeout");
          return [{ id: qid(55), name: "Portishead" }];
        },
      }),
      { kind: "artists", items: [{ name: "Tricky" }, { name: "Portishead" }] },
    );
    expect(artists.matched).toEqual([{ label: "Portishead", id: qid(55), via: "search" }]);
    expect(artists.unmatched).toEqual(["Tricky (could not be looked up)"]);
  });

  it("stops on an error every item would hit, without searching for the rest", async () => {
    const searchTracks = vi.fn(async (): Promise<Track[]> => {
      throw new ServiceError("qobuz", "authentication", "signed out");
    });
    const items = Array.from({ length: 100 }, (_, index) => ({ title: `Song ${index}`, artist: "A" }));
    await expect(resolveImport(fakeResolver({ searchTracks }), { kind: "tracks", items })).rejects.toThrow(
      "signed out",
    );
    expect(searchTracks.mock.calls.length).toBeLessThan(20);
  });
});

// A writer that records every call for assertions.
function fakeWriter(): ImportWriterClient & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  return {
    calls,
    addFavoriteTracks: async (ids) => record("addFavoriteTracks", ids),
    addFavoriteAlbums: async (ids) => record("addFavoriteAlbums", ids),
    addFavoriteArtists: async (ids) => record("addFavoriteArtists", ids),
    createPlaylist: async (name, options) => {
      record("createPlaylist", name, options);
      return { id: qid(100), name };
    },
    addTracksToPlaylist: async (playlistId, ids) =>
      record("addTracksToPlaylist", playlistId, ids),
    getPlaylistTracks: async () => [],
  };
}

/** Plays back what restoreBackup adds, as the writer's playlist. */
function readBackFrom(writer: ReturnType<typeof fakeWriter>): void {
  writer.getPlaylistTracks = async () =>
    ((writer.calls["addTracksToPlaylist"] ?? []) as [unknown, TrackId[]][]).flatMap(([, ids]) =>
      ids.map((id) => ({ id }) as never),
    );
}

describe("commitImport", () => {
  it("adds matched tracks to favourites", async () => {
    const writer = fakeWriter();
    const result = await commitImport(
      writer,
      { kind: "tracks", matched: [{ label: "a", id: qid(1) }, { label: "b", id: qid(2) }], unmatched: [] },
      { type: "favourites" },
    );
    expect(writer.calls["addFavoriteTracks"]).toEqual([[[qid(1), qid(2)]]]);
    expect(result.written).toBe(2);
  });

  it("routes album and artist favourites to their own endpoints", async () => {
    const writer = fakeWriter();
    await commitImport(
      writer,
      { kind: "albums", matched: [{ label: "a", id: "x" }], unmatched: [] },
      { type: "favourites" },
    );
    await commitImport(
      writer,
      { kind: "artists", matched: [{ label: "b", id: qid(9) }], unmatched: [] },
      { type: "favourites" },
    );
    expect(writer.calls["addFavoriteAlbums"]).toEqual([[["x"]]]);
    expect(writer.calls["addFavoriteArtists"]).toEqual([[[qid(9)]]]);
  });

  it("creates a new playlist from a track plan", async () => {
    const writer = fakeWriter();
    const result = await commitImport(
      writer,
      { kind: "tracks", matched: [{ label: "a", id: qid(1) }], unmatched: [] },
      { type: "playlist-new", name: "Imported", isPublic: true },
    );
    expect(writer.calls["createPlaylist"]).toEqual([["Imported", { isPublic: true }]]);
    expect(writer.calls["addTracksToPlaylist"]).toEqual([[qid(100), [qid(1)]]]);
    expect(result.playlist).toEqual({ id: qid(100), name: "Imported" });
  });

  it("refuses to put a non-track plan into a playlist", async () => {
    await expect(
      commitImport(
        fakeWriter(),
        { kind: "albums", matched: [{ label: "a", id: "x" }], unmatched: [] },
        { type: "playlist-new", name: "X" },
      ),
    ).rejects.toThrow(/only tracks/);
  });
});

function fakeExportClient(): ExportClient {
  const favTracks: Track[] = [{ id: qid(1), title: "Roads", artist: "Portishead" }];
  const favAlbums: Album[] = [{ id: qid("alb"), title: "Dummy", artist: "Portishead" }];
  const favArtists: Artist[] = [{ id: qid(55), name: "Portishead" }];
  const playlists: Playlist[] = [{ id: qid(7), name: "Chill" }];
  return {
    getFavoriteTracks: async () => favTracks,
    getFavoriteAlbums: async () => favAlbums,
    getFavoriteArtists: async () => favArtists,
    getUserPlaylists: async () => playlists,
    getPlaylistTracks: async (id) =>
      id === qid(7) ? [{ id: qid(2), title: "Glory Box", artist: "Portishead" }] : [],
  };
}

describe("collectCollection", () => {
  it("reads favourite tracks into an export collection", async () => {
    const collection = await collectCollection(fakeExportClient(), {
      type: "favourite-tracks",
    });
    expect(collection).toEqual({
      kind: "tracks",
      items: [{ id: qid(1), title: "Roads", artist: "Portishead" }],
    });
  });

  it("reads a playlist's tracks", async () => {
    const collection = await collectCollection(fakeExportClient(), {
      type: "playlist",
      playlistId: qid(7),
    });
    expect(collection.items).toEqual([{ id: qid(2), title: "Glory Box", artist: "Portishead" }]);
  });
});

describe("buildBackup and restoreBackup", () => {
  it("captures every favourite collection and playlist with tracks", async () => {
    const backup = await buildBackup(fakeExportClient(), () => new Date("2026-07-07T00:00:00Z"));
    expect(backup.formatVersion).toBe(1);
    expect(backup.exportedAt).toBe("2026-07-07T00:00:00.000Z");
    expect(backup.favourites.tracks).toHaveLength(1);
    expect(backup.favourites.albums).toHaveLength(1);
    expect(backup.favourites.artists).toHaveLength(1);
    expect(backup.playlists).toEqual([
      { name: "Chill", tracks: [{ id: qid(2), title: "Glory Box", artist: "Portishead" }] },
    ]);
  });

  it("round-trips a backup through JSON", () => {
    const backup: LibraryBackup = {
      formatVersion: 1,
      exportedAt: "2026-07-07T00:00:00.000Z",
      favourites: {
        tracks: [{ id: qid(1), title: "Roads" }],
        albums: [{ id: qid("alb"), title: "Dummy" }],
        artists: [{ id: qid(55), name: "Portishead" }],
      },
      playlists: [{ name: "Chill", tracks: [{ id: qid(2), title: "Glory Box" }] }],
    };
    expect(parseBackup(serializeBackup(backup))).toEqual(backup);
  });

  it("replays every part of a backup on restore", async () => {
    const writer = fakeWriter();
    const backup: LibraryBackup = {
      formatVersion: 1,
      exportedAt: "",
      favourites: {
        tracks: [{ id: qid(1), title: "a" }, { id: qid(2), title: "b" }],
        albums: [{ id: qid("alb"), title: "Dummy" }],
        artists: [{ id: qid(55), name: "Portishead" }],
      },
      playlists: [{ name: "Chill", tracks: [{ id: qid(9), title: "c" }] }],
    };
    readBackFrom(writer);
    const result = await restoreBackup(writer, backup);
    expect(writer.calls["addFavoriteTracks"]).toEqual([[[qid(1), qid(2)]]]);
    expect(writer.calls["addFavoriteAlbums"]).toEqual([[[qid("alb")]]]);
    expect(writer.calls["addFavoriteArtists"]).toEqual([[[qid(55)]]]);
    expect(writer.calls["createPlaylist"]).toEqual([["Chill", { isPublic: false }]]);
    expect(writer.calls["addTracksToPlaylist"]).toEqual([[qid(100), [qid(9)]]]);
    expect(result.playlists).toEqual([{ name: "Chill", trackCount: 1, missing: [] }]);
  });

  it("restores a playlist's repeated songs on a Qobuz-like account and reports what is missing", async () => {
    const account = new FakeAccount();
    account.unplayable.add(qid(4));
    const backup: LibraryBackup = {
      formatVersion: 1,
      exportedAt: "",
      favourites: { tracks: [], albums: [], artists: [] },
      playlists: [
        { name: "Loops", tracks: [1, 2, 1, 3].map((n) => ({ id: qid(n), title: "t" })) },
        { name: "Gone", tracks: [qid(1), qid(4)].map((id) => ({ id, title: "t" })) },
      ],
    };
    const result = await restoreBackup(account as never, backup);
    const ids = [...account.playlists.keys()];
    expect(account.trackIds(ids[0]!)).toEqual([qid(1), qid(2), qid(1), qid(3)]);
    expect(result.playlists).toEqual([
      { name: "Loops", trackCount: 4, missing: [] },
      { name: "Gone", trackCount: 1, missing: [qid(4)] },
    ]);
  });

  it("rejects content that is not a backup", () => {
    expect(() => parseBackup('{"tracks":[]}')).toThrow(/not a crosstune backup/);
  });
});

describe("format helpers", () => {
  it("infers a format from a file extension", () => {
    expect(formatFromFilename("library.json")).toBe("json");
    expect(formatFromFilename("out.csv")).toBe("csv");
    expect(formatFromFilename("list.txt")).toBe("text");
    expect(formatFromFilename("mix.m3u8")).toBe("m3u");
    expect(formatFromFilename("noext")).toBeUndefined();
  });

  it("recognises a backup document by its shape", () => {
    expect(looksLikeBackup('{"favourites":{}}')).toBe(true);
    expect(looksLikeBackup('{"tracks":[]}')).toBe(false);
    expect(looksLikeBackup("nope")).toBe(false);
  });
});

// --- Spotify (Exportify) import ---------------------------------------------

const EXPORTIFY_HEADER =
  '"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album URI","Album Name",' +
  '"Album Release Date","Disc Number","Track Number","Track Duration (ms)","Explicit",' +
  '"Popularity","ISRC","Added By","Added At"';

function exportifyRow(fields: {
  name: string;
  artists: string;
  album: string;
  isrc: string;
}): string {
  return [
    "spotify:track:abc",
    fields.name,
    "spotify:artist:x",
    fields.artists,
    "spotify:album:y",
    fields.album,
    "2013-05-17",
    "1",
    "8",
    "369626",
    "false",
    "80",
    fields.isrc,
    "spotify:user:me",
    "2020-01-01T00:00:00Z",
  ]
    .map((field) => `"${field.replace(/"/g, '""')}"`)
    .join(",");
}

const exportify = [
  EXPORTIFY_HEADER,
  exportifyRow({
    name: "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
    artists: "Daft Punk,Pharrell Williams,Nile Rodgers",
    album: "Random Access Memories",
    isrc: "USQX91300108",
  }),
  exportifyRow({
    name: "Bohemian Rhapsody - Remastered 2011",
    artists: "Queen",
    album: "A Night At The Opera (2011 Remaster)",
    isrc: "GBUM71029604",
  }),
].join("\n");

describe("Spotify (Exportify) parsing", () => {
  it("recognises an Exportify header", () => {
    expect(isSpotifyExport(exportify)).toBe(true);
    expect(isSpotifyExport(serializeCollection(tracks, "csv"))).toBe(false);
    expect(isSpotifyExport("Portishead - Roads")).toBe(false);
  });

  it("reads Exportify rows into tracks, splitting the artists on commas", () => {
    const parsed = parseCollection(exportify, "spotify", "tracks");
    expect(parsed).toEqual({
      kind: "tracks",
      items: [
        {
          title: "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
          artist: "Daft Punk, Pharrell Williams, Nile Rodgers",
          artists: ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
          album: "Random Access Memories",
          isrc: "USQX91300108",
        },
        {
          title: "Bohemian Rhapsody - Remastered 2011",
          artist: "Queen",
          artists: ["Queen"],
          album: "A Night At The Opera (2011 Remaster)",
          isrc: "GBUM71029604",
        },
      ],
    });
  });

  it("auto-detects an Exportify file given as plain CSV", () => {
    expect(effectiveImportFormat(exportify, "csv")).toBe("spotify");
    expect(effectiveImportFormat(serializeCollection(tracks, "csv"), "csv")).toBe("csv");
    expect(effectiveImportFormat(exportify, "text")).toBe("text");
    expect(parseCollection(exportify, "csv", "tracks")).toEqual(
      parseCollection(exportify, "spotify", "tracks"),
    );
  });

  it("tolerates other column orders, extra columns, the older 'Artist Name' and a BOM", () => {
    const older =
      "﻿Spotify ID,Popularity,Artist Name,Track Name,Album Name,Duration (ms),Genres\r\n" +
      "4uLU6hMCjMI75M1A2tKUQC,50,Portishead,Roads,Dummy,305000,trip hop\r\n";
    expect(isSpotifyExport(older)).toBe(true);
    expect(parseCollection(older, "spotify", "tracks").items).toEqual([
      { title: "Roads", artist: "Portishead", artists: ["Portishead"], album: "Dummy" },
    ]);
  });

  it("splits the artists on semicolons when a newer export uses them, keeping commas in names", () => {
    const newer = [
      EXPORTIFY_HEADER,
      exportifyRow({
        name: "EARFQUAKE",
        artists: "Tyler, The Creator;Playboi Carti",
        album: "IGOR",
        isrc: "USQX91900537",
      }),
      exportifyRow({ name: "Yonkers", artists: "Tyler, The Creator", album: "Goblin", isrc: "USQX91100001" }),
    ].join("\n");
    const items = parseCollection(newer, "spotify", "tracks").items;
    expect(items[0]).toMatchObject({
      artist: "Tyler, The Creator, Playboi Carti",
      artists: ["Tyler, The Creator", "Playboi Carti"],
    });
    // Without a semicolon there is no telling a comma in a name from a separator.
    expect(items[1]).toMatchObject({ artists: ["Tyler", "The Creator"] });
  });

  it("refuses to read a Spotify export as albums or artists", () => {
    expect(() => parseCollection(exportify, "spotify", "albums")).toThrow(/tracks/);
  });
});

describe("resolveImport by ISRC", () => {
  const getLucky = (over: Partial<Track>): Track => ({
    id: qid(0),
    title: "Get Lucky",
    artist: "Daft Punk",
    isrc: "USQX91300108",
    ...over,
  });

  it("searches by ISRC, keeps only exact ISRCs, and prefers the named album then quality", async () => {
    const searchTracks = vi.fn(async (query: string) =>
      query === "USQX91300108"
        ? [
            getLucky({ id: qid(1), album: "Summer Hits", bitDepth: 24, samplingRate: 96 }),
            getLucky({ id: qid(2), album: "Random Access Memories", bitDepth: 16, samplingRate: 44.1 }),
            getLucky({ id: qid(3), album: "Random Access Memories", bitDepth: 24, samplingRate: 88.2 }),
            getLucky({ id: 4, isrc: "USQX91300999", album: "Random Access Memories", bitDepth: 24, samplingRate: 192 }),
          ]
        : [],
    );
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [
        {
          title: "Get Lucky (feat. Pharrell Williams)",
          artist: "Daft Punk, Pharrell Williams",
          artists: ["Daft Punk", "Pharrell Williams"],
          album: "Random Access Memories",
          isrc: "usqx-91300108",
        },
      ],
    });
    expect(searchTracks).toHaveBeenCalledWith("USQX91300108", expect.any(Number));
    expect(plan.matched).toEqual([
      { label: "Daft Punk, Pharrell Williams - Get Lucky (feat. Pharrell Williams)", id: qid(3), via: "isrc" },
    ]);
  });

  it("prefers a streamable release over a better one Qobuz no longer streams", async () => {
    const searchTracks = vi.fn(async () => [
      getLucky({ id: qid(1), album: "Random Access Memories", bitDepth: 24, samplingRate: 192, streamable: false }),
      getLucky({ id: qid(2), album: "Compilation", bitDepth: 16, samplingRate: 44.1, streamable: true }),
    ]);
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [{ title: "Get Lucky", isrc: "USQX91300108", album: "Random Access Memories" }],
    });
    expect(plan.matched[0]).toMatchObject({ id: qid(2), via: "isrc" });
  });

  it("falls back to an artist and title search when the ISRC finds nothing", async () => {
    const searchTracks = vi.fn(async (query: string): Promise<Track[]> =>
      query === "Daft Punk Get Lucky"
        ? [
            { id: qid(8), title: "Get Lucky", artist: "Someone Else" },
            { id: qid(9), title: "Get Lucky", version: "feat. Pharrell Williams", artist: "Daft Punk feat. Pharrell Williams" },
          ]
        : [],
    );
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [
        {
          title: "Get Lucky (feat. Pharrell Williams)",
          artist: "Daft Punk, Pharrell Williams",
          artists: ["Daft Punk", "Pharrell Williams"],
          isrc: "XX0000000000",
        },
      ],
    });
    expect(searchTracks.mock.calls.map((call) => call[0])).toEqual([
      "XX0000000000",
      "Daft Punk Get Lucky",
    ]);
    expect(plan.matched).toEqual([
      { label: "Daft Punk, Pharrell Williams - Get Lucky (feat. Pharrell Williams)", id: qid(9), via: "search" },
    ]);
  });

  it("matches a Spotify ' - Live' title against Qobuz's title plus version", async () => {
    const searchTracks = vi.fn(async (): Promise<Track[]> => [
      { id: qid(5), title: "Roads", artist: "Portishead" },
      { id: qid(6), title: "Roads", version: "Live", artist: "Portishead" },
    ]);
    const plan = await resolveImport(fakeResolver({ searchTracks }), {
      kind: "tracks",
      items: [{ title: "Roads - Live", artist: "Portishead" }],
    });
    expect(plan.matched[0]).toMatchObject({ id: qid(6), via: "search" });
  });

  it("counts how each entry was matched", () => {
    expect(
      countMatchMethods({
        kind: "tracks",
        matched: [
          { label: "a", id: qid(1), via: "isrc" },
          { label: "b", id: qid(2), via: "isrc" },
          { label: "c", id: qid(3), via: "search" },
          { label: "d", id: qid(4), via: "id" },
          { label: "e", id: qid(5) },
        ],
        unmatched: ["f"],
      }),
    ).toEqual({ id: 1, isrc: 2, search: 2, unmatched: 1 }); // "e" has no via: a search
  });

  it("describes the counts for a report, leaving out methods that found nothing", () => {
    expect(describeMatchCounts({ id: 0, isrc: 12, search: 3, unmatched: 2 })).toBe(
      "12 by ISRC, 3 by artist and title",
    );
    expect(describeMatchCounts({ id: 4, isrc: 0, search: 0, unmatched: 0 })).toBe("4 by Qobuz id");
    expect(describeMatchCounts({ id: 0, isrc: 0, search: 0, unmatched: 5 })).toBe("");
  });
});

// --- Exporting every playlist -------------------------------------------------

describe("playlistFilenames", () => {
  it("sanitises characters that are unsafe in file names", () => {
    expect(playlistFilenames(['AC/DC: "Best" <of>?*|\\'], "csv")).toEqual([
      "AC_DC_ _Best_ _of_.csv",
    ]);
  });

  it("de-duplicates names case-insensitively, keeping the extension", () => {
    expect(playlistFilenames(["Chill", "chill", "Chill", "Chill (2)"], "m3u")).toEqual([
      "Chill.m3u",
      "chill (2).m3u",
      "Chill (3).m3u",
      "Chill (2) (2).m3u",
    ]);
  });

  it("names empty, dot-only and reserved names safely", () => {
    expect(playlistFilenames(["", "  ..  ", "CON", "nul.txt", "Mix. "], "txt")).toEqual([
      "playlist.txt",
      "playlist (2).txt",
      "_CON.txt",
      "_nul.txt.txt",
      "Mix.txt",
    ]);
  });

  it("caps very long names", () => {
    const [name] = playlistFilenames(["x".repeat(300)], "json");
    expect(name).toBe(`${"x".repeat(100)}.json`);
  });
});

describe("exportAllPlaylists", () => {
  it("serialises every playlist to its own file, in playlist order", async () => {
    const client: ExportClient = {
      ...fakeExportClient(),
      getUserPlaylists: async () => [
        { id: qid(7), name: "Chill" },
        { id: qid(8), name: "chill" },
      ],
      getPlaylistTracks: async (id) =>
        id === qid(7)
          ? [{ id: qid(2), title: "Glory Box", artist: "Portishead" }]
          : [{ id: qid(3), title: "Roads", artist: "Portishead" }],
    };
    const files = await exportAllPlaylists(client, "text");
    expect(files).toEqual([
      {
        filename: "Chill.txt",
        playlist: { id: qid(7), name: "Chill" },
        trackCount: 1,
        content: "Portishead - Glory Box\n",
      },
      {
        filename: "chill (2).txt",
        playlist: { id: qid(8), name: "chill" },
        trackCount: 1,
        content: "Portishead - Roads\n",
      },
    ]);
  });
});

describe("ids in exported files", () => {
  const tracks = [
    { id: tagId<TrackId>("qobuz", 12), title: "Roads", artist: "Portishead", isrc: "GB1" },
    { id: tagId<TrackId>("qobuz", 13), title: "Glory Box" },
  ];
  const albums = [{ id: tagId<AlbumId>("qobuz", "0060254735156"), title: "Dummy", artist: "Portishead" }];
  const artists = [{ id: tagId<ArtistId>("qobuz", 7), name: "Portishead" }];

  it("writes Qobuz's own ids, exactly as before", () => {
    expect(serializeCollection({ kind: "tracks", items: tracks }, "json")).toBe(
      `${JSON.stringify({ tracks: [{ id: 12, title: "Roads", artist: "Portishead", isrc: "GB1" }, { id: 13, title: "Glory Box" }] }, null, 2)}\n`,
    );
    expect(serializeCollection({ kind: "tracks", items: tracks }, "csv")).toBe(
      "title,artist,album,isrc,id\r\nRoads,Portishead,,GB1,12\r\nGlory Box,,,,13\r\n",
    );
    expect(serializeCollection({ kind: "albums", items: albums }, "csv")).toBe(
      "title,artist,id\r\nDummy,Portishead,0060254735156\r\n",
    );
    expect(serializeCollection({ kind: "artists", items: artists }, "csv")).toBe("name,id\r\nPortishead,7\r\n");
    expect(serializeCollection({ kind: "tracks", items: tracks }, "m3u")).toContain("\nqobuz://track/12\n");
  });

  it("writes and restores a backup with Qobuz's own ids", () => {
    const text = serializeBackup({
      formatVersion: 1,
      exportedAt: "x",
      favourites: { tracks, albums, artists },
      playlists: [{ name: "Mix", tracks }],
    });
    expect(JSON.parse(text)).toMatchObject({
      favourites: { tracks: [{ id: 12 }, { id: 13 }], albums: [{ id: "0060254735156" }], artists: [{ id: 7 }] },
      playlists: [{ tracks: [{ id: 12 }, { id: 13 }] }],
    });
    expect(parseBackup(text)).toMatchObject({
      favourites: { tracks, albums, artists },
      playlists: [{ name: "Mix", tracks }],
    });
  });

  it("leaves out of a backup what has no usable id, rather than writing it to the account", () => {
    const backup = parseBackup(
      JSON.stringify({ favourites: { tracks: [{ title: "no id" }, { id: 0 }, { id: 12 }], albums: [{}], artists: [{ id: "x" }] } }),
    );
    expect(backup.favourites.tracks.map((t) => t.id)).toEqual(["qobuz:12"]);
    expect(backup.favourites.albums).toEqual([]);
    expect(backup.favourites.artists).toEqual([]);
  });

  it.each(["json", "csv", "m3u"] as const)("reads back the ids of a %s file", (format) => {
    const text = serializeCollection({ kind: "tracks", items: tracks }, format);
    const parsed = parseCollection(text, format, "tracks");
    expect(parsed.items.map((item) => ("id" in item ? item.id : undefined))).toEqual(["qobuz:12", "qobuz:13"]);
  });
});

describe("ids in files from elsewhere", () => {
  const search = () => vi.fn(async () => [{ id: qid(5), title: "Roads", artist: "Portishead" }] as Track[]);

  it.each([
    ["json", JSON.stringify({ tracks: [{ id: "77640617", title: "Roads", artist: "Portishead" }] })],
    ["json", JSON.stringify({ tracks: [{ id: "spotify:track:4iV5", title: "Roads", artist: "Portishead" }] })],
    ["json", JSON.stringify({ tracks: [{ id: "tidal:9", title: "Roads", artist: "Portishead" }] })],
    ["csv", "title,artist,id\nRoads,Portishead,spotify:track:4iV5"],
    ["csv", "title,artist,id\nRoads,Portishead,4iV5W9uYEdYUVa79Axb7Rh"],
  ] as const)("searches for a %s entry whose id is not one of Qobuz's: %s", async (format, text) => {
    const searchTracks = search();
    const plan = await resolveImport({ searchTracks, searchAlbums: vi.fn(), searchArtists: vi.fn() } as never, parseCollection(text, format, "tracks"));
    expect(searchTracks).toHaveBeenCalled();
    expect(plan.matched).toEqual([{ label: "Portishead - Roads", id: qid(5), via: "search" }]);
  });

  it.each(["12", " 12 ", "12.0", "qobuz:12"])("takes the CSV id %j as Qobuz's", (id) => {
    const parsed = parseCollection(`title,artist,id\nRoads,Portishead,${id}`, "csv", "tracks");
    expect(parsed.items[0]).toMatchObject({ id: qid(12) });
  });

  it("restores nothing when a backup names a song of another service", async () => {
    const writer = { ...fakeWriter(), name: "qobuz" as const };
    const backup: LibraryBackup = {
      formatVersion: 1,
      exportedAt: "",
      favourites: { tracks: [{ id: qid(1), title: "a" }], albums: [], artists: [] },
      playlists: [{ name: "Mix", tracks: [{ id: tagId<TrackId>("tidal", 9), title: "c" }] }],
    };
    await expect(restoreBackup(writer, backup)).rejects.toMatchObject({ kind: "bad-id" });
    expect(writer.calls).toEqual({});
  });
});
