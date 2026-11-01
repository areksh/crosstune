/**
 * Playlist from albums, starting from an artist's discography.
 *
 * Instead of "Artist - Album" lines, the user names one artist and which kinds
 * of release to include (studio albums by default; EPs and singles, live
 * albums and compilations on request). Resolving fetches the artist's releases
 * and turns them into the same {@link ResolvedAlbumVersions} groups the album
 * list produces, so the rest of the tool -- version choice, filters, the
 * review, the write -- is shared unchanged:
 *
 *   - with "one version of each album" (the default) the editions of an album
 *     (original, remaster, deluxe, anniversary, hi-res...) are grouped by their
 *     edition-free title into one entry whose versions are those editions, and
 *     the usual version preference picks one;
 *   - otherwise every release is its own entry.
 *
 * Entries come oldest first. The release helpers here ({@link editionKey},
 * {@link parseIncludeList}) are shared with the new-releases tool.
 */

import type { Artist, ArtistReleases, Release, ReleaseType } from "../qobuz/index.js";
import { normalise } from "./deduplicate.js";
import {
  writeAlbumPlaylist,
  type AlbumTracksClient,
  type BuildAlbumPlaylistOptions,
  type BuildAlbumPlaylistResult,
  type ResolveAlbumsResult,
  type ResolvedAlbumVersions,
} from "./playlist-from-albums.js";
import { pickArtist, type PlaylistWriterClient } from "./playlist-from-artists.js";
import { albumExclusion, NO_FILTER, type TrackFilter } from "./track-filter.js";

/** The client surface needed to list an artist's releases. */
export interface ArtistReleasesClient {
  getArtistReleases(artistId: number, maxReleases?: number): Promise<ArtistReleases>;
}

/** The client surface needed to resolve an artist's discography. */
export interface DiscographyResolverClient extends ArtistReleasesClient {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
}

/** The include names the CLI and API accept, mapped to release types. */
export const INCLUDE_NAMES: Readonly<Record<string, ReleaseType>> = {
  albums: "album",
  eps: "ep-single",
  singles: "ep-single",
  live: "live",
  compilations: "compilation",
};

/** By default a discography is the artist's studio albums. */
export const DEFAULT_DISCOGRAPHY_INCLUDE: readonly ReleaseType[] = ["album"];

/**
 * Parse an include list such as "albums,eps,live" into release types (unique,
 * in the order given).
 *
 * @throws {Error} if the list is empty or names an unknown kind.
 */
export function parseIncludeList(raw: string): ReleaseType[] {
  const types: ReleaseType[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name.length === 0) {
      continue;
    }
    const type = INCLUDE_NAMES[name];
    if (type === undefined) {
      throw new Error(
        `Unknown release kind "${part.trim()}": use ${Object.keys(INCLUDE_NAMES).join(", ")}`,
      );
    }
    if (!types.includes(type)) {
      types.push(type);
    }
  }
  if (types.length === 0) {
    throw new Error(`Name at least one release kind: ${Object.keys(INCLUDE_NAMES).join(", ")}`);
  }
  return types;
}

/** Words that mark an edition of an album rather than a different album. */
const EDITION_WORDS =
  /\b(deluxe|remaster(ed)?|remasterised|anniversary|expanded|edition|reissue|bonus|special|legacy|collector'?s|version|mono|stereo|super)\b/i;

/**
 * An album title without its edition labels, for grouping the editions of one
 * album: bracketed segments and " - " suffixes that name an edition
 * ("(Deluxe Edition)", "[2011 Remaster]", " - 25th Anniversary") are dropped,
 * then the title is normalised as the deduplicator does (case, accents,
 * punctuation, leftover edition noise). Brackets that do not name an edition
 * ("(Part 2)", "(Live)") are kept, so those stay separate albums.
 */
export function editionKey(title: string): string {
  const stripped = title
    .replace(/[([{][^)\]}]*[)\]}]/g, (segment) => (EDITION_WORDS.test(segment) ? " " : segment))
    .replace(/\s+[-–—]\s+(.*)$/, (suffix, rest: string) =>
      EDITION_WORDS.test(rest) ? " " : suffix,
    );
  return normalise(stripped);
}

/** True when the release is by the artist (or does not say who it is by). */
export function isByArtist(release: Release, artistId: number): boolean {
  return release.artistId === undefined || release.artistId === artistId;
}

