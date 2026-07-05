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
    if (isRecord(item) && typeof item["id"] === "number" && typeof item["title"] === "string") {
      tracks.push({ id: item["id"], title: item["title"] });
    }
  }
  return tracks;
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
