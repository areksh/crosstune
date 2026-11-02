import { describe, expect, it, vi } from "vitest";

import type { Album, Artist, Release, Track } from "../qobuz/index.js";
import {
  commitNewReleases,
  daysBefore,
  findNewReleases,
  isIsoDate,
  type NewReleasesClient,
} from "./new-releases.js";
import { compileTrackFilter } from "./track-filter.js";

const NOW = new Date("2026-11-01T12:00:00Z");

function release(
  id: string,
  artistId: number,
  artist: string,
  title: string,
  releaseDate: string,
  overrides: Partial<Release> = {},
): Release {
  return { id, artistId, artist, title, releaseDate, releaseType: "album", ...overrides };
}

const MASSIVE: Artist = { id: 1, name: "Massive Attack" };
const TRICKY: Artist = { id: 2, name: "Tricky" };
const PORTISHEAD: Artist = { id: 3, name: "Portishead" };

const RELEASES: Record<number, Release[]> = {
  1: [
    release("ma-new", 1, "Massive Attack", "New Album", "2026-10-24", { bitDepth: 16, samplingRate: 44.1, trackCount: 11 }),
    release("ma-new-hr", 1, "Massive Attack", "New Album (Deluxe)", "2026-10-24", { bitDepth: 24, samplingRate: 96, trackCount: 14 }),
    release("ma-future", 1, "Massive Attack", "Pre-order", "2026-12-01"),
    release("ma-mezz-rm", 1, "Massive Attack", "Mezzanine", "2026-10-10", { version: "2026 Remaster" }),
    release("ma-collab", 99, "Various Artists", "Bristol Sounds", "2026-10-15", { releaseType: "compilation" }),
    release("ma-old", 1, "Massive Attack", "Mezzanine", "1998-04-20"),
  ],
  2: [
    release("tr-ep", 2, "Tricky", "Hell EP", "2026-10-17", { releaseType: "ep-single", trackCount: 4 }),
    release("tr-live", 2, "Tricky", "Live at Brixton", "2026-10-12", { releaseType: "live" }),
    release("tr-maxi", 2, "Tricky", "Maxinquaye", "2026-10-05"),
    release("tr-maxi-old", 2, "Tricky", "Maxinquaye", "1995-02-20"),
    release("tr-old", 2, "Tricky", "Pre-Millennium Tension", "1996-11-18"),
    release("tr-fav", 2, "Tricky", "Already Loved", "2026-10-20"),
  ],
  3: [release("ph-single", 3, "Portishead", "Third", "2026-10-02", { releaseType: "ep-single", trackCount: 1 })],
};

function stubClient(overrides: Partial<NewReleasesClient> = {}) {
  return {
    getFavoriteArtists: vi.fn(async () => [MASSIVE, TRICKY, PORTISHEAD]),
    getFavoriteAlbums: vi.fn(async (): Promise<Album[]> => [
      { id: "tr-fav", title: "Already Loved", artist: "Tricky" },
    ]),
    getPlaylistTracks: vi.fn(async (): Promise<Track[]> => []),
    getArtistReleases: vi.fn(async (artistId: number) => ({
      releases: RELEASES[artistId] ?? [],
      truncated: false,
    })),
    ...overrides,
  };
}

