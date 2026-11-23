/**
 * What a service cannot say, asked of another (spec section 7): Spotify gives
 * no artist top tracks and no similar artists, so they come from Qobuz or TIDAL
 * and are found again on Spotify. Only exact matches by the same artist are
 * given, as managed playlists write them without review (ADR-0012).
 */

import { matchTracks, type MatchMemory } from "../features/match.js";
import { normaliseArtistName } from "../features/track-filter.js";
import { labelOf, ServiceError } from "./errors.js";
import type { ArtistId } from "./ids.js";
import type { Artist, Track } from "./model.js";
import type { Capabilities, Capability, MusicService } from "./service.js";

/** The capabilities this fills, and how a service is asked for them. */
const FILLED = ["topTracks", "similarArtists"] as const;

/**
 * `service`, with its gaps filled from `donors` (other connected services,
 * asked in order). A service without gaps is returned as it is.
 */
export function fillGaps(service: MusicService, donors: () => readonly MusicService[], matches: MatchMemory): MusicService {
  if (FILLED.every((name) => service.capabilities[name]?.ok !== false)) {
    return service;
  }
  const helping = (capability: (typeof FILLED)[number]): MusicService[] =>
    donors().filter((donor) => donor.name !== service.name && donor.capabilities[capability]?.ok === true);
  const none = (what: string): ServiceError =>
    new ServiceError(
      service.name,
      "unsupported",
      `${labelOf(service.name)} does not give ${what}. Connect Qobuz or TIDAL, and they are taken from there.`,
    );

  /** The same artist on a donor: by exact name. */
  const onDonor = async (donor: MusicService, artistId: ArtistId): Promise<Artist | undefined> => {
    const { name } = await service.getArtist(artistId);
    const wanted = normaliseArtistName(name);
    return (await donor.searchArtists(name, 10)).find((artist) => normaliseArtistName(artist.name) === wanted);
  };

  const overrides: Partial<MusicService> = {
    getArtistTopTracks: async (artistId: ArtistId, limit = 10): Promise<Track[]> => {
      if (service.capabilities.topTracks.ok) {
        return service.getArtistTopTracks(artistId, limit);
      }
      for (const donor of helping("topTracks")) {
        const there = await onDonor(donor, artistId);
        if (there === undefined) {
          continue;
        }
        const theirs = await donor.getArtistTopTracks(there.id, limit * 2);
        // Scheduled jobs write these unseen: only the same recording, by this
        // artist (a namesake's songs match exactly too) -- never a likely one.
        const found = (await matchTracks(service, theirs, matches)).flatMap((match) =>
          match.track !== undefined && match.grade === "exact" && match.track.artistId === artistId ? [match.track] : [],
        );
        return [...new Map(found.map((track) => [track.id, track])).values()].slice(0, limit);
      }
      throw none("an artist's top tracks");
    },
    getSimilarArtists: async (artistId: ArtistId, limit: number): Promise<Artist[]> => {
      if (service.capabilities.similarArtists.ok) {
        return service.getSimilarArtists(artistId, limit);
      }
      for (const donor of helping("similarArtists")) {
        const there = await onDonor(donor, artistId);
        if (there === undefined) {
          continue;
        }
        const theirs = await donor.getSimilarArtists(there.id, limit);
        const found: Artist[] = [];
        for (const similar of theirs) {
          const wanted = normaliseArtistName(similar.name);
          const here = (await service.searchArtists(similar.name, 10)).find(
            (artist) => normaliseArtistName(artist.name) === wanted,
          );
          if (here !== undefined) {
            found.push(here);
          }
        }
        return found;
      }
      throw none("similar artists");
    },
  };

  const capabilities = (): Capabilities => {
    const out = { ...service.capabilities };
    for (const name of FILLED) {
      const from = helping(name)[0]?.name;
      if (!service.capabilities[name].ok && from !== undefined) {
        out[name] = { ok: true, from } as Capability;
      }
    }
    return out;
  };

  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "capabilities") {
        return capabilities();
      }
      if (typeof property === "string" && property in overrides) {
        return overrides[property as keyof typeof overrides];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

