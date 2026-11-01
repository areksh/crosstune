import { describe, expect, it } from "vitest";

import type { Album, Track } from "../qobuz/index.js";
import {
  albumExclusion,
  applyTrackFilter,
  artistExclusion,
  compileArtistTerm,
  compileTerm,
  compileTrackFilter,
  isFilterActive,
  normaliseArtistName,
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

describe("compileArtistTerm", () => {
  it("matches the whole name only, ignoring case", () => {
    const term = compileArtistTerm("Drake");
    expect(term("Drake")).toBe(true);
    expect(term("DRAKE")).toBe(true);
    expect(term("Nick Drake")).toBe(false);
    expect(term("Drake & Future")).toBe(false);
  });

  it("ignores diacritics on either side", () => {
    expect(compileArtistTerm("bjork")("Bj\u00f6rk")).toBe(true);
    expect(compileArtistTerm("Bj\u00f6rk")("Bjork")).toBe(true);
    expect(compileArtistTerm("sigur ros")("Sigur R\u00f3s")).toBe(true);
  });

  it("collapses and trims whitespace on either side", () => {
    expect(compileArtistTerm("  massive   attack ")("Massive Attack")).toBe(true);
    expect(compileArtistTerm("Massive Attack")(" Massive\tAttack ")).toBe(true);
  });

  it("treats regex metacharacters in a plain term literally", () => {
    expect(compileArtistTerm("AC/DC")("AC/DC")).toBe(true);
    expect(compileArtistTerm("P!nk")("P!nk")).toBe(true);
    expect(compileArtistTerm("M.I.A.")("MxIxAx")).toBe(false);
  });

  it("treats a /slashed/ term as a case-insensitive regex on the name as given", () => {
    const term = compileArtistTerm("/^the /");
    expect(term("The National")).toBe(true);
    expect(term("Thee Oh Sees")).toBe(false);
    expect(compileArtistTerm("/drake/")("Nick Drake")).toBe(true);
    // No diacritic folding for a regex.
    expect(compileArtistTerm("/bjork/")("Bj\u00f6rk")).toBe(false);
  });

  it("rejects an invalid regex, naming the term", () => {
    expect(() => compileArtistTerm("/(unclosed/")).toThrow(/\/\(unclosed\//);
  });

  it("rejects an empty term", () => {
    expect(() => compileArtistTerm("  ")).toThrow(/empty/);
    expect(() => compileArtistTerm("//")).toThrow(/empty/);
  });
});

describe("normaliseArtistName", () => {
  it("strips diacritics, lower-cases and collapses whitespace", () => {
    expect(normaliseArtistName("  Bj\u00f6rk   Gu\u00f0mundsd\u00f3ttir ")).toBe(
      "bjork gu\u00f0mundsdottir",
    );
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
    expect(isFilterActive(compileTrackFilter({ excludeArtists: ["Drake"] }))).toBe(true);
    expect(isFilterActive(compileTrackFilter({ discs: [1] }))).toBe(true);
  });

  it("ignores blank terms rather than rejecting them", () => {
    const filter = compileTrackFilter({ excludeTracks: ["", "  "], excludeArtists: [" "] });
    expect(isFilterActive(filter)).toBe(false);
  });

  it("propagates an invalid term", () => {
    expect(() => compileTrackFilter({ excludeAlbums: ["/[/"] })).toThrow(/\/\[\//);
    expect(() => compileTrackFilter({ excludeArtists: ["/[/"] })).toThrow(/\/\[\//);
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

  it("excludes a track whose performer matches an artist term, reporting the term", () => {
    const filter = compileTrackFilter({ excludeArtists: ["  bjork "] });
    expect(trackExclusion(track({ artist: "Bj\u00f6rk" }), filter)).toEqual({
      kind: "artist",
      term: "bjork",
    });
    expect(trackExclusion(track({ artist: "Bj\u00f6rk Trio" }), filter)).toBeUndefined();
  });

  it("keeps a track with no performer under an artist filter", () => {
    const filter = compileTrackFilter({ excludeArtists: ["/./"] });
    expect(trackExclusion(track({}), filter)).toBeUndefined();
  });

  it("does not apply an artist term to the title or album", () => {
    const filter = compileTrackFilter({ excludeArtists: ["Song"] });
    expect(trackExclusion(track({ album: "Song", artist: "Someone" }), filter)).toBeUndefined();
  });

  it("checks the disc, then the artist, then the track, then the album", () => {
    const filter = compileTrackFilter({
      excludeTracks: ["song"],
      excludeAlbums: ["hits"],
      excludeArtists: ["Drake"],
      discs: [1],
    });
    const all = { title: "Song", album: "Hits", artist: "Drake" };
    expect(trackExclusion(track({ ...all, discNumber: 2 }), filter)).toEqual({
      kind: "disc",
      disc: 2,
    });
    expect(trackExclusion(track(all), filter)).toEqual({ kind: "artist", term: "Drake" });
    expect(trackExclusion(track({ ...all, artist: "Future" }), filter)).toEqual({
      kind: "track",
      term: "song",
    });
    expect(trackExclusion(track({ album: "Hits", artist: "Future", title: "x" }), filter)).toEqual(
      { kind: "album", term: "hits" },
    );
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

describe("artistExclusion", () => {
  it("returns the first matching artist term, or undefined", () => {
    const filter = compileTrackFilter({ excludeArtists: ["/^the /", "The National"] });
    expect(artistExclusion("The National", filter)).toBe("/^the /");
    expect(artistExclusion("National", filter)).toBeUndefined();
    expect(artistExclusion("Drake", compileTrackFilter({}))).toBeUndefined();
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
