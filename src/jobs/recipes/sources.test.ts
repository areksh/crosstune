import { describe, expect, it, vi } from "vitest";

import type { Artist, Track } from "../../services/model.js";
import { validateJob, type CombinedSource, type DiscoverySource, type SmartSource } from "../model.js";
import { resolveCombined } from "./combined.js";
import { stableShuffle } from "./common.js";
import { resolveDiscovery, rotationNumber, type DiscoveryClient } from "./discovery.js";
import { resolveFollow } from "./follow.js";
import { meetsRule, resolveSmart } from "./smart.js";

const NOW = new Date("2026-11-02T12:00:00Z");
const tr = (id: number, extra: Partial<Track> = {}): Track => ({ id, title: `T${id}`, ...extra });
const ids = (result: { tracks: { trackId: number }[] }) => result.tracks.map((t) => t.trackId);

function source<T>(raw: Record<string, unknown>): T {
  return validateJob({
    id: "a1b2c3d4",
    name: "x",
    createdAt: "2026-10-01T00:00:00.000Z",
    kind: "playlist",
    schedule: { every: "day" },
    target: { type: "created" },
    source: raw,
  }).source as T;
}

function inputs(lists: Record<string, Track[] | Error>) {
  const read = (key: string) => {
    const value = lists[key];
    if (value === undefined || value instanceof Error) {
      throw value ?? new Error(`no ${key}`);
    }
    return value;
  };
  return {
    getFavoriteTracks: vi.fn(async () => read("f")),
    getPlaylistTracks: vi.fn(async (id: number) => read(`p${id}`)),
  };
}

describe("stableShuffle", () => {
  it("keeps the others' order when an item is added", () => {
    const before = stableShuffle("job", [1, 2, 3, 4, 5, 6], (n) => n);
    const after = stableShuffle("job", [1, 2, 3, 4, 5, 6, 7], (n) => n);
    expect(after.filter((n) => n !== 7)).toEqual(before);
    expect(stableShuffle("other", [1, 2, 3, 4, 5, 6], (n) => n)).not.toEqual(before);
  });
});

