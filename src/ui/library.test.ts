import { describe, expect, it } from "vitest";
import type { ManagerPlaylist } from "../features/playlist-manager.js";
import type { PlaylistId } from "../services/ids.js";
import { libraryRows, sidebarRows, tabsFor, validTab } from "./library.js";

function pl(id: string, name: string, updatedAt?: string, trackCount?: number): ManagerPlaylist {
  return {
    id: id as PlaylistId,
    name,
    owned: true,
    readBy: [],
    ...(updatedAt !== undefined && { updatedAt }),
    ...(trackCount !== undefined && { trackCount }),
  };
}

const list = [pl("qobuz:1", "Techno", "2026-11-01", 112), pl("spotify:a", "Techno", "2026-11-03"), pl("tidal:x", "uk rap", "2026-11-02")];

describe("tabsFor", () => {
  it("offers All only when more than one service is connected", () => {
    expect(tabsFor(["qobuz"])).toEqual(["qobuz"]);
    expect(tabsFor(["qobuz", "spotify"])).toEqual(["all", "qobuz", "spotify"]);
  });
});

describe("validTab", () => {
  it("keeps a remembered tab that is still connected", () => {
    expect(validTab("tidal", ["qobuz", "tidal"])).toBe("tidal");
  });

  it("falls back from a tab that is no longer valid", () => {
    expect(validTab("tidal", ["qobuz"])).toBe("qobuz");
    expect(validTab("all", ["qobuz"])).toBe("qobuz");
    expect(validTab(undefined, ["qobuz", "tidal"])).toBe("all");
    expect(validTab("nonsense", ["qobuz", "tidal"])).toBe("all");
  });
});

describe("sidebarRows", () => {
  it("lists every copy of a linked playlist under All, newest change first", () => {
    const rows = sidebarRows(list, { tab: "all", filter: "", linked: new Set(["qobuz:1", "spotify:a"] as PlaylistId[]) });
    expect(rows.map((row) => [row.id, row.service, row.linked])).toEqual([
      ["spotify:a", "spotify", true],
      ["tidal:x", "tidal", false],
      ["qobuz:1", "qobuz", true],
    ]);
  });

  it("carries the song count when known", () => {
    const rows = sidebarRows(list, { tab: "qobuz", filter: "", linked: new Set() });
    expect(rows).toEqual([{ id: "qobuz:1", name: "Techno", service: "qobuz", trackCount: 112, linked: false }]);
  });

  it("filters by name, ignoring case and surrounding space", () => {
    expect(sidebarRows(list, { tab: "all", filter: " UK ", linked: new Set() }).map((row) => row.id)).toEqual(["tidal:x"]);
  });

  it("puts undated playlists last, by name in numeric order", () => {
    const rows = sidebarRows([pl("qobuz:3", "Mix 10"), pl("qobuz:4", "Mix 9"), pl("qobuz:5", "New", "2026-01-01")], {
      tab: "all",
      filter: "",
      linked: new Set(),
    });
    expect(rows.map((row) => row.name)).toEqual(["New", "Mix 9", "Mix 10"]);
  });
});

describe("libraryRows", () => {
  it("gives Favourites and All playlists per service, New releases once", () => {
    expect(libraryRows(["qobuz", "spotify"], "all")).toEqual([
      { kind: "favourites", service: "qobuz" },
      { kind: "favourites", service: "spotify" },
      { kind: "all", service: "qobuz" },
      { kind: "all", service: "spotify" },
      { kind: "new-releases" },
    ]);
  });

  it("gives only the chosen service's rows under its tab", () => {
    expect(libraryRows(["qobuz", "spotify"], "spotify")).toEqual([
      { kind: "favourites", service: "spotify" },
      { kind: "all", service: "spotify" },
      { kind: "new-releases" },
    ]);
  });

  it("has nothing when no service is connected", () => {
    expect(libraryRows([], "all")).toEqual([]);
  });
});
