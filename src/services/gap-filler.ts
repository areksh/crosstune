/**
 * What a service cannot say, asked of another (spec section 7): Spotify gives
 * no artist top tracks and no similar artists, so they come from Qobuz or TIDAL
 * and are found again on Spotify. Only exact matches by the same artist are
 * given, as managed playlists write them without review (ADR-0012).
 *
 * Likewise an artist or album id of another service -- a pasted Spotify link
 * in a tool running on Qobuz -- is read there and found again here: an artist
 * by its exact name, an album by its barcode, else its exact title and artist.
 */

import { matchTracks, type MatchMemory } from "../features/match.js";
import { normaliseArtistName } from "../features/track-filter.js";
import { labelOf, ServiceError } from "./errors.js";
import { serviceOf, type AlbumId, type AnyId, type ArtistId } from "./ids.js";
import type { Album, Artist, Track } from "./model.js";
import type { Capabilities, Capability, MusicService } from "./service.js";

/** The capabilities this fills, and how a service is asked for them. */
const FILLED = ["topTracks", "similarArtists"] as const;

/**
 * `service`, with its gaps filled from `donors` (other connected services,
 * asked in order). A service without gaps is returned as it is.
 */
export function fillGaps(service: MusicService, donors: () => readonly MusicService[], matches: MatchMemory): MusicService {
  const label = labelOf(service.name);
  /** The connected service an id of another is on. */
  const owner = (id: AnyId): MusicService => {
    const name = serviceOf(id);
    const found = donors().find((donor) => donor.name === name);
    if (found === undefined) {
      const theirs = labelOf(name);
      throw new ServiceError(service.name, "not-connected", `That is a ${theirs} link. Connect ${theirs} to find it on ${label}.`);
    }
    return found;
  };
  const notHere = (what: string): ServiceError => new ServiceError(service.name, "not-found", `${what} is not on ${label}`);

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
    getArtist: async (artistId: ArtistId): Promise<Artist> => {
      if (serviceOf(artistId) === service.name) {
        return service.getArtist(artistId);
      }
      const { name } = await owner(artistId).getArtist(artistId);
      const wanted = normaliseArtistName(name);
      const found = (await service.searchArtists(name, 10)).find((artist) => normaliseArtistName(artist.name) === wanted);
      if (found === undefined) {
        throw notHere(name);
      }
      return found;
    },
    getAlbum: async (albumId: AlbumId): Promise<Album> => {
      if (serviceOf(albumId) === service.name) {
        return service.getAlbum(albumId);
      }
      const theirs = await owner(albumId).getAlbum(albumId);
      const candidates = await service.searchAlbums(`${theirs.artist} ${theirs.title}`, 20);
      const barcode = barcodeOf(theirs);
      const found =
        (barcode === undefined ? undefined : candidates.find((album) => barcodeOf(album) === barcode)) ??
        candidates.find((album) => sameText(album.title, theirs.title) && sameText(album.artist, theirs.artist));
      if (found === undefined) {
        throw notHere(`${theirs.artist} - ${theirs.title}`);
      }
      return found;
    },
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

  const gaps = FILLED.some((name) => service.capabilities[name]?.ok === false);
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
        return gaps ? capabilities() : target.capabilities;
      }
      if (typeof property === "string" && property in overrides) {
        return overrides[property as keyof typeof overrides];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}


/** A UPC and the EAN-13 it becomes compare equal; undefined when there is none. */
function barcodeOf(album: Album): string | undefined {
  const digits = album.upc?.replace(/\D/g, "").replace(/^0+/, "");
  return digits === undefined || digits.length === 0 ? undefined : digits;
}

function sameText(a: string, b: string): boolean {
  return normaliseArtistName(a) === normaliseArtistName(b);
}
