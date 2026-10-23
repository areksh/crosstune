import { describe, expect, it, vi } from "vitest";

import type { Artist, Track } from "../qobuz/index.js";
import {
  planFromArtists,
  planFromPlaylist,
  resolveSimilarArtists,
  seedsFromPlaylist,
  similarTrackIds,
  type SimilarArtistsClient,
} from "./similar-artists.js";
import { compileTrackFilter } from "./track-filter.js";

const artist = (id: number, name = `Artist ${id}`): Artist => ({ id, name });

/** One track per artist by default, so every artist has something to add. */
const tracksFor = (id: number, count = 1): Track[] =>
  Array.from({ length: count }, (_v, i) => ({ id: id * 100 + i, title: `Song ${i}` }));

/** A stub honouring `limit` on both lookups, like the real client. */
function stubClient(config: {
  similar: Record<number, Artist[]>;
  tracks?: Record<number, Track[]>;
  searches?: Record<string, Artist[]>;
  playlist?: Track[];
}) {
  return {
    getSimilarArtists: vi.fn(async (id: number, limit: number) =>
      (config.similar[id] ?? []).slice(0, limit),
    ),
    getArtistTopTracks: vi.fn(async (id: number, limit?: number) =>
      (config.tracks?.[id] ?? tracksFor(id)).slice(0, limit),
    ),
    searchArtists: vi.fn(async (query: string) => config.searches?.[query] ?? []),
    getPlaylistTracks: vi.fn(async () => config.playlist ?? []),
  };
}

