import { describe, expect, it, vi } from "vitest";

import type { Artist, Playlist, Track } from "../qobuz/index.js";
import {
  buildPlaylistFromArtists,
  type PlaylistBuilderClient,
} from "./playlist-from-artists.js";

/** A configurable stub of the client surface the builder depends on. */
function stubClient(config: {
  artistsByQuery?: Record<string, Artist[]>;
  tracksByArtist?: Record<number, Track[]>;
  playlist?: Playlist;
}): PlaylistBuilderClient & {
  createPlaylist: ReturnType<typeof vi.fn>;
  addTracksToPlaylist: ReturnType<typeof vi.fn>;
  getArtistTopTracks: ReturnType<typeof vi.fn>;
} {
  return {
    searchArtists: vi.fn(async (query: string) => config.artistsByQuery?.[query] ?? []),
    getArtistTopTracks: vi.fn(
      async (artistId: number) => config.tracksByArtist?.[artistId] ?? [],
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
