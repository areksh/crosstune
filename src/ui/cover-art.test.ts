import { describe, expect, it } from "vitest";
import { coverBackground, generatedCover, glowBackground } from "./cover-art.js";

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

describe("generatedCover", () => {
  it("is stable for a name", () => {
    expect(generatedCover("Techno")).toEqual(generatedCover("Techno"));
  });

  it("ignores case and surrounding space, so a re-cased name keeps its colour", () => {
    expect(generatedCover(" techno ")).toEqual(generatedCover("Techno"));
  });

  it("tells near names apart", () => {
    expect(hueGap(generatedCover("rock/metal v3").hue, generatedCover("rock/metal v2").hue)).toBeGreaterThanOrEqual(20);
  });

  it("spreads names around the wheel", () => {
    const names = ["Techno", "uk rap", "rap", "race games", "rock/metal v3", "Download 2026 Headline", "Favourites", "Chill", "Gym", "Jazz"];
    const sextants = new Set(names.map((name) => Math.floor(generatedCover(name).hue / 60)));
    expect(sextants.size).toBeGreaterThanOrEqual(4);
  });

  it("yields colours a page can use", () => {
    const cover = generatedCover("Techno");
    expect(cover.colours).toHaveLength(3);
    for (const colour of cover.colours) {
      expect(colour).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    }
    expect(coverBackground(cover)).toMatch(/^conic-gradient\(/);
    expect(glowBackground(cover)).toMatch(/^radial-gradient\(.*transparent/);
  });

  it("gives an empty name a cover too", () => {
    expect(generatedCover("").colours).toHaveLength(3);
  });
});
