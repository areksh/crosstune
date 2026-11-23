/**
 * Spotify's ids and URIs.
 *
 * A song's native id is Spotify's own. An episode's and a local file's keep
 * their kind (`episode:<id>`, `local:<artist>:<album>:<title>:<seconds>`), so
 * their tagged id is also their Spotify URI.
 */

import { ServiceError } from "../errors.js";
import { nativeOf, type AlbumId, type ArtistId, type PlaylistId, type TrackId } from "../ids.js";

const ID = "[A-Za-z0-9]+";
const PLAIN = new RegExp(`^${ID}$`);
const TRACK = new RegExp(`^(${ID}|episode:${ID}|local:.+)$`);

function checked(id: AlbumId | ArtistId | PlaylistId | TrackId, form: RegExp): string {
  const native = nativeOf("spotify", id);
  if (!form.test(native)) {
    throw new ServiceError("spotify", "bad-id", `not a Spotify id: ${String(id)}`);
  }
  return native;
}

/** An id that goes into a path or URI. @throws {ServiceError} kind `bad-id`. */
export function plainId(id: AlbumId | ArtistId | PlaylistId): string {
  return checked(id, PLAIN);
}

/** The URI of a song, episode or local file. @throws {ServiceError} kind `bad-id`. */
export function uriOf(id: TrackId): string {
  const native = checked(id, TRACK);
  return native.includes(":") ? `spotify:${native}` : `spotify:track:${native}`;
}

/** The native id behind a song's, episode's or local file's URI. */
export function nativeOfUri(uri: unknown): string | undefined {
  const match = typeof uri === "string" ? /^spotify:(?:track:(.+)|((?:episode|local):.+))$/.exec(uri) : null;
  return match === null ? undefined : (match[1] ?? match[2]);
}

export function isLocal(id: TrackId): boolean {
  return nativeOf("spotify", id).startsWith("local:");
}

/** A song of the catalogue: neither an episode nor a local file. */
export function isSong(id: TrackId): boolean {
  return !nativeOf("spotify", id).includes(":");
}
