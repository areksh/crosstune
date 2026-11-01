/**
 * New releases: what your artists have released lately.
 *
 * Split like every tool into two phases so the web UI can review between them:
 *
 *   1. *Find* ({@link findNewReleases}) -- take the artists of a source (your
 *      favourite artists, or a playlist's artists, most frequent first), list
 *      each one's releases, and keep those of the chosen kinds released in the
 *      window (since a date, up to today). Releases already among your
 *      favourite albums are hidden, as are reissues of older albums: a release
 *      whose version or title carries a reissue label ("Remastered",
 *      "Anniversary", "Expanded", ...) or whose edition-free title the artist
 *      already released before the window. Editions of one new album (say the
 *      standard and the deluxe, or CD and hi-res) are shown once, the best
 *      quality. The result is newest first.
 *   2. *Commit* ({@link commitNewReleases}) -- put the chosen releases' tracks,
 *      release by release in the order given, in a new playlist; or add the
 *      releases to your favourite albums.
 *
 * The artist fan-out goes through {@link mapWithConcurrency} and is capped at
 * {@link MAX_ARTISTS}; the plan says when the cap cut the list short.
 */

import type {
  Album,
  Artist,
  Playlist,
  Release,
  ReleaseType,
  Track,
} from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { editionKey, isByArtist, type ArtistReleasesClient } from "./discography.js";
import { fetchAlbumTracks, type AlbumTracksClient } from "./playlist-from-albums.js";
import {
  createPlaylistWithTracks,
  type PlaylistWriterClient,
} from "./playlist-from-artists.js";
import { seedsFromPlaylist } from "./similar-artists.js";
import {
  albumExclusion,
  artistExclusion,
  NO_FILTER,
  normaliseArtistName,
  type TrackFilter,
} from "./track-filter.js";

