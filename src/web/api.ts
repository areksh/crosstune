/**
 * Shared API client for the frontend.
 *
 * Every call goes to the local server (never to Qobuz directly) and carries the
 * per-run nonce injected into the page, which the server requires. This is the
 * one place that knows the transport; views deal in typed requests/responses.
 */

import type { AlbumId, ArtistId, EntryId, PlaylistId, TrackId } from "../services/ids.js";
import { isWriteRequest } from "../ui/writes.js";
import { chosenService, type Choice } from "./service.js";

export interface Artist {
  id: ArtistId;
  name: string;
}

export interface Track {
  id: TrackId;
  title: string;
  version?: string;
  discNumber?: number;
  artist?: string;
  album?: string;
  albumId?: AlbumId;
  isrc?: string;
  playlistTrackId?: EntryId;
  bitDepth?: number;
  samplingRate?: number;
  releaseDate?: string;
  /** Album cover URL on Qobuz's image server; loaded only if artwork is on. */
  image?: string;
  /** Length in seconds, when known. */
  duration?: number;
}

/**
 * Why the server excluded a track: a filter, or a plan option (already a
 * favourite, or a later copy of a song) -- see src/features/track-filter.ts.
 */
export type Exclusion =
  | { kind: "track"; term: string }
  | { kind: "album"; term: string }
  | { kind: "artist"; term: string }
  | { kind: "disc"; disc: number }
  | { kind: "favourite" }
  | { kind: "repeat"; of: string };

/**
 * A track the filter excluded from an artist's top tracks, with `position`: its
 * index among the listed tracks (kept and excluded, most popular first).
 */
export interface ExcludedTrack {
  track: Track;
  exclusion: Exclusion;
  position: number;
}

/** The filter sent with playlist requests; the server validates it. */
export interface FilterInput {
  excludeTracks: string[];
  excludeAlbums: string[];
  excludeArtists: string[];
  discs?: string;
}

export interface Album {
  id: AlbumId;
  title: string;
  artist: string;
  version?: string;
  releaseDate?: string;
  bitDepth?: number;
  samplingRate?: number;
  hires?: boolean;
  trackCount?: number;
  /** Cover URL on Qobuz's image server; loaded only if artwork is on. */
  image?: string;
}

export interface Playlist {
  id: PlaylistId;
  name: string;
  trackCount?: number;
}

const nonce =
  document.querySelector('meta[name="crosstune-nonce"]')?.getAttribute("content") ??
  "";

/** What every request carries: the page's nonce, and the service it is on. */
function baseHeaders(on: Choice | undefined = chosenService()): Record<string, string> {
  const service = on;
  return { "X-Crosstune-Nonce": nonce, ...(service !== undefined && { "X-Music-Service": service }) };
}

/** Changes sent and not yet answered (see src/ui/writes.ts). */
let inFlight = 0;

/** How many changes are being written now: a reload would hide how they end. */
export function writesInFlight(): number {
  return inFlight;
}

/** Call a local API route, returning the parsed JSON or throwing on error. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  /** The service to work on, when it is not the one the page is on. */
  on?: Choice,
): Promise<T> {
  const headers = baseHeaders(on);
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const writing = isWriteRequest(method, path);
  if (writing) {
    inFlight += 1;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } finally {
    if (writing) {
      inFlight -= 1;
    }
  }
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      isRecord(data) && typeof data["error"] === "string"
        ? data["error"]
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

/**
 * Call a local API route that answers with a file (such as a zip), returning
 * its bytes and the filename from the attachment header; an error response is
 * JSON as usual and throws.
 */
export async function apiDownload(
  method: string,
  path: string,
  body: unknown,
  fallbackName: string,
): Promise<{ filename: string; blob: Blob }> {
  const response = await fetch(path, {
    method,
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => ({}));
    throw new Error(
      isRecord(data) && typeof data["error"] === "string"
        ? data["error"]
        : `HTTP ${response.status}`,
    );
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  return { filename, blob: await response.blob() };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
