import { describe, expect, it, vi } from "vitest";

import type { Artist, Playlist, Track } from "../services/model.js";
import {
  addTracksToExistingPlaylist,
  buildPlaylistFromArtists,
  collectTrackIds,
  createPlaylistWithTracks,
  fetchTopTracks,
  resolveArtistTracks,
  TOP_TRACKS_POOL,
  type PlaylistBuilderClient,
} from "./playlist-from-artists.js";
import { seededRandom } from "./combine.js";
import { SongPicker } from "./song-picker.js";
import { compileTrackFilter } from "./track-filter.js";

/** A configurable stub of the client surface the builder depends on. */
function stubClient(config: {
  artistsByQuery?: Record<string, Artist[]>;
  tracksByArtist?: Record<number, Track[]>;
  playlist?: Playlist;
  favourites?: Track[];
}): PlaylistBuilderClient & {
  createPlaylist: ReturnType<typeof vi.fn>;
  addTracksToPlaylist: ReturnType<typeof vi.fn>;
  getArtistTopTracks: ReturnType<typeof vi.fn>;
  getFavoriteTracks: ReturnType<typeof vi.fn>;
  getArtist: ReturnType<typeof vi.fn>;
} {
  return {
    getFavoriteTracks: vi.fn(async () => config.favourites ?? []),
    getArtist: vi.fn(async (id: number): Promise<Artist> => ({ id, name: `Artist ${id}` })),
    searchArtists: vi.fn(async (query: string) => config.artistsByQuery?.[query] ?? []),
    // Honour the limit like the real client, so pool sizes are observable.
    getArtistTopTracks: vi.fn(async (artistId: number, limit?: number) =>
      (config.tracksByArtist?.[artistId] ?? []).slice(0, limit),
    ),
    createPlaylist: vi.fn(
      async (name: string) => config.playlist ?? { id: 1, name },
    ),
    addTracksToPlaylist: vi.fn(async () => {}),
  };
}

describe("buildPlaylistFromArtists", () => {
  it("resolves artists, creates the playlist and adds their tracks", async () => {
    const client = stubClient({
      artistsByQuery: {
        Portishead: [{ id: 5, name: "Portishead" }],
        Massive: [{ id: 8, name: "Massive Attack" }],
      },
      tracksByArtist: {
        5: [{ id: 100, title: "Roads" }],
        8: [{ id: 200, title: "Teardrop" }],
      },
      playlist: { id: 777, name: "Trip Hop" },
    });

    const result = await buildPlaylistFromArtists(client, {
      artists: ["Portishead", "Massive"],
      playlistName: "Trip Hop",
    });

    expect(result.playlist).toEqual({ id: 777, name: "Trip Hop" });
    expect(result.trackCount).toBe(2);
    expect(result.unresolvedArtists).toEqual([]);
    expect(result.resolvedArtists.map((r) => r.artist.name)).toEqual([
      "Portishead",
      "Massive Attack",
    ]);
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(777, [100, 200]);
  });

  it("prefers an exact case-insensitive name match over the first result", async () => {
    const client = stubClient({
      artistsByQuery: {
        Wire: [
          { id: 1, name: "Wired Differently" },
          { id: 2, name: "Wire" },
        ],
      },
      tracksByArtist: { 2: [{ id: 300, title: "Outdoor Miner" }] },
    });

    const result = await buildPlaylistFromArtists(client, {
      artists: ["Wire"],
      playlistName: "Post-Punk",
    });

    expect(result.resolvedArtists[0]?.artist).toEqual({ id: 2, name: "Wire" });
    expect(client.getArtistTopTracks).toHaveBeenCalledWith(2, 10);
  });

  it("records artists that cannot be resolved and continues", async () => {
    const client = stubClient({
      artistsByQuery: { Real: [{ id: 5, name: "Real" }] },
      tracksByArtist: { 5: [{ id: 100, title: "Song" }] },
    });

    const result = await buildPlaylistFromArtists(client, {
      artists: ["Real", "Nonexistent Band"],
      playlistName: "Mix",
    });

    expect(result.unresolvedArtists).toEqual(["Nonexistent Band"]);
    expect(result.resolvedArtists).toHaveLength(1);
    expect(result.trackCount).toBe(1);
  });

  it("de-duplicates track ids shared across artists, keeping first occurrence", async () => {
    const client = stubClient({
      artistsByQuery: {
        A: [{ id: 1, name: "A" }],
        B: [{ id: 2, name: "B" }],
      },
      tracksByArtist: {
        1: [{ id: 100, title: "Shared" }, { id: 101, title: "OnlyA" }],
        2: [{ id: 100, title: "Shared" }, { id: 102, title: "OnlyB" }],
      },
    });

    const result = await buildPlaylistFromArtists(client, {
      artists: ["A", "B"],
      playlistName: "Dedup",
    });

    expect(result.trackCount).toBe(3);
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [100, 101, 102]);
  });

  it("passes tracksPerArtist through to the track fetch", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: [{ id: 100, title: "x" }] },
    });

    await buildPlaylistFromArtists(client, {
      artists: ["A"],
      playlistName: "P",
      tracksPerArtist: 3,
    });

    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, 3);
  });

  it("throws when given no artists", async () => {
    const client = stubClient({});
    await expect(
      buildPlaylistFromArtists(client, { artists: [], playlistName: "Empty" }),
    ).rejects.toThrow(/artist/i);
  });
});

