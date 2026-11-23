import { describe, expect, it } from "vitest";
import { coverBackground, coverFromColour, generatedCover, glowBackground } from "./cover-art.js";

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

describe("coverFromColour", () => {
  const parts = (colour: string): number[] => /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colour)!.slice(1).map(Number);

  it("takes the hue of a cover's colour", () => {
    expect(coverFromColour({ r: 200, g: 40, b: 40 }).hue).toBe(0);
    expect(coverFromColour({ r: 40, g: 40, b: 200 }).hue).toBe(240);
    expect(coverFromColour({ r: 40, g: 200, b: 40 }).hue).toBe(120);
  });

  it("keeps a dark or washed-out cover's glow visible", () => {
    const [, s, l] = parts(coverFromColour({ r: 10, g: 12, b: 30 }).colours[0]);
    expect(s).toBeGreaterThanOrEqual(45);
    expect(l).toBeGreaterThanOrEqual(50);
  });

  it("gives a grey cover a neutral, low-saturation glow", () => {
    const [, s] = parts(coverFromColour({ r: 128, g: 128, b: 128 }).colours[0]);
    expect(s).toBeLessThanOrEqual(20);
  });

  it("yields colours the glow and cover functions take", () => {
    const cover = coverFromColour({ r: 90, g: 30, b: 160 });
    expect(cover.colours).toHaveLength(3);
    expect(glowBackground(cover)).toMatch(/^radial-gradient\(/);
  });
});
