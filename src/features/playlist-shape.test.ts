import { describe, expect, it } from "vitest";

import { seededRandom } from "./combine.js";
import {
  fitToLength,
  formatDuration,
  isPlaylistOrder,
  orderGroups,
  parseFitMinutes,
  playsAs,
  shapePlaylist,
  totalSeconds,
  uniqueGroups,
} from "./playlist-shape.js";

interface Item {
  id: string;
  duration?: number;
}

const item = (id: string, duration?: number): Item =>
  duration === undefined ? { id } : { id, duration };
const ids = (items: readonly Item[]): string[] => items.map((i) => i.id);
const durationOf = (i: Item): number | undefined => i.duration;

describe("orderGroups", () => {
  const groups = [
    [item("a1"), item("a2"), item("a3")],
    [item("b1")],
    [item("c1"), item("c2")],
  ];

  it("plays each group in turn for by-artist", () => {
    expect(ids(orderGroups(groups, "by-artist"))).toEqual(["a1", "a2", "a3", "b1", "c1", "c2"]);
  });

  it("takes turns between the groups, skipping those that ran out", () => {
    expect(ids(orderGroups(groups, "take-turns"))).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
  });

  it("treats as-listed like by-artist", () => {
    expect(ids(orderGroups(groups, "as-listed"))).toEqual(ids(orderGroups(groups, "by-artist")));
  });

  it("shuffles every item with the given random source, reproducibly", () => {
    const once = ids(orderGroups(groups, "shuffle", seededRandom(7)));
    const again = ids(orderGroups(groups, "shuffle", seededRandom(7)));
    expect(once).toEqual(again);
    expect([...once].sort()).toEqual(["a1", "a2", "a3", "b1", "c1", "c2"]);
    expect(once).not.toEqual(ids(orderGroups(groups, "by-artist")));
  });

  it("handles no groups and empty groups", () => {
    expect(orderGroups([], "take-turns")).toEqual([]);
    expect(ids(orderGroups([[], [item("x")], []], "take-turns"))).toEqual(["x"]);
  });
});

describe("isPlaylistOrder", () => {
  it("accepts the three orders only", () => {
    expect(isPlaylistOrder("by-artist")).toBe(true);
    expect(isPlaylistOrder("take-turns")).toBe(true);
    expect(isPlaylistOrder("shuffle")).toBe(true);
    expect(isPlaylistOrder("as-listed")).toBe(false);
    expect(isPlaylistOrder(undefined)).toBe(false);
  });
});

describe("totalSeconds", () => {
  it("sums known durations", () => {
    expect(totalSeconds([item("a", 100), item("b", 200)], durationOf)).toBe(300);
  });

  it("counts a track of unknown length as the average of the known ones", () => {
    expect(totalSeconds([item("a", 100), item("b", 300), item("c")], durationOf)).toBe(600);
  });

  it("counts every track as four minutes when no length is known", () => {
    expect(totalSeconds([item("a"), item("b")], durationOf)).toBe(480);
  });

  it("is zero for nothing", () => {
    expect(totalSeconds([], durationOf)).toBe(0);
  });
});