/** The client surface needed to find new releases. */
export interface NewReleasesClient extends ArtistReleasesClient {
  getFavoriteArtists(): Promise<Artist[]>;
  getFavoriteAlbums(): Promise<Album[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
}

/** Whose releases to look at. */
export type ArtistSource = { type: "favourites" } | { type: "playlist"; playlistId: number };

/** By default: albums, and EPs and singles (live albums and compilations off). */
export const DEFAULT_NEW_RELEASE_INCLUDE: readonly ReleaseType[] = ["album", "ep-single"];

/** The default window: releases from the last 30 days. */
export const DEFAULT_WINDOW_DAYS = 30;

/** The most artists checked in one run; more are reported as capped. */
export const MAX_ARTISTS = 200;

/**
 * Releases read per artist, newest first: enough for the window and, for most
 * artists, the older albums a reissue would repeat.
 */
export const RELEASES_PER_ARTIST = 100;

/** Labels that mark a reissue of an older album, in a version or title. */
const REISSUE_LABEL =
  /\b(remaster(ed)?|remasterised|anniversary|reissue|re-issue|expanded|legacy edition)\b/i;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** The (UTC) date `days` days before `now`, as YYYY-MM-DD. */
export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export interface FindNewReleasesOptions {
  source: ArtistSource;
  /** First day of the window (YYYY-MM-DD); default 30 days before `now`. */
  since?: string;
  /** The clock; the window ends on its (UTC) date. Default: the real time. */
  now?: Date;
  /** Kinds of release to include (default albums and EPs/singles). */
  include?: readonly ReleaseType[];
  /** Artist terms leave artists (and their releases) out; album terms, releases. */
  filter?: TrackFilter;
  /** Check at most this many artists (default {@link MAX_ARTISTS}). */
  maxArtists?: number;
}

export interface NewReleasesPlan {
  /** The window, inclusive, as YYYY-MM-DD. */
  since: string;
  until: string;
  /** The new releases, newest first. */
  releases: Release[];
  /** Artists whose releases were checked. */
  checkedArtists: number;
  /** Artists the source had (after the exclude filter), before the cap. */
  totalArtists: number;
  /** True when the cap left some artists unchecked. */
  capped: boolean;
  /** How many releases in the window were hidden, and why. */
  hidden: { favourites: number; reissues: number };
  /** Source artists the exclude-artist filter left out. */
  excludedArtists: string[];
  /** Artists whose releases could not be fetched. */
  failedArtists: string[];
}

/**
 * Find the recent releases of a source's artists (phase 1). See the module
 * comment for what is kept and hidden.
 */
export async function findNewReleases(
  client: NewReleasesClient,
  options: FindNewReleasesOptions,
): Promise<NewReleasesPlan> {
  const now = options.now ?? new Date();
  const since = options.since ?? daysBefore(now, DEFAULT_WINDOW_DAYS);
  const until = now.toISOString().slice(0, 10);
  const include = new Set(options.include ?? DEFAULT_NEW_RELEASE_INCLUDE);
  const filter = options.filter ?? NO_FILTER;

  const sourceArtists = await artistsOf(client, options.source);
  const excludedArtists: string[] = [];
  const artists: Artist[] = [];
  for (const artist of sourceArtists) {
    if (artistExclusion(artist.name, filter) !== undefined) {
      excludedArtists.push(artist.name);
    } else {
      artists.push(artist);
    }
  }
  const checked = artists.slice(0, options.maxArtists ?? MAX_ARTISTS);

  const favourites = favouriteIndex(await client.getFavoriteAlbums());
  const outcomes = await mapWithConcurrency(checked, DEFAULT_CONCURRENCY, async (artist) => {
    try {
      const { releases } = await client.getArtistReleases(artist.id, RELEASES_PER_ARTIST);
      return { artist, releases };
    } catch {
      return { artist, releases: undefined };
    }
  });

  const hidden = { favourites: 0, reissues: 0 };
  const failedArtists: string[] = [];
  const kept: Release[] = [];
  for (const { artist, releases } of outcomes) {
    if (releases === undefined) {
      failedArtists.push(artist.name);
      continue;
    }
    const own = releases.filter((release) => isByArtist(release, artist.id));
    // The albums (kind and edition-free title) the artist released before
    // the window. The kind matters: a lead single released earlier under the
    // album's title does not make the album a reissue.
    const earlier = new Set(
      own
        .filter((release) => release.releaseDate !== undefined && release.releaseDate < since)
        .map(releaseKey),
    );
    for (const release of own) {
      const date = release.releaseDate;
      if (
        date === undefined ||
        date < since ||
        date > until ||
        !include.has(release.releaseType) ||
        albumExclusion(release, filter) !== undefined ||
        (release.artist.length > 0 && artistExclusion(release.artist, filter) !== undefined)
      ) {
        continue;
      }
      if (isReissue(release, earlier)) {
        hidden.reissues += 1;
      } else if (favourites.has(release)) {
        hidden.favourites += 1;
      } else {
        kept.push(release);
      }
    }
  }

  return {
    since,
    until,
    releases: newestFirst(onePerAlbum(kept)),
    checkedArtists: checked.length,
    totalArtists: artists.length,
    capped: checked.length < artists.length,
    hidden,
    excludedArtists,
    failedArtists,
  };
}

/** The source's artists: favourites as listed, or a playlist's most frequent first. */
async function artistsOf(client: NewReleasesClient, source: ArtistSource): Promise<Artist[]> {
  const artists =
    source.type === "favourites"
      ? await client.getFavoriteArtists()
      : seedsFromPlaylist(await client.getPlaylistTracks(source.playlistId), Infinity).seeds;
  const seen = new Set<number>();
  return artists.filter((artist) => !seen.has(artist.id) && seen.add(artist.id));
}

/** A reissue label, or a title the artist already released before the window. */
function isReissue(release: Release, earlier: ReadonlySet<string>): boolean {
  return (
    REISSUE_LABEL.test(release.version ?? "") ||
    REISSUE_LABEL.test(release.title) ||
    earlier.has(releaseKey(release))
  );
}

function releaseKey(release: Release): string {
  return `${release.releaseType}|${editionKey(release.title)}`;
}

/** Favourite albums, matched by id or by artist and edition-free title. */
function favouriteIndex(albums: readonly Album[]): { has(release: Release): boolean } {
  const ids = new Set(albums.map((album) => album.id));
  const keys = new Set(albums.map(albumKey));
  return { has: (release) => ids.has(release.id) || keys.has(albumKey(release)) };
}

function albumKey(album: Album): string {
  return `${normaliseArtistName(album.artist)}|${editionKey(album.title)}`;
}

/**
 * One release per new album: the same release listed under two artists is
 * kept once, and editions of one album (same artist, kind and edition-free
 * title) collapse to the best quality, then the most tracks.
 */
function onePerAlbum(releases: readonly Release[]): Release[] {
  const best = new Map<string, Release>();
  const seenIds = new Set<string>();
  for (const release of releases) {
    if (seenIds.has(release.id)) {
      continue;
    }
    seenIds.add(release.id);
    const key = `${release.releaseType}|${albumKey(release)}`;
    const current = best.get(key);
    if (current === undefined || isBetter(release, current)) {
      best.set(key, release);
    }
  }
  return [...best.values()];
}

function isBetter(a: Release, b: Release): boolean {
  return (
    ((a.bitDepth ?? 0) - (b.bitDepth ?? 0) ||
      (a.samplingRate ?? 0) - (b.samplingRate ?? 0) ||
      (a.trackCount ?? 0) - (b.trackCount ?? 0)) > 0
  );
}

/** Newest first; ties by artist, then title. */
function newestFirst(releases: Release[]): Release[] {
  return releases.sort(
    (a, b) =>
      (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") ||
      a.artist.localeCompare(b.artist) ||
      a.title.localeCompare(b.title),
  );
}

/** Where to put the chosen releases. */
export type NewReleasesTarget =
  | { type: "playlist"; name: string; isPublic?: boolean; description?: string }
  | { type: "favourite-albums" };

/** The client surface needed to commit new releases. */
export interface CommitNewReleasesClient extends AlbumTracksClient, PlaylistWriterClient {
  addFavoriteAlbums(albumIds: readonly string[]): Promise<void>;
}

export type CommitNewReleasesResult =
  | {
      type: "playlist";
      playlist: Playlist;
      trackCount: number;
      /** Tracks the filter's track (or artist, or disc) terms left out. */
      excludedCount: number;
      /** Releases whose tracks could not be fetched (left out). */
      failedAlbumIds: string[];
    }
  | { type: "favourite-albums"; added: number };

/**
 * Write the chosen releases (phase 2): into a new playlist -- each release's
 * tracks in album order, release after release in the order given, without
 * repeats or tracks the filter excludes -- or into your favourite albums.
 *
 * @throws {Error} if no release is given, or (for a playlist) no track could be
 *   fetched, so no empty playlist is created.
 */
export async function commitNewReleases(
  client: CommitNewReleasesClient,
  options: { albumIds: readonly string[]; target: NewReleasesTarget; filter?: TrackFilter },
): Promise<CommitNewReleasesResult> {
  const albumIds = [...new Set(options.albumIds)];
  if (albumIds.length === 0) {
    throw new Error("Choose at least one release");
  }
  const { target } = options;
  if (target.type === "favourite-albums") {
    await client.addFavoriteAlbums(albumIds);
    return { type: "favourite-albums", added: albumIds.length };
  }

  const { fetched, failedAlbumIds } = await fetchAlbumTracks(client, albumIds, options.filter);
  const trackIds: number[] = [];
  const seen = new Set<number>();
  let excludedCount = 0;
  for (const album of fetched) {
    for (const { track, exclusion } of album.tracks) {
      if (exclusion !== undefined) {
        excludedCount += 1;
      } else if (!seen.has(track.id)) {
        seen.add(track.id);
        trackIds.push(track.id);
      }
    }
  }
  if (trackIds.length === 0) {
    throw new Error("No tracks could be fetched for these releases; nothing was created");
  }
  const playlist = await createPlaylistWithTracks(client, {
    name: target.name,
    trackIds,
    isPublic: target.isPublic ?? false,
    ...(target.description !== undefined && { description: target.description }),
  });
  return { type: "playlist", playlist, trackCount: trackIds.length, excludedCount, failedAlbumIds };
}
