import { describe, expect, it } from "vitest";
import type { PlaylistId } from "../services/ids.js";
import { askSuggestions, type AskContext } from "./ask.js";

const techno = "qobuz:71489352" as PlaylistId;
const context: AskContext = {
  playlists: [
    { id: techno, name: "Techno", owned: true },
    { id: "qobuz:2" as PlaylistId, name: "rock/metal v3", owned: true },
  ],
  service: "qobuz",
};

describe("askSuggestions", () => {
  it("suggests nothing for nothing", () => {
    expect(askSuggestions("  ", context)).toEqual([]);
  });

  it("offers what a pasted playlist link is for", () => {
    const [first] = askSuggestions("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", context);
    expect(first?.label).toBe("Similar artists from this playlist");
    expect(first?.hash).toBe("#/new/similar");
  });

  it("builds from pasted artists, keeping every line", () => {
    const [first] = askSuggestions("Portishead\nMassive Attack", context);
    expect(first).toEqual({
      label: "Build a playlist from these artists",
      hash: "#/new/artists",
      fill: { view: "playlist", fields: { artists: "Portishead\nMassive Attack" } },
    });
  });

  it("offers the tools on a pasted playlist only when it is the user's", () => {
    const own = askSuggestions("https://play.qobuz.com/playlist/71489352", context).map((s) => s.hash);
    expect(own).toContain("#/p/71489352/repeats");
    const other = askSuggestions("https://play.qobuz.com/playlist/99", context).map((s) => s.hash);
    expect(other.some((hash) => hash.startsWith("#/p/"))).toBe(false);
  });

  it("opens playlists whose name holds the text", () => {
    expect(askSuggestions("tech", context)[0]).toEqual({ label: "Open Techno", hash: "#/p/71489352" });
  });

  it("opens a tool on the open playlist, else on the service's Favourites", () => {
    expect(askSuggestions("repeats", { ...context, open: techno })[0]?.hash).toBe("#/p/71489352/repeats");
    expect(askSuggestions("repeats", context)[0]?.hash).toBe("#/favourites/qobuz/repeats");
  });

  it("opens tools that start a playlist, and the pages of their own", () => {
    expect(askSuggestions("word", context)[0]?.hash).toBe("#/new/word-play");
    expect(askSuggestions("history", context)[0]?.hash).toBe("#/history");
    expect(askSuggestions("jobs", context)[0]?.hash).toBe("#/jobs");
  });

  it("takes an unmatched line as an artist", () => {
    expect(askSuggestions("Portishead", context)[0]).toEqual({
      label: "Build a playlist from Portishead",
      hash: "#/new/artists",
      fill: { view: "playlist", fields: { artists: "Portishead" } },
    });
  });

  it("finds a playlist whose name has a dash, before reading it as an album", () => {
    const dashed: AskContext = { ...context, playlists: [{ id: "qobuz:5" as PlaylistId, name: "Chill - Evening", owned: true }] };
    const suggestions = askSuggestions("Chill - Evening", dashed);
    expect(suggestions[0]).toEqual({ label: "Open Chill - Evening", hash: "#/p/5" });
    expect(suggestions.some((s) => s.label === "Build a playlist from these albums")).toBe(true);
  });

  it("names a pasted artist link as an artist, not by its address", () => {
    expect(askSuggestions("https://open.spotify.com/artist/6liAMWkVf5LH7YR9yfFy1Y", context)[0]?.label).toBe(
      "Build a playlist from this artist",
    );
  });

  it("names an artist given as a Spotify address or a link without https as an artist", () => {
    expect(askSuggestions("spotify:artist:6liAMWkVf5LH7YR9yfFy1Y", context)[0]?.label).toBe("Build a playlist from this artist");
    expect(askSuggestions("open.spotify.com/artist/6liAMWkVf5LH7YR9yfFy1Y", context)[0]?.label).toBe("Build a playlist from this artist");
  });

  it("keeps the album suggestion for an \"X - Y\" line that also names a tool", () => {
    expect(askSuggestions("Import - Live", context).some((s) => s.label === "Build a playlist from these albums")).toBe(true);
  });

  it("says when a link is of a kind no tool takes, rather than offering nothing", () => {
    expect(askSuggestions("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", context)).toEqual([
      { label: "Track and label links are not used by a tool yet" },
    ]);
  });

  it("never offers more than eight", () => {
    const many: AskContext = {
      ...context,
      playlists: Array.from({ length: 20 }, (_, i) => ({ id: `qobuz:${i + 10}` as PlaylistId, name: `Mix ${i}`, owned: true })),
    };
    expect(askSuggestions("mix", many).length).toBeLessThanOrEqual(8);
  });
});
