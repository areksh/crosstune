import { describe, expect, it } from "vitest";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseDedupeArgs,
  parseExportArgs,
  parseImportArgs,
  parsePlaylistArgs,
  parseSimilarArgs,
} from "./args.js";

describe("extractLogLevel", () => {
  it("defaults to info and leaves the arguments untouched", () => {
    expect(extractLogLevel(["deduplicate", "--favourites"])).toEqual({
      level: "info",
      rest: ["deduplicate", "--favourites"],
    });
  });

  it("extracts --loglevel and strips it from the rest", () => {
    expect(
      extractLogLevel(["--loglevel", "debug", "check"]),
    ).toEqual({ level: "debug", rest: ["check"] });
  });

  it("accepts the --loglevel=<level> form anywhere in the arguments", () => {
    expect(
      extractLogLevel(["deduplicate", "--loglevel=warn", "--favourites"]),
    ).toEqual({ level: "warn", rest: ["deduplicate", "--favourites"] });
  });

  it("throws on an invalid level", () => {
    expect(() => extractLogLevel(["--loglevel", "verbose"])).toThrow(
      /loglevel/i,
    );
  });

  it("throws when --loglevel has no value", () => {
    expect(() => extractLogLevel(["check", "--loglevel"])).toThrow(/loglevel/i);
  });
});

