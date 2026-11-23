import { describe, expect, it } from "vitest";
import type { PlaylistId } from "../services/ids.js";
import { newToolView, sourceToolFill, toolLabel, toolsFor } from "./tools.js";

describe("toolsFor", () => {
  it("offers each source its tools", () => {
    expect(toolsFor("playlist")).toEqual(["repeats", "upgrade", "stats", "export", "similar", "combine"]);
    expect(toolsFor("favourites")).toEqual(["repeats", "upgrade", "stats", "export"]);
    expect(toolsFor("all")).toEqual(["repeats", "upgrade", "stats", "export"]);
  });
});

describe("sourceToolFill", () => {
  it("fills a tool for a playlist", () => {
    expect(sourceToolFill("repeats", { kind: "playlist", id: "tidal:x" as PlaylistId })).toEqual({
      view: "deduplicate",
      radios: { "dedup-source": "playlist" },
      fields: { "dedup-playlist-select": "tidal:x" },
    });
    expect(sourceToolFill("upgrade", { kind: "playlist", id: "qobuz:12" as PlaylistId })).toEqual({
      view: "upgrade",
      fields: { "upgrade-source": "playlist:qobuz:12" },
    });
  });

  it("gives Similar artists a link it can read", () => {
    expect(sourceToolFill("similar", { kind: "playlist", id: "qobuz:12" as PlaylistId })?.fields).toEqual({
      "similar-source-link": "https://play.qobuz.com/playlist/12",
    });
    expect(sourceToolFill("similar", { kind: "playlist", id: "tidal:x" as PlaylistId })?.fields).toEqual({
      "similar-source-link": "tidal:x",
    });
  });

  it("fills Favourites and All playlists", () => {
    expect(sourceToolFill("stats", { kind: "all" })).toEqual({ view: "stats", fields: { "stats-source": "everything" } });
    expect(sourceToolFill("export", { kind: "favourites" })).toEqual({
      view: "import-export",
      radios: { "ie-source": "favourite-tracks" },
    });
    expect(sourceToolFill("repeats", { kind: "all" })).toEqual({
      view: "deduplicate",
      radios: { "dedup-source": "all-playlists" },
    });
  });

  it("offers nothing a source cannot do", () => {
    expect(sourceToolFill("combine", { kind: "favourites" })).toBeUndefined();
    expect(sourceToolFill("similar", { kind: "all" })).toBeUndefined();
  });
});

describe("toolLabel", () => {
  it("labels tools for their source", () => {
    expect(toolLabel("repeats")).toBe("Find repeats");
    expect(toolLabel("repeats", "all")).toBe("Find repeats across them");
    expect(toolLabel("upgrade", "all")).toBe("Upgrade all");
    expect(toolLabel("artists")).toBe("Playlist from artists");
  });
});

describe("newToolView", () => {
  it("names each new-playlist tool's section", () => {
    expect(newToolView("artists")).toBe("playlist");
    expect(newToolView("import")).toBe("import-export");
    expect(newToolView("word-play")).toBe("word-play");
  });
});
