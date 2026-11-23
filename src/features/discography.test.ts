import { describe, expect, it, vi } from "vitest";

import type { Release, Track } from "../services/model.js";
import {
  buildPlaylistFromDiscography,
  editionKey,
  parseIncludeList,
  resolveDiscography,
  type DiscographyPlaylistClient,
} from "./discography.js";
import { selectAlbumVersion } from "./playlist-from-albums.js";
import { compileTrackFilter } from "./track-filter.js";

function release(id: string, title: string, overrides: Partial<Release> = {}): Release {
  return {
    id,
    title,
    artist: "Portishead",
    artistId: 42,
    releaseType: "album",
    ...overrides,
  };
}

/** Portishead's releases, newest first as Qobuz lists them. */
const RELEASES: Release[] = [
  release("third-hr", "Third", { releaseDate: "2008-04-28", bitDepth: 24, samplingRate: 96 }),
  release("dummy-25", "Dummy (25th Anniversary Edition)", { releaseDate: "2019-08-22", bitDepth: 24, samplingRate: 44.1 }),
  release("roseland", "Roseland NYC Live", { releaseDate: "1998-11-02", releaseType: "live" }),
  release("portishead", "Portishead", { releaseDate: "1997-09-29", bitDepth: 16, samplingRate: 44.1 }),
  release("dummy", "Dummy", { releaseDate: "1994-08-22", bitDepth: 16, samplingRate: 44.1 }),
  release("sour", "Sour Times", { releaseDate: "1994-07-01", releaseType: "ep-single" }),
  release("various", "Trip-Hop Classics", { releaseDate: "2000-01-01", artistId: 99, artist: "Various Artists", releaseType: "compilation" }),
];

function stubClient(releases: Release[] = RELEASES, truncated = false) {
  return {
    searchArtists: vi.fn(async (query: string) =>
      query === "Nobody" ? [] : [{ id: 7, name: "Portishead Tribute" }, { id: 42, name: "Portishead" }],
    ),
    getArtistReleases: vi.fn(async () => ({ releases, truncated })),
  };
}

describe("parseIncludeList", () => {
  it("maps the include names to release types, without repeats", () => {
    expect(parseIncludeList("albums, eps,live,compilations,singles")).toEqual([
      "album",
      "ep-single",
      "live",
      "compilation",
    ]);
  });

  it("rejects unknown names and empty lists", () => {
    expect(() => parseIncludeList("albums,bootlegs")).toThrow(/bootlegs/);
    expect(() => parseIncludeList(" , ")).toThrow(/at least one/);
  });
});

describe("editionKey", () => {
  it("drops edition labels so editions of one album match", () => {
    const key = editionKey("Dummy");
    expect(editionKey("Dummy (Deluxe Edition)")).toBe(key);
    expect(editionKey("Dummy [2011 Remaster]")).toBe(key);
    expect(editionKey("Dummy - 25th Anniversary Edition")).toBe(key);
    expect(editionKey("DUMMY (Expanded)")).toBe(key);
  });

  it("keeps brackets and suffixes that are not editions", () => {
    expect(editionKey("Album (Part 2)")).not.toBe(editionKey("Album"));
    expect(editionKey("Dummy (Live)")).not.toBe(editionKey("Dummy"));
    expect(editionKey("F# A# - Infinity")).toBe("f a infinity");
  });
});

