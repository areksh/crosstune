import { describe, expect, it, vi } from "vitest";

import type { Track } from "../services/model.js";
import {
  missingGoesTo,
  combinedTrackIds,
  combineTracks,
  formatCombineReport,
  resolveCombine,
  seededRandom,
  shuffle,
  sourcesProblem,
  type CombineClient,
  type CombineInput,
} from "./combine.js";

function track(id: number, title: string, artist = "Artist", extra: Partial<Track> = {}): Track {
  return { id, title, artist, ...extra };
}

const roads = track(1, "Roads", "Portishead");
const glory = track(2, "Glory Box", "Portishead");
const teardrop = track(3, "Teardrop", "Massive Attack");
const angel = track(4, "Angel", "Massive Attack");
const overcome = track(5, "Overcome", "Tricky");

function input(label: string, ...tracks: Track[]): CombineInput {
  return { label, tracks };
}

function ids(inputs: CombineInput[], options = {}): number[] {
  return combinedTrackIds(combineTracks(inputs, options));
}

describe("combineTracks: modes", () => {
  const a = input("A", roads, glory, teardrop);
  const b = input("B", teardrop, angel);

  it("merges every song once, in input order", () => {
    expect(ids([a, b])).toEqual([1, 2, 3, 4]);
  });

  it("keeps only the first input's songs that no other input has", () => {
    expect(ids([a, b], { mode: "only-first" })).toEqual([1, 2]);
  });

  it("keeps only the songs every input has", () => {
    expect(ids([a, b], { mode: "common" })).toEqual([3]);
  });

  it("needs a song in every input for common, not just in two", () => {
    const c = input("C", roads, angel);
    expect(ids([a, b, c], { mode: "common" })).toEqual([]);
    expect(ids([a, b, input("D", teardrop)], { mode: "common" })).toEqual([3]);
  });

  it("collapses a song repeated within one input", () => {
    expect(ids([input("A", roads, roads), input("B", glory)])).toEqual([1, 2]);
  });

  it("records which inputs have each kept song", () => {
    const plan = combineTracks([a, b]);
    expect(plan.tracks.map((t) => t.inputs)).toEqual([[0], [0], [0, 1], [1]]);
  });
});

describe("combineTracks: counts", () => {
  it("counts songs only in each input, shared, in all, and the result", () => {
    const plan = combineTracks(
      [input("A", roads, glory, teardrop), input("B", teardrop, angel), input("C", angel, overcome)],
      { mode: "only-first" },
    );
    expect(plan.counts).toEqual({
      perInput: [3, 2, 2],
      onlyIn: [2, 0, 1],
      shared: 2,
      inAll: 0,
      songs: 5,
      result: 2,
    });
  });

  it("suggests a name joining the inputs' labels", () => {
    const plan = combineTracks([input("Road Trip", roads), input("Late Night", glory)]);
    expect(plan.suggestedName).toBe("Road Trip + Late Night");
    expect(plan.labels).toEqual(["Road Trip", "Late Night"]);
  });
});

describe("combineTracks: same song", () => {
  const remaster = track(10, "Roads (2014 Remaster)", "Portishead", { bitDepth: 24, samplingRate: 96 });
  const original = track(1, "Roads", "Portishead", { bitDepth: 16, samplingRate: 44.1 });

  it("treats a remaster as the same song by default", () => {
    const plan = combineTracks([input("A", original), input("B", remaster)], { mode: "common" });
    expect(plan.counts.shared).toBe(1);
    expect(plan.tracks).toHaveLength(1);
  });

  it("matches by shared ISRC too", () => {
    const x = track(20, "Something", "X", { isrc: "GB123" });
    const y = track(21, "Different title", "Y", { isrc: "GB123" });
    expect(ids([input("A", x), input("B", y)])).toEqual([20]);
  });

  it("only matches equal ids when song matching is off", () => {
    const plan = combineTracks([input("A", original), input("B", remaster)], {
      matchSongs: false,
    });
    expect(combinedTrackIds(plan)).toEqual([1, 10]);
    expect(plan.counts.shared).toBe(0);
  });

  it("keeps the highest-quality copy by default", () => {
    expect(ids([input("A", original), input("B", remaster)])).toEqual([10]);
  });

  it("keeps the first copy when asked", () => {
    expect(ids([input("A", original), input("B", remaster)], { keep: "first" })).toEqual([1]);
  });

  it("places a song where its first copy is, whichever copy is kept", () => {
    const plan = combineTracks([input("A", original, glory), input("B", angel, remaster)]);
    expect(combinedTrackIds(plan)).toEqual([10, 2, 4]);
  });

  it("keeps live versions apart from the studio recording", () => {
    const live = track(30, "Roads (Live)", "Portishead");
    expect(ids([input("A", roads), input("B", live)], { mode: "common" })).toEqual([]);
  });
});

