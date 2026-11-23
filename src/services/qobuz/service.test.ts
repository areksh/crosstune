import { describe, expect, it, vi } from "vitest";

import { describeServiceContract } from "../contract.test-support.js";
import { tagId } from "../ids.js";
import { FakeQobuz } from "./fake-qobuz.test-support.js";
import { QobuzService } from "./service.js";

const t = (n: number) => tagId<never>("qobuz", n);

function adapter(methods: Record<string, unknown> = {}) {
  return new QobuzService(methods as never);
}

describeServiceContract("qobuz", () => {
  const fake = new FakeQobuz();
  fake.unplayable.add(66);
  return {
    service: new QobuzService(fake as never),
    tracks: [1, 2, 3, 4].map(t),
    dropped: t(66),
    albums: [tagId("qobuz", "0060254735156")],
    artists: [t(7)],
    recording: { isrc: "GBAAA0000001", track: t(1), absent: "GBZZZ9999999" },
    requests: () => fake.calls.length,
  };
});

describe("QobuzService", () => {
  it("tags every id of a track", async () => {
    const service = adapter({
      getPlaylistTracks: async () => [
        { id: 12, title: "Roads", artistId: 3, albumId: "0060254735156", playlistTrackId: 99 },
      ],
    });
    expect(await service.getPlaylistTracks(t(1))).toEqual([
      {
        id: "qobuz:12",
        title: "Roads",
        artistId: "qobuz:3",
        albumId: "qobuz:0060254735156",
        playlistTrackId: "qobuz:99",
      },
    ]);
  });

  it("keeps the order of a track's fields, which --json output shows", async () => {
    const native = { id: 12, title: "Roads", artistId: 3, albumId: "a1", playlistTrackId: 9, streamable: true };
    const service = adapter({ searchTracks: async () => [native] });
    expect(Object.keys((await service.searchTracks("x"))[0]!)).toEqual(Object.keys(native));
  });

  it("leaves absent ids absent", async () => {
    const service = adapter({ searchTracks: async () => [{ id: 12, title: "Roads" }] });
    expect(await service.searchTracks("roads")).toEqual([{ id: "qobuz:12", title: "Roads" }]);
  });

  it("tags playlists, albums, artists and releases", async () => {
    const service = adapter({
      getPlaylist: async () => ({ id: 5, name: "Mix", ownerId: 8 }),
      getAlbum: async () => ({ id: "abc", title: "Dummy", artist: "Portishead" }),
      getSimilarArtists: async () => [{ id: 4, name: "Tricky" }],
      getArtistReleases: async () => ({
        releases: [{ id: "abc", title: "Dummy", artist: "Portishead", releaseType: "album", artistId: 3 }],
        truncated: true,
      }),
    });
    expect(await service.getPlaylist(t(5))).toEqual({ id: "qobuz:5", name: "Mix", ownerId: "qobuz:8" });
    expect((await service.getAlbum(tagId("qobuz", "abc"))).id).toBe("qobuz:abc");
    expect(await service.getSimilarArtists(t(3), 1)).toEqual([{ id: "qobuz:4", name: "Tricky" }]);
    expect(await service.getArtistReleases(t(3))).toEqual({
      releases: [
        { id: "qobuz:abc", title: "Dummy", artist: "Portishead", releaseType: "album", artistId: "qobuz:3" },
      ],
      truncated: true,
    });
  });

  it("gives the client Qobuz's own ids, and passes limits through", async () => {
    const getArtistTopTracks = vi.fn(async () => []);
    const addTracksToPlaylist = vi.fn(async () => {});
    const addFavoriteAlbums = vi.fn(async () => {});
    const service = adapter({ getArtistTopTracks, addTracksToPlaylist, addFavoriteAlbums });
    await service.getArtistTopTracks(t(3), 25);
    await service.getArtistTopTracks(t(3));
    await service.addTracksToPlaylist(t(1), [t(12), t(13)]);
    await service.addFavoriteAlbums([tagId("qobuz", "0060254735156")]);
    expect(getArtistTopTracks.mock.calls).toEqual([[3, 25], [3, undefined]]);
    expect(addTracksToPlaylist).toHaveBeenCalledWith(1, [12, 13]);
    expect(addFavoriteAlbums).toHaveBeenCalledWith(["0060254735156"]);
  });

  it("refuses a Qobuz id that is not a number where Qobuz has numbers", async () => {
    const getPlaylist = vi.fn();
    const service = adapter({ getPlaylist });
    await expect(service.getPlaylist(tagId("qobuz", "abc"))).rejects.toMatchObject({ kind: "bad-id" });
    expect(getPlaylist).not.toHaveBeenCalled();
  });

  it("finds recordings by ISRC, trusting only equal ones", async () => {
    const searchTracks = vi.fn(async (query: string) =>
      query === "GBF089400010"
        ? [
            { id: 1, title: "Roads", isrc: "GB-F08-94-00010" },
            { id: 2, title: "Other", isrc: "GBF089400011" },
            { id: 3, title: "No code" },
          ]
        : [],
    );
    const found = await adapter({ searchTracks }).findByIsrc(["gb-f08-94-00010", "USNONE000001", ""]);
    expect([...found].map(([isrc, tracks]) => [isrc, tracks.map((track) => track.id)])).toEqual([
      ["GBF089400010", ["qobuz:1"]],
    ]);
    expect(searchTracks).toHaveBeenCalledTimes(2);
  });

  it("looks up one track", async () => {
    const service = adapter({ getTrack: async (id: number) => ({ id, title: "Roads", streamable: false }) });
    expect(await service.getTrack(t(12))).toEqual({ id: "qobuz:12", title: "Roads", streamable: false });
  });

  it("says who is signed in", () => {
    expect(
      adapter({ session: { userId: 8, displayName: "Arek", subscriptionLabel: "Studio" } }).account(),
    ).toEqual({ id: "qobuz:8", displayName: "Arek", plan: "Studio" });
    expect(adapter({ session: undefined }).account()).toBeUndefined();
  });
});
