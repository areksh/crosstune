/**
 * Test support (not shipped): what every music service must do, run against
 * its adapter over a fake of its API. A new service passes this before any
 * tool uses it (ADR-0010).
 */

import { describe, expect, it } from "vitest";

import { isNotFound, ServiceError } from "./errors.js";
import { parseId, tagId, SERVICES, type ServiceName } from "./ids.js";
import type { AlbumId, ArtistId, EntryId, PlaylistId, Track, TrackId } from "./model.js";
import { MUSIC_READS, MUSIC_WRITES, type CapabilityName, type MusicService } from "./service.js";

export interface ContractWorld {
  service: MusicService;
  /** At least four tracks that can be added. */
  tracks: TrackId[];
  /** A track the service takes without an error but does not add, if it has those. */
  dropped?: TrackId;
  albums: AlbumId[];
  artists: ArtistId[];
  /** How many requests the fake API has seen. */
  requests(): number;
}

/** The method behind each capability that is yes or no, where there is one. */
const CALLS: Partial<Record<CapabilityName, (service: MusicService, id: string) => Promise<unknown>>> = {
  topTracks: (s, id) => s.getArtistTopTracks(id as unknown as ArtistId),
  similarArtists: (s, id) => s.getSimilarArtists(id as unknown as ArtistId, 5),
  artistReleases: (s, id) => s.getArtistReleases(id as unknown as ArtistId),
  deletePlaylist: (s, id) => s.deletePlaylist(id as unknown as PlaylistId),
};

