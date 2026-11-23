import { describe, expect, it, vi } from "vitest";

import type { Track } from "../services/model.js";
import {
  collectLibrary,
  computeStats,
  decadeOf,
  findDecade,
  formatStatsReport,
  listeningTime,
  qualityOf,
  type Library,
  type StatsClient,
} from "./stats.js";

function track(id: number, extra: Partial<Track> = {}): Track {
  return { id, title: `T${id}`, ...extra };
}

function favourites(...tracks: Track[]): Library {
  return { kind: "favourites", label: "Favourites", tracks };
}

describe("qualityOf", () => {
  it.each([
    [{ bitDepth: 24, samplingRate: 96 }, "hires"],
    [{ bitDepth: 24, samplingRate: 44.1 }, "hires"],
    [{ bitDepth: 16, samplingRate: 96 }, "hires"],
    [{ bitDepth: 16, samplingRate: 48 }, "cd"],
    [{ bitDepth: 16, samplingRate: 44.1 }, "cd"],
    [{ bitDepth: 16 }, "cd"],
    [{}, "unknown"],
    [{ hires: true }, "hires"],
    [{ bitDepth: 16, samplingRate: 44.1, hires: true }, "cd"],
  ] as const)("classifies %o as %s", (quality, expected) => {
    expect(qualityOf(quality)).toBe(expected);
  });
});

describe("decadeOf", () => {
  it("buckets a release date by decade", () => {
    expect(decadeOf("1994-08-22")).toBe("1990s");
    expect(decadeOf("2000-01-01")).toBe("2000s");
    expect(decadeOf("1969")).toBe("1960s");
  });

  it("puts a missing or malformed date in the unknown bucket", () => {
    expect(decadeOf(undefined)).toBe("unknown");
    expect(decadeOf("")).toBe("unknown");
    expect(decadeOf("n/a")).toBe("unknown");
  });
});

describe("listeningTime", () => {
  it("rounds to hours from an hour up, else to minutes", () => {
    expect(listeningTime(86 * 3600 + 1000)).toBe("86 hours");
    expect(listeningTime(3600)).toBe("1 hour");
    expect(listeningTime(42 * 60)).toBe("42 minutes");
    expect(listeningTime(60)).toBe("1 minute");
    expect(listeningTime(20)).toBe("Under a minute");
    expect(listeningTime(2000 * 3600)).toBe("2,000 hours");
  });
});