/** Ascending release date; undated releases sort last. */
function byDateAscending(a: Release, b: Release): number {
  if (a.releaseDate === b.releaseDate) return 0;
  if (a.releaseDate === undefined) return 1;
  if (b.releaseDate === undefined) return -1;
  return a.releaseDate < b.releaseDate ? -1 : 1;
}

export interface ResolveDiscographyOptions {
  /** The artist's name, resolved as the artists tool does. */
  artist: string;
  /** Kinds of release to include (default: studio albums only). */
  include?: readonly ReleaseType[];
  /** Group an album's editions into one entry (default true). */
  oneVersion?: boolean;
  /** Releases matching one of its album terms are dropped. */
  filter?: TrackFilter;
}

export interface ResolveDiscographyResult extends ResolveAlbumsResult {
  /** The artist the name resolved to; absent when nothing matched. */
  artist?: Artist;
  /** True when the artist has more releases than were fetched. */
  truncated: boolean;
}

/**
 * Resolve an artist's discography into album entries (phase 1), oldest first.
 *
 * Only the artist's own releases of the included kinds are kept (releases
 * whose main artist is someone else are dropped). A name that matches no
 * artist is reported in `unresolvedAlbums`; a group whose every edition the
 * filter's album terms exclude, in `excludedAlbums`.
 */
export async function resolveDiscography(
  client: DiscographyResolverClient,
  options: ResolveDiscographyOptions,
): Promise<ResolveDiscographyResult> {
  const include = new Set(options.include ?? DEFAULT_DISCOGRAPHY_INCLUDE);
  const filter = options.filter ?? NO_FILTER;
  const empty = { resolvedAlbums: [], unresolvedAlbums: [], excludedAlbums: [] };

  const artist = pickArtist(await client.searchArtists(options.artist, 5), options.artist);
  if (artist === undefined) {
    return { ...empty, unresolvedAlbums: [options.artist], truncated: false };
  }
  const { releases, truncated } = await client.getArtistReleases(artist.id);
  const wanted = releases
    .filter((release) => isByArtist(release, artist.id) && include.has(release.releaseType))
    .sort(byDateAscending);

  // Group (or not) in date order, so each group's first version is its
  // earliest and groups come out oldest first.
  const groups = new Map<string, Release[]>();
  for (const release of wanted) {
    const key =
      options.oneVersion === false
        ? release.id
        : `${release.releaseType}:${editionKey(release.title)}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [release]);
    } else {
      group.push(release);
    }
  }

  const resolvedAlbums: ResolvedAlbumVersions[] = [];
  const excludedAlbums: string[] = [];
  for (const editions of groups.values()) {
    const first = editions[0]!;
    const name = first.artist.length > 0 ? first.artist : artist.name;
    const query = `${name} - ${first.title}`;
    const versions = editions.filter((release) => albumExclusion(release, filter) === undefined);
    if (versions.length === 0) {
      excludedAlbums.push(query);
      continue;
    }
    resolvedAlbums.push({ query, artist: name, album: first.title, versions });
  }
  return { artist, resolvedAlbums, unresolvedAlbums: [], excludedAlbums, truncated };
}

/** The full surface {@link buildPlaylistFromDiscography} depends on. */
export type DiscographyPlaylistClient = DiscographyResolverClient &
  AlbumTracksClient &
  PlaylistWriterClient;

export interface BuildDiscographyPlaylistResult extends BuildAlbumPlaylistResult {
  artist: Artist;
  truncated: boolean;
}

/**
 * Resolve an artist's discography, pick one version of each entry (per
 * `preference`), then create and fill a new playlist with their tracks, oldest
 * release first.
 *
 * @throws {Error} if the name matches no artist, or no release is left (so no
 *   empty playlist is created).
 */
export async function buildPlaylistFromDiscography(
  client: DiscographyPlaylistClient,
  options: ResolveDiscographyOptions & Omit<BuildAlbumPlaylistOptions, "entries">,
): Promise<BuildDiscographyPlaylistResult> {
  const resolution = await resolveDiscography(client, options);
  if (resolution.artist === undefined) {
    throw new Error(`No artist found for "${options.artist}"`);
  }
  if (resolution.resolvedAlbums.length === 0) {
    throw new Error(
      `No releases of the chosen kinds found for ${resolution.artist.name}; nothing was created`,
    );
  }
  const result = await writeAlbumPlaylist(client, resolution, options);
  return {
    ...result,
    artist: resolution.artist,
    truncated: resolution.truncated,
  };
}