describe("resolveArtistTracks", () => {
  it("returns each resolved artist with its tracks, preserving overlaps", async () => {
    const client = stubClient({
      artistsByQuery: {
        A: [{ id: 1, name: "A" }],
        B: [{ id: 2, name: "B" }],
      },
      tracksByArtist: {
        1: [{ id: 100, title: "Shared" }, { id: 101, title: "OnlyA" }],
        2: [{ id: 100, title: "Shared" }, { id: 102, title: "OnlyB" }],
      },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A", "B"],
      tracksPerArtist: 5,
    });

    expect(result.unresolvedArtists).toEqual([]);
    expect(result.resolvedArtists.map((r) => r.tracks.map((t) => t.id))).toEqual([
      [100, 101],
      [100, 102],
    ]);
    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, 5);
  });

  it("runs artist lookups concurrently and returns them in input order", async () => {
    // Each search stays pending until released, so we can prove several are in
    // flight at once and then resolve them out of order.
    const release = new Map<string, () => void>();
    const searchArtists = vi.fn(
      (query: string) =>
        new Promise<Artist[]>((resolve) => {
          release.set(query, () => resolve([{ id: query.length, name: query }]));
        }),
    );
    const client = {
      searchArtists,
      getArtistTopTracks: vi.fn(async (id: number) => [{ id, title: "t" }]),
    };

    const promise = resolveArtistTracks(client, {
      artists: ["aa", "bbb", "cccc"],
    });
    await Promise.resolve();

    // A sequential resolve would have called search exactly once by now.
    expect(searchArtists.mock.calls.length).toBeGreaterThan(1);

    // Release out of input order; the result must still follow input order.
    release.get("cccc")!();
    release.get("aa")!();
    release.get("bbb")!();
    const result = await promise;

    expect(result.resolvedArtists.map((r) => r.query)).toEqual([
      "aa",
      "bbb",
      "cccc",
    ]);
  });

  it("records unresolved names and continues", async () => {
    const client = stubClient({
      artistsByQuery: { Real: [{ id: 5, name: "Real" }] },
      tracksByArtist: { 5: [{ id: 100, title: "Song" }] },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["Real", "Ghost Band"],
    });

    expect(result.unresolvedArtists).toEqual(["Ghost Band"]);
    expect(result.resolvedArtists).toHaveLength(1);
  });

  it("flags a matched artist with no tracks and drops it from the list", async () => {
    const client = stubClient({
      artistsByQuery: {
        "The Miracles, Smokey Robinson": [
          { id: 9, name: "Smokey Robinson and the Miracles" },
        ],
      },
      tracksByArtist: { 9: [] },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["The Miracles, Smokey Robinson"],
      tracksPerArtist: 20,
    });

    expect(result.resolvedArtists).toEqual([]);
    expect(result.partialArtists).toEqual([]);
    expect(result.emptyArtists).toEqual([
      {
        query: "The Miracles, Smokey Robinson",
        artist: { id: 9, name: "Smokey Robinson and the Miracles" },
        trackCount: 0,
        requested: 20,
      },
    ]);
  });

  it("flags an artist with fewer tracks than requested but keeps it", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }], B: [{ id: 2, name: "B" }] },
      tracksByArtist: {
        1: [{ id: 100, title: "x" }, { id: 101, title: "y" }],
        2: Array.from({ length: 4 }, (_v, i) => ({ id: 200 + i, title: `t${i}` })),
      },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A", "B"],
      tracksPerArtist: 4,
    });

    // Both are kept (each has at least one track); only the short one is flagged.
    expect(result.resolvedArtists.map((r) => r.artist.name)).toEqual(["A", "B"]);
    expect(result.emptyArtists).toEqual([]);
    expect(result.partialArtists).toEqual([
      { query: "A", artist: { id: 1, name: "A" }, trackCount: 2, requested: 4 },
    ]);
  });
});