export function describeServiceContract(name: ServiceName, make: () => ContractWorld): void {
  const other = SERVICES.find((s) => s !== name)!;
  const ids = (tracks: readonly Track[]): TrackId[] => tracks.map((t) => t.id);
  const entries = (tracks: readonly Track[]): EntryId[] => tracks.map((t) => t.playlistTrackId!);

  describe(`${name} as a music service`, () => {
    it("names itself and has every method", () => {
      const { service } = make();
      expect(service.name).toBe(name);
      for (const method of [...MUSIC_READS, ...MUSIC_WRITES]) {
        expect(typeof service[method], method).toBe("function");
      }
    });

    it("creates, fills and reads back a playlist, in order, with tagged ids", async () => {
      const { service, tracks } = make();
      const playlist = await service.createPlaylist("Mix", { description: "d" });
      expect(parseId(String(playlist.id))?.service).toBe(name);
      expect(await service.getPlaylistTracks(playlist.id)).toEqual([]);
      await service.addTracksToPlaylist(playlist.id, [tracks[2]!, tracks[0]!, tracks[1]!]);
      const read = await service.getPlaylistTracks(playlist.id);
      expect(ids(read)).toEqual([tracks[2], tracks[0], tracks[1]]);
      for (const id of [...ids(read), ...entries(read)]) {
        expect(parseId(String(id))?.service).toBe(name);
      }
      expect((await service.getUserPlaylists()).map((p) => p.id)).toContain(playlist.id);
      expect((await service.getPlaylist(playlist.id)).name).toBe("Mix");
    });

    it("adds more tracks than fit in one request, in order", async () => {
      const { service, tracks } = make();
      const playlist = await service.createPlaylist("Long");
      const many = Array.from({ length: 130 }, (_, i) => tracks[i % 4]!);
      // Separate adds, as one request may fold repeats.
      for (let i = 0; i < many.length; i += 4) {
        await service.addTracksToPlaylist(playlist.id, many.slice(i, i + 4));
      }
      expect(ids(await service.getPlaylistTracks(playlist.id))).toEqual(many);
    });

    it("keeps copies of a track apart, and removes only the one asked for", async () => {
      const { service, tracks } = make();
      const [a, b] = tracks as [TrackId, TrackId];
      const playlist = await service.createPlaylist("Copies");
      await service.addTracksToPlaylist(playlist.id, [a]);
      await service.addTracksToPlaylist(playlist.id, [b]);
      await service.addTracksToPlaylist(playlist.id, [a]);
      const before = await service.getPlaylistTracks(playlist.id);
      expect(new Set(entries(before)).size).toBe(3);
      await service.removeTracksFromPlaylist(playlist.id, [before[0]!.playlistTrackId!]);
      expect(ids(await service.getPlaylistTracks(playlist.id))).toEqual([b, a]);
    });

    it("moves entries, in the order given, and to the end", async () => {
      const { service, tracks } = make();
      if (!service.capabilities.movePlaylistEntries.ok) {
        return;
      }
      const [a, b, c, d] = tracks as [TrackId, TrackId, TrackId, TrackId];
      const playlist = await service.createPlaylist("Order");
      await service.addTracksToPlaylist(playlist.id, [a, b, c, d]);
      const start = entries(await service.getPlaylistTracks(playlist.id));
      await service.movePlaylistTracks(playlist.id, [start[3]!, start[2]!], 1);
      const moved = await service.getPlaylistTracks(playlist.id);
      expect(ids(moved)).toEqual([d, c, a, b]);
      await service.movePlaylistTracks(playlist.id, [entries(moved)[0]!], 5);
      expect(ids(await service.getPlaylistTracks(playlist.id))).toEqual([c, a, b, d]);
    });

    it("renames and deletes a playlist", async () => {
      const { service } = make();
      const playlist = await service.createPlaylist("Old");
      await service.updatePlaylist(playlist.id, { name: "New" });
      expect((await service.getPlaylist(playlist.id)).name).toBe("New");
      if (service.capabilities.deletePlaylist.ok) {
        await service.deletePlaylist(playlist.id);
        expect((await service.getUserPlaylists()).map((p) => p.id)).not.toContain(playlist.id);
      }
    });

    it("answers a missing playlist with a not-found error", async () => {
      const { service } = make();
      const missing = tagId<PlaylistId>(name, name === "qobuz" ? 999_999 : "missing");
      const error = await service.getPlaylist(missing).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isNotFound(error), String(error)).toBe(true);
    });

    it("adds and removes favourites of every kind", async () => {
      const { service, tracks, albums, artists } = make();
      await service.addFavoriteTracks(tracks.slice(0, 2));
      await service.addFavoriteAlbums(albums.slice(0, 1));
      await service.addFavoriteArtists(artists.slice(0, 1));
      expect(new Set(ids(await service.getFavoriteTracks()))).toEqual(new Set(tracks.slice(0, 2)));
      expect((await service.getFavoriteAlbums()).map((a) => a.id)).toEqual(albums.slice(0, 1));
      expect((await service.getFavoriteArtists()).map((a) => a.id)).toEqual(artists.slice(0, 1));
      await service.removeFavoriteTracks(tracks.slice(0, 1));
      await service.removeFavoriteAlbums(albums.slice(0, 1));
      await service.removeFavoriteArtists(artists.slice(0, 1));
      expect(ids(await service.getFavoriteTracks())).toEqual(tracks.slice(1, 2));
      expect(await service.getFavoriteAlbums()).toEqual([]);
      expect(await service.getFavoriteArtists()).toEqual([]);
    });

    it("drops an unplayable track without failing the rest", async () => {
      const { service, tracks, dropped } = make();
      if (dropped === undefined) {
        return;
      }
      const playlist = await service.createPlaylist("Dropped");
      await service.addTracksToPlaylist(playlist.id, [tracks[0]!, dropped, tracks[1]!]);
      expect(ids(await service.getPlaylistTracks(playlist.id))).toEqual([tracks[0], tracks[1]]);
    });

    it("does nothing for empty lists", async () => {
      const { service } = make();
      const playlist = await service.createPlaylist("Empty");
      await service.addTracksToPlaylist(playlist.id, []);
      await service.removeTracksFromPlaylist(playlist.id, []);
      await service.addFavoriteTracks([]);
      expect(await service.getPlaylistTracks(playlist.id)).toEqual([]);
    });

    it("refuses another service's ids before any request", async () => {
      const { service, tracks, requests } = make();
      const playlist = await service.createPlaylist("Mine");
      const before = requests();
      const foreign = tagId<TrackId>(other, 1);
      const attempts = [
        () => service.getPlaylistTracks(tagId<PlaylistId>(other, 1)),
        () => service.addTracksToPlaylist(playlist.id, [tracks[0]!, foreign]),
        () => service.addFavoriteTracks([tracks[0]!, foreign]),
        () => service.removeTracksFromPlaylist(playlist.id, [tagId<EntryId>(other, 1)]),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ kind: "bad-id" });
      }
      expect(requests()).toBe(before);
    });

    it("answers what it cannot do with an unsupported error and a reason", async () => {
      const { service, requests } = make();
      for (const [capability, call] of Object.entries(CALLS) as [CapabilityName, NonNullable<(typeof CALLS)[CapabilityName]>][]) {
        const can = service.capabilities[capability];
        if (!can.ok) {
          const before = requests();
          const error = await call(service, `${name}:1`).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(ServiceError);
          expect(error).toMatchObject({ kind: "unsupported", message: can.reason });
          expect(requests()).toBe(before);
        }
      }
    });
  });
}
