import { describe, expect, it } from "vitest";
import type { PlaylistId } from "../services/ids.js";
import { parseRoute, redirectFor, routeHash, viewOf, type Route } from "./routes.js";

describe("parseRoute", () => {
  it("reads the library home", () => {
    expect(parseRoute("")).toEqual({ kind: "home" });
    expect(parseRoute("#/")).toEqual({ kind: "home" });
  });

  it("reads a playlist, Qobuz ids in their short form", () => {
    expect(parseRoute("#/p/12345")).toEqual({ kind: "playlist", id: "qobuz:12345" });
    expect(parseRoute("#/p/spotify%3A37i9dQ")).toEqual({ kind: "playlist", id: "spotify:37i9dQ" });
  });

  it("reads Favourites and All playlists per service", () => {
    expect(parseRoute("#/favourites/tidal")).toEqual({ kind: "favourites", service: "tidal" });
    expect(parseRoute("#/all/qobuz")).toEqual({ kind: "all", service: "qobuz" });
  });

  it("treats an unknown service or a bad id as home", () => {
    expect(parseRoute("#/favourites/deezer")).toEqual({ kind: "home" });
    expect(parseRoute("#/p/")).toEqual({ kind: "home" });
    expect(parseRoute("#/p/%E0%A4%A")).toEqual({ kind: "home" });
  });

  it("passes tool views through, and reads Settings", () => {
    expect(parseRoute("#/deduplicate")).toEqual({ kind: "view", view: "deduplicate" });
    expect(parseRoute("#/settings")).toEqual({ kind: "settings" });
  });
});

describe("tool routes", () => {
  it("reads tools on a source", () => {
    expect(parseRoute("#/p/12345/repeats")).toEqual({ kind: "playlist", id: "qobuz:12345", tool: "repeats" });
    expect(parseRoute("#/favourites/tidal/stats")).toEqual({ kind: "favourites", service: "tidal", tool: "stats" });
    expect(parseRoute("#/all/qobuz/upgrade")).toEqual({ kind: "all", service: "qobuz", tool: "upgrade" });
  });

  it("reads a tool the source does not have as the source alone", () => {
    expect(parseRoute("#/p/12345/nonsense")).toEqual({ kind: "playlist", id: "qobuz:12345" });
    expect(parseRoute("#/favourites/qobuz/combine")).toEqual({ kind: "favourites", service: "qobuz" });
  });

  it("reads new-playlist tools and Jobs", () => {
    expect(parseRoute("#/new/artists")).toEqual({ kind: "new", tool: "artists" });
    expect(parseRoute("#/new/nonsense")).toEqual({ kind: "home" });
    expect(parseRoute("#/jobs")).toEqual({ kind: "jobs" });
  });

  it("round-trips them", () => {
    const routes: Route[] = [
      { kind: "playlist", id: "spotify:37i9dQ" as PlaylistId, tool: "export" },
      { kind: "favourites", service: "tidal", tool: "repeats" },
      { kind: "all", service: "qobuz", tool: "stats" },
      { kind: "new", tool: "word-play" },
      { kind: "jobs" },
    ];
    for (const route of routes) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ kind: "playlist", id: "qobuz:1" as PlaylistId, tool: "repeats" })).toBe("#/p/1/repeats");
  });
});

describe("viewOf", () => {
  it("names the section each route shows", () => {
    expect(viewOf({ kind: "home" })).toBe("home");
    expect(viewOf({ kind: "playlist", id: "qobuz:1" as PlaylistId })).toBe("playlists");
    expect(viewOf({ kind: "playlist", id: "qobuz:1" as PlaylistId, tool: "repeats" })).toBe("deduplicate");
    expect(viewOf({ kind: "favourites", service: "qobuz" })).toBe("favourites");
    expect(viewOf({ kind: "all", service: "qobuz" })).toBe("playlists");
    expect(viewOf({ kind: "all", service: "qobuz", tool: "export" })).toBe("import-export");
    expect(viewOf({ kind: "new", tool: "artists" })).toBe("playlist");
    expect(viewOf({ kind: "jobs" })).toBe("managed");
    expect(viewOf({ kind: "settings" })).toBe("accounts");
    expect(viewOf({ kind: "view", view: "history" })).toBe("history");
    expect(viewOf({ kind: "view", view: "new-releases" })).toBe("new-releases");
    expect(viewOf({ kind: "view", view: "import-export" })).toBe("import-export");
    expect(viewOf({ kind: "view", view: "deduplicate" })).toBe("home");
  });
});

describe("routeHash", () => {
  it("round-trips every route", () => {
    const routes: Route[] = [
      { kind: "home" },
      { kind: "playlist", id: "qobuz:12345" as PlaylistId },
      { kind: "playlist", id: "spotify:37i9dQ" as PlaylistId },
      { kind: "favourites", service: "tidal" },
      { kind: "all", service: "spotify" },
      { kind: "settings" },
      { kind: "view", view: "upgrade" },
    ];
    for (const route of routes) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
  });

  it("keeps Qobuz playlist ids short", () => {
    expect(routeHash({ kind: "playlist", id: "qobuz:12345" as PlaylistId })).toBe("#/p/12345");
  });
});

describe("redirectFor", () => {
  it("sends old addresses to their new homes", () => {
    expect(redirectFor("#/playlists/12345")).toBe("#/p/12345");
    expect(redirectFor("#/playlists")).toBe("#/");
    expect(redirectFor("#/home")).toBe("#/");
    expect(redirectFor("#/accounts")).toBe("#/settings");
  });

  it("sends old tool addresses to their new homes", () => {
    expect(redirectFor("#/playlist")).toBe("#/new/artists");
    expect(redirectFor("#/albums")).toBe("#/new/albums");
    expect(redirectFor("#/similar")).toBe("#/new/similar");
    expect(redirectFor("#/word-play")).toBe("#/new/word-play");
    expect(redirectFor("#/combine")).toBe("#/new/combine");
    expect(redirectFor("#/managed")).toBe("#/jobs");
    expect(redirectFor("#/deduplicate", "tidal")).toBe("#/favourites/tidal/repeats");
    expect(redirectFor("#/upgrade", "qobuz")).toBe("#/favourites/qobuz/upgrade");
    expect(redirectFor("#/stats", "qobuz")).toBe("#/favourites/qobuz/stats");
    expect(redirectFor("#/stats")).toBe("#/");
  });

  it("leaves current addresses alone", () => {
    expect(redirectFor("#/import-export")).toBeUndefined();
    expect(redirectFor("#/new-releases")).toBeUndefined();
    expect(redirectFor("#/history")).toBeUndefined();
    expect(redirectFor("#/jobs")).toBeUndefined();
    expect(redirectFor("#/p/12345")).toBeUndefined();
    expect(redirectFor("")).toBeUndefined();
  });
});
