/**
 * Test support (not shipped): a fake Qobuz account whose tracks carry details
 * (artist, ISRC, quality, playability) from a catalogue, with search by ISRC
 * and favourite dates -- enough for sources and tidy-ups to run against.
 */

import type { Track } from "../services/model.js";
import { FakeAccount } from "../features/fake-account.test-support.js";

const cd = { bitDepth: 16, samplingRate: 44.1 };
const hires = { bitDepth: 24, samplingRate: 96 };

/** 1 -> 2 is an upgrade; 3 is unplayable with 4 as its copy; 5 and 6 are the same song. */
export const CATALOGUE: Record<number, Omit<Track, "id">> = {
  1: { title: "Teardrop", artist: "Massive Attack", isrc: "GB1", streamable: true, ...cd },
  2: { title: "Teardrop", artist: "Massive Attack", isrc: "GB1", streamable: true, ...hires },
  3: { title: "Angel", artist: "Massive Attack", isrc: "GB3", streamable: false, ...cd },
  4: { title: "Angel", artist: "Massive Attack", isrc: "GB3", streamable: true, ...cd },
  5: { title: "Protection", artist: "Massive Attack", isrc: "GB5", streamable: true, ...hires },
  6: { title: "Protection (2011 Remaster)", artist: "Massive Attack", streamable: true, ...cd },
  7: { title: "Unfinished Sympathy", artist: "Massive Attack", isrc: "GB7", streamable: true, bitDepth: 24, samplingRate: 192 },
  8: { title: "Karmacoma", artist: "Massive Attack", isrc: "GB8", streamable: true, bitDepth: 24, samplingRate: 192 },
};

export function detail(id: number): Track {
  return { id, title: `Track ${id}`, ...CATALOGUE[id] };
}

export function richAccount(favouriteDates: Record<number, string> = {}) {
  const account = new FakeAccount();
  const plain = account.getPlaylistTracks.bind(account);
  return Object.assign(account, {
    getPlaylistTracks: async (playlistId: number) =>
      (await plain(playlistId)).map((track) => ({ ...detail(track.id), playlistTrackId: track.playlistTrackId })),
    getFavoriteTracks: async () => {
      account.calls.push("getFavoriteTracks:");
      return account.favourites.tracks.map((id) => ({
        ...detail(id),
        ...(favouriteDates[id] !== undefined && { favouritedAt: favouriteDates[id] }),
      }));
    },
    searchTracks: async (query: string) =>
      Object.keys(CATALOGUE)
        .map(Number)
        .filter((id) => CATALOGUE[id]?.isrc === query)
        .map(detail),
  });
}