describe("resolveSimilarArtists", () => {
  it("takes the most similar artists of each seed, with their top tracks", async () => {
    const client = stubClient({
      similar: { 1: [artist(11), artist(12), artist(13)] },
      tracks: { 11: tracksFor(11, 5), 12: tracksFor(12, 5) },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1, "Nirvana")],
      similarPerArtist: 2,
      depth: 1,
      tracksPerSimilar: 3,
    });

    expect(result.similar.map((s) => [s.artist.id, s.seed.id, s.via.id, s.level])).toEqual([
      [11, 1, 1, 1],
      [12, 1, 1, 1],
    ]);
    expect(result.similar[0]?.tracks.map((t) => t.id)).toEqual([1100, 1101, 1102]);
    // Asks for spare candidates so already-used artists can be skipped.
    expect(client.getSimilarArtists).toHaveBeenCalledWith(1, 12);
    expect(client.getArtistTopTracks).toHaveBeenCalledWith(11, 3);
    expect(result.truncated).toBe(false);
  });

  it("caps the candidate request at 50", async () => {
    const client = stubClient({ similar: {} });

    await resolveSimilarArtists(client, {
      seeds: [artist(1)],
      similarPerArtist: 45,
      depth: 1,
      tracksPerSimilar: 1,
    });

    expect(client.getSimilarArtists).toHaveBeenCalledWith(1, 50);
  });

  it("never suggests a seed, a skipped artist, or one already chosen", async () => {
    const client = stubClient({
      similar: {
        1: [artist(2), artist(11), artist(12), artist(13)],
        2: [artist(11), artist(99), artist(21)],
      },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1), artist(2)],
      similarPerArtist: 2,
      depth: 1,
      tracksPerSimilar: 1,
      skipArtistIds: new Set([99]),
    });

    // Seed 1 skips seed 2; seed 2 skips 11 (taken by seed 1) and 99 (skipped).
    expect(result.similar.map((s) => [s.seed.id, s.artist.id])).toEqual([
      [1, 11],
      [1, 12],
      [2, 21],
    ]);
  });

  it("walks deeper levels from the previous level's artists, grouped by seed", async () => {
    const client = stubClient({
      similar: {
        1: [artist(11), artist(12)],
        2: [artist(21)],
        11: [artist(111), artist(1)],
        12: [artist(121)],
        21: [artist(211)],
        111: [artist(1111)],
      },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1), artist(2)],
      similarPerArtist: 2,
      depth: 2,
      tracksPerSimilar: 1,
    });

    expect(result.similar.map((s) => [s.artist.id, s.via.id, s.seed.id, s.level])).toEqual([
      [11, 1, 1, 1],
      [12, 1, 1, 1],
      [111, 11, 1, 2],
      [121, 12, 1, 2],
      [21, 2, 2, 1],
      [211, 21, 2, 2],
    ]);
    // Depth 2 stops there: level-2 artists are not expanded.
    expect(client.getSimilarArtists).not.toHaveBeenCalledWith(111, expect.anything());
  });

  it("stops at the artist cap and reports the truncation", async () => {
    const client = stubClient({
      similar: { 1: [artist(11), artist(12)], 2: [artist(21), artist(22)] },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1), artist(2)],
      similarPerArtist: 2,
      depth: 1,
      tracksPerSimilar: 1,
      maxArtists: 3,
    });

    expect(result.similar.map((s) => s.artist.id)).toEqual([11, 12, 21]);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when the cap is met exactly", async () => {
    const client = stubClient({ similar: { 1: [artist(11), artist(12)] } });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1)],
      similarPerArtist: 2,
      depth: 1,
      tracksPerSimilar: 1,
      maxArtists: 2,
    });

    expect(result.truncated).toBe(false);
  });

  it("drops similar artists with no tracks and flags short ones", async () => {
    const client = stubClient({
      similar: { 1: [artist(11, "Restricted"), artist(12, "Short")] },
      tracks: { 11: [], 12: tracksFor(12, 1) },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1)],
      similarPerArtist: 2,
      depth: 1,
      tracksPerSimilar: 3,
    });

    expect(result.similar.map((s) => s.artist.id)).toEqual([12]);
    expect(result.emptyArtists).toEqual([
      { query: "Restricted", artist: artist(11, "Restricted"), trackCount: 0, requested: 3 },
    ]);
    expect(result.partialArtists).toEqual([
      { query: "Short", artist: artist(12, "Short"), trackCount: 1, requested: 3 },
    ]);
  });

  it("still walks from a similar artist that has no tracks", async () => {
    const client = stubClient({
      similar: { 1: [artist(11)], 11: [artist(111)] },
      tracks: { 11: [] },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1)],
      similarPerArtist: 1,
      depth: 2,
      tracksPerSimilar: 1,
    });

    expect(result.similar.map((s) => s.artist.id)).toEqual([111]);
  });

  it("applies the filter to similar artists' tracks", async () => {
    const client = stubClient({
      similar: { 1: [artist(11)] },
      tracks: { 11: [{ id: 1, title: "Song", version: "Live" }, { id: 2, title: "Other" }] },
    });

    const result = await resolveSimilarArtists(client, {
      seeds: [artist(1)],
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
      filter: compileTrackFilter({ excludeTracks: ["live"] }),
    });

    expect(result.similar[0]?.tracks.map((t) => t.id)).toEqual([2]);
    expect(result.similar[0]?.excluded.map((e) => e.track.id)).toEqual([1]);
  });

  it("keeps seed order when lookups finish out of order", async () => {
    const release = new Map<number, () => void>();
    const client = {
      getSimilarArtists: vi.fn(
        (id: number) =>
          new Promise<Artist[]>((resolve) => {
            release.set(id, () => resolve([artist(id * 10)]));
          }),
      ),
      getArtistTopTracks: vi.fn(async (id: number) => tracksFor(id)),
    } satisfies SimilarArtistsClient;

    const promise = resolveSimilarArtists(client, {
      seeds: [artist(1), artist(2), artist(3)],
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
    });
    await Promise.resolve();
    release.get(3)!();
    release.get(1)!();
    release.get(2)!();
    const result = await promise;

    expect(result.similar.map((s) => s.artist.id)).toEqual([10, 20, 30]);
  });
});

