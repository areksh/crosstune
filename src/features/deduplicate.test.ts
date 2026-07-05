import { describe, expect, it } from "vitest";

import {
  deduplicateTracks,
  findDuplicateGroups,
  formatDuplicateReport,
  normalise,
  toDedupTrack,
  trackSignature,
  type DedupTrack,
} from "./deduplicate.js";

describe("normalise", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalise("  So   What!! ")).toBe("so what");
  });

  it("folds accents so accented and plain spellings match", () => {
    expect(normalise("Café del Mar")).toBe(normalise("Cafe del Mar"));
  });

  it("removes edition noise and its trailing year", () => {
    expect(normalise("So What (2015 Remaster)")).toBe("so what");
    expect(normalise("So What - 2011 Remastered Version")).toBe("so what");
    expect(normalise("Kind of Blue (Deluxe Edition)")).toBe("kind of blue");
  });

  it("keeps meaningful qualifiers that distinguish recordings", () => {
    expect(normalise("Teardrop (Live)")).toBe("teardrop live");
    expect(normalise("Song (Acoustic)")).toBe("song acoustic");
    expect(normalise("Song (Extended Version)")).toBe("song extended version");
  });

  it("does not strip numbers that are part of the title", () => {
    expect(normalise("1999")).toBe("1999");
    expect(normalise("Symphony No. 5")).toBe("symphony no 5");
  });
});

describe("trackSignature", () => {
  it("combines normalised artist and title so same title different artist differ", () => {
    const gnarls: DedupTrack = { id: 1, title: "Crazy", artist: "Gnarls Barkley" };
    const patsy: DedupTrack = { id: 2, title: "Crazy", artist: "Patsy Cline" };
    expect(trackSignature(gnarls)).not.toBe(trackSignature(patsy));
  });

  it("matches a remaster to the original", () => {
    const original: DedupTrack = { id: 1, title: "So What", artist: "Miles Davis" };
    const remaster: DedupTrack = {
      id: 2,
      title: "So What (2015 Remaster)",
      artist: "Miles Davis",
    };
    expect(trackSignature(original)).toBe(trackSignature(remaster));
  });
});

describe("findDuplicateGroups", () => {
  it("groups tracks sharing a normalised signature (different ISRCs)", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "So What", artist: "Miles Davis", isrc: "AAA" },
      { id: 2, title: "So What (2015 Remaster)", artist: "Miles Davis", isrc: "BBB" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });

  it("groups tracks sharing an ISRC even if titles differ textually", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Teardrop", artist: "Massive Attack", isrc: "SAME" },
      { id: 2, title: "Teardrop (from Mezzanine)", artist: "Massive Attack", isrc: "SAME" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });

  it("merges transitively across ISRC and signature links", () => {
    // A-B share an ISRC; B-C share a signature -> all one group.
    const tracks: DedupTrack[] = [
      { id: 1, title: "Song", artist: "Band", isrc: "X" },
      { id: 2, title: "Song (Weird Tag)", artist: "Band", isrc: "X" },
      { id: 3, title: "Song", artist: "Band", isrc: "Y" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("keeps distinct songs with the same title but different artists apart", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Crazy", artist: "Gnarls Barkley" },
      { id: 2, title: "Crazy", artist: "Patsy Cline" },
    ];
    expect(findDuplicateGroups(tracks)).toEqual([]);
  });

  it("keeps distinct versions (live, remix) apart", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Song", artist: "Band" },
      { id: 2, title: "Song (Live)", artist: "Band" },
      { id: 3, title: "Song (Tiesto Remix)", artist: "Band" },
    ];
    expect(findDuplicateGroups(tracks)).toEqual([]);
  });

  it("returns only groups with more than one track, in order of first appearance", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Unique One", artist: "A" },
      { id: 2, title: "Dupe", artist: "B" },
      { id: 3, title: "Unique Two", artist: "C" },
      { id: 4, title: "Dupe", artist: "B" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([2, 4]);
  });
});

describe("toDedupTrack", () => {
  it("maps a Qobuz track, defaulting a missing artist to empty", () => {
    expect(
      toDedupTrack({ id: 1, title: "T", isrc: "X", album: "Alb" }),
    ).toEqual({ id: 1, title: "T", artist: "", isrc: "X", album: "Alb" });
  });
});

describe("deduplicateTracks", () => {
  it("groups Qobuz tracks by their dedup signature", () => {
    const groups = deduplicateTracks([
      { id: 1, title: "So What", artist: "Miles Davis" },
      { id: 2, title: "So What (2015 Remaster)", artist: "Miles Davis" },
      { id: 3, title: "Blue in Green", artist: "Miles Davis" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("formatDuplicateReport", () => {
  it("reports a friendly message when there are no duplicates", () => {
    expect(formatDuplicateReport([])).toBe("No duplicates found.");
  });

  it("lists each group with its members", () => {
    const report = formatDuplicateReport([
      [
        { id: 100, title: "So What", artist: "Miles Davis", album: "Kind of Blue" },
        { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
      ],
    ]);
    expect(report).toContain("Found 1 duplicate group");
    expect(report).toContain("Miles Davis - So What (2 copies)");
    expect(report).toContain("id 100: So What  [Kind of Blue]");
    expect(report).toContain("id 200: So What (2015 Remaster)");
  });
});