describe("resolveArtistTracks with no tracks wanted", () => {
  it("resolves the artists without fetching or flagging them", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: [{ id: 100, title: "Song" }] },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A", "Ghost"],
      tracksPerArtist: 0,
    });

    expect(client.getArtistTopTracks).not.toHaveBeenCalled();
    expect(result.resolvedArtists).toEqual([
      { query: "A", artist: { id: 1, name: "A" }, tracks: [], excluded: [] },
    ]);
    expect(result.unresolvedArtists).toEqual(["Ghost"]);
    expect(result.emptyArtists).toEqual([]);
    expect(result.partialArtists).toEqual([]);
  });
});

describe("resolveArtistTracks with a filter", () => {
  /** Ten popularity-ordered tracks; even ids are live recordings. */
  const popular: Track[] = Array.from({ length: 10 }, (_v, i) => ({
    id: 100 + i,
    title: `Song ${i}`,
    ...(i % 2 === 0 && { version: "Live" }),
  }));
  const live = compileTrackFilter({ excludeTracks: ["live"] });

  it("fetches the whole popularity pool and backfills past excluded tracks", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: popular },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: 3,
      filter: live,
    });

    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, TOP_TRACKS_POOL);
    const [resolved] = result.resolvedArtists;
    expect(resolved?.tracks.map((t) => t.id)).toEqual([101, 103, 105]);
    // Only the excluded tracks ranked above the last kept one are reported,
    // each with its place in the popularity order among the listed tracks.
    expect(resolved?.excluded).toEqual([
      { track: popular[0], exclusion: { kind: "track", term: "live" }, position: 0 },
      { track: popular[2], exclusion: { kind: "track", term: "live" }, position: 2 },
      { track: popular[4], exclusion: { kind: "track", term: "live" }, position: 4 },
    ]);
    expect(result.partialArtists).toEqual([]);
  });

  it("replaces a top track credited to an excluded artist like any other exclusion", async () => {
    const tracks: Track[] = [
      { id: 1, title: "Feature", artist: "Drake" },
      { id: 2, title: "Own", artist: "A" },
      { id: 3, title: "Other", artist: "Nick Drake" },
    ];
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: tracks },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: 2,
      filter: compileTrackFilter({ excludeArtists: ["drake"] }),
    });

    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, TOP_TRACKS_POOL);
    expect(result.resolvedArtists[0]?.tracks.map((t) => t.id)).toEqual([2, 3]);
    expect(result.resolvedArtists[0]?.excluded).toEqual([
      { track: tracks[0], exclusion: { kind: "artist", term: "drake" }, position: 0 },
    ]);
  });

  it("asks for more than the pool when more tracks are wanted", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: popular },
    });

    await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: TOP_TRACKS_POOL + 5,
      filter: live,
    });

    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, TOP_TRACKS_POOL + 5);
  });

  it("asks only for the requested count when the filter is empty", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: popular },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: 3,
      filter: compileTrackFilter({}),
    });

    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, 3);
    expect(result.resolvedArtists[0]?.excluded).toEqual([]);
  });

  it("flags an artist whose pool runs out after filtering as partial", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: popular },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: 8,
      filter: live,
    });

    expect(result.resolvedArtists[0]?.tracks).toHaveLength(5);
    expect(result.resolvedArtists[0]?.excluded).toHaveLength(5);
    expect(result.partialArtists).toEqual([
      { query: "A", artist: { id: 1, name: "A" }, trackCount: 5, requested: 8 },
    ]);
  });

  it("keeps an artist whose tracks were all excluded, so they can be reviewed", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: { 1: [{ id: 100, title: "Song", version: "Live" }] },
    });

    const result = await resolveArtistTracks(client, {
      artists: ["A"],
      tracksPerArtist: 2,
      filter: live,
    });

    expect(result.emptyArtists).toEqual([]);
    expect(result.resolvedArtists[0]?.tracks).toEqual([]);
    expect(result.resolvedArtists[0]?.excluded).toHaveLength(1);
    expect(result.partialArtists).toEqual([
      { query: "A", artist: { id: 1, name: "A" }, trackCount: 0, requested: 2 },
    ]);
  });
});

