/**
 * Build a playlist from a list of albums.
 *
 * Mirrors {@link ./playlist-from-artists.ts} and reuses its commit half. The
 * work splits into two phases so a caller can review and edit between them (the
 * web UI does this):
 *
 *   1. *Resolve* -- turn each "Artist - Album" line into the Qobuz album
 *      *versions* that match it (an album often exists as several releases:
 *      original, remaster, hi-res, ...). Lines that match nothing are reported,
 *      not fatal.
 *   2. *Commit* -- pick one version per album, gather its tracks, then create a
 *      new playlist or add to an existing one (handled by the artists module's
 *      {@link createPlaylistWithTracks}/{@link addTracksToExistingPlaylist}).
 *
 * {@link buildPlaylistFromAlbums} composes both phases in one call for the CLI,
 * choosing versions by a single {@link AlbumPreference}. An optional
 * {@link TrackFilter} drops releases whose title matches an album term before a
 * version is chosen, and marks tracks on unwanted discs or matching a track term
 * as excluded (left out by the CLI; shown unticked by the web UI). An optional
 * {@link SongPicker} marks tracks already in the favourites, and later copies of
 * a song an earlier album has, the same way (an album keeps its other tracks:
 * nothing replaces them). The composed build can shuffle the playlist and trim
 * it to a length from the end, keeping whole albums from the top of the list.
 * Each function depends
 * only on the small client surface it needs, so all are unit-testable against
 * stubs; QobuzClient satisfies them structurally.
 */

import type { Album, Playlist, Track } from "../services/model.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { normalise } from "./deduplicate.js";
import { describeLinkMismatch, parseQobuzLink } from "./qobuz-links.js";
import {
  createPlaylistWithTracks,
  type PlaylistWriterClient,
} from "./playlist-from-artists.js";
import { shapePlaylist, uniqueGroups, type AlbumOrder } from "./playlist-shape.js";
import {
  createSongPicker,
  type FavouriteTracksClient,
  type SongPicker,
  type SongPickerOptions,
} from "./song-picker.js";
import {
  albumExclusion,
  applyTrackFilter,
  NO_FILTER,
  type FilteredTrack,
  type TrackFilter,
} from "./track-filter.js";

/** An artist/album pair parsed from an input line. */
export interface AlbumEntry {
  artist: string;
  album: string;
}

/** The separator between the artist and the album in an input line. */
const ENTRY_SEPARATOR = " - ";

/** How many search results to consider when looking for an album's versions. */
const ALBUM_SEARCH_LIMIT = 20;

/**
 * Parse an "Artist - Album" line into its parts.
 *
 * Splits on the *first* separator so album titles containing " - " survive
 * (e.g. "Godspeed You! - F# A# - Infinity"). Returns undefined if the separator
 * is absent or either side is empty.
 */
export function parseAlbumEntry(line: string): AlbumEntry | undefined {
  const index = line.indexOf(ENTRY_SEPARATOR);
  if (index === -1) {
    return undefined;
  }
  const artist = line.slice(0, index).trim();
  const album = line.slice(index + ENTRY_SEPARATOR.length).trim();
  if (artist.length === 0 || album.length === 0) {
    return undefined;
  }
  return { artist, album };
}

/** A pasted Qobuz album link: one release, resolved by its id. */
export interface AlbumLinkEntry {
  /** The line as typed, for reporting. */
  link: string;
  albumId: string;
}

/**
 * Parse an input line: an album link, or an "Artist - Album" line. Anything
 * else is a problem to report -- the line itself, or a link to something
 * other than an album with the reason.
 */
export function parseAlbumLine(
  line: string,
): { entry: AlbumEntry | AlbumLinkEntry } | { problem: string } {
  const link = parseQobuzLink(line);
  if (link?.kind === "album") {
    return { entry: { link: line.trim(), albumId: link.id } };
  }
  if (link !== undefined) {
    return { problem: `${line.trim()} (${describeLinkMismatch(link, "album")})` };
  }
  const entry = parseAlbumEntry(line);
  return entry === undefined ? { problem: line.trim() } : { entry };
}

/** Render an entry back as its "Artist - Album" form (for display/reporting). */
function formatEntry(entry: AlbumEntry): string {
  return `${entry.artist}${ENTRY_SEPARATOR}${entry.album}`;
}

/** A strategy for choosing which version of an album to use. */
export type AlbumPreference = "newest" | "oldest" | "highest-quality";

