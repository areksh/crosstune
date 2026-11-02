import { describe, expect, it } from "vitest";

import { addSubstitutions, findReverts, mapDesired } from "./substitutions.js";

const t = (trackId: number, source = "s") => ({ trackId, source });

describe("mapDesired", () => {
  it("replaces a desired track by its substitute, keeping its place", () => {
    expect(mapDesired([t(1), t(2), t(3)], [{ from: 2, to: 9, key: "k" }]).map((d) => d.trackId)).toEqual([1, 9, 3]);
  });

  it("follows chains and drops a track substituted by nothing", () => {
    const subs = [
      { from: 1, to: 2, key: "a" },
      { from: 2, to: 3, key: "b" },
      { from: 4, key: "c" },
    ];
    expect(mapDesired([t(1), t(4), t(5)], subs).map((d) => d.trackId)).toEqual([3, 5]);
  });

  it("stops at a cycle rather than looping", () => {
    const subs = [
      { from: 1, to: 2, key: "a" },
      { from: 2, to: 1, key: "b" },
    ];
    expect(mapDesired([t(1)], subs)).toHaveLength(1);
  });

  it("keeps the first place when two desired tracks map to the same one", () => {
    const mapped = mapDesired([t(1, "x"), t(2, "y"), t(3, "z")], [{ from: 3, to: 1, key: "dedupe" }]);
    expect(mapped).toEqual([t(1, "x"), t(2, "y")]);
  });
});

describe("findReverts", () => {
  it("drops substitutions whose original is back, returning their keys", () => {
    const subs = [
      { from: 1, to: 2, key: "upgrade:1>2" },
      { from: 3, key: "repair:3" },
    ];
    expect(findReverts(subs, new Set([1, 2]))).toEqual({
      kept: [{ from: 3, key: "repair:3" }],
      revertedKeys: ["upgrade:1>2"],
    });
  });
});

describe("addSubstitutions", () => {
  it("replaces one for the same track and caps the list", () => {
    const merged = addSubstitutions([{ from: 1, to: 2, key: "a" }], [{ from: 1, to: 3, key: "b" }, { from: 5, key: "c" }], 2);
    expect(merged).toEqual([
      { from: 1, to: 3, key: "b" },
      { from: 5, key: "c" },
    ]);
    expect(addSubstitutions([{ from: 1, key: "a" }, { from: 2, key: "b" }], [{ from: 3, key: "c" }], 2)).toEqual([
      { from: 2, key: "b" },
      { from: 3, key: "c" },
    ]);
  });
});