describe("fetchTopTracks", () => {
  it("fetches the pool for an active filter and backfills past excluded tracks", async () => {
    const getArtistTopTracks = vi.fn(async (_id: number, limit?: number) =>
      [
        { id: 1, title: "Song", version: "Live" },
        { id: 2, title: "Other" },
        { id: 3, title: "Third" },
      ].slice(0, limit),
    );

    const result = await fetchTopTracks(
      { getArtistTopTracks },
      9,
      1,
      compileTrackFilter({ excludeTracks: ["live"] }),
    );

    expect(getArtistTopTracks).toHaveBeenCalledWith(9, TOP_TRACKS_POOL);
    expect(result.tracks.map((t) => t.id)).toEqual([2]);
    expect(result.excluded.map((e) => e.track.id)).toEqual([1]);
  });

  it("requests only the count without a filter", async () => {
    const getArtistTopTracks = vi.fn(async () => [{ id: 1, title: "Song" }]);

    await fetchTopTracks({ getArtistTopTracks }, 9, 4);

    expect(getArtistTopTracks).toHaveBeenCalledWith(9, 4);
  });
});

describe("buildPlaylistFromArtists with a filter", () => {
  it("leaves excluded tracks out and counts them per artist", async () => {
    const client = stubClient({
      artistsByQuery: { A: [{ id: 1, name: "A" }] },
      tracksByArtist: {
        1: [
          { id: 100, title: "Roads", album: "Roseland NYC Live" },
          { id: 101, title: "Sour Times", album: "Dummy" },
        ],
      },
    });

    const result = await buildPlaylistFromArtists(client, {
      artists: ["A"],
      playlistName: "P",
      tracksPerArtist: 1,
      filter: compileTrackFilter({ excludeAlbums: ["live"] }),
    });

    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [101]);
    expect(result.resolvedArtists).toEqual([
      { query: "A", artist: { id: 1, name: "A" }, trackCount: 1, excludedCount: 1 },
    ]);
  });
});

