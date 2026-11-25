import { describe, expect, it } from "vitest";

import { optionLine, songLine } from "./song-line.js";

describe("songLine", () => {
  it("names a song by its title, version and artist", () => {
    expect(songLine({ title: "Roads" })).toBe("Roads");
    expect(songLine({ title: "Roads", version: "Live", artist: "Portishead" })).toBe("Roads (Live) – Portishead");
  });
});

describe("optionLine", () => {
  it("adds what tells one song of a title from another: album, year and length", () => {
    expect(
      optionLine({ title: "Yesterday", artist: "The Beatles", album: "Help!", releaseDate: "1965-08-06", duration: 125 }),
    ).toBe("Yesterday – The Beatles, Help!, 1965 (2:05)");
    expect(optionLine({ title: "Yesterday", artist: "A Cover Band" })).toBe("Yesterday – A Cover Band");
  });
});