describe("dates", () => {
  it("checks real YYYY-MM-DD dates", () => {
    expect(isIsoDate("2026-10-01")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
    expect(isIsoDate("yesterday")).toBe(false);
  });

  it("counts days back from now", () => {
    expect(daysBefore(NOW, 30)).toBe("2026-10-02");
  });
});

describe("findNewReleases", () => {
  it("keeps the window's albums and EPs, newest first, hiding favourites and reissues", async () => {
    const client = stubClient();

    const plan = await findNewReleases(client, { source: { type: "favourites" }, now: NOW });

    expect(plan.since).toBe("2026-10-02");
    expect(plan.until).toBe("2026-11-01");
    expect(plan.releases.map((r) => r.id)).toEqual([
      // The deluxe hi-res edition stands for the new album.
      "ma-new-hr",
      "tr-ep",
      "ph-single",
    ]);
    // Mezzanine 2026 Remaster (label) and Maxinquaye (same album, 1995).
    expect(plan.hidden).toEqual({ favourites: 1, reissues: 2 });
    expect(plan).toMatchObject({
      checkedArtists: 3,
      totalArtists: 3,
      capped: false,
      excludedArtists: [],
      failedArtists: [],
    });
    expect(client.getArtistReleases).toHaveBeenCalledWith(1, 100);
  });

  it("takes the window start and kinds given", async () => {
    const plan = await findNewReleases(stubClient(), {
      source: { type: "favourites" },
      now: NOW,
      since: "2026-10-10",
      include: ["live", "album"],
    });

    expect(plan.releases.map((r) => r.id)).toEqual(["ma-new-hr", "tr-live"]);
  });

  it("does not treat an earlier single of the same title as the original album", async () => {
    const client = stubClient({
      getFavoriteArtists: vi.fn(async () => [PORTISHEAD]),
      getArtistReleases: vi.fn(async () => ({
        releases: [
          release("album", 3, "Portishead", "Roads", "2026-10-20"),
          release("single", 3, "Portishead", "Roads", "2026-08-01", { releaseType: "ep-single" }),
        ],
        truncated: false,
      })),
    });

    const plan = await findNewReleases(client, { source: { type: "favourites" }, now: NOW });

    expect(plan.releases.map((r) => r.id)).toEqual(["album"]);
  });

  it("uses a playlist's artists, most frequent first", async () => {
    const client = stubClient({
      getPlaylistTracks: vi.fn(async (): Promise<Track[]> => [
        { id: 1, title: "a", artistId: 3, artist: "Portishead" },
        { id: 2, title: "b", artistId: 2, artist: "Tricky" },
        { id: 3, title: "c", artistId: 2, artist: "Tricky" },
      ]),
    });

    const plan = await findNewReleases(client, {
      source: { type: "playlist", playlistId: 9 },
      now: NOW,
      maxArtists: 1,
    });

    expect(client.getPlaylistTracks).toHaveBeenCalledWith(9);
    expect(client.getFavoriteArtists).not.toHaveBeenCalled();
    expect(client.getArtistReleases).toHaveBeenCalledTimes(1);
    expect(client.getArtistReleases).toHaveBeenCalledWith(2, 100);
    expect(plan).toMatchObject({ checkedArtists: 1, totalArtists: 2, capped: true });
  });

  it("leaves out excluded artists and releases matching an album term", async () => {
    const client = stubClient();

    const plan = await findNewReleases(client, {
      source: { type: "favourites" },
      now: NOW,
      filter: compileTrackFilter({ excludeArtists: ["tricky"], excludeAlbums: ["third"] }),
    });

    expect(plan.excludedArtists).toEqual(["Tricky"]);
    expect(plan.releases.map((r) => r.id)).toEqual(["ma-new-hr"]);
    expect(client.getArtistReleases).not.toHaveBeenCalledWith(2, 100);
  });

  it("hides a favourite album's other edition", async () => {
    const client = stubClient({
      getFavoriteAlbums: vi.fn(async (): Promise<Album[]> => [
        { id: "other-id", title: "New Album", artist: "Massive Attack" },
      ]),
    });

    const plan = await findNewReleases(client, { source: { type: "favourites" }, now: NOW });

    expect(plan.releases.map((r) => r.id)).not.toContain("ma-new-hr");
    expect(plan.hidden.favourites).toBe(2);
  });

  it("reports artists whose releases could not be fetched", async () => {
    const client = stubClient({
      getArtistReleases: vi.fn(async (artistId: number) => {
        if (artistId === 2) throw new Error("boom");
        return { releases: RELEASES[artistId] ?? [], truncated: false };
      }),
    });

    const plan = await findNewReleases(client, { source: { type: "favourites" }, now: NOW });

    expect(plan.failedArtists).toEqual(["Tricky"]);
    expect(plan.releases.map((r) => r.id)).toEqual(["ma-new-hr", "ph-single"]);
  });

  it("checks each artist once", async () => {
    const client = stubClient({ getFavoriteArtists: vi.fn(async () => [TRICKY, TRICKY]) });

    const plan = await findNewReleases(client, { source: { type: "favourites" }, now: NOW });

    expect(client.getArtistReleases).toHaveBeenCalledTimes(1);
    expect(plan.totalArtists).toBe(1);
  });
});

describe("findNewReleases windows and sources", () => {
  const ids = (plan: { releases: Release[] }) => plan.releases.map((r) => r.id);

  it("treats a last-days window as since that many days before now", async () => {
    const bySince = await findNewReleases(stubClient(), {
      source: { type: "favourites" },
      now: NOW,
      since: daysBefore(NOW, 20),
    });
    const byWindow = await findNewReleases(stubClient(), {
      source: { type: "favourites" },
      now: NOW,
      window: { type: "last-days", days: 20 },
    });
    expect(byWindow).toEqual(bySince);
    expect(byWindow.since).toBe("2026-10-12");
  });

  it("keeps each artist's newest N releases, skipping reissues of older titles", async () => {
    const plan = await findNewReleases(stubClient(), {
      source: { type: "favourites" },
      now: NOW,
      window: { type: "latest-per-artist", count: 2 },
      hideFavourites: false,
    });
    // Massive Attack: the new album (best edition) and 1998's Mezzanine; the
    // remaster is a reissue and the pre-order is not out yet. Tricky: the
    // favourite and the EP; Maxinquaye (2026) repeats a 1995 title.
    expect(ids(plan).sort()).toEqual(["ma-new-hr", "ma-old", "ph-single", "tr-ep", "tr-fav"].sort());
    expect(plan.since).toBe("1998-04-20");
  });

  it("applies the count before hiding favourites", async () => {
    const plan = await findNewReleases(stubClient(), {
      source: { type: "artists", artists: [TRICKY] },
      now: NOW,
      window: { type: "latest-per-artist", count: 1 },
    });
    expect(ids(plan)).toEqual([]);
    expect(plan.hidden.favourites).toBe(1);
  });

  it("keeps favourited releases when hideFavourites is false", async () => {
    const plan = await findNewReleases(stubClient(), {
      source: { type: "favourites" },
      now: NOW,
      hideFavourites: false,
    });
    expect(ids(plan)).toContain("tr-fav");
    expect(plan.hidden.favourites).toBe(0);
  });

  it("checks exactly the artists given", async () => {
    const client = stubClient();
    const plan = await findNewReleases(client, {
      source: { type: "artists", artists: [TRICKY, TRICKY] },
      now: NOW,
    });
    expect(client.getFavoriteArtists).not.toHaveBeenCalled();
    expect(client.getArtistReleases).toHaveBeenCalledTimes(1);
    expect(plan.checkedArtists).toBe(1);
    expect(ids(plan)).toEqual(["tr-ep"]);
  });
});

describe("commitNewReleases", () => {
  function writer() {
    const tracks: Record<string, Track[]> = {
      a: [{ id: 1, title: "One" }, { id: 2, title: "Two (Demo)" }],
      b: [{ id: 3, title: "Three" }, { id: 1, title: "One" }],
    };
    return {
      getAlbumTracks: vi.fn(async (id: string) => {
        const list = tracks[id];
        if (list === undefined) throw new Error("404");
        return list;
      }),
      createPlaylist: vi.fn(async (name: string) => ({ id: 77, name })),
      addTracksToPlaylist: vi.fn(async () => {}),
      addFavoriteAlbums: vi.fn(async () => {}),
    };
  }

  it("creates a playlist of the releases' tracks in the order given", async () => {
    const client = writer();

    const result = await commitNewReleases(client, {
      albumIds: ["b", "missing", "a"],
      target: { type: "playlist", name: "Fresh", isPublic: true },
      filter: compileTrackFilter({ excludeTracks: ["demo"] }),
    });

    expect(client.createPlaylist).toHaveBeenCalledWith("Fresh", { isPublic: true });
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(77, [3, 1]);
    expect(result).toEqual({
      type: "playlist",
      playlist: { id: 77, name: "Fresh" },
      trackCount: 2,
      excludedCount: 1,
      failedAlbumIds: ["missing"],
    });
  });

  it("adds the releases to favourite albums", async () => {
    const client = writer();

    const result = await commitNewReleases(client, {
      albumIds: ["a", "b", "a"],
      target: { type: "favourite-albums" },
    });

    expect(client.addFavoriteAlbums).toHaveBeenCalledWith(["a", "b"]);
    expect(result).toEqual({ type: "favourite-albums", added: 2 });
    expect(client.getAlbumTracks).not.toHaveBeenCalled();
  });

  it("refuses an empty selection or a playlist with no tracks", async () => {
    const client = writer();

    await expect(
      commitNewReleases(client, { albumIds: [], target: { type: "favourite-albums" } }),
    ).rejects.toThrow(/at least one/);
    await expect(
      commitNewReleases(client, { albumIds: ["missing"], target: { type: "playlist", name: "x" } }),
    ).rejects.toThrow(/No tracks/);
    expect(client.createPlaylist).not.toHaveBeenCalled();
  });
});
