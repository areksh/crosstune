import { describe, expect, it } from "vitest";

import { align, maybeMoved } from "./align.js";

describe("align", () => {
  it.each([
    [[1, 2, 3], [1, 2, 3], [0, 1, 2]],
    [[1, 2, 3], [1, 3], [0, -1, 1]],
    [[1, 2, 1, 3], [2, 1, 3], [-1, 0, 1, 2]],
    [[1, 2, 3], [3, 1, 2], [1, 2, 0]],
    [[], [1], []],
    [[1], [], [-1]],
    [[1, 1, 1], [1, 1], [0, 1, -1]],
  ])("of %j to %j", (from, to, pairs) => {
    expect(align(from, to)).toEqual(pairs);
  });
});

describe("maybeMoved", () => {
  it.each([
    [[0, 1, 2, 3], []],
    [[3, 0, 1, 2], [3]],
    [[1, 2, 3, 0], [0]],
    // A swap: either may be the one that moved.
    [[1, 0, 2, 3], [0, 1]],
    [[2, 1, 0], [0, 1, 2]],
    [[], []],
  ])("of the order %j is %j", (order, moved) => {
    expect([...maybeMoved(order)].sort()).toEqual(moved);
  });
});
