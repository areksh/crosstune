import { describe, expect, it } from "vitest";

import type { Album, Track } from "../qobuz/index.js";
import {
  albumExclusion,
  applyTrackFilter,
  compileTerm,
  compileTrackFilter,
  isFilterActive,
  parseDiscList,
  trackExclusion,
} from "./track-filter.js";

describe("compileTerm", () => {
  it("matches a plain term as a whole word, ignoring case", () => {
    const term = compileTerm("live");
    expect(term.test("Karma Police (Live)")).toBe(true);
    expect(term.test("LIVE at Wembley")).toBe(true);
    expect(term.test("Alive")).toBe(false);
    expect(term.test("Oliver's Army")).toBe(false);
  });

  it("matches a multi-word plain term as a phrase", () => {
    const term = compileTerm("live at");
    expect(term.test("Live at Pompeii")).toBe(true);
    expect(term.test("Live in Paris")).toBe(false);
  });

  it("treats regex metacharacters in a plain term literally", () => {
    const term = compileTerm("Vol. 2");
    expect(term.test("Greatest Hits Vol. 2")).toBe(true);
    expect(term.test("Greatest Hits Vol 2x")).toBe(false);
  });

  it("matches a plain term that starts or ends with punctuation", () => {
    expect(compileTerm("(demo)").test("Song (Demo)")).toBe(true);
  });

  it("matches accented words without treating letters as boundaries", () => {
    expect(compileTerm("en vivo").test("Concierto En Vivo")).toBe(true);
    expect(compileTerm("vivo").test("Vivo\u00e9")).toBe(false);
  });

  it("treats a /slashed/ term as a case-insensitive regex", () => {
    const term = compileTerm("/remix|edit$/");
    expect(term.test("Teardrop (Mad Professor Remix)")).toBe(true);
    expect(term.test("Radio EDIT")).toBe(true);
    expect(term.test("Editorial")).toBe(false);
  });

  it("trims surrounding whitespace from a term", () => {
    expect(compileTerm("  live  ").test("Live")).toBe(true);
  });

  it("rejects an invalid regex, naming the term", () => {
    expect(() => compileTerm("/(unclosed/")).toThrow(/\/\(unclosed\//);
  });

  it("rejects an empty term", () => {
    expect(() => compileTerm("   ")).toThrow(/empty/);
    expect(() => compileTerm("//")).toThrow(/empty/);
  });
});

describe("parseDiscList", () => {
  it("parses single discs, lists and ranges", () => {
    expect(parseDiscList("1")).toEqual([1]);
    expect(parseDiscList("1,3")).toEqual([1, 3]);
    expect(parseDiscList("1-3, 5")).toEqual([1, 2, 3, 5]);
  });

  it("de-duplicates and sorts", () => {
    expect(parseDiscList("3,1,1-2")).toEqual([1, 2, 3]);
  });

  it("treats a blank list as no restriction", () => {
    expect(parseDiscList("")).toEqual([]);
    expect(parseDiscList("  ")).toEqual([]);
  });

  it("rejects malformed input", () => {
    expect(() => parseDiscList("one")).toThrow(/disc/i);
    expect(() => parseDiscList("0")).toThrow(/disc/i);
    expect(() => parseDiscList("3-1")).toThrow(/disc/i);
    expect(() => parseDiscList("1,,2")).toThrow(/disc/i);
    expect(() => parseDiscList("1-")).toThrow(/disc/i);
  });

  it("rejects a range too large to be a real disc list", () => {
    expect(() => parseDiscList("1-100000")).toThrow(/disc/i);
  });
});

describe("compileTrackFilter / isFilterActive", () => {
  it("is inactive when nothing is given", () => {
    expect(isFilterActive(compileTrackFilter({}))).toBe(false);
    expect(
      isFilterActive(compileTrackFilter({ excludeTracks: [], excludeAlbums: [], discs: [] })),
    ).toBe(false);
  });

  it("is active when any part is given", () => {
    expect(isFilterActive(compileTrackFilter({ excludeTracks: ["live"] }))).toBe(true);
    expect(isFilterActive(compileTrackFilter({ excludeAlbums: ["live"] }))).toBe(true);
    expect(isFilterActive(compileTrackFilter({ discs: [1] }))).toBe(true);
  });

  it("ignores blank terms rather than rejecting them", () => {
    const filter = compileTrackFilter({ excludeTracks: ["", "  "] });
    expect(isFilterActive(filter)).toBe(false);
  });

  it("propagates an invalid term", () => {
    expect(() => compileTrackFilter({ excludeAlbums: ["/[/"] })).toThrow(/\/\[\//);
  });
});

describe("trackExclusion", () => {
  const track = (extra: Partial<Track>): Track => ({ id: 1, title: "Song", ...extra });

  it("excludes a track whose title matches a track term", () => {
    const filter = compileTrackFilter({ excludeTracks: ["demo"] });
    expect(trackExclusion(track({ title: "Song (Demo)" }), filter)).toEqual({
      kind: "track",
      term: "demo",
    });
  });

  it("matches a track term against the version label too", () => {
    const filter = compileTrackFilter({ excludeTracks: ["live"] });
    expect(trackExclusion(track({ version: "Live at Wembley" }), filter)).toEqual({
      kind: "track",
      term: "live",
    });
  });

  it("excludes a track whose album title matches an album term", () => {
    const filter = compileTrackFilter({ excludeAlbums: ["greatest hits"] });
    expect(trackExclusion(track({ album: "Greatest Hits" }), filter)).toEqual({
      kind: "album",
      term: "greatest hits",
    });
  });

  it("does not apply an album term to the track title", () => {
    const filter = compileTrackFilter({ excludeAlbums: ["live"] });
    expect(trackExclusion(track({ title: "Live Forever" }), filter)).toBeUndefined();
  });

  it("excludes a track on a disc outside the list", () => {
    const filter = compileTrackFilter({ discs: [1] });
    expect(trackExclusion(track({ discNumber: 2 }), filter)).toEqual({
      kind: "disc",
      disc: 2,
    });
    expect(trackExclusion(track({ discNumber: 1 }), filter)).toBeUndefined();
  });

  it("keeps a track with no disc number under a disc filter", () => {
    const filter = compileTrackFilter({ discs: [1] });
    expect(trackExclusion(track({}), filter)).toBeUndefined();
  });

  it("reports the disc before a term when both apply", () => {
    const filter = compileTrackFilter({ excludeTracks: ["demo"], discs: [1] });
    expect(trackExclusion(track({ title: "Demo", discNumber: 2 }), filter)).toEqual({
      kind: "disc",
      disc: 2,
    });
  });

  it("keeps everything under an empty filter", () => {
    expect(trackExclusion(track({ title: "Live" }), compileTrackFilter({}))).toBeUndefined();
  });
});

describe("albumExclusion", () => {
  const album = (extra: Partial<Album>): Album => ({
    id: "a",
    title: "Dummy",
    artist: "Portishead",
    ...extra,
  });

  it("matches album terms against the title and version", () => {
    const filter = compileTrackFilter({ excludeAlbums: ["live"] });
    expect(albumExclusion(album({ title: "Roseland NYC Live" }), filter)).toEqual({
      kind: "album",
      term: "live",
    });
    expect(albumExclusion(album({ version: "Live" }), filter)).toEqual({
      kind: "album",
      term: "live",
    });
    expect(albumExclusion(album({}), filter)).toBeUndefined();
  });

  it("ignores track terms and discs", () => {
    const filter = compileTrackFilter({ excludeTracks: ["dummy"], discs: [2] });
    expect(albumExclusion(album({}), filter)).toBeUndefined();
  });
});

describe("applyTrackFilter", () => {
  it("annotates each track in order, leaving kept tracks unmarked", () => {
    const filter = compileTrackFilter({ discs: [1] });
    const tracks: Track[] = [
      { id: 1, title: "A", discNumber: 1 },
      { id: 2, title: "B", discNumber: 2 },
    ];
    expect(applyTrackFilter(tracks, filter)).toEqual([
      { track: tracks[0] },
      { track: tracks[1], exclusion: { kind: "disc", disc: 2 } },
    ]);
  });
});
