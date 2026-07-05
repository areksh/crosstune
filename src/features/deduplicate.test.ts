import { describe, expect, it } from "vitest";

import {
  deduplicateTracks,
  enrichReleaseDates,
  findDuplicateGroups,
  formatResolutionReport,
  normalise,
  removedTracks,
  resolveDuplicateGroups,
  selectKeeper,
  strategyNeedsReleaseDates,
  tracksToRemove,
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

describe("selectKeeper", () => {
  it("keeps the first-added track (fetch order)", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "So What", artist: "Miles Davis" },
      { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
    ];
    expect(selectKeeper(group, "first-added")).toBe(100);
  });

  it("throws on an empty group", () => {
    expect(() => selectKeeper([], "first-added")).toThrow();
  });

  it("keeps the last-added track", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X" },
      { id: 200, title: "T", artist: "X" },
    ];
    expect(selectKeeper(group, "last-added")).toBe(200);
  });

  it("keeps the highest-quality track (bit depth then sample rate)", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", bitDepth: 16, samplingRate: 44.1 },
      { id: 200, title: "T", artist: "X", bitDepth: 24, samplingRate: 96 },
      { id: 300, title: "T", artist: "X", bitDepth: 24, samplingRate: 192 },
    ];
    expect(selectKeeper(group, "highest-quality")).toBe(300);
  });

  it("keeps the oldest and newest releases, and ignores missing dates", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", releaseDate: "1973-03-01" },
      { id: 200, title: "T", artist: "X", releaseDate: "2011-09-26" },
      { id: 300, title: "T", artist: "X" }, // no date
    ];
    expect(selectKeeper(group, "oldest")).toBe(100);
    expect(selectKeeper(group, "newest")).toBe(200);
  });

  it("breaks ties by keeping the earlier member", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", bitDepth: 24 },
      { id: 200, title: "T", artist: "X", bitDepth: 24 },
    ];
    expect(selectKeeper(group, "highest-quality")).toBe(100);
  });
});

describe("strategyNeedsReleaseDates", () => {
  it("is true only for date-based strategies", () => {
    expect(strategyNeedsReleaseDates("oldest")).toBe(true);
    expect(strategyNeedsReleaseDates("newest")).toBe(true);
    expect(strategyNeedsReleaseDates("first-added")).toBe(false);
    expect(strategyNeedsReleaseDates("highest-quality")).toBe(false);
  });
});

describe("enrichReleaseDates", () => {
  it("fills missing dates, fetching each album only once", async () => {
    const groups: DedupTrack[][] = [
      [
        { id: 1, title: "T", artist: "X", albumId: "alb-a" },
        { id: 2, title: "T", artist: "X", albumId: "alb-a", releaseDate: "2000-01-01" },
        { id: 3, title: "T", artist: "X", albumId: "alb-b" },
      ],
    ];
    const calls: string[] = [];
    const fetchDate = async (albumId: string): Promise<string | undefined> => {
      calls.push(albumId);
      return albumId === "alb-a" ? "1990-01-01" : undefined;
    };

    const enriched = await enrichReleaseDates(groups, fetchDate);

    expect(enriched[0]?.map((t) => t.releaseDate)).toEqual([
      "1990-01-01", // fetched
      "2000-01-01", // already present, not refetched
      undefined, // fetch returned nothing
    ]);
    expect(calls).toEqual(["alb-a", "alb-b"]); // alb-a fetched once despite two tracks
  });
});

describe("resolveDuplicateGroups / removedTracks", () => {
  it("produces a plan keeping the first track and removing the rest", () => {
    const groups: DedupTrack[][] = [
      [
        { id: 100, title: "So What", artist: "Miles Davis" },
        { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
        { id: 300, title: "So What", artist: "Miles Davis" },
      ],
    ];
    const [resolved] = resolveDuplicateGroups(groups, "first-added");
    expect(resolved?.keepId).toBe(100);
    expect(removedTracks(resolved!).map((t) => t.id)).toEqual([200, 300]);
  });

  it("respects a user-overridden keepId when computing removals", () => {
    const resolved = {
      keepId: 200,
      tracks: [
        { id: 100, title: "A", artist: "X" },
        { id: 200, title: "A", artist: "X" },
      ],
    };
    expect(removedTracks(resolved).map((t) => t.id)).toEqual([100]);
  });

  it("collects removals across all groups in a plan", () => {
    const removals = tracksToRemove([
      {
        keepId: 1,
        tracks: [
          { id: 1, title: "A", artist: "X" },
          { id: 2, title: "A", artist: "X" },
        ],
      },
      {
        keepId: 3,
        tracks: [
          { id: 3, title: "B", artist: "Y" },
          { id: 4, title: "B", artist: "Y" },
        ],
      },
    ]);
    expect(removals.map((t) => t.id)).toEqual([2, 4]);
  });
});

describe("formatResolutionReport", () => {
  it("reports a friendly message when there are no duplicates", () => {
    expect(formatResolutionReport([])).toBe("No duplicates found.");
  });

  it("marks the kept and dropped tracks in each group", () => {
    const report = formatResolutionReport([
      {
        keepId: 100,
        tracks: [
          { id: 100, title: "So What", artist: "Miles Davis", album: "Kind of Blue" },
          { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
        ],
      },
    ]);
    expect(report).toContain("Found 1 duplicate group; keeping 1 each, 1 to remove:");
    expect(report).toContain("Miles Davis - So What");
    expect(report).toContain("keep  id 100: So What  [Kind of Blue]");
    expect(report).toContain("drop  id 200: So What (2015 Remaster)");
  });
});
