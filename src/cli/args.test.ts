import { describe, expect, it } from "vitest";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseCombineArgs,
  parseDedupeArgs,
  parseExportArgs,
  parseHistoryArgs,
  parseImportArgs,
  parseNewReleasesArgs,
  parsePlaylistArgs,
  parseSimilarArgs,
  parseStatsArgs,
  parseUndoArgs,
  parseUpgradeArgs,
  parseWordPlayArgs,
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

  it("parses a discography with its defaults (studio albums, one version each)", () => {
    const parsed = parseAlbumArgs(["--name", "All", "--discography", "Portishead"]);
    expect(parsed).toEqual({
      playlistName: "All",
      preference: "highest-quality",
      isPublic: false,
      entries: [],
      discography: { artist: "Portishead", include: ["album"], allVersions: false },
    });
  });

  it("parses --include and --all-versions with a discography", () => {
    const parsed = parseAlbumArgs([
      "--name",
      "All",
      "--discography",
      "Portishead",
      "--include",
      "albums,eps,live,compilations",
      "--all-versions",
      "--prefer",
      "oldest",
    ]);
    expect(parsed.discography).toEqual({
      artist: "Portishead",
      include: ["album", "ep-single", "live", "compilation"],
      allVersions: true,
    });
    expect(parsed.preference).toBe("oldest");
  });

  it("rejects an invalid discography", () => {
    expect(() => parseAlbumArgs(["--name", "x", "--discography"])).toThrow(/artist/);
    expect(() =>
      parseAlbumArgs(["--name", "x", "--discography", "A", "--include", "bootlegs"]),
    ).toThrow(/bootlegs/);
    expect(() => parseAlbumArgs(["--name", "x", "--discography", "A", "B - C"])).toThrow(
      /not both/,
    );
    expect(() => parseAlbumArgs(["--name", "x", "--include", "live", "B - C"])).toThrow(
      /--discography/,
    );
    expect(() => parseAlbumArgs(["--name", "x", "--all-versions", "B - C"])).toThrow(
      /--discography/,
    );
  });
});

