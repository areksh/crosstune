import { describe, expect, it } from "vitest";

import { parseDedupeArgs, parsePlaylistArgs } from "./args.js";

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

describe("parseDedupeArgs", () => {
  it("parses a playlist source with the default keep strategy", () => {
    expect(parseDedupeArgs(["--playlist", "555"])).toEqual({
      source: { type: "playlist", playlistId: 555 },
      keep: "first-added",
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

  it("parses an explicit --keep strategy", () => {
    expect(parseDedupeArgs(["--favourites", "--keep", "first-added"]).keep).toBe(
      "first-added",
    );
  });

  it("throws on an unsupported --keep strategy", () => {
    expect(() =>
      parseDedupeArgs(["--favourites", "--keep", "highest-quality"]),
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