describe("fitToLength", () => {
  it("keeps everything that already fits", () => {
    const groups = [[item("a1", 60), item("a2", 60)], [item("b1", 60)]];
    const result = fitToLength(groups, 180, durationOf);
    expect(result.kept.map(ids)).toEqual([["a1", "a2"], ["b1"]]);
    expect(result.dropped).toEqual([]);
    expect(result.seconds).toBe(180);
  });

  it("drops from the end fairly, so each group keeps its first items", () => {
    // Three groups of three 100s items: 900s; the target 500s drops four.
    const groups = ["a", "b", "c"].map((g) => [1, 2, 3].map((n) => item(`${g}${n}`, 100)));
    const result = fitToLength(groups, 500, durationOf);
    // Every third item goes first (last group first), then the seconds.
    expect(ids(result.dropped)).toEqual(["c3", "b3", "a3", "c2"]);
    expect(result.kept.map(ids)).toEqual([["a1", "a2"], ["b1", "b2"], ["c1"]]);
    expect(result.seconds).toBe(500);
  });

  it("trims a longer group before touching a shorter one's top items", () => {
    const groups = [
      [item("a1", 100), item("a2", 100), item("a3", 100), item("a4", 100)],
      [item("b1", 100)],
    ];
    const result = fitToLength(groups, 300, durationOf);
    expect(ids(result.dropped)).toEqual(["a4", "a3"]);
    expect(result.kept.map(ids)).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("drops from the tail of a single group", () => {
    const result = fitToLength([[item("1", 200), item("2", 200), item("3", 200)]], 450, durationOf);
    expect(ids(result.dropped)).toEqual(["3"]);
    expect(result.seconds).toBe(400);
  });

  it("counts unknown lengths as the average", () => {
    const groups = [[item("a1", 100), item("a2")], [item("b1", 300), item("b2")]];
    // Average 200: total 800. Target 500 drops b2 (200) then a2 (200).
    const result = fitToLength(groups, 500, durationOf);
    expect(ids(result.dropped)).toEqual(["b2", "a2"]);
    expect(result.seconds).toBe(400);
  });

  it("keeps at least one item however short the target", () => {
    const result = fitToLength([[item("a", 600)], [item("b", 600)]], 60, durationOf);
    expect(result.kept.map(ids)).toEqual([["a"], []]);
    expect(result.seconds).toBe(600);
  });

  it("handles no items", () => {
    expect(fitToLength([], 60, durationOf)).toEqual({ kept: [], dropped: [], seconds: 0 });
  });
});

describe("parseFitMinutes", () => {
  it("parses a whole number of minutes", () => {
    expect(parseFitMinutes("60")).toBe(60);
    expect(parseFitMinutes(" 45 ")).toBe(45);
  });

  it("rejects anything else", () => {
    for (const raw of ["0", "-5", "1.5", "abc", "", "100000"]) {
      expect(() => parseFitMinutes(raw)).toThrow(/minutes/);
    }
  });
});

describe("formatDuration", () => {
  it("shows minutes under an hour", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(29)).toBe("0 min");
    expect(formatDuration(30)).toBe("1 min");
    expect(formatDuration(58 * 60 + 10)).toBe("58 min");
  });

  it("shows hours and minutes from an hour", () => {
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(79 * 60)).toBe("1 h 19 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
  });
});

describe("playsAs", () => {
  it("lists the first titles, then 'and so on'", () => {
    expect(playsAs(["A", "B", "C", "D", "E", "F", "G"])).toBe(
      "Plays as A, B, C, D, E, F, and so on.",
    );
  });

  it("lists a short playlist in full", () => {
    expect(playsAs(["A"])).toBe("Plays as A.");
    expect(playsAs(["A", "B"])).toBe("Plays as A and B.");
    expect(playsAs(["A", "B", "C"])).toBe("Plays as A, B and C.");
  });

  it("says nothing is ticked for an empty list", () => {
    expect(playsAs([])).toBe("Nothing ticked yet.");
  });

  it("takes how many to show", () => {
    expect(playsAs(["A", "B", "C", "D"], 2)).toBe("Plays as A, B, and so on.");
  });
});

describe("uniqueGroups", () => {
  it("keeps the first occurrence of each key across groups", () => {
    const groups = [[item("a"), item("b")], [item("b"), item("c")], [item("a")]];
    expect(uniqueGroups(groups, (i) => i.id).map(ids)).toEqual([["a", "b"], ["c"], []]);
  });
});

describe("shapePlaylist", () => {
  const groups = [
    [item("a1", 100), item("a2", 100), item("a3", 100)],
    [item("b1", 100), item("b2", 100)],
  ];

  it("orders without trimming by default", () => {
    const result = shapePlaylist(groups, durationOf, { order: "take-turns" });
    expect(ids(result.ordered)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(result.dropped).toEqual([]);
    expect(result.seconds).toBe(500);
  });

  it("fits fairly across groups, then orders what is left", () => {
    const result = shapePlaylist(groups, durationOf, { order: "take-turns", fitMinutes: 5 });
    expect(result.seconds).toBe(300);
    expect(ids(result.dropped)).toEqual(["a3", "b2"]);
    expect(result.kept.map(ids)).toEqual([["a1", "a2"], ["b1"]]);
    expect(ids(result.ordered)).toEqual(["a1", "b1", "a2"]);
  });

  it("fits from the end of the list in tail mode", () => {
    const result = shapePlaylist(groups, durationOf, { fitMinutes: 5, fit: "tail" });
    expect(ids(result.dropped)).toEqual(["b2", "b1"]);
    expect(result.kept.map(ids)).toEqual([["a1", "a2", "a3"], []]);
    expect(ids(result.ordered)).toEqual(["a1", "a2", "a3"]);
  });

  it("shuffles with the random source given", () => {
    const one = shapePlaylist(groups, durationOf, { order: "shuffle", random: seededRandom(3) });
    const two = shapePlaylist(groups, durationOf, { order: "shuffle", random: seededRandom(3) });
    expect(ids(one.ordered)).toEqual(ids(two.ordered));
    expect(one.ordered).toHaveLength(5);
  });
});
