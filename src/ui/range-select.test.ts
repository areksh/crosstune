import { describe, expect, it } from "vitest";
import { rangeTick } from "./range-select.js";

const rows = ["a", "b", "c", "d", "e"];

describe("rangeTick", () => {
  it("a plain click sets the target and becomes the anchor", () => {
    expect(rangeTick(rows, "a", "c", false)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("shift ticks everything between the anchor and the target, inclusive, and keeps the anchor", () => {
    expect(rangeTick(rows, "b", "d", true)).toEqual({ ids: ["b", "c", "d"], anchor: "b" });
  });

  it("works upwards", () => {
    expect(rangeTick(rows, "d", "b", true)).toEqual({ ids: ["b", "c", "d"], anchor: "d" });
  });

  it("shift on the anchor itself sets just it", () => {
    expect(rangeTick(rows, "c", "c", true)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("without an anchor, shift acts as a plain click", () => {
    expect(rangeTick(rows, undefined, "c", true)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("an anchor no longer shown (filtered out) makes it a plain click", () => {
    expect(rangeTick(["a", "c", "e"], "b", "e", true)).toEqual({ ids: ["e"], anchor: "e" });
  });

  it("counts only the rows shown", () => {
    expect(rangeTick(["a", "c", "e"], "a", "e", true).ids).toEqual(["a", "c", "e"]);
  });
});