/** All album preferences, for CLI validation and help. */
export const ALBUM_PREFERENCES: readonly AlbumPreference[] = [
  "newest",
  "oldest",
  "highest-quality",
];

/** The default version preference when none is given. */
export const DEFAULT_ALBUM_PREFERENCE: AlbumPreference = "highest-quality";

/** The client surface needed to resolve "Artist - Album" entries to their versions. */
export interface AlbumSearchClient {
  searchAlbums(query: string, limit?: number): Promise<Album[]>;
}

/** The client surface needed to resolve entries and album links to their versions. */
export interface AlbumResolverClient extends AlbumSearchClient {
  getAlbum(albumId: string): Promise<Album>;
}

/** The client surface needed to fetch an album's tracks. */
export interface AlbumTracksClient {
  getAlbumTracks(albumId: string): Promise<Track[]>;
}

/** A resolved album entry together with the versions found for it. */
export interface ResolvedAlbumVersions {
  /** The original "Artist - Album" line, for display. */
  query: string;
  artist: string;
  album: string;
  /** The matching album releases, most relevant first. */
  versions: Album[];
  /** True when the line was an album link: the one release it names. */
  fromLink?: boolean;
}

export interface ResolveAlbumsResult {
  resolvedAlbums: ResolvedAlbumVersions[];
  unresolvedAlbums: string[];
  /** Entries that matched releases, but every one was excluded by an album term. */
  excludedAlbums: string[];
}

export interface ResolveAlbumsOptions {
  /** "Artist - Album" entries and album links, in the order typed. */
  entries: (AlbumEntry | AlbumLinkEntry)[];
  /** Releases matching one of its album terms are dropped from the versions. */
  filter?: TrackFilter;
}

/**
 * Resolve each entry to its matching album versions (phase 1).
 *
 * An album link resolves to the one release it names (by id). Otherwise this
 * searches Qobuz for "artist album" and keeps the results whose artist and
 * title match the entry (normalised, so case and edition noise are ignored).
 * Entries with no match are collected in `unresolvedAlbums`; entries whose
 * every match was excluded by the filter's album terms in `excludedAlbums`.
 */
export async function resolveAlbumVersions(
  client: AlbumSearchClient & Partial<Pick<AlbumResolverClient, "getAlbum">>,
  options: ResolveAlbumsOptions,
): Promise<ResolveAlbumsResult> {
  // Resolve entries through a bounded pool (results stay in input order) so a
  // large list does not hold a single web request open long enough for the
  // browser to abort the fetch.
  const outcomes = await mapWithConcurrency(
    options.entries,
    DEFAULT_CONCURRENCY,
    async (input): Promise<{ entry: AlbumEntry; versions: Album[]; fromLink?: boolean } | string> => {
      if (!("albumId" in input)) {
        return { entry: input, versions: await findAlbumVersions(client, input) };
      }
      // A link names one release: use it as the only version.
      if (client.getAlbum === undefined) {
        return `${input.link} (album links are not accepted here)`;
      }
      try {
        const album = await client.getAlbum(input.albumId);
        return {
          entry: { artist: album.artist, album: album.title },
          versions: [album],
          fromLink: true,
        };
      } catch {
        return `${input.link} (no Qobuz album has this id)`;
      }
    },
  );

  const filter = options.filter ?? NO_FILTER;
  const resolvedAlbums: ResolvedAlbumVersions[] = [];
  const unresolvedAlbums: string[] = [];
  const excludedAlbums: string[] = [];
  for (const outcome of outcomes) {
    if (typeof outcome === "string") {
      unresolvedAlbums.push(outcome);
      continue;
    }
    const { entry, versions: matched } = outcome;
    if (matched.length === 0) {
      unresolvedAlbums.push(formatEntry(entry));
      continue;
    }
    const versions = matched.filter((version) => albumExclusion(version, filter) === undefined);
    if (versions.length === 0) {
      excludedAlbums.push(formatEntry(entry));
      continue;
    }
    resolvedAlbums.push({
      query: formatEntry(entry),
      artist: entry.artist,
      album: entry.album,
      versions,
      ...(outcome.fromLink === true && { fromLink: true }),
    });
  }

  return { resolvedAlbums, unresolvedAlbums, excludedAlbums };
}

/**
 * Find an entry's matching album versions.
 *
 * Searches "artist album" first; if that yields no match, falls back to an
 * album-title-only search filtered by artist. The combined query sometimes
 * returns an empty page for a valid album, while the broader title search does
 * not, so the fallback markedly improves recall.
 */