describe("parseDedupeArgs", () => {
  it("parses a playlist source with defaults (first-added, report-only)", () => {
    expect(parseDedupeArgs(["--playlist", "555"])).toEqual({
      source: { type: "playlist", playlistId: 555 },
      keep: ["first-added"],
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
      expect(parseDedupeArgs(["--favourites", "--keep", keep]).keep).toEqual([keep]);
    }
  });

  it("parses a comma-separated --keep chain", () => {
    expect(
      parseDedupeArgs(["--favourites", "--keep", "highest-quality, oldest"]).keep,
    ).toEqual(["highest-quality", "oldest"]);
  });

  it("throws when any part of a --keep chain is unknown, or it is empty", () => {
    expect(() =>
      parseDedupeArgs(["--favourites", "--keep", "highest-quality,cheapest"]),
    ).toThrow(/keep/i);
    expect(() => parseDedupeArgs(["--favourites", "--keep", "oldest,"])).toThrow(/keep/i);
    expect(() => parseDedupeArgs(["--favourites", "--keep"])).toThrow(/keep/i);
  });

  it("parses the all-playlists source", () => {
    expect(parseDedupeArgs(["--all-playlists"]).source).toEqual({ type: "all-playlists" });
    expect(() => parseDedupeArgs(["--all-playlists", "--favourites"])).toThrow(/only one/i);
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

  it("parses every playlist into an output directory", () => {
    expect(
      parseExportArgs(["--all-playlists", "--out-dir", "lists", "--format", "m3u"]),
    ).toEqual({
      source: { type: "all-playlists" },
      format: "m3u",
      outDir: "lists",
    });
  });

  it("requires --out-dir with --all-playlists, and only there", () => {
    expect(() => parseExportArgs(["--all-playlists"])).toThrow(/--out-dir/);
    expect(() => parseExportArgs(["--all-playlists", "--out-dir", "d", "--out", "f"])).toThrow(
      /--out-dir/,
    );
    expect(() => parseExportArgs(["--favourites", "--out-dir", "d"])).toThrow(/--all-playlists/);
    expect(() => parseExportArgs(["--all-playlists", "--out-dir"])).toThrow(/--out-dir/);
  });

  it("refuses a Spotify format for export (it is import-only)", () => {
    expect(() => parseExportArgs(["--favourites", "--format", "spotify"])).toThrow(/--format/);
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

  it("accepts the import-only spotify format", () => {
    expect(parseImportArgs(["--new-playlist", "From Spotify", "--format", "spotify", "x.csv"])).toEqual({
      target: { type: "playlist-new", name: "From Spotify" },
      file: "x.csv",
      format: "spotify",
      isPublic: false,
      apply: false,
    });
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

describe("parseCombineArgs", () => {
  it("takes the inputs in the order given, with defaults", () => {
    expect(parseCombineArgs(["--playlist", "12", "--favourites", "--playlist", "34"])).toEqual({
      sources: [
        { type: "playlist", playlistId: 12 },
        { type: "favourites" },
        { type: "playlist", playlistId: 34 },
      ],
      mode: "merge",
      order: "sequential",
      keep: "highest-quality",
      matchSongs: true,
      isPublic: false,
      apply: false,
    });
  });

  it("parses every option", () => {
    expect(
      parseCombineArgs([
        "--favorites",
        "--playlist",
        "1",
        "--mode",
        "common",
        "--order",
        "shuffle",
        "--keep",
        "first",
        "--exact-ids-only",
        "--name",
        "Both",
        "--public",
        "--apply",
      ]),
    ).toEqual({
      sources: [{ type: "favourites" }, { type: "playlist", playlistId: 1 }],
      mode: "common",
      order: "shuffle",
      keep: "first",
      matchSongs: false,
      playlistName: "Both",
      isPublic: true,
      apply: true,
    });
  });

  it("needs at least two inputs", () => {
    expect(() => parseCombineArgs(["--playlist", "1"])).toThrow(/at least two/);
  });

  it("rejects an input given twice", () => {
    expect(() => parseCombineArgs(["--favourites", "--favourites"])).toThrow(/only once/);
  });

  it("rejects a non-numeric playlist id", () => {
    expect(() => parseCombineArgs(["--playlist", "abc", "--favourites"])).toThrow(
      /numeric id/,
    );
  });

  it.each([
    ["--mode", "union"],
    ["--order", "random"],
    ["--keep", "newest"],
  ])("rejects an invalid %s", (flag, value) => {
    expect(() =>
      parseCombineArgs(["--playlist", "1", "--favourites", flag, value]),
    ).toThrow(new RegExp(`${flag} must be one of`));
  });

  it("rejects an empty name and unknown arguments", () => {
    expect(() => parseCombineArgs(["--playlist", "1", "--favourites", "--name", " "])).toThrow(
      /--name/,
    );
    expect(() => parseCombineArgs(["--playlist", "1", "--favourites", "--dry"])).toThrow(
      /Unknown argument/,
    );
  });
});

describe("parseStatsArgs", () => {
  it("takes one source", () => {
    expect(parseStatsArgs(["--favourites"])).toEqual({ source: { type: "favourites" }, json: false });
    expect(parseStatsArgs(["--favorites", "--json"])).toEqual({
      source: { type: "favourites" },
      json: true,
    });
    expect(parseStatsArgs(["--playlist", "12"])).toEqual({
      source: { type: "playlist", playlistId: 12 },
      json: false,
    });
    expect(parseStatsArgs(["--everything"])).toEqual({ source: { type: "everything" }, json: false });
  });

  it("needs exactly one source", () => {
    expect(() => parseStatsArgs([])).toThrow(/source is required/);
    expect(() => parseStatsArgs(["--favourites", "--everything"])).toThrow(/only one/);
    expect(() => parseStatsArgs(["--playlist", "x"])).toThrow(/numeric id/);
  });

  it("parses a decade playlist with its name, visibility and --apply", () => {
    expect(
      parseStatsArgs([
        "--favourites",
        "--decade-playlist",
        "1990s",
        "--name",
        "Nineties",
        "--public",
        "--apply",
      ]),
    ).toEqual({
      source: { type: "favourites" },
      json: false,
      decadePlaylist: { decade: "1990s", name: "Nineties", isPublic: true, apply: true },
    });
    expect(parseStatsArgs(["--everything", "--decade-playlist", "Unknown"]).decadePlaylist).toEqual({
      decade: "unknown",
      isPublic: false,
      apply: false,
    });
  });

  it.each(["1995", "90s", "1990", "nineties"])("rejects the decade %s", (decade) => {
    expect(() => parseStatsArgs(["--favourites", "--decade-playlist", decade])).toThrow(
      /--decade-playlist must be a decade/,
    );
  });

  it("allows --name, --public and --apply only with --decade-playlist", () => {
    expect(() => parseStatsArgs(["--favourites", "--apply"])).toThrow(
      /--apply only applies with --decade-playlist/,
    );
    expect(() => parseStatsArgs(["--favourites", "--name", "x"])).toThrow(/--name only applies/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseStatsArgs(["--favourites", "--top", "5"])).toThrow(/Unknown argument/);
  });
});

describe("parseWordPlayArgs", () => {
  const defaults = {
    ignorePunctuation: true,
    ignoreVersions: true,
    closeForms: false,
    onePerArtist: true,
    preferHires: false,
  };

  it("parses a sentence with defaults (report only)", () => {
    expect(parseWordPlayArgs(["--sentence", "a quick brown fox"])).toEqual({
      request: { mode: "sentence", text: "a quick brown fox" },
      match: defaults,
      isPublic: false,
      apply: false,
    });
  });

  it("parses the sentence options", () => {
    expect(
      parseWordPlayArgs(["--sentence", "x y", "--split", "words", "--max-span", "3"]).request,
    ).toEqual({ mode: "sentence", text: "x y", split: "words", maxSpan: 3 });
  });

  it("parses contains and exact with a count", () => {
    expect(parseWordPlayArgs(["--contains", "night", "--count", "10"]).request).toEqual({
      mode: "contains",
      text: "night",
      count: 10,
    });
    expect(parseWordPlayArgs(["--exact", "home"]).request).toEqual({
      mode: "exact",
      text: "home",
    });
  });

  it("parses acrostic and A-to-Z sources", () => {
    expect(parseWordPlayArgs(["--acrostic", "QOBUZ", "--favorites"]).request).toEqual({
      mode: "acrostic",
      text: "QOBUZ",
      source: { type: "favourites" },
    });
    expect(parseWordPlayArgs(["--a-to-z", "--playlist", "42"]).request).toEqual({
      mode: "a-to-z",
      source: { type: "playlist", playlistId: 42 },
    });
  });

  it("parses the matching flags", () => {
    expect(
      parseWordPlayArgs([
        "--exact",
        "x",
        "--close-forms",
        "--keep-punctuation",
        "--keep-versions",
        "--allow-repeat-artists",
        "--prefer-hires",
      ]).match,
    ).toEqual({
      ignorePunctuation: false,
      ignoreVersions: false,
      closeForms: true,
      onePerArtist: false,
      preferHires: true,
    });
  });

  it("parses the destination, --apply and filters", () => {
    expect(
      parseWordPlayArgs([
        "--exact",
        "x",
        "--name",
        "Mine",
        "--public",
        "--apply",
        "--exclude-artist",
        "Drake",
      ]),
    ).toMatchObject({
      name: "Mine",
      isPublic: true,
      apply: true,
      filter: { excludeArtists: ["Drake"], excludeTracks: [], excludeAlbums: [] },
    });
    expect(parseWordPlayArgs(["--exact", "x", "--add-to", "7"]).addTo).toBe(7);
  });

  it.each([
    [[], /mode is required/],
    [["--exact", "x", "--contains", "y"], /only one/],
    [["--sentence"], /requires a value/],
    [["--exact", "x", "--split", "words"], /--split does not apply/],
    [["--sentence", "x", "--count", "5"], /--count does not apply/],
    [["--sentence", "x", "--favourites"], /--favourites does not apply/],
    [["--sentence", "x", "--split", "longest"], /--split must be one of/],
    [["--sentence", "x", "--max-span", "9"], /--max-span/],
    [["--contains", "x", "--count", "0"], /--count/],
    [["--acrostic", "x"], /needs a source/],
    [["--a-to-z", "--favourites", "--playlist", "1"], /only one of --favourites/],
    [["--a-to-z", "--playlist", "abc"], /numeric id/],
    [["--exact", "x", "--add-to", "1", "--name", "y"], /--add-to/],
    [["--exact", "x", "positional"], /Unknown argument/],
  ])("rejects %j", (argv, error) => {
    expect(() => parseWordPlayArgs(argv)).toThrow(error);
  });
});

describe("parseNewReleasesArgs", () => {
  it("defaults to favourite artists, the default window, albums and EPs, report only", () => {
    expect(parseNewReleasesArgs([])).toEqual({
      source: { type: "favourites" },
      include: ["album", "ep-single"],
      apply: false,
    });
  });

  it("parses the window, source, kinds and filters", () => {
    expect(
      parseNewReleasesArgs([
        "--since",
        "2026-10-01",
        "--playlist",
        "123",
        "--include",
        "albums,live",
        "--exclude-artist",
        "Drake",
      ]),
    ).toEqual({
      source: { type: "playlist", playlistId: 123 },
      since: "2026-10-01",
      include: ["album", "live"],
      apply: false,
      filter: { excludeTracks: [], excludeAlbums: [], excludeArtists: ["Drake"] },
    });
    expect(parseNewReleasesArgs(["--days", "7"]).days).toBe(7);
  });

  it("parses a destination, written only with --apply", () => {
    expect(parseNewReleasesArgs(["--name", "Fresh", "--public"])).toMatchObject({
      target: { type: "playlist", name: "Fresh", isPublic: true },
      apply: false,
    });
    expect(parseNewReleasesArgs(["--favourite-albums", "--apply"])).toMatchObject({
      target: { type: "favourite-albums" },
      apply: true,
    });
    expect(parseNewReleasesArgs(["--favorite-albums"]).target).toEqual({
      type: "favourite-albums",
    });
  });

  it("rejects invalid or conflicting options", () => {
    const cases: Array<[string[], RegExp]> = [
      [["--since", "2026-13-01"], /--since/],
      [["--since"], /--since/],
      [["--days", "0"], /--days/],
      [["--since", "2026-10-01", "--days", "3"], /only one of/],
      [["--playlist", "abc"], /--playlist/],
      [["--include", "bootlegs"], /bootlegs/],
      [["--name"], /--name/],
      [["--name", "x", "--favourite-albums"], /one destination/],
      [["--public"], /--public/],
      [["--apply"], /destination/],
      [["--frobnicate"], /Unknown argument/],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseNewReleasesArgs(argv)).toThrow(message);
    }
  });
});

describe("parseUpgradeArgs", () => {
  it("parses each source, report-only by default", () => {
    expect(parseUpgradeArgs(["--favourites"])).toEqual({
      source: { type: "favourites" },
      allowSignatureMatch: false,
      removeUnplayable: false,
      apply: false,
    });
    expect(parseUpgradeArgs(["--favorites"]).source).toEqual({ type: "favourites" });
    expect(parseUpgradeArgs(["--playlist", "42"]).source).toEqual({
      type: "playlist",
      playlistId: 42,
    });
    expect(parseUpgradeArgs(["--all-playlists"]).source).toEqual({ type: "all-playlists" });
  });

  it("parses the options", () => {
    expect(
      parseUpgradeArgs([
        "--all-playlists",
        "--allow-signature-match",
        "--remove-unplayable",
        "--apply",
      ]),
    ).toEqual({
      source: { type: "all-playlists" },
      allowSignatureMatch: true,
      removeUnplayable: true,
      apply: true,
    });
  });

  it("requires exactly one source", () => {
    expect(() => parseUpgradeArgs([])).toThrow(/source is required/);
    expect(() => parseUpgradeArgs(["--favourites", "--all-playlists"])).toThrow(/only one/);
  });

  it("rejects a bad playlist id and unknown arguments", () => {
    expect(() => parseUpgradeArgs(["--playlist", "abc"])).toThrow(/numeric id/);
    expect(() => parseUpgradeArgs(["--playlist"])).toThrow(/numeric id/);
    expect(() => parseUpgradeArgs(["--favourites", "--keep", "x"])).toThrow(/Unknown argument/);
  });
});

describe("playlist links for --playlist", () => {
  const link = "https://play.qobuz.com/playlist/72685925";

  it("accepts a Qobuz playlist link wherever a playlist id is typed", () => {
    expect(parseDedupeArgs(["--playlist", link]).source).toEqual({
      type: "playlist",
      playlistId: 72685925,
    });
    expect(parseSimilarArgs(["--playlist", link]).source).toMatchObject({
      type: "playlist",
      playlistId: 72685925,
    });
    expect(parseUpgradeArgs(["--playlist", link]).source).toEqual({
      type: "playlist",
      playlistId: 72685925,
    });
    expect(parseStatsArgs(["--playlist", link]).source).toEqual({
      type: "playlist",
      playlistId: 72685925,
    });
  });

  it("rejects a link to something other than a playlist", () => {
    expect(() =>
      parseDedupeArgs(["--playlist", "https://play.qobuz.com/album/abc"]),
    ).toThrow(/numeric id or a playlist link/);
  });
});

describe("playlist plan flags", () => {
  it("parses order, skip-favourites, one-copy and fit for playlist-from-artists", () => {
    const parsed = parsePlaylistArgs([
      "--name",
      "Mix",
      "--order",
      "take-turns",
      "--skip-favourites",
      "--one-copy",
      "--fit",
      "60",
      "Portishead",
    ]);
    expect(parsed.artists).toEqual(["Portishead"]);
    expect(parsed.plan).toEqual({
      order: "take-turns",
      skipFavourites: true,
      oneCopy: true,
      fitMinutes: 60,
    });
  });

  it("leaves the plan unset without plan flags", () => {
    expect(parsePlaylistArgs(["--name", "Mix", "Wire"]).plan).toBeUndefined();
  });

  it("rejects a bad order or length", () => {
    expect(() => parsePlaylistArgs(["--name", "x", "--order", "random", "A"])).toThrow(
      /--order must be one of: by-artist, take-turns, shuffle/,
    );
    expect(() => parsePlaylistArgs(["--name", "x", "--order"])).toThrow(/--order/);
    expect(() => parsePlaylistArgs(["--name", "x", "--fit", "abc", "A"])).toThrow(/minutes/);
    expect(() => parsePlaylistArgs(["--name", "x", "--fit"])).toThrow(/--fit/);
  });

  it("takes as-listed or shuffle as the albums order", () => {
    const parsed = parseAlbumArgs(["--name", "x", "--order", "shuffle", "--fit", "45", "A - B"]);
    expect(parsed.entries).toEqual(["A - B"]);
    expect(parsed.plan).toEqual({ order: "shuffle", skipFavourites: false, oneCopy: false, fitMinutes: 45 });
    expect(() => parseAlbumArgs(["--name", "x", "--order", "take-turns", "A - B"])).toThrow(
      /--order must be one of: as-listed, shuffle/,
    );
  });

  it("accepts the plan flags and --skip-favourite-artists for similar-artists", () => {
    const parsed = parseSimilarArgs([
      "--playlist",
      "42",
      "--order",
      "shuffle",
      "--one-copy",
      "--skip-favourite-artists",
    ]);
    expect(parsed.plan).toEqual({ order: "shuffle", skipFavourites: false, oneCopy: true });
    expect(parsed.skipFavouriteArtists).toBe(true);
    expect(parseSimilarArgs(["--name", "x", "A"]).skipFavouriteArtists).toBeUndefined();
  });
});

describe("parseHistoryArgs", () => {
  it("lists the last 20 entries by default", () => {
    expect(parseHistoryArgs([])).toEqual({ limit: 20 });
  });

  it("takes --limit", () => {
    expect(parseHistoryArgs(["--limit", "5"])).toEqual({ limit: 5 });
  });

  it("rejects a bad limit or an unknown argument", () => {
    expect(() => parseHistoryArgs(["--limit", "0"])).toThrow(/--limit must be a whole number from 1 to 200/);
    expect(() => parseHistoryArgs(["--limit"])).toThrow(/--limit/);
    expect(() => parseHistoryArgs(["--all"])).toThrow(/Unknown argument: --all/);
  });
});

describe("parseUndoArgs", () => {
  it("undoes the latest change, as a report only, by default", () => {
    expect(parseUndoArgs([])).toEqual({ apply: false });
  });

  it("takes an entry id and --apply", () => {
    expect(parseUndoArgs(["a1b2c3d4", "--apply"])).toEqual({ id: "a1b2c3d4", apply: true });
  });

  it("rejects two ids, an odd id or an unknown flag", () => {
    expect(() => parseUndoArgs(["a1", "b2"])).toThrow(/only one entry id/);
    expect(() => parseUndoArgs(["../x"])).toThrow(/not an entry id/);
    expect(() => parseUndoArgs(["--yes"])).toThrow(/Unknown argument: --yes/);
  });
});
