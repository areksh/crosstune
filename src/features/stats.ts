/**
 * Library statistics: what a track list is made of.
 *
 * The source is your favourite tracks, one playlist, or everything (favourites
 * plus all of your playlists, each track once). {@link computeStats} is a pure
 * aggregation over the tracks: how many there are, by how many artists, how
 * long they run, how they split by quality and by decade, and which artists and
 * albums account for most of them.
 *
 * Each decade and top-artist bucket carries its track ids and a suggested
 * playlist name, so a caller can *commit* one to a new playlist ("Favourites:
 * 1990s") with the playlist writers in `playlist-from-artists.ts`; computing
 * the stats is the *resolve* step and writes nothing.
 */

import type { PlaylistId, TrackId } from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";

/** Where the tracks come from. */
export type StatsSource =
  | { type: "favourites" }
  | { type: "playlist"; playlistId: PlaylistId }
  | { type: "everything" };

/** The client surface needed to gather a source's tracks. */
export interface StatsClient {
  getFavoriteTracks(): Promise<Track[]>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
  getUserPlaylists(): Promise<Playlist[]>;
}

/** A source's tracks, with the name its buckets' playlists are named after. */
export interface Library {
  kind: StatsSource["type"];
  /** "Favourites", the playlist's name, or "Library". */
  label: string;
  tracks: Track[];
}

/** A track's quality class. */
export type QualityClass = "hires" | "cd" | "unknown";

/** A slice of the library that can become a playlist. */
export interface Bucket {
  /** Stable key: "1990s" or "unknown" for a decade; the artist's name key. */
  key: string;
  /** What to show: "1990s", "Unknown", or the artist's name. */
  label: string;
  count: number;
  trackIds: TrackId[];
  /** E.g. "Favourites: 1990s". */
  suggestedName: string;
}

export interface AlbumCount {
  title: string;
  artist: string;
  count: number;
}

export interface LibraryStats {
  label: string;
  trackCount: number;
  /** Distinct artists (tracks without an artist are not counted). */
  artistCount: number;
  /** Total length in seconds of the tracks whose duration is known. */
  totalDuration: number;
  quality: Record<QualityClass, number>;
  /**
   * Tracks by release decade, oldest first, with every decade between the
   * oldest and newest listed (empty ones too); tracks without a release date
   * are in a last "Unknown" bucket, present only when there are any.
   */
  decades: Bucket[];
  /** The artists with the most tracks, most first (at most {@link TOP_COUNT}). */
  topArtists: Bucket[];
  /** The share (0 to 1) of the tracks that are by the top artists. */
  topArtistsShare: number;
  /** The albums with the most tracks, most first (at most {@link TOP_COUNT}). */
  topAlbums: AlbumCount[];
  /** E.g. "1,240 favourite tracks by 312 artists. 86 hours of music." */
  headline: string;
}

/** How many top artists and albums are listed. */
export const TOP_COUNT = 10;

/** The key of the decade bucket for tracks without a release date. */
export const UNKNOWN_DECADE = "unknown";

/**
 * Gather a source's tracks. "Everything" is your favourites followed by each of
 * your playlists, keeping the first copy of each track id.
 */
export async function collectLibrary(
  client: StatsClient,
  source: StatsSource,
): Promise<Library> {
  switch (source.type) {
    case "favourites":
      return { kind: "favourites", label: "Favourites", tracks: await client.getFavoriteTracks() };
    case "playlist": {
      const [playlists, tracks] = await Promise.all([
        client.getUserPlaylists(),
        client.getPlaylistTracks(source.playlistId),
      ]);
      const name = playlists.find((p) => p.id === source.playlistId)?.name;
      return { kind: "playlist", label: name ?? `Playlist ${source.playlistId}`, tracks };
    }
    case "everything": {
      const [favourites, playlists] = await Promise.all([
        client.getFavoriteTracks(),
        client.getUserPlaylists(),
      ]);
      const lists = await mapWithConcurrency(playlists, DEFAULT_CONCURRENCY, (playlist) =>
        client.getPlaylistTracks(playlist.id),
      );
      const seen = new Set<number>();
      const tracks = [favourites, ...lists].flat().filter((track) => {
        if (seen.has(track.id)) {
          return false;
        }
        seen.add(track.id);
        return true;
      });
      return { kind: "everything", label: "Library", tracks };
    }
  }
}

