/**
 * Ids that carry their service: `"<service>:<native id>"` (ADR-0010).
 *
 * The native id is opaque -- a Qobuz number, a TIDAL or Spotify string -- and
 * only its service's own folder takes it apart. Everything else compares ids
 * whole, so the same number on two services is never the same song. Ids are
 * made only here: by a service's adapter ({@link tagId}) or by reading one from
 * outside ({@link readId}, {@link readAlbumId}), which also accept the bare
 * Qobuz ids that older files, links and commands hold.
 */

import { labelOf, ServiceError } from "./errors.js";
import { isServiceName, type ServiceName } from "./names.js";

export { SERVICES, SERVICE_LABELS, isServiceName, type ServiceName } from "./names.js";

// Aliases for now: they become distinct string types once every use is named
// (the multi-service phase 1 plan, task 4).
export type TrackId = number;
export type AlbumId = string;
export type ArtistId = number;
export type PlaylistId = number;
/** A playlist entry: one track's place in one playlist. */
export type EntryId = number;
export type UserId = number;
export type AnyId = TrackId | AlbumId | ArtistId | PlaylistId | EntryId | UserId;

/** @throws {ServiceError} kind `bad-id` if the native id is empty. */
export function tagId<T extends AnyId>(service: ServiceName, native: string | number): T {
  const text = String(native);
  if (text.length === 0) {
    throw new ServiceError(service, "bad-id", `${labelOf(service)} gave an empty id`);
  }
  return `${service}:${text}` as unknown as T;
}

/** An id's parts, or undefined when it is not one. */
export function parseId(id: string): { service: ServiceName; native: string } | undefined {
  const colon = id.indexOf(":");
  const service = id.slice(0, Math.max(colon, 0));
  const native = id.slice(colon + 1);
  return colon > 0 && isServiceName(service) && native.length > 0 ? { service, native } : undefined;
}

function parts(id: AnyId): { service: ServiceName; native: string } {
  const parsed = parseId(String(id));
  if (parsed === undefined) {
    throw new ServiceError(undefined, "bad-id", `not an id: ${JSON.stringify(id)}`);
  }
  return parsed;
}

/** @throws {ServiceError} kind `bad-id` if it is not an id. */
export function serviceOf(id: AnyId): ServiceName {
  return parts(id).service;
}

/**
 * The id as `service` knows it.
 *
 * @throws {ServiceError} kind `bad-id` if it is not an id, or is another service's.
 */
export function nativeOf(service: ServiceName, id: AnyId): string {
  const parsed = parts(id);
  if (parsed.service !== service) {
    throw new ServiceError(service, "bad-id", `${String(id)} is not on ${labelOf(service)}`);
  }
  return parsed.native;
}

const BARE_NUMBER = /^[1-9]\d{0,15}$/;
const BARE_ALBUM = /^[a-z0-9]+$/i;

/** An id from outside: a tagged one, or a bare number, which is Qobuz's. */
export function readId<T extends AnyId>(value: unknown): T | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? tagId<T>("qobuz", value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (BARE_NUMBER.test(value)) {
    return Number.isSafeInteger(Number(value)) ? tagId<T>("qobuz", value) : undefined;
  }
  return parseId(value) === undefined ? undefined : (value as unknown as T);
}

/** An album id from outside: a tagged one, or a bare one, which is Qobuz's. */
export function readAlbumId(value: unknown): AlbumId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return BARE_ALBUM.test(value)
    ? tagId<AlbumId>("qobuz", value)
    : parseId(value) === undefined
      ? undefined
      : (value as AlbumId);
}