async function findAlbumVersions(
  client: AlbumSearchClient,
  entry: AlbumEntry,
): Promise<Album[]> {
  const combined = await client.searchAlbums(
    `${entry.artist} ${entry.album}`,
    ALBUM_SEARCH_LIMIT,
  );
  const matches = matchAlbums(combined, entry);
  if (matches.length > 0) {
    return matches;
  }
  const byTitle = await client.searchAlbums(entry.album, ALBUM_SEARCH_LIMIT);
  return matchAlbums(byTitle, entry);
}

/**
 * Keep the candidates that are the album the entry asked for.
 *
 * Qobuz release titles carry edition suffixes ("(Reloaded)", "(Legacy
 * Edition)") and artist credits vary ("Ritchie Blackmore's Rainbow" for
 * "Rainbow"), so a plain equality check misses real matches. Matching therefore:
 *
 *   - drops bracketed segments from titles and requires the remaining title
 *     tokens to be *equal* -- so "Blackwater Park (Legacy Edition)" matches
 *     "Blackwater Park", but a sequel like "Danzig II" does not match "Danzig";
 *   - reconciles "&"/"and" and spelled-out numbers with digits ("Volume One" ==
 *     "Volume 1"); and
 *   - treats the artist as matching when either name's tokens are a subset of
 *     the other's, catching band prefixes.
 */
function matchAlbums(candidates: readonly Album[], entry: AlbumEntry): Album[] {
  const wantArtist = matchTokens(entry.artist);
  const wantTitle = matchTokens(entry.album).join(" ");
  return candidates.filter(
    (candidate) =>
      artistMatches(wantArtist, matchTokens(candidate.artist)) &&
      matchTokens(candidate.title).join(" ") === wantTitle,
  );
}

/** Spelled-out numbers mapped to digits, so "Volume Two" matches "Volume 2". */
const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

/** Remove bracketed segments, e.g. "(Deluxe Edition)" or "[Remastered]". */
function stripBracketed(text: string): string {
  return text.replace(/[([{][^)\]}]*[)\]}]/g, " ");
}

/**
 * Tokenise a title or artist for matching: drop bracketed segments, fold "&" to
 * "and", normalise (case, accents, edition noise), then map number words to
 * digits.
 */
function matchTokens(text: string): string[] {
  const cleaned = stripBracketed(text).replace(/&/g, " and ");
  return normalise(cleaned)
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => NUMBER_WORDS[token] ?? token);
}

/** True when either artist's tokens are a subset of the other's (catches prefixes). */
function artistMatches(want: readonly string[], candidate: readonly string[]): boolean {
  if (want.length === 0 || candidate.length === 0) {
    return false;
  }
  const wantSet = new Set(want);
  const candidateSet = new Set(candidate);
  return (
    want.every((token) => candidateSet.has(token)) ||
    candidate.every((token) => wantSet.has(token))
  );
}

/**
 * Choose which version of an album to use, per the given preference.
 *
 * `highest-quality` prefers higher bit depth then sampling rate; `oldest` and
 * `newest` compare release dates, with a known date always beating an unknown
 * one. Ties keep the earliest (most relevant) version, so the result is stable.
 * Returns undefined only for an empty list.
 */
export function selectAlbumVersion(
  versions: readonly Album[],
  preference: AlbumPreference,
): Album | undefined {
  if (versions.length === 0) {
    return undefined;
  }
  const compare =
    preference === "highest-quality"
      ? compareQuality
      : (a: Album, b: Album): number => compareByDate(a, b, preference === "oldest");
  let best = versions[0]!;
  for (let i = 1; i < versions.length; i += 1) {
    if (compare(versions[i]!, best) > 0) {
      best = versions[i]!;
    }
  }
  return best;
}

/** Higher bit depth wins, then higher sampling rate. */
function compareQuality(a: Album, b: Album): number {
  return (
    (a.bitDepth ?? 0) - (b.bitDepth ?? 0) ||
    (a.samplingRate ?? 0) - (b.samplingRate ?? 0)
  );
}

/**
 * Compare two albums by release date. An album with a known date is always
 * preferred over one without; `wantOldest` selects the earlier or later date.
 */
function compareByDate(a: Album, b: Album, wantOldest: boolean): number {
  const da = a.releaseDate;
  const db = b.releaseDate;
  if (da === undefined && db === undefined) return 0;
  if (da === undefined) return -1;
  if (db === undefined) return 1;
  if (da === db) return 0;
  const aIsEarlier = da < db;
  return wantOldest ? (aIsEarlier ? 1 : -1) : aIsEarlier ? -1 : 1;
}