describe("combineTracks: order", () => {
  const a = input("A", roads, glory, teardrop);
  const b = input("B", angel, overcome);

  it("takes turns between the inputs when interleaving", () => {
    expect(ids([a, b], { order: "interleave" })).toEqual([1, 4, 2, 5, 3]);
  });

  it("skips an input that ran out when interleaving three", () => {
    const c = input("C", track(6, "Six"));
    expect(ids([a, b, c], { order: "interleave" })).toEqual([1, 4, 6, 2, 5, 3]);
  });

  it("interleaves a shared song from its first input", () => {
    const shared = input("B", roads, angel);
    expect(ids([input("A", roads, glory), shared], { order: "interleave" })).toEqual([1, 4, 2]);
  });

  it("shuffles with the given random source", () => {
    // random() = 0 always swaps with index 0: [1,2,3,4,5] -> [2,3,4,5,1]
    expect(ids([a, b], { order: "shuffle", random: () => 0 })).toEqual([2, 3, 4, 5, 1]);
  });

  it("shuffles reproducibly with a seeded random source", () => {
    const once = ids([a, b], { order: "shuffle", random: seededRandom(42) });
    const again = ids([a, b], { order: "shuffle", random: seededRandom(42) });
    expect(once).toEqual(again);
    expect([...once].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("shuffle and seededRandom", () => {
  it("does not mutate its input", () => {
    const items = [1, 2, 3];
    shuffle(items, () => 0.5);
    expect(items).toEqual([1, 2, 3]);
  });

  it("produces numbers in [0, 1)", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 100; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("sourcesProblem", () => {
  it("needs at least two sources", () => {
    expect(sourcesProblem([{ type: "favourites" }])).toMatch(/at least two/);
  });

  it("rejects a source given twice", () => {
    expect(
      sourcesProblem([
        { type: "playlist", playlistId: 1 },
        { type: "playlist", playlistId: 1 },
      ]),
    ).toMatch(/only once/);
  });

  it("accepts distinct sources", () => {
    expect(
      sourcesProblem([{ type: "favourites" }, { type: "playlist", playlistId: 1 }]),
    ).toBeUndefined();
  });
});

describe("resolveCombine", () => {
  function client(): CombineClient {
    return {
      getFavoriteTracks: vi.fn(async () => [roads, angel]),
      getPlaylistTracks: vi.fn(async (id: number) => (id === 7 ? [roads, glory] : [teardrop])),
      getUserPlaylists: vi.fn(async () => [{ id: 7, name: "Road Trip" }]),
    };
  }

  it("fetches each source and labels it", async () => {
    const plan = await resolveCombine(client(), [
      { type: "playlist", playlistId: 7 },
      { type: "favourites" },
      { type: "playlist", playlistId: 8 },
    ]);
    expect(plan.labels).toEqual(["Road Trip", "Favourites", "Playlist 8"]);
    expect(combinedTrackIds(plan)).toEqual([1, 2, 4, 3]);
  });

  it("passes the options through", async () => {
    const plan = await resolveCombine(
      client(),
      [{ type: "playlist", playlistId: 7 }, { type: "favourites" }],
      { mode: "common" },
    );
    expect(combinedTrackIds(plan)).toEqual([1]);
  });

  it("rejects fewer than two sources", async () => {
    await expect(resolveCombine(client(), [{ type: "favourites" }])).rejects.toThrow(
      /at least two/,
    );
  });
});

describe("formatCombineReport", () => {
  it("summarises the overlap and lists the result", () => {
    const plan = combineTracks([input("A", roads, glory), input("B", glory, angel)]);
    expect(formatCombineReport(plan, "merge")).toBe(
      [
        "  1. A: 2 songs, 1 only here",
        "  2. B: 2 songs, 1 only here",
        "  In both: 1",
        "",
        "Result (every song once): 3 tracks",
        "  1. Portishead - Roads",
        "  2. Portishead - Glory Box",
        "  3. Massive Attack - Angel",
      ].join("\n"),
    );
  });

  it("names the mode and counts in-all for three inputs", () => {
    const plan = combineTracks(
      [input("A", roads), input("B", roads), input("C", glory)],
      { mode: "only-first" },
    );
    const report = formatCombineReport(plan, "only-first");
    expect(report).toContain("In more than one: 1; in all 3: 0");
    expect(report).toContain("Result (songs only in A): 0 tracks");
  });
});

describe("missingGoesTo", () => {
  const a = { type: "playlist", playlistId: "qobuz:1" } as const;
  const b = { type: "playlist", playlistId: "spotify:x" } as const;

  it("offers the second playlist for what only the first has", () => {
    expect(missingGoesTo("only-first", [a, b])).toBe("spotify:x");
  });

  it("offers nothing for other modes, more inputs, or favourites second", () => {
    expect(missingGoesTo("merge", [a, b])).toBeUndefined();
    expect(missingGoesTo("only-first", [a, b, a])).toBeUndefined();
    expect(missingGoesTo("only-first", [a, { type: "favourites" }])).toBeUndefined();
  });
});
