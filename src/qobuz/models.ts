/**
 * Lightweight domain models and defensive parsers for Qobuz JSON responses.
 *
 * The API returns large, loosely-typed objects; these parsers pull out just the
 * fields the tools need and tolerate missing or malformed entries rather than
 * trusting the shape.
 */

import { QobuzError } from "./errors.js";

export interface Artist {
  id: number;
  name: string;
}

export interface Track {
  id: number;
  title: string;
  /** Track artist (performer) name, when present. */
  artist?: string;
  /** International Standard Recording Code, when present. */
  isrc?: string;
  /** Album title the track appears on, when present. */
  album?: string;
  /** Album id, used to look up release dates. */
  albumId?: string;
  /** Id of this track *within a playlist*, needed to remove it from that playlist. */
  playlistTrackId?: number;
  /** Maximum bit depth (e.g. 16, 24), a quality signal. */
  bitDepth?: number;
  /** Maximum sampling rate in kHz (e.g. 44.1, 96), a quality signal. */
  samplingRate?: number;
  /** Whether the track is hi-res. */
  hires?: boolean;
  /** Original release date (YYYY-MM-DD) when available on the embedded album. */
  releaseDate?: string;
}

/** A page of tracks plus the total available, for paginated fetches. */
export interface TracksPage {
  tracks: Track[];
  total: number;
}

export interface Playlist {
  id: number;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function itemsOf(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const container = value[key];
  if (!isRecord(container) || !Array.isArray(container["items"])) {
    return [];
  }
  return container["items"];
}

/** Parse the `artists.items` list of an artist search response. */
export function parseArtists(response: unknown): Artist[] {
  const artists: Artist[] = [];
  for (const item of itemsOf(response, "artists")) {
    if (isRecord(item) && typeof item["id"] === "number" && typeof item["name"] === "string") {
      artists.push({ id: item["id"], name: item["name"] });
    }
  }
  return artists;
}

/** Parse the `tracks.items` list of a tracks container (e.g. artist/get?extra=tracks). */
export function parseTracks(response: unknown): Track[] {
  const tracks: Track[] = [];
  for (const item of itemsOf(response, "tracks")) {
    const track = parseTrack(item);
    if (track !== undefined) {
      tracks.push(track);
    }
  }
  return tracks;
}

/** Parse a tracks container into its tracks plus the total count (for pagination). */
export function parseTracksPage(response: unknown): TracksPage {
  const container =
    isRecord(response) && isRecord(response["tracks"]) ? response["tracks"] : {};
  const total = typeof container["total"] === "number" ? container["total"] : 0;
  return { tracks: parseTracks(response), total };
}

/** Parse a single track object, pulling artist, ISRC and album when present. */
function parseTrack(item: unknown): Track | undefined {
  if (!isRecord(item) || typeof item["id"] !== "number" || typeof item["title"] !== "string") {
    return undefined;
  }
  const track: Track = { id: item["id"], title: item["title"] };

  const performer = item["performer"];
  if (isRecord(performer) && typeof performer["name"] === "string") {
    track.artist = performer["name"];
  }
  if (typeof item["isrc"] === "string") {
    track.isrc = item["isrc"];
  }
  const album = item["album"];
  if (isRecord(album)) {
    if (typeof album["title"] === "string") {
      track.album = album["title"];
    }
    if (typeof album["id"] === "string") {
      track.albumId = album["id"];
    }
    const embeddedDate = releaseDateOf(album);
    if (embeddedDate !== undefined) {
      track.releaseDate = embeddedDate;
    }
  }
  if (typeof item["playlist_track_id"] === "number") {
    track.playlistTrackId = item["playlist_track_id"];
  }
  if (typeof item["maximum_bit_depth"] === "number") {
    track.bitDepth = item["maximum_bit_depth"];
  }
  if (typeof item["maximum_sampling_rate"] === "number") {
    track.samplingRate = item["maximum_sampling_rate"];
  }
  if (typeof item["hires"] === "boolean") {
    track.hires = item["hires"];
  }
  return track;
}

/** Read a release date (YYYY-MM-DD) from an album object, if present. */
function releaseDateOf(album: Record<string, unknown>): string | undefined {
  const original = album["release_date_original"];
  if (typeof original === "string" && original.length > 0) {
    return original.slice(0, 10);
  }
  const releasedAt = album["released_at"];
  if (typeof releasedAt === "number") {
    return new Date(releasedAt * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** Parse an album/get response for its original release date (YYYY-MM-DD). */
export function parseAlbumReleaseDate(response: unknown): string | undefined {
  return isRecord(response) ? releaseDateOf(response) : undefined;
}

/**
 * Parse a playlist object (e.g. from playlist/create).
 *
 * @throws {QobuzError} kind `api-response` if the response carries no numeric id.
 */
export function parsePlaylist(response: unknown): Playlist {
  if (!isRecord(response) || typeof response["id"] !== "number") {
    throw new QobuzError("api-response", "Playlist response has no id");
  }
  const name = typeof response["name"] === "string" ? response["name"] : "";
  return { id: response["id"], name };
}
