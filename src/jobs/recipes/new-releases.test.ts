import { describe, expect, it, vi } from "vitest";

import type { Artist, Release, Track } from "../../qobuz/index.js";
import type { NewReleasesRecipeDef } from "../model.js";
import { resolveNewReleasesFeed, type FeedClient } from "./new-releases.js";

const NOW = new Date("2026-11-01T12:00:00Z");

const A: Artist = { id: 1, name: "Air" };
const B: Artist = { id: 2, name: "Bonobo" };
const S: Artist = { id: 3, name: "Similar One" };

function release(id: string, artist: Artist, date: string, overrides: Partial<Release> = {}): Release {
  return { id, artistId: artist.id, artist: artist.name, title: id, releaseDate: date, releaseType: "album", ...overrides };
}

const RELEASES: Record<number, Release[]> = {
  1: [release("air-new", A, "2026-10-20"), release("air-older", A, "2026-10-05")],
  2: [release("bonobo-old", B, "2020-01-01")], // nothing new
  3: [release("sim-new", S, "2026-10-25")],
};

const TRACKS: Record<string, Track[]> = {
  "air-new": [
    { id: 11, title: "a1", duration: 200 },
    { id: 12, title: "a2", duration: 200 },
  ],
  "air-older": [{ id: 13, title: "a3", duration: 200 }],
  "sim-new": [{ id: 31, title: "s1", duration: 300 }],
};

function client(overrides: Partial<Record<keyof FeedClient, unknown>> = {}) {
  return {
    getFavoriteArtists: vi.fn(async () => [A, B]),
    getFavoriteAlbums: vi.fn(async () => []),
    getPlaylistTracks: vi.fn(async (): Promise<Track[]> => []),
    getArtistReleases: vi.fn(async (id: number) => ({ releases: RELEASES[id] ?? [], truncated: false })),
    getAlbumTracks: vi.fn(async (albumId: string) => {
      const tracks = TRACKS[albumId];
      if (tracks === undefined) {
        throw new Error(`no album ${albumId}`);
      }
      return tracks;
    }),
    getSimilarArtists: vi.fn(async () => [S]),
    ...overrides,
  } as FeedClient & Record<string, ReturnType<typeof vi.fn>>;
}

function def(overrides: Partial<NewReleasesRecipeDef> = {}): NewReleasesRecipeDef {
  return {
    type: "new-releases",
    artists: { type: "list", artists: [A, B] },
    window: { type: "last-days", days: 30 },
    include: ["album", "ep-single"],
    hideFavourites: false,
    ...overrides,
  };
}

const ctx = (state: { similar?: { takenAt: string; artists: Artist[] } } = {}) => ({
  now: NOW,
  jobId: "a1b2c3d4",
  state,
});