describe("seedsFromPlaylist", () => {
  const track = (id: number, artistId?: number, name?: string): Track => ({
    id,
    title: "t",
    ...(artistId !== undefined && { artistId }),
    ...(name !== undefined && { artist: name }),
  });

  it("ranks performers by track count, ties by first appearance, up to the cap", () => {
    const tracks = [
      track(1, 5, "Five"),
      track(2, 7, "Seven"),
      track(3, 7, "Seven"),
      track(4, 9, "Nine"),
      track(5, 5, "Five"),
      track(6, 8, "Eight"),
      track(7),
    ];

    const { seeds, presentIds } = seedsFromPlaylist(tracks, 2);

    expect(seeds).toEqual([artist(5, "Five"), artist(7, "Seven")]);
    expect([...presentIds].sort()).toEqual([5, 7, 8, 9]);
  });

  it("names an artist by id when the track has no performer name", () => {
    expect(seedsFromPlaylist([track(1, 5)], 5).seeds).toEqual([artist(5, "Unknown artist (5)")]);
  });
});

describe("similarTrackIds", () => {
  it("orders each seed's tracks before its similar artists, without repeats", () => {
    const seeds = [
      { artist: artist(1), tracks: tracksFor(1, 2) },
      { artist: artist(2), tracks: [] },
    ];
    const similar = [
      { artist: artist(11), seed: artist(1), tracks: [...tracksFor(11), tracksFor(1)[0]!] },
      { artist: artist(21), seed: artist(2), tracks: tracksFor(21) },
    ];

    expect(similarTrackIds(seeds, similar)).toEqual([100, 101, 1100, 2100]);
  });
});

describe("planFromArtists", () => {
  it("resolves seeds with their tracks, then walks their similar artists", async () => {
    const client = stubClient({
      searches: { Nirvana: [artist(1, "Nirvana")] },
      similar: { 1: [artist(11)] },
      tracks: { 1: tracksFor(1, 5) },
    });

    const plan = await planFromArtists(client, {
      artists: ["Nirvana", "Nobody"],
      tracksPerSeed: 2,
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
    });

    expect(plan.seeds.map((s) => [s.artist.id, s.tracks.length])).toEqual([[1, 2]]);
    expect(plan.similar.map((s) => s.artist.id)).toEqual([11]);
    expect(plan.unresolvedArtists).toEqual(["Nobody"]);
  });

  it("walks from a seed with no tracks of its own and flags it", async () => {
    const client = stubClient({
      searches: { Restricted: [artist(1, "Restricted")] },
      similar: { 1: [artist(11)] },
      tracks: { 1: [] },
    });

    const plan = await planFromArtists(client, {
      artists: ["Restricted"],
      tracksPerSeed: 3,
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
    });

    expect(plan.seeds.map((s) => [s.artist.id, s.tracks.length])).toEqual([[1, 0]]);
    expect(plan.similar.map((s) => s.artist.id)).toEqual([11]);
    expect(plan.emptyArtists.map((a) => a.artist.id)).toEqual([1]);
  });

  it("leaves the seeds' tracks out when none are wanted", async () => {
    const client = stubClient({
      searches: { Nirvana: [artist(1, "Nirvana")] },
      similar: { 1: [artist(11)] },
    });

    const plan = await planFromArtists(client, {
      artists: ["Nirvana"],
      tracksPerSeed: 0,
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
    });

    expect(client.getArtistTopTracks).not.toHaveBeenCalledWith(1, expect.anything());
    expect(plan.seeds.map((s) => s.tracks)).toEqual([[]]);
    expect(plan.similar.map((s) => s.artist.id)).toEqual([11]);
  });
});

describe("planFromPlaylist", () => {
  it("seeds from the playlist's artists and never suggests one already in it", async () => {
    const client = stubClient({
      playlist: [
        { id: 1, title: "a", artistId: 5, artist: "Five" },
        { id: 2, title: "b", artistId: 7, artist: "Seven" },
      ],
      similar: { 5: [artist(7), artist(50)], 7: [artist(70)] },
    });

    const plan = await planFromPlaylist(client, {
      playlistId: 42,
      maxSeeds: 1,
      similarPerArtist: 1,
      depth: 1,
      tracksPerSimilar: 1,
    });

    expect(client.getPlaylistTracks).toHaveBeenCalledWith(42);
    // Only the top seed is walked, but every playlist artist is skipped.
    expect(plan.seeds.map((s) => [s.artist.id, s.tracks])).toEqual([[5, []]]);
    expect(plan.similar.map((s) => s.artist.id)).toEqual([50]);
    expect(plan.unresolvedArtists).toEqual([]);
  });
});
