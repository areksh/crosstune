import { describe, expect, it } from "vitest";

import {
  parseArtists,
  parsePlaylist,
  parseTracks,
  parseTracksPage,
} from "./models.js";

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

  it("pulls artist, isrc and album when present", () => {
    const json = {
      tracks: {
        items: [
          {
            id: 10,
            title: "So What",
            isrc: "USSM15900001",
            performer: { name: "Miles Davis" },
            album: { title: "Kind of Blue" },
          },
        ],
      },
    };
    expect(parseTracks(json)).toEqual([
      {
        id: 10,
        title: "So What",
        artist: "Miles Davis",
        isrc: "USSM15900001",
        album: "Kind of Blue",
      },
    ]);
  });
});

describe("parseTracksPage", () => {
  it("returns the tracks and the total for pagination", () => {
    const json = { tracks: { items: [{ id: 1, title: "A" }], total: 137 } };
    expect(parseTracksPage(json)).toEqual({
      tracks: [{ id: 1, title: "A" }],
      total: 137,
    });
  });

  it("defaults total to zero when absent", () => {
    expect(parseTracksPage({}).total).toBe(0);
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
