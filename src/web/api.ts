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
  artist?: string;
  album?: string;
  albumId?: string;
  isrc?: string;
  playlistTrackId?: number;
  bitDepth?: number;
  samplingRate?: number;
  releaseDate?: string;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