describe("resolveNewReleasesFeed", () => {
  it("adds the new releases' tracks, newest release first; artists with nothing new add nothing", async () => {
    const result = await resolveNewReleasesFeed(client(), def(), undefined, ctx());
    expect(result.tracks.map((t) => t.trackId)).toEqual([11, 12, 13]);
    expect(result.tracks[0]).toEqual({ trackId: 11, source: "album:air-new", durationSeconds: 200 });
    expect(result.complete).toBe(true);
  });

  it("takes a similar-artist snapshot on the first run", async () => {
    const c = client();
    const result = await resolveNewReleasesFeed(c, def({ similar: { perArtist: 1, refreshDays: 30 } }), undefined, ctx());
    expect(result.similar).toEqual({ takenAt: NOW.toISOString(), artists: [S] });
    expect(result.tracks.map((t) => t.trackId)).toEqual([31, 11, 12, 13]);
  });

  it("reuses the snapshot within refreshDays", async () => {
    const c = client();
    const snapshot = { takenAt: "2026-10-20T00:00:00.000Z", artists: [S] };
    const result = await resolveNewReleasesFeed(
      c,
      def({ similar: { perArtist: 1, refreshDays: 30 } }),
      undefined,
      ctx({ similar: snapshot }),
    );
    expect(c.getSimilarArtists).not.toHaveBeenCalled();
    expect(result.similar).toEqual(snapshot);
  });

  it("refreshes the snapshot after refreshDays", async () => {
    const c = client();
    const result = await resolveNewReleasesFeed(
      c,
      def({ similar: { perArtist: 1, refreshDays: 30 } }),
      undefined,
      ctx({ similar: { takenAt: "2026-09-01T00:00:00.000Z", artists: [] } }),
    );
    expect(c.getSimilarArtists).toHaveBeenCalled();
    expect(result.similar?.takenAt).toBe(NOW.toISOString());
  });

  it("keeps the old snapshot and marks the run incomplete when the walk fails", async () => {
    const old = { takenAt: "2026-09-01T00:00:00.000Z", artists: [S] };
    const c = client({
      getSimilarArtists: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const result = await resolveNewReleasesFeed(
      c,
      def({ similar: { perArtist: 1, refreshDays: 30 } }),
      undefined,
      ctx({ similar: old }),
    );
    expect(result.similar).toEqual(old);
    expect(result.complete).toBe(false);
    expect(result.tracks.map((t) => t.trackId)).toContain(31);
  });

  it("marks the run incomplete when an artist cannot be read", async () => {
    const c = client({
      getArtistReleases: vi.fn(async (id: number) => {
        if (id === 2) {
          throw new Error("down");
        }
        return { releases: RELEASES[id] ?? [], truncated: false };
      }),
    });
    const result = await resolveNewReleasesFeed(c, def(), undefined, ctx());
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/Bonobo/);
  });

  it("marks the run incomplete when an album's tracks cannot be read", async () => {
    const c = client({
      getArtistReleases: vi.fn(async () => ({ releases: [release("ghost", A, "2026-10-30")], truncated: false })),
    });
    const result = await resolveNewReleasesFeed(c, def(), undefined, ctx());
    expect(result.complete).toBe(false);
  });

  it("keeps only the newest releases with maxReleases", async () => {
    const result = await resolveNewReleasesFeed(client(), def(), { maxReleases: 1 }, ctx());
    expect(result.tracks.map((t) => t.trackId)).toEqual([11, 12]);
  });

  it("caps the track count with maxTracks", async () => {
    const result = await resolveNewReleasesFeed(client(), def(), { maxTracks: 2 }, ctx());
    expect(result.tracks.map((t) => t.trackId)).toEqual([11, 12]);
  });

  it("trims from the end to fit maxMinutes", async () => {
    const result = await resolveNewReleasesFeed(client(), def(), { maxMinutes: 7 }, ctx());
    expect(result.tracks.map((t) => t.trackId)).toEqual([11, 12]);
  });

  it("reads favourite artists live", async () => {
    const c = client();
    await resolveNewReleasesFeed(c, def({ artists: { type: "favourites" } }), undefined, ctx());
    expect(c.getFavoriteArtists).toHaveBeenCalled();
  });

  it("drops excluded tracks", async () => {
    const result = await resolveNewReleasesFeed(client(), def({ exclude: { excludeTracks: ["a2"] } }), undefined, ctx());
    expect(result.tracks.map((t) => t.trackId)).toEqual([11, 13]);
  });

  it("marks the run incomplete when there are more artists than it checks", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: 1000 + i, name: `Artist ${i}` }));
    const result = await resolveNewReleasesFeed(client(), def({ artists: { type: "list", artists: many } }), undefined, ctx());
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/1,?000 of 1,?001/);
  });

  it("gives the same tracks for the same inputs and state", async () => {
    const state = { similar: { takenAt: "2026-10-30T00:00:00.000Z", artists: [S] } };
    const recipe = def({ similar: { perArtist: 1, refreshDays: 30 } });
    const first = await resolveNewReleasesFeed(client(), recipe, undefined, ctx(state));
    const second = await resolveNewReleasesFeed(client(), recipe, undefined, ctx(state));
    expect(second.tracks).toEqual(first.tracks);
  });
});