/**
 * The quality class of a track: hi-res above 16 bits or 48 kHz, CD quality
 * otherwise, unknown when neither is known (unless Qobuz flags it hi-res).
 */
export function qualityOf(track: Pick<Track, "bitDepth" | "samplingRate" | "hires">): QualityClass {
  const { bitDepth, samplingRate } = track;
  if ((bitDepth ?? 0) > 16 || (samplingRate ?? 0) > 48) {
    return "hires";
  }
  if (bitDepth !== undefined || samplingRate !== undefined) {
    return "cd";
  }
  return track.hires === true ? "hires" : "unknown";
}

/** The decade key of a release date ("1994-01-01" -> "1990s"), or "unknown". */
export function decadeOf(releaseDate: string | undefined): string {
  const year = Number(releaseDate?.slice(0, 4));
  if (releaseDate === undefined || !Number.isInteger(year) || year < 1000) {
    return UNKNOWN_DECADE;
  }
  return `${Math.floor(year / 10) * 10}s`;
}

/** Aggregate a library's tracks into its stats (pure). */
export function computeStats(library: Library): LibraryStats {
  const { tracks, label } = library;
  const trackCount = tracks.length;
  const name = (bucketLabel: string): string => `${label}: ${bucketLabel}`;

  const quality: Record<QualityClass, number> = { hires: 0, cd: 0, unknown: 0 };
  let totalDuration = 0;
  for (const track of tracks) {
    quality[qualityOf(track)] += 1;
    totalDuration += track.duration ?? 0;
  }

  const decades = decadeBuckets(tracks, name);

  // Artists, keyed by their name ignoring case and surrounding space.
  const byArtist = new Map<string, { label: string; trackIds: TrackId[] }>();
  for (const track of tracks) {
    const artist = track.artist?.trim();
    if (artist === undefined || artist.length === 0) {
      continue;
    }
    const key = artist.toLowerCase();
    const entry = byArtist.get(key);
    if (entry === undefined) {
      byArtist.set(key, { label: artist, trackIds: [track.id] });
    } else {
      entry.trackIds.push(track.id);
    }
  }
  const topArtists = [...byArtist]
    .map(([key, { label: artistName, trackIds }]) => ({
      key,
      label: artistName,
      count: trackIds.length,
      trackIds,
      suggestedName: name(artistName),
    }))
    .sort(byCountThenLabel)
    .slice(0, TOP_COUNT);
  const topTotal = topArtists.reduce((sum, artist) => sum + artist.count, 0);

  const byAlbum = new Map<string, AlbumCount>();
  for (const track of tracks) {
    if (track.album === undefined) {
      continue;
    }
    // By title and artist, not album id: editions of one album (each its own
    // id) count as one, as artists are grouped by name.
    const title = tidy(track.album);
    const artist = tidy(track.artist ?? "");
    const key = `${title.toLowerCase()}\u0000${artist.toLowerCase()}`;
    const entry = byAlbum.get(key);
    if (entry === undefined) {
      byAlbum.set(key, { title, artist, count: 1 });
    } else {
      entry.count += 1;
    }
  }
  const topAlbums = [...byAlbum.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, TOP_COUNT);

  const stats: Omit<LibraryStats, "headline"> = {
    label,
    trackCount,
    artistCount: byArtist.size,
    totalDuration,
    quality,
    decades,
    topArtists,
    topArtistsShare: trackCount === 0 ? 0 : topTotal / trackCount,
    topAlbums,
  };
  return { ...stats, headline: headline(library, stats) };
}

function byCountThenLabel(a: Bucket, b: Bucket): number {
  return b.count - a.count || a.label.localeCompare(b.label);
}