describe("parsePlaylistArgs", () => {
  it("parses the name, artists, track count and public flag", () => {
    const parsed = parsePlaylistArgs([
      "--name",
      "Trip Hop",
      "--tracks",
      "5",
      "--public",
      "Portishead",
      "Massive Attack",
    ]);
    expect(parsed).toEqual({
      playlistName: "Trip Hop",
      tracksPerArtist: 5,
      isPublic: true,
      artists: ["Portishead", "Massive Attack"],
    });
  });

  it("defaults isPublic to false and leaves tracksPerArtist unset", () => {
    const parsed = parsePlaylistArgs(["--name", "Mix", "Wire"]);
    expect(parsed.isPublic).toBe(false);
    expect(parsed.tracksPerArtist).toBeUndefined();
    expect(parsed.artists).toEqual(["Wire"]);
  });

  it("throws when --name is missing", () => {
    expect(() => parsePlaylistArgs(["Artist"])).toThrow(/name/i);
  });

  it("throws when --tracks is not a positive integer", () => {
    expect(() =>
      parsePlaylistArgs(["--name", "x", "--tracks", "abc", "A"]),
    ).toThrow(/tracks/i);
    expect(() =>
      parsePlaylistArgs(["--name", "x", "--tracks", "0", "A"]),
    ).toThrow(/tracks/i);
  });

  it("collects repeated --exclude-track and --exclude-album terms", () => {
    const parsed = parsePlaylistArgs([
      "--name",
      "x",
      "--exclude-track",
      "live",
      "--exclude-album",
      "greatest hits",
      "--exclude-track",
      "/remix|edit/",
      "A",
    ]);
    expect(parsed.filter).toEqual({
      excludeTracks: ["live", "/remix|edit/"],
      excludeAlbums: ["greatest hits"],
      excludeArtists: [],
    });
    expect(parsed.artists).toEqual(["A"]);
  });

  it("collects repeated --exclude-artist names", () => {
    const parsed = parsePlaylistArgs([
      "--name",
      "x",
      "--exclude-artist",
      "Drake",
      "--exclude-artist",
      "/^the /",
      "A",
    ]);
    expect(parsed.filter).toEqual({
      excludeTracks: [],
      excludeAlbums: [],
      excludeArtists: ["Drake", "/^the /"],
    });
    expect(parsed.artists).toEqual(["A"]);
  });

  it("rejects an --exclude-artist with no value or an invalid regex", () => {
    expect(() => parsePlaylistArgs(["--name", "x", "--exclude-artist"])).toThrow(
      /--exclude-artist/,
    );
    expect(() =>
      parsePlaylistArgs(["--name", "x", "--exclude-artist", "/[/", "A"]),
    ).toThrow(/\/\[\//);
  });

  it("omits the filter when no exclude flag is given", () => {
    expect(parsePlaylistArgs(["--name", "x", "A"]).filter).toBeUndefined();
  });

  it("rejects an exclude flag with no value or an invalid regex", () => {
    expect(() => parsePlaylistArgs(["--name", "x", "--exclude-track"])).toThrow(
      /--exclude-track/,
    );
    expect(() =>
      parsePlaylistArgs(["--name", "x", "--exclude-album", "/(oops/", "A"]),
    ).toThrow(/\/\(oops\//);
  });
});

describe("parseAlbumArgs", () => {
  it("parses the name, album lines, preference and public flag", () => {
    const parsed = parseAlbumArgs([
      "--name",
      "Classics",
      "--prefer",
      "oldest",
      "--public",
      "Radiohead - OK Computer",
      "Daft Punk - Discovery",
    ]);
    expect(parsed).toEqual({
      playlistName: "Classics",
      preference: "oldest",
      isPublic: true,
      entries: ["Radiohead - OK Computer", "Daft Punk - Discovery"],
    });
  });

  it("defaults preference to highest-quality and isPublic to false", () => {
    const parsed = parseAlbumArgs(["--name", "Mix", "Wire - Pink Flag"]);
    expect(parsed.preference).toBe("highest-quality");
    expect(parsed.isPublic).toBe(false);
    expect(parsed.entries).toEqual(["Wire - Pink Flag"]);
  });

  it("throws when --name is missing", () => {
    expect(() => parseAlbumArgs(["Radiohead - OK Computer"])).toThrow(/name/i);
  });

  it("throws on an unsupported --prefer value", () => {
    expect(() =>
      parseAlbumArgs(["--name", "x", "--prefer", "cheapest", "A - B"]),
    ).toThrow(/prefer/i);
  });

  it("parses exclude terms and a --discs list into a filter", () => {
    const parsed = parseAlbumArgs([
      "--name",
      "x",
      "--discs",
      "1,3-4",
      "--exclude-track",
      "demo",
      "--exclude-album",
      "live",
      "--exclude-artist",
      "Various Artists",
      "A - B",
    ]);
    expect(parsed.filter).toEqual({
      excludeTracks: ["demo"],
      excludeAlbums: ["live"],
      excludeArtists: ["Various Artists"],
      discs: [1, 3, 4],
    });
    expect(parsed.entries).toEqual(["A - B"]);
  });

  it("rejects a malformed or missing --discs list", () => {
    expect(() => parseAlbumArgs(["--name", "x", "--discs", "two", "A - B"])).toThrow(
      /disc/i,
    );
    expect(() => parseAlbumArgs(["--name", "x", "--discs"])).toThrow(/--discs/);
  });
});

describe("parseDedupeArgs", () => {
  it("parses a playlist source with defaults (first-added, report-only)", () => {
    expect(parseDedupeArgs(["--playlist", "555"])).toEqual({
      source: { type: "playlist", playlistId: 555 },
      keep: "first-added",
      apply: false,
    });
  });

  it("parses a favourites source (both spellings)", () => {
    expect(parseDedupeArgs(["--favourites"]).source).toEqual({
      type: "favourites",
    });
    expect(parseDedupeArgs(["--favorites"]).source).toEqual({
      type: "favourites",
    });
  });

  it("parses the supported --keep strategies", () => {
    for (const keep of [
      "first-added",
      "last-added",
      "highest-quality",
      "oldest",
      "newest",
    ] as const) {
      expect(parseDedupeArgs(["--favourites", "--keep", keep]).keep).toBe(keep);
    }
  });

  it("parses --apply", () => {
    expect(parseDedupeArgs(["--favourites", "--apply"]).apply).toBe(true);
  });

  it("throws on an unsupported --keep strategy", () => {
    expect(() =>
      parseDedupeArgs(["--favourites", "--keep", "cheapest"]),
    ).toThrow(/keep/i);
  });

  it("throws when no source is given", () => {
    expect(() => parseDedupeArgs([])).toThrow(/source/i);
  });

  it("throws when both sources are given", () => {
    expect(() =>
      parseDedupeArgs(["--playlist", "1", "--favourites"]),
    ).toThrow(/only one/i);
  });

  it("throws on a non-numeric playlist id", () => {
    expect(() => parseDedupeArgs(["--playlist", "abc"])).toThrow(/playlist/i);
  });
});

describe("parseExportArgs", () => {
  it("parses a favourites source with a format", () => {
    expect(parseExportArgs(["--favourites", "--format", "csv"])).toEqual({
      source: { type: "favourite-tracks" },
      format: "csv",
    });
  });

  it("parses a playlist source and an output file", () => {
    expect(parseExportArgs(["--playlist", "42", "--out", "list.m3u"])).toEqual({
      source: { type: "playlist", playlistId: 42 },
      out: "list.m3u",
    });
  });

  it("parses an account backup source", () => {
    expect(parseExportArgs(["--account"])).toEqual({ source: { type: "account" } });
  });

  it("requires a source", () => {
    expect(() => parseExportArgs(["--format", "csv"])).toThrow(/source is required/);
  });

  it("rejects more than one source", () => {
    expect(() => parseExportArgs(["--favourites", "--account"])).toThrow(/only one/);
  });

  it("rejects an invalid format and a non-numeric playlist id", () => {
    expect(() => parseExportArgs(["--favourites", "--format", "xml"])).toThrow(/--format/);
    expect(() => parseExportArgs(["--playlist", "x"])).toThrow(/numeric id/);
  });
});

describe("parseImportArgs", () => {
  it("parses a favourites target and a file", () => {
    expect(parseImportArgs(["--favourites", "tracks.csv"])).toEqual({
      target: { type: "favourites" },
      file: "tracks.csv",
      isPublic: false,
      apply: false,
    });
  });

  it("parses a new-playlist target with public and apply", () => {
    expect(
      parseImportArgs(["--new-playlist", "Mix", "--public", "--apply", "in.txt"]),
    ).toEqual({
      target: { type: "playlist-new", name: "Mix" },
      file: "in.txt",
      isPublic: true,
      apply: true,
    });
  });

  it("parses an account restore target", () => {
    expect(parseImportArgs(["--account", "backup.json"])).toEqual({
      target: { type: "account" },
      file: "backup.json",
      isPublic: false,
      apply: false,
    });
  });

  it("requires a target and exactly one file", () => {
    expect(() => parseImportArgs(["file.csv"])).toThrow(/target is required/);
    expect(() => parseImportArgs(["--favourites"])).toThrow(/file to import is required/);
    expect(() => parseImportArgs(["--favourites", "a.csv", "b.csv"])).toThrow(/only one file/);
  });

  it("rejects more than one target", () => {
    expect(() => parseImportArgs(["--favourites", "--account", "f.json"])).toThrow(/only one/);
  });
});

describe("parseSimilarArgs", () => {
  it("parses an artists source with defaults", () => {
    expect(parseSimilarArgs(["--name", "Grunge", "Nirvana", "Hole"])).toEqual({
      source: {
        type: "artists",
        playlistName: "Grunge",
        artists: ["Nirvana", "Hole"],
        tracksPerSeed: 5,
        isPublic: false,
      },
      similarPerArtist: 3,
      depth: 1,
      tracksPerSimilar: 3,
      maxArtists: 100,
      yes: false,
      replaceRepeats: false,
    });
  });

  it("parses every option of an artists source", () => {
    const parsed = parseSimilarArgs([
      "--name",
      "Metal",
      "--similar",
      "5",
      "--depth",
      "2",
      "--tracks",
      "4",
      "--seed-tracks",
      "0",
      "--max-artists",
      "250",
      "--yes",
      "--replace-repeats",
      "--public",
      "--exclude-track",
      "live",
      "Metallica",
    ]);
    expect(parsed).toEqual({
      source: {
        type: "artists",
        playlistName: "Metal",
        artists: ["Metallica"],
        tracksPerSeed: 0,
        isPublic: true,
      },
      similarPerArtist: 5,
      depth: 2,
      tracksPerSimilar: 4,
      maxArtists: 250,
      yes: true,
      replaceRepeats: true,
      filter: { excludeTracks: ["live"], excludeAlbums: [], excludeArtists: [] },
    });
  });

  it("parses a playlist source", () => {
    expect(parseSimilarArgs(["--playlist", "42", "--seeds", "8", "--apply"])).toEqual({
      source: { type: "playlist", playlistId: 42, maxSeeds: 8, apply: true },
      similarPerArtist: 3,
      depth: 1,
      tracksPerSimilar: 3,
      maxArtists: 100,
      yes: false,
      replaceRepeats: false,
    });
    expect(
      parseSimilarArgs(["--playlist", "42", "--exclude-artist", "Drake"]).filter,
    ).toEqual({ excludeTracks: [], excludeAlbums: [], excludeArtists: ["Drake"] });
    expect(parseSimilarArgs(["--playlist", "42"]).source).toEqual({
      type: "playlist",
      playlistId: 42,
      maxSeeds: 10,
      apply: false,
    });
  });

  it("requires exactly one of --name and --playlist", () => {
    expect(() => parseSimilarArgs(["Nirvana"])).toThrow(/--name.*--playlist/);
    expect(() => parseSimilarArgs(["--name", "x", "--playlist", "1"])).toThrow(/only one/i);
  });

  it("rejects options that belong to the other source", () => {
    expect(() => parseSimilarArgs(["--name", "x", "--apply", "A"])).toThrow(/--apply/);
    expect(() => parseSimilarArgs(["--name", "x", "--seeds", "3", "A"])).toThrow(/--seeds/);
    expect(() => parseSimilarArgs(["--playlist", "1", "--seed-tracks", "2"])).toThrow(
      /--seed-tracks/,
    );
    expect(() => parseSimilarArgs(["--playlist", "1", "--public"])).toThrow(/--public/);
    expect(() => parseSimilarArgs(["--playlist", "1", "Nirvana"])).toThrow(/Nirvana/);
  });

  it("has no upper limit on --similar, --depth or --max-artists", () => {
    const parsed = parseSimilarArgs([
      "--name",
      "x",
      "--similar",
      "70",
      "--depth",
      "8",
      "--max-artists",
      "5000",
      "A",
    ]);
    expect([parsed.similarPerArtist, parsed.depth, parsed.maxArtists]).toEqual([70, 8, 5000]);
  });

  it.each([
    ["--similar", "0"],
    ["--depth", "0"],
    ["--max-artists", "0"],
    ["--tracks", "31"],
    ["--tracks", "two"],
    ["--seed-tracks", "-1"],
  ])("rejects %s %s", (flag, value) => {
    expect(() => parseSimilarArgs(["--name", "x", flag, value, "A"])).toThrow(flag);
  });

  it("rejects a bad playlist id or seed count", () => {
    expect(() => parseSimilarArgs(["--playlist", "abc"])).toThrow(/--playlist/);
    expect(() => parseSimilarArgs(["--playlist", "1", "--seeds", "0"])).toThrow(/--seeds/);
  });

  it("rejects --discs, which only the album tool has", () => {
    expect(() => parseSimilarArgs(["--name", "x", "--discs", "1", "A"])).toThrow(/--discs/);
  });
});
