import { describe, expect, it } from "vitest";
import { shouldAskArtwork } from "./artwork-question.js";

describe("shouldAskArtwork", () => {
  it("asks once a service is connected and nothing has been chosen or asked", () => {
    expect(shouldAskArtwork(null, null, 1)).toBe(true);
  });

  it("does not ask once covers are chosen either way", () => {
    expect(shouldAskArtwork("on", null, 2)).toBe(false);
    expect(shouldAskArtwork("off", null, 2)).toBe(false);
  });

  it("does not ask twice", () => {
    expect(shouldAskArtwork(null, "yes", 1)).toBe(false);
  });

  it("does not ask with nothing connected (there is nothing to show)", () => {
    expect(shouldAskArtwork(null, null, 0)).toBe(false);
  });
});
