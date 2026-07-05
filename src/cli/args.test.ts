import { describe, expect, it } from "vitest";

import { parsePlaylistArgs } from "./args.js";

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
