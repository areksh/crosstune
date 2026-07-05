import { describe, expect, it } from "vitest";

import { parseArtists, parsePlaylist, parseTracks } from "./models.js";

describe("parseArtists", () => {
  it("extracts id and name from the artists.items list", () => {
    const json = {
      artists: {
        items: [
          { id: 1, name: "Miles Davis", extra: "ignored" },
          { id: 2, name: "John Coltrane" },
        ],
      },
    };
    expect(parseArtists(json)).toEqual([
      { id: 1, name: "Miles Davis" },
      { id: 2, name: "John Coltrane" },
    ]);
  });

  it("skips entries without a numeric id or name", () => {
    const json = {
      artists: { items: [{ id: 1, name: "Ok" }, { name: "No id" }, { id: 3 }] },
    };
    expect(parseArtists(json)).toEqual([{ id: 1, name: "Ok" }]);
  });

  it("returns an empty array when the shape is unexpected", () => {
    expect(parseArtists({})).toEqual([]);
    expect(parseArtists({ artists: {} })).toEqual([]);
    expect(parseArtists(null)).toEqual([]);
  });
});

describe("parseTracks", () => {
  it("extracts id and title from a tracks container", () => {
    const json = {
      tracks: {
        items: [
          { id: 10, title: "So What" },
          { id: 11, title: "Blue in Green", duration: 327 },
        ],
      },
    };
    expect(parseTracks(json)).toEqual([
      { id: 10, title: "So What" },
      { id: 11, title: "Blue in Green" },
    ]);
  });

  it("skips malformed track entries", () => {
    const json = { tracks: { items: [{ id: 10, title: "Ok" }, { id: 11 }] } };
    expect(parseTracks(json)).toEqual([{ id: 10, title: "Ok" }]);
  });
});

describe("parsePlaylist", () => {
  it("extracts id and name", () => {
    expect(parsePlaylist({ id: 999, name: "Jazz", is_public: false })).toEqual({
      id: 999,
      name: "Jazz",
    });
  });

  it("throws when the response has no numeric id", () => {
    expect(() => parsePlaylist({ name: "no id" })).toThrow();
  });
});