describe("resolveDiscography", () => {
  it("resolves the artist by exact name and lists studio albums oldest first, editions grouped", async () => {
    const client = stubClient();

    const result = await resolveDiscography(client, { artist: "portishead" });

    expect(result.artist).toEqual({ id: 42, name: "Portishead" });
    expect(client.getArtistReleases).toHaveBeenCalledWith(42);
    expect(result.resolvedAlbums.map((album) => album.query)).toEqual([
      "Portishead - Dummy",
      "Portishead - Portishead",
      "Portishead - Third",
    ]);
    // Dummy's original and its anniversary edition are one entry, original first.
    expect(result.resolvedAlbums[0]!.versions.map((v) => v.id)).toEqual(["dummy", "dummy-25"]);
    expect(result.resolvedAlbums[0]).toMatchObject({ artist: "Portishead", album: "Dummy" });
    expect(result).toMatchObject({ unresolvedAlbums: [], excludedAlbums: [], truncated: false });
  });

  it("lets the version preference pick one edition per album", async () => {
    const result = await resolveDiscography(stubClient(), { artist: "Portishead" });
    const dummy = result.resolvedAlbums[0]!.versions;

    expect(selectAlbumVersion(dummy, "highest-quality")?.id).toBe("dummy-25");
    expect(selectAlbumVersion(dummy, "oldest")?.id).toBe("dummy");
  });

  it("includes the requested kinds, never other artists' releases", async () => {
    const result = await resolveDiscography(stubClient(), {
      artist: "Portishead",
      include: ["ep-single", "live", "compilation"],
    });

    expect(result.resolvedAlbums.map((album) => album.album)).toEqual([
      "Sour Times",
      "Roseland NYC Live",
    ]);
  });

  it("lists every release on its own when asked for all versions", async () => {
    const result = await resolveDiscography(stubClient(), {
      artist: "Portishead",
      oneVersion: false,
    });

    expect(result.resolvedAlbums.map((album) => album.versions.map((v) => v.id))).toEqual([
      ["dummy"],
      ["portishead"],
      ["third-hr"],
      ["dummy-25"],
    ]);
  });

  it("drops editions an album term excludes, and reports albums left with none", async () => {
    const result = await resolveDiscography(stubClient(), {
      artist: "Portishead",
      filter: compileTrackFilter({ excludeAlbums: ["anniversary", "third"] }),
    });

    expect(result.resolvedAlbums[0]!.versions.map((v) => v.id)).toEqual(["dummy"]);
    expect(result.excludedAlbums).toEqual(["Portishead - Third"]);
  });

  it("reports a name that matches no artist, without fetching releases", async () => {
    const client = stubClient();

    const result = await resolveDiscography(client, { artist: "Nobody" });

    expect(result).toEqual({
      resolvedAlbums: [],
      unresolvedAlbums: ["Nobody"],
      excludedAlbums: [],
      truncated: false,
    });
    expect(client.getArtistReleases).not.toHaveBeenCalled();
  });

  it("passes on a truncated release list and sorts undated releases last", async () => {
    const result = await resolveDiscography(
      stubClient([release("undated", "Mystery"), release("dummy", "Dummy", { releaseDate: "1994-08-22" })], true),
      { artist: "Portishead" },
    );

    expect(result.truncated).toBe(true);
    expect(result.resolvedAlbums.map((album) => album.album)).toEqual(["Dummy", "Mystery"]);
  });
});

describe("buildPlaylistFromDiscography", () => {
  function writerClient(): DiscographyPlaylistClient & {
    addTracksToPlaylist: ReturnType<typeof vi.fn>;
    createPlaylist: ReturnType<typeof vi.fn>;
  } {
    const tracks: Record<string, Track[]> = {
      dummy: [{ id: 1, title: "Mysterons" }, { id: 2, title: "Sour Times" }],
      "dummy-25": [{ id: 11, title: "Mysterons" }],
      portishead: [{ id: 3, title: "Cowboys" }],
      "third-hr": [{ id: 4, title: "Silence" }],
    };
    return {
      ...stubClient(),
      getAlbumTracks: vi.fn(async (id: string) => tracks[id] ?? []),
      createPlaylist: vi.fn(async (name: string) => ({ id: 500, name })),
      addTracksToPlaylist: vi.fn(async () => {}),
    };
  }

  it("writes one version of each album, oldest album first", async () => {
    const client = writerClient();

    const result = await buildPlaylistFromDiscography(client, {
      artist: "Portishead",
      playlistName: "All of Portishead",
      preference: "oldest",
    });

    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(500, [1, 2, 3, 4]);
    expect(result.artist).toEqual({ id: 42, name: "Portishead" });
    expect(result.trackCount).toBe(4);
    expect(result.resolvedAlbums.map((album) => album.album.id)).toEqual([
      "dummy",
      "portishead",
      "third-hr",
    ]);
  });

  it("refuses to create an empty playlist", async () => {
    const client = writerClient();

    await expect(
      buildPlaylistFromDiscography(client, { artist: "Nobody", playlistName: "x" }),
    ).rejects.toThrow(/No artist found/);
    await expect(
      buildPlaylistFromDiscography(client, {
        artist: "Portishead",
        playlistName: "x",
        include: ["compilation"],
      }),
    ).rejects.toThrow(/No releases/);
    expect(client.createPlaylist).not.toHaveBeenCalled();
  });
});