/** The tracks of a single album, in album order, each marked if the filter excludes it. */
export interface AlbumTracks {
  albumId: string;
  tracks: FilteredTrack[];
}

/** The outcome of fetching several albums' tracks: what came back, and what failed. */
export interface FetchAlbumTracksResult {
  /** Fetched albums with their tracks, in request order. */
  fetched: AlbumTracks[];
  /**
   * Ids of albums whose track list could not be fetched (e.g. Qobuz returned a
   * 404 for the id, or a transient error). Reported rather than fatal so one bad
   * album does not sink the whole operation.
   */
  failedAlbumIds: string[];
}

/**
 * Fetch each album's tracks, returning the tracks per album (in request order,
 * each marked with any exclusion from `filter`, then from `picker` -- consulted
 * in request order, and updated so a retry can carry the run on) alongside the
 * ids of any album that could not be fetched.
 *
 * Deliberately does no writing and no cross-album de-duplication: the caller
 * assembles the final ordered track list once *every* album has been fetched, so
 * a single unreachable album (a stale id, or a transient Qobuz error) never
 * forces a partial write in the wrong order. Each album is fetched at most once.
 */
export async function fetchAlbumTracks(
  client: AlbumTracksClient,
  albumIds: readonly string[],
  filter: TrackFilter = NO_FILTER,
  picker?: SongPicker,
): Promise<FetchAlbumTracksResult> {
  // Fetch each unique album once, in request order, through a bounded pool. The
  // pool keeps a large list fast without holding a single web request open long
  // enough for the browser to abort the fetch; ordering the unique ids up front
  // and reassembling in that order keeps the result deterministic.
  const uniqueAlbumIds: string[] = [];
  const seen = new Set<string>();
  for (const albumId of albumIds) {
    if (!seen.has(albumId)) {
      seen.add(albumId);
      uniqueAlbumIds.push(albumId);
    }
  }

  type Outcome = AlbumTracks | { albumId: string; failed: true };
  const outcomes = await mapWithConcurrency<string, Outcome>(
    uniqueAlbumIds,
    DEFAULT_CONCURRENCY,
    async (albumId) => {
      try {
        const tracks = await client.getAlbumTracks(albumId);
        return { albumId, tracks: applyTrackFilter(tracks, filter) };
      } catch {
        return { albumId, failed: true };
      }
    },
  );

  const fetched: AlbumTracks[] = [];
  const failedAlbumIds: string[] = [];
  for (const outcome of outcomes) {
    if ("failed" in outcome) {
      failedAlbumIds.push(outcome.albumId);
    } else {
      fetched.push(
        picker === undefined ? outcome : { ...outcome, tracks: pickTracks(outcome.tracks, picker) },
      );
    }
  }
  return { fetched, failedAlbumIds };
}

/**
 * Mark the tracks the picker excludes (favourites, later copies of a song),
 * telling it what was kept and skipped. Tracks the filter already excluded
 * are left as they are.
 */
function pickTracks(tracks: readonly FilteredTrack[], picker: SongPicker): FilteredTrack[] {
  return tracks.map((entry) => {
    if (entry.exclusion !== undefined) {
      return entry;
    }
    const exclusion = picker.exclusion(entry.track);
    if (exclusion === undefined) {
      picker.take(entry.track);
      return entry;
    }
    picker.skip(entry.track);
    return { track: entry.track, exclusion };
  });
}

/** The full surface {@link buildPlaylistFromAlbums} depends on. */
export type AlbumPlaylistBuilderClient = AlbumResolverClient &
  AlbumTracksClient &
  PlaylistWriterClient &
  FavouriteTracksClient;

export interface BuildAlbumPlaylistOptions extends SongPickerOptions {
  /** Default `as-listed`. */
  order?: AlbumOrder;
  /** Trim to at most about this many minutes, from the end of the list. */
  fitMinutes?: number;
  /** Random source for `shuffle`; default `Math.random`. */
  random?: () => number;
  /** Artist/album entries to include. */
  entries: (AlbumEntry | AlbumLinkEntry)[];
  /** Name for the new playlist. */
  playlistName: string;
  /** Which version to pick when an album has several (default highest-quality). */
  preference?: AlbumPreference;
  /** Releases and tracks to leave out. */
  filter?: TrackFilter;
  /** Optional playlist description. */
  description?: string;
  /** Whether the playlist is public (default false). */
  isPublic?: boolean;
}

