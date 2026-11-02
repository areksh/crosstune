import { describe, expect, it } from "vitest";

import { count } from "./text.js";

describe("count", () => {
  it("uses the singular for exactly one", () => {
    expect(count(1, "track")).toBe("1 track");
  });

  it("uses the plural otherwise, including zero", () => {
    expect(count(0, "track")).toBe("0 tracks");
    expect(count(15, "release")).toBe("15 releases");
  });

  it("takes an irregular plural", () => {
    expect(count(2, "match", "matches")).toBe("2 matches");
    expect(count(1, "match", "matches")).toBe("1 match");
  });

  it("groups thousands", () => {
    expect(count(1240, "track")).toBe("1,240 tracks");
  });
});
