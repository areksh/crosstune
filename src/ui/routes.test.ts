import { describe, expect, it } from "vitest";
import type { PlaylistId } from "../services/ids.js";
import { parseRoute, redirectFor, routeHash, type Route } from "./routes.js";

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

  it("leaves current addresses alone", () => {
    expect(redirectFor("#/p/12345")).toBeUndefined();
    expect(redirectFor("#/deduplicate")).toBeUndefined();
    expect(redirectFor("")).toBeUndefined();
  });
});
