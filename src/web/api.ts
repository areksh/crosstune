/**
 * Shared API client for the frontend.
 *
 * Every call goes to the local server (never to Qobuz directly) and carries the
 * per-run nonce injected into the page, which the server requires. This is the
 * one place that knows the transport; views deal in typed requests/responses.
 */

export interface Artist {
  id: number;
  name: string;
}

export interface Track {
  id: number;
  title: string;
  version?: string;
  discNumber?: number;
  artist?: string;
  album?: string;
  albumId?: string;
  isrc?: string;
  playlistTrackId?: number;
  bitDepth?: number;
  samplingRate?: number;
  releaseDate?: string;
  /** Album cover URL on Qobuz's image server; loaded only if artwork is on. */
  image?: string;
  /** Length in seconds, when known. */
  duration?: number;
}

/** Why the server's filter excluded a track (see src/features/track-filter.ts). */
export type Exclusion =
  | { kind: "track"; term: string }
  | { kind: "album"; term: string }
  | { kind: "artist"; term: string }
  | { kind: "disc"; disc: number };

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
  id: string;
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
  id: number;
  name: string;
  trackCount?: number;
}

const nonce =
  document.querySelector('meta[name="qobuz-nonce"]')?.getAttribute("content") ??
  "";

/** Call a local API route, returning the parsed JSON or throwing on error. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "X-Qobuz-Nonce": nonce };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
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
    headers: { "X-Qobuz-Nonce": nonce, "Content-Type": "application/json" },
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
