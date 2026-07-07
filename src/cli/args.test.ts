import { describe, expect, it } from "vitest";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseDedupeArgs,
  parsePlaylistArgs,
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