describe("resolveArtistTracks with a song picker", () => {
  const artistsByQuery = {
    Portishead: [{ id: 1, name: "Portishead" }],
    Beth: [{ id: 2, name: "Beth Gibbons" }],
  };
  const tracksByArtist: Record<number, Track[]> = {
    1: [
      { id: 10, title: "Roads", artist: "Portishead", isrc: "R1" },
      { id: 11, title: "Glory Box", artist: "Portishead" },
      { id: 12, title: "Sour Times", artist: "Portishead" },
    ],
    2: [
      { id: 20, title: "Roads", version: "Live", artist: "Beth Gibbons", isrc: "R1" },
      { id: 21, title: "Tom the Model", artist: "Beth Gibbons" },
      { id: 22, title: "Mysteries", artist: "Beth Gibbons" },
    ],
  };

  it("replaces a later copy of a song with the next most popular track", async () => {
    const client = stubClient({ artistsByQuery, tracksByArtist });
    const result = await resolveArtistTracks(client, {
      artists: ["Portishead", "Beth"],
      tracksPerArtist: 2,
      picker: new SongPicker({ oneCopy: true }),
    });
    expect(result.resolvedArtists[0]!.tracks.map((t) => t.id)).toEqual([10, 11]);
    expect(result.resolvedArtists[1]!.tracks.map((t) => t.id)).toEqual([21, 22]);
    expect(result.resolvedArtists[1]!.excluded).toEqual([
      {
        track: tracksByArtist[2]![0],
        exclusion: { kind: "repeat", of: "Roads" },
        position: 0,
      },
    ]);
    // The pool is fetched so excluded tracks can be replaced.
    expect(client.getArtistTopTracks).toHaveBeenCalledWith(1, TOP_TRACKS_POOL);
  });

  it("takes in input order however the lookups finish", async () => {
    const client = stubClient({ artistsByQuery, tracksByArtist });
    // Portishead's lookup finishes last; its Roads is still the first copy.
    client.getArtistTopTracks.mockImplementation(async (artistId: number) => {
      await new Promise((resolve) => setTimeout(resolve, artistId === 1 ? 20 : 0));
      return tracksByArtist[artistId] ?? [];
    });
    const result = await resolveArtistTracks(client, {
      artists: ["Portishead", "Beth"],
      tracksPerArtist: 1,
      picker: new SongPicker({ oneCopy: true }),
    });
    expect(result.resolvedArtists.map((r) => r.tracks.map((t) => t.id))).toEqual([[10], [21]]);
  });

  it("replaces favourites, listing them excluded", async () => {
    const client = stubClient({ artistsByQuery, tracksByArtist });
    const result = await resolveArtistTracks(client, {
      artists: ["Portishead"],
      tracksPerArtist: 2,
      picker: SongPicker.fromFavourites([{ id: 99, title: "Glory Box", artist: "Portishead" }], {
        oneCopy: false,
      }),
    });
    const [portishead] = result.resolvedArtists;
    expect(portishead!.tracks.map((t) => t.id)).toEqual([10, 12]);
    expect(portishead!.excluded).toEqual([
      { track: tracksByArtist[1]![1], exclusion: { kind: "favourite" }, position: 1 },
    ]);
  });
});

describe("resolveArtistTracks with Qobuz links", () => {
  it("resolves an artist link by id instead of searching, marking it", async () => {
    const client = stubClient({ tracksByArtist: { 41259: [{ id: 1, title: "Roads" }] } });
    client.getArtist = vi.fn(async (id: number) => ({ id, name: "Portishead" }));
    const link = "https://play.qobuz.com/artist/41259";

    const result = await resolveArtistTracks(client, { artists: [link], tracksPerArtist: 1 });

    expect(client.getArtist).toHaveBeenCalledWith(41259);
    expect(client.searchArtists).not.toHaveBeenCalled();
    expect(result.resolvedArtists).toEqual([
      {
        query: link,
        artist: { id: 41259, name: "Portishead" },
        fromLink: true,
        tracks: [{ id: 1, title: "Roads" }],
        excluded: [],
      },
    ]);
  });

  it("reports a link to something else, or to no artist, with the reason", async () => {
    const client = stubClient({});
    client.getArtist = vi.fn(async () => {
      throw new Error("artist/page failed with HTTP 404");
    });
    const album = "https://open.qobuz.com/album/pvsb64n704d0b";
    const missing = "https://play.qobuz.com/artist/999";

    const result = await resolveArtistTracks(client, { artists: [album, missing] });

    expect(result.unresolvedArtists).toEqual([
      `${album} (an album link, not an artist)`,
      `${missing} (no Qobuz artist has this id)`,
    ]);
    expect(client.searchArtists).not.toHaveBeenCalled();
  });
});