/** Decade buckets, oldest first and gap-free, then the unknown bucket if any. */
function decadeBuckets(tracks: readonly Track[], name: (label: string) => string): Bucket[] {
  const byDecade = new Map<string, number[]>();
  for (const track of tracks) {
    const key = decadeOf(track.releaseDate);
    const ids = byDecade.get(key);
    if (ids === undefined) {
      byDecade.set(key, [track.id]);
    } else {
      ids.push(track.id);
    }
  }
  const years = [...byDecade.keys()]
    .filter((key) => key !== UNKNOWN_DECADE)
    .map((key) => Number(key.slice(0, -1)));
  const buckets: Bucket[] = [];
  if (years.length > 0) {
    for (let year = Math.min(...years); year <= Math.max(...years); year += 10) {
      const key = `${year}s`;
      const trackIds = byDecade.get(key) ?? [];
      buckets.push({ key, label: key, count: trackIds.length, trackIds, suggestedName: name(key) });
    }
  }
  const unknown = byDecade.get(UNKNOWN_DECADE);
  if (unknown !== undefined) {
    buckets.push({
      key: UNKNOWN_DECADE,
      label: "Unknown",
      count: unknown.length,
      trackIds: unknown,
      suggestedName: name("unknown year"),
    });
  }
  return buckets;
}

/** "1,240 favourite tracks by 312 artists. 86 hours of music." */
function headline(library: Library, stats: Omit<LibraryStats, "headline">): string {
  const count = number(stats.trackCount);
  const tracks =
    library.kind === "favourites"
      ? `${count} favourite ${noun(stats.trackCount, "track")}`
      : library.kind === "playlist"
        ? `${count} ${noun(stats.trackCount, "track")} in ${library.label}`
        : `${count} ${noun(stats.trackCount, "track")} in your library`;
  const artists = `${number(stats.artistCount)} ${noun(stats.artistCount, "artist")}`;
  const sentence = stats.artistCount > 0 ? `${tracks} by ${artists}.` : `${tracks}.`;
  return stats.totalDuration > 0
    ? `${sentence} ${listeningTime(stats.totalDuration)} of music.`
    : sentence;
}

/**
 * A rough listening time: whole hours from an hour up ("86 hours"), else whole
 * minutes ("42 minutes"), with "Under a minute" below that.
 */
export function listeningTime(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${number(hours)} ${noun(hours, "hour")}`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes >= 1 ? `${minutes} ${noun(minutes, "minute")}` : "Under a minute";
}

/** The decade bucket for a key such as "1990s" or "unknown", if present. */
export function findDecade(stats: LibraryStats, key: string): Bucket | undefined {
  return stats.decades.find((bucket) => bucket.key === key.toLowerCase());
}

/** Render the stats as a human-readable report (for the CLI). */
export function formatStatsReport(stats: LibraryStats): string {
  const percent = (count: number): string =>
    stats.trackCount === 0 ? "" : `  (${Math.round((count / stats.trackCount) * 100)}%)`;
  const lines = [stats.headline, "", "Quality"];
  lines.push(`  Hi-res      ${pad(stats.quality.hires)}${percent(stats.quality.hires)}`);
  lines.push(`  CD quality  ${pad(stats.quality.cd)}${percent(stats.quality.cd)}`);
  if (stats.quality.unknown > 0) {
    lines.push(`  Unknown     ${pad(stats.quality.unknown)}${percent(stats.quality.unknown)}`);
  }
  if (stats.decades.length > 0) {
    lines.push("", "By decade");
    for (const decade of stats.decades) {
      lines.push(`  ${decade.label.padEnd(8)}  ${pad(decade.count)}${percent(decade.count)}`);
    }
  }
  if (stats.topArtists.length > 0) {
    const share = Math.round(stats.topArtistsShare * 100);
    lines.push("", `Most-saved artists (${share}% of the tracks)`);
    stats.topArtists.forEach((artist, i) => {
      lines.push(`  ${String(i + 1).padStart(2)}. ${artist.label}: ${artist.count}`);
    });
  }
  if (stats.topAlbums.length > 0) {
    lines.push("", "Top albums");
    stats.topAlbums.forEach((album, i) => {
      const by = album.artist.length > 0 ? ` - ${album.artist}` : "";
      lines.push(`  ${String(i + 1).padStart(2)}. ${album.title}${by}: ${album.count}`);
    });
  }
  return lines.join("\n");
}

function pad(count: number): string {
  return number(count).padStart(6);
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function noun(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** Trim and collapse whitespace, as Qobuz titles can carry stray spaces. */
function tidy(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