/** A resolved album (the chosen version) and how many of its tracks were added. */
export interface ResolvedAlbumSummary {
  query: string;
  album: Album;
  trackCount: number;
  /** Tracks of the chosen version that the filter or the picker left out. */
  excludedCount: number;
}

export interface BuildAlbumPlaylistResult {
  playlist: Playlist;
  resolvedAlbums: ResolvedAlbumSummary[];
  unresolvedAlbums: string[];
  /** Entries whose every release was excluded by the filter's album terms. */
  excludedAlbums: string[];
  /** Entries whose chosen version's tracks could not be fetched from Qobuz. */
  failedAlbums: string[];
  trackCount: number;
  /** Total length of the tracks written, in seconds (unknown ones as the average). */
  durationSeconds: number;
  /** Tracks dropped to fit the length asked for (0 without one). */
  droppedToFit: number;
}

/**
 * Resolve albums, pick one version each (per `preference`), then create and
 * fill a new playlist with their tracks.
 *
 * @throws {Error} if no album entries are given.
 */
export async function buildPlaylistFromAlbums(
  client: AlbumPlaylistBuilderClient,
  options: BuildAlbumPlaylistOptions,
): Promise<BuildAlbumPlaylistResult> {
  if (options.entries.length === 0) {
    throw new Error("At least one album is required");
  }
  const resolved = await resolveAlbumVersions(client, {
    entries: options.entries,
    ...(options.filter !== undefined && { filter: options.filter }),
  });
  return writeAlbumPlaylist(client, resolved, options);
}

/**
 * Pick one version of each resolved album (per `preference`), gather the
 * chosen versions' tracks, and create and fill a new playlist with them: the
 * write half of {@link buildPlaylistFromAlbums}, shared with the discography
 * mode (see ./discography.ts).
 */
export async function writeAlbumPlaylist(
  client: AlbumTracksClient & PlaylistWriterClient & FavouriteTracksClient,
  resolution: ResolveAlbumsResult,
  options: Omit<BuildAlbumPlaylistOptions, "entries">,
): Promise<BuildAlbumPlaylistResult> {
  const preference = options.preference ?? DEFAULT_ALBUM_PREFERENCE;
  const filter = options.filter ?? NO_FILTER;
  const picker = await createSongPicker(client, options);
  const { resolvedAlbums, unresolvedAlbums, excludedAlbums } = resolution;

  // Pick a version per album and gather its tracks. An album whose tracks fail
  // to fetch is reported rather than fatal, so one bad album does not sink the
  // whole playlist.
  const fetched: { query: string; album: Album; tracks: FilteredTrack[] }[] = [];
  const failedAlbums: string[] = [];
  for (const resolved of resolvedAlbums) {
    const album = selectAlbumVersion(resolved.versions, preference)!;
    let tracks: Track[];
    try {
      tracks = await client.getAlbumTracks(album.id);
    } catch {
      failedAlbums.push(resolved.query);
      continue;
    }
    fetched.push({
      query: resolved.query,
      album,
      tracks: pickTracks(applyTrackFilter(tracks, filter), picker),
    });
  }

  // De-duplicate across albums, trim the end of the list to fit, and order,
  // counting how many tracks each album contributed.
  const groups = uniqueGroups(
    fetched.map((entry) =>
      entry.tracks.filter((t) => t.exclusion === undefined).map((t) => t.track),
    ),
    (track) => track.id,
  );
  const shaped = shapePlaylist(groups, (track) => track.duration, {
    order: options.order ?? "as-listed",
    fit: "tail",
    ...(options.fitMinutes !== undefined && { fitMinutes: options.fitMinutes }),
    ...(options.random !== undefined && { random: options.random }),
  });
  const trackIds = shaped.ordered.map((track) => track.id);
  const summaries: ResolvedAlbumSummary[] = fetched.map((entry, index) => ({
    query: entry.query,
    album: entry.album,
    trackCount: shaped.kept[index]?.length ?? 0,
    excludedCount: entry.tracks.filter((t) => t.exclusion !== undefined).length,
  }));

  const playlist = await createPlaylistWithTracks(client, {
    name: options.playlistName,
    trackIds,
    ...(options.description !== undefined && { description: options.description }),
    isPublic: options.isPublic ?? false,
  });

  return {
    playlist,
    resolvedAlbums: summaries,
    unresolvedAlbums,
    excludedAlbums,
    failedAlbums,
    trackCount: trackIds.length,
    durationSeconds: shaped.seconds,
    droppedToFit: shaped.dropped.length,
  };
}