describe("buildPlaylistFromArtists with plan options", () => {
  const artistsByQuery = {
    A: [{ id: 1, name: "A" }],
    B: [{ id: 2, name: "B" }],
  };
  const tracksByArtist: Record<number, Track[]> = {
    1: [
      { id: 10, title: "a1", artist: "A", duration: 100 },
      { id: 11, title: "a2", artist: "A", duration: 100 },
      { id: 12, title: "a3", artist: "A", duration: 100 },
    ],
    2: [
      { id: 20, title: "b1", artist: "B", duration: 100 },
      { id: 21, title: "b2", artist: "B", duration: 100 },
    ],
  };

  it("writes the tracks taking turns between the artists", async () => {
    const client = stubClient({ artistsByQuery, tracksByArtist });
    const result = await buildPlaylistFromArtists(client, {
      artists: ["A", "B"],
      playlistName: "P",
      tracksPerArtist: 3,
      order: "take-turns",
    });
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [10, 20, 11, 21, 12]);
    expect(result.durationSeconds).toBe(500);
    expect(client.getFavoriteTracks).not.toHaveBeenCalled();
  });

  it("skips favourites (fetched once) and fits to length fairly", async () => {
    const client = stubClient({
      artistsByQuery,
      tracksByArtist,
      favourites: [{ id: 11, title: "a2", artist: "A" }],
    });
    const result = await buildPlaylistFromArtists(client, {
      artists: ["A", "B"],
      playlistName: "P",
      tracksPerArtist: 3,
      skipFavourites: true,
      fitMinutes: 4,
    });
    expect(client.getFavoriteTracks).toHaveBeenCalledTimes(1);
    // A keeps a1 and a3 (a2 is a favourite); fitting 400s to 240s drops b2 and
    // a3, the deepest ranks, last artist first.
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(1, [10, 20]);
    expect(result.trackCount).toBe(2);
    expect(result.droppedToFit).toBe(2);
    expect(result.durationSeconds).toBe(200);
    expect(result.resolvedArtists.map((r) => [r.artist.name, r.trackCount, r.excludedCount])).toEqual(
      [
        ["A", 1, 1],
        ["B", 1, 0],
      ],
    );
  });

  it("shuffles with the random source given", async () => {
    const client = stubClient({ artistsByQuery, tracksByArtist });
    await buildPlaylistFromArtists(client, {
      artists: ["A", "B"],
      playlistName: "P",
      tracksPerArtist: 3,
      order: "shuffle",
      random: seededRandom(1),
    });
    const written = client.addTracksToPlaylist.mock.calls[0]![1] as number[];
    expect([...written].sort()).toEqual([10, 11, 12, 20, 21]);
  });
});

describe("collectTrackIds", () => {
  it("flattens to unique ids keeping first occurrence order", () => {
    const ids = collectTrackIds([
      { query: "A", artist: { id: 1, name: "A" }, tracks: [{ id: 100, title: "x" }, { id: 101, title: "y" }] },
      { query: "B", artist: { id: 2, name: "B" }, tracks: [{ id: 100, title: "x" }, { id: 102, title: "z" }] },
    ]);
    expect(ids).toEqual([100, 101, 102]);
  });
});

describe("createPlaylistWithTracks", () => {
  it("creates the playlist then adds the tracks", async () => {
    const client = stubClient({ playlist: { id: 9, name: "New" } });

    const playlist = await createPlaylistWithTracks(client, {
      name: "New",
      trackIds: [1, 2],
      isPublic: true,
    });

    expect(playlist).toEqual({ id: 9, name: "New" });
    expect(client.createPlaylist).toHaveBeenCalledWith("New", { isPublic: true });
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(9, [1, 2]);
  });
});

describe("addTracksToExistingPlaylist", () => {
  it("adds only tracks not already present, skipping duplicates", async () => {
    const client = {
      getPlaylistTracks: vi.fn(async () => [{ id: 100, title: "present" }] as Track[]),
      addTracksToPlaylist: vi.fn(async () => {}),
    };

    const result = await addTracksToExistingPlaylist(client, {
      playlistId: 55,
      trackIds: [100, 101, 101, 102],
    });

    expect(result.added).toEqual([101, 102]);
    expect(result.skipped).toEqual([100, 101]);
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(55, [101, 102]);
  });
});
