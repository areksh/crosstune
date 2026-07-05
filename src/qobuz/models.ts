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
  if (isRecord(album) && typeof album["title"] === "string") {
    track.album = album["title"];
  }
  return track;
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