describe("computeStats", () => {
  const library = favourites(
    track(1, { artist: "Massive Attack", releaseDate: "1998-04-20", bitDepth: 24, samplingRate: 96, duration: 300, album: "Mezzanine", albumId: "m" }),
    track(2, { artist: "massive attack ", releaseDate: "1991-04-08", bitDepth: 16, samplingRate: 44.1, duration: 250, album: "Blue Lines", albumId: "b" }),
    track(3, { artist: "Portishead", releaseDate: "1994-08-22", duration: 280, album: "Dummy", albumId: "d" }),
    track(4, { artist: "Portishead", releaseDate: "1971-01-01", bitDepth: 16, samplingRate: 44.1, album: "Dummy", albumId: "d" }),
    track(5, { artist: "Tricky", bitDepth: 24, samplingRate: 48 }),
    track(6, {}),
  );
  const stats = computeStats(library);

  it("counts tracks, distinct artists (ignoring case) and the known duration", () => {
    expect(stats.trackCount).toBe(6);
    expect(stats.artistCount).toBe(3);
    expect(stats.totalDuration).toBe(830);
  });

  it("splits by quality", () => {
    expect(stats.quality).toEqual({ hires: 2, cd: 2, unknown: 2 });
  });

  it("lists every decade from the oldest to the newest, then the unknown bucket", () => {
    expect(stats.decades.map((d) => [d.key, d.label, d.count])).toEqual([
      ["1970s", "1970s", 1],
      ["1980s", "1980s", 0],
      ["1990s", "1990s", 3],
      ["unknown", "Unknown", 2],
    ]);
    expect(findDecade(stats, "1990s")).toMatchObject({
      trackIds: [1, 2, 3],
      suggestedName: "Favourites: 1990s",
    });
    expect(findDecade(stats, "UNKNOWN")?.suggestedName).toBe("Favourites: unknown year");
    expect(findDecade(stats, "1950s")).toBeUndefined();
  });

  it("ranks the top artists by track count, then name, with their share", () => {
    expect(stats.topArtists.map((a) => [a.label, a.count, a.trackIds])).toEqual([
      ["Massive Attack", 2, [1, 2]],
      ["Portishead", 2, [3, 4]],
      ["Tricky", 1, [5]],
    ]);
    expect(stats.topArtists[0]?.suggestedName).toBe("Favourites: Massive Attack");
    expect(stats.topArtistsShare).toBeCloseTo(5 / 6);
  });

  it("keeps only the top ten artists", () => {
    const many = computeStats(
      favourites(...Array.from({ length: 12 }, (_, i) => track(i, { artist: `A${String(i).padStart(2, "0")}` }))),
    );
    expect(many.topArtists).toHaveLength(10);
    expect(many.topArtistsShare).toBeCloseTo(10 / 12);
  });

  it("ranks albums by track count", () => {
    expect(stats.topAlbums[0]).toEqual({ title: "Dummy", artist: "Portishead", count: 2 });
    expect(stats.topAlbums).toHaveLength(3);
  });

  // Live data listed "The Ultimate Collection - Black Sabbath" twice (two
  // editions, two album ids) and kept Qobuz's trailing spaces in titles.
  it("counts editions of an album as one, by title and artist", () => {
    const editions = computeStats(
      favourites(
        track(1, { album: "The Ultimate Collection", albumId: "a", artist: "Black Sabbath" }),
        track(2, { album: "The Ultimate Collection ", albumId: "b", artist: "Black Sabbath" }),
        track(3, { album: "the ultimate  collection", albumId: "c", artist: "black sabbath" }),
        track(4, { album: "The Ultimate Collection", albumId: "d", artist: "Ozzy Osbourne" }),
      ),
    );
    expect(editions.topAlbums).toEqual([
      { title: "The Ultimate Collection", artist: "Black Sabbath", count: 3 },
      { title: "The Ultimate Collection", artist: "Ozzy Osbourne", count: 1 },
    ]);
  });

  it("writes a headline", () => {
    expect(stats.headline).toBe("6 favourite tracks by 3 artists. 14 minutes of music.");
  });

  it("words the headline for a playlist and for everything", () => {
    const one = [track(1, { artist: "A" })];
    expect(computeStats({ kind: "playlist", label: "Road Trip", tracks: one }).headline).toBe(
      "1 track in Road Trip by 1 artist.",
    );
    expect(computeStats({ kind: "everything", label: "Library", tracks: one }).headline).toBe(
      "1 track in your library by 1 artist.",
    );
  });

  it("copes with an empty library", () => {
    const empty = computeStats(favourites());
    expect(empty).toMatchObject({
      trackCount: 0,
      artistCount: 0,
      decades: [],
      topArtists: [],
      topArtistsShare: 0,
      headline: "0 favourite tracks.",
    });
  });

  it("formats thousands in the headline", () => {
    const big = computeStats(
      favourites(...Array.from({ length: 1240 }, (_, i) => track(i, { artist: "A", duration: 250 }))),
    );
    expect(big.headline).toBe("1,240 favourite tracks by 1 artist. 86 hours of music.");
  });
});

describe("collectLibrary", () => {
  function client(): StatsClient {
    return {
      getFavoriteTracks: vi.fn(async () => [track(1), track(2)]),
      getPlaylistTracks: vi.fn(async (id: number) => (id === 7 ? [track(2), track(3)] : [track(3), track(4)])),
      getUserPlaylists: vi.fn(async () => [
        { id: 7, name: "Road Trip" },
        { id: 8, name: "Late Night" },
      ]),
    };
  }

  it("reads favourites", async () => {
    const library = await collectLibrary(client(), { type: "favourites" });
    expect(library).toMatchObject({ kind: "favourites", label: "Favourites" });
    expect(library.tracks.map((t) => t.id)).toEqual([1, 2]);
  });

  it("reads a playlist under its name", async () => {
    const library = await collectLibrary(client(), { type: "playlist", playlistId: 7 });
    expect(library.label).toBe("Road Trip");
    expect(library.tracks.map((t) => t.id)).toEqual([2, 3]);
    const unknown = await collectLibrary(client(), { type: "playlist", playlistId: 99 });
    expect(unknown.label).toBe("Playlist 99");
  });

  it("reads everything, each track once", async () => {
    const library = await collectLibrary(client(), { type: "everything" });
    expect(library).toMatchObject({ kind: "everything", label: "Library" });
    expect(library.tracks.map((t) => t.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("formatStatsReport", () => {
  it("prints the headline, quality, decades, artists and albums", () => {
    const stats = computeStats(
      favourites(
        track(1, { artist: "Portishead", album: "Dummy", releaseDate: "1994-01-01", bitDepth: 24, samplingRate: 96 }),
        track(2, { artist: "Portishead", album: "Dummy", releaseDate: "1994-01-01", bitDepth: 16, samplingRate: 44.1 }),
      ),
    );
    expect(formatStatsReport(stats)).toBe(
      [
        "2 favourite tracks by 1 artist.",
        "",
        "Quality",
        "  Hi-res           1  (50%)",
        "  CD quality       1  (50%)",
        "",
        "By decade",
        "  1990s          2  (100%)",
        "",
        "Most-saved artists (100% of the tracks)",
        "   1. Portishead: 2",
        "",
        "Top albums",
        "   1. Dummy - Portishead: 2",
      ].join("\n"),
    );
  });
});