describe("combined source", () => {
  const def = (overrides: Record<string, unknown> = {}) =>
    source<CombinedSource>({
      type: "combined",
      inputs: [{ type: "playlist", playlistId: 1 }, { type: "playlist", playlistId: 2 }],
      ...overrides,
    });

  it("merges the inputs, each song once", async () => {
    const client = inputs({ p1: [tr(1), tr(2)], p2: [tr(2), tr(3)] });
    const result = await resolveCombined(client, def(), { jobId: "j" });
    expect(ids(result)).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
    expect(result.tracks[2]?.source).toBe("playlist:2");
  });

  it("keeps what it read when one merge input fails, removing nothing", async () => {
    const client = inputs({ p1: [tr(1)], p2: new Error("down") });
    const result = await resolveCombined(client, def(), { jobId: "j" });
    expect(ids(result)).toEqual([1]);
    expect(result.complete).toBe(false);
  });

  it("fails when an input of a common or only-first combination fails", async () => {
    const client = inputs({ p1: [tr(1)], p2: new Error("down") });
    await expect(resolveCombined(client, def({ mode: "common" }), { jobId: "j" })).rejects.toThrow(/playlist 2/);
  });

  it("shuffles stably by job", async () => {
    const client = inputs({ p1: [tr(1), tr(2), tr(3)], p2: [tr(4), tr(5)] });
    const a = await resolveCombined(client, def({ order: "shuffle" }), { jobId: "j" });
    const b = await resolveCombined(client, def({ order: "shuffle" }), { jobId: "j" });
    expect(ids(a)).toEqual(ids(b));
    expect([...ids(a)].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("follow source", () => {
  it("follows the playlist's tracks in its order", async () => {
    const result = await resolveFollow(inputs({ p9: [tr(3), tr(1)] }), { type: "follow", playlistId: 9, keepRemoved: false }, { state: {} });
    expect(ids(result)).toEqual([3, 1]);
    expect(result.state).toEqual({});
  });

  it("archives: keeps every track ever seen, newest last", async () => {
    const def = { type: "follow" as const, playlistId: 9, keepRemoved: true };
    const result = await resolveFollow(inputs({ p9: [tr(3), tr(4)] }), def, { state: { seen: [1, 3] } });
    expect(ids(result)).toEqual([1, 3, 4]);
    expect(result.state.seen).toEqual([1, 3, 4]);
  });

  it("is incomplete when the playlist cannot be read (an archive keeps its list)", async () => {
    const failing = inputs({ p9: new Error("down") });
    const followed = await resolveFollow(failing, { type: "follow", playlistId: 9, keepRemoved: false }, { state: {} });
    expect(followed).toMatchObject({ tracks: [], complete: false });
    const archived = await resolveFollow(failing, { type: "follow", playlistId: 9, keepRemoved: true }, { state: { seen: [1] } });
    expect(ids(archived)).toEqual([1]);
    expect(archived.complete).toBe(false);
  });
});

describe("smart source", () => {
  it.each([
    [{ type: "quality", quality: "hires" }, tr(1, { bitDepth: 24, samplingRate: 96 }), true],
    [{ type: "quality", quality: "hires" }, tr(1, { bitDepth: 16, samplingRate: 44.1 }), false],
    [{ type: "decades", decades: ["1990s"] }, tr(1, { releaseDate: "1994-05-01" }), true],
    [{ type: "decades", decades: ["1990s"] }, tr(1), false],
    [{ type: "genres", genres: ["jazz"] }, tr(1, { genre: "Jazz" }), true],
    [{ type: "favourited-within", days: 30 }, tr(1, { favouritedAt: "2026-10-20T00:00:00.000Z" }), true],
    [{ type: "favourited-within", days: 30 }, tr(1, { favouritedAt: "2026-01-01T00:00:00.000Z" }), false],
    [{ type: "artists", exclude: [{ id: 5, name: "X" }] }, tr(1, { artistId: 5 }), false],
    [{ type: "artists", include: [{ id: 5, name: "Air" }] }, tr(1, { artist: "AIR" }), true],
    [{ type: "duration", maxSeconds: 200 }, tr(1, { duration: 250 }), false],
  ] as const)("rule %j on %j -> %s", (rule, track, expected) => {
    expect(meetsRule(track, rule as never, NOW)).toBe(expected);
  });

  it("keeps the tracks meeting every rule, carrying favourite dates over to playlist copies", async () => {
    const def = source<SmartSource>({
      type: "smart",
      from: [{ type: "playlist", playlistId: 1 }, { type: "favourites" }],
      rules: [{ type: "favourited-within", days: 30 }],
      order: "newest-favourited",
    });
    const client = inputs({
      p1: [tr(1), tr(2)],
      f: [
        tr(1, { favouritedAt: "2026-10-10T00:00:00.000Z" }),
        tr(3, { favouritedAt: "2026-10-30T00:00:00.000Z" }),
        tr(4, { favouritedAt: "2025-01-01T00:00:00.000Z" }),
      ],
    });
    const result = await resolveSmart(client, def, { now: NOW, jobId: "j" });
    expect(ids(result)).toEqual([3, 1]);
    expect(result.complete).toBe(true);
  });

  it("uses a favourite's original date when a tidy-up replaced it", async () => {
    const def = source<SmartSource>({
      type: "smart",
      from: [{ type: "favourites" }],
      rules: [{ type: "favourited-within", days: 30 }],
    });
    // Track 8 was favourited years ago; an upgrade swapped it in today.
    const client = inputs({ f: [tr(8, { favouritedAt: NOW.toISOString() })] });
    const result = await resolveSmart(client, def, {
      now: NOW,
      jobId: "j",
      favouriteDates: new Map([[8, "2020-01-01T00:00:00.000Z"]]),
    });
    expect(ids(result)).toEqual([]);
  });

  it("is incomplete when an input fails", async () => {
    const def = source<SmartSource>({
      type: "smart",
      from: [{ type: "playlist", playlistId: 1 }],
      rules: [{ type: "quality", quality: "cd" }],
    });
    const result = await resolveSmart(inputs({ p1: new Error("down") }), def, { now: NOW, jobId: "j" });
    expect(result).toMatchObject({ tracks: [], complete: false, notes: [expect.stringMatching(/playlist 1/)] });
  });
});

describe("discovery source", () => {
  it("numbers rotations in local days and ISO weeks since creation", () => {
    const created = "2026-10-01T10:00:00"; // a Thursday, local time
    expect(rotationNumber("day", created, new Date("2026-10-01T23:00:00"))).toBe(0);
    expect(rotationNumber("day", created, new Date("2026-10-03T01:00:00"))).toBe(2);
    expect(rotationNumber("week", created, new Date("2026-10-04T23:00:00"))).toBe(0); // Sunday
    expect(rotationNumber("week", created, new Date("2026-10-05T00:30:00"))).toBe(1); // Monday
  });

  const seed: Artist = { id: 1, name: "Seed" };
  const similar: Artist[] = [2, 3, 4, 5].map((id) => ({ id, name: `S${id}` }));
  function client(): DiscoveryClient & Record<string, ReturnType<typeof vi.fn>> {
    return {
      getFavoriteArtists: vi.fn(async () => [seed]),
      getPlaylistTracks: vi.fn(async () => []),
      getSimilarArtists: vi.fn(async () => similar),
      getArtistTopTracks: vi.fn(async (id: number) => [tr(id * 10), tr(id * 10 + 1), tr(id * 10 + 2)]),
      getFavoriteTracks: vi.fn(async () => [tr(20)]),
    } as never;
  }
  const def = source<DiscoverySource>({
    type: "discovery",
    seeds: { type: "list", artists: [seed] },
    artistsPerRotation: 2,
    tracksPerArtist: 2,
    rotation: "week",
  });
  const ctx = { now: NOW, jobId: "j", createdAt: "2026-10-01T00:00:00.000Z" };

  it("picks artists and their top tracks, skipping favourites, and reuses them within the rotation", async () => {
    const c = client();
    const first = await resolveDiscovery(c, def, { ...ctx, state: {} });
    expect(first.tracks).toHaveLength(4);
    expect(ids(first)).not.toContain(20);
    expect(first.state.rotation?.artistIds).toHaveLength(2);
    const again = await resolveDiscovery(c, def, { ...ctx, state: first.state });
    expect(ids(again)).toEqual(ids(first));
    expect(c.getArtistTopTracks).toHaveBeenCalledTimes(2);
  });

  it("is the same for the same job and rotation", async () => {
    const a = await resolveDiscovery(client(), def, { ...ctx, state: {} });
    const b = await resolveDiscovery(client(), def, { ...ctx, state: {} });
    expect(ids(a)).toEqual(ids(b));
  });

  it("does not serve last rotation's tracks again", async () => {
    const first = await resolveDiscovery(client(), def, { ...ctx, state: {} });
    const nextWeek = new Date(NOW.getTime() + 7 * 86_400_000);
    const second = await resolveDiscovery(client(), def, { ...ctx, now: nextWeek, state: first.state });
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
    expect(second.state.served?.map((entry) => entry.rotation)).toHaveLength(2);
  });
});
