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
import { isServiceName, SERVICES, type ServiceName } from "./names.js";

export { SERVICES, SERVICE_LABELS, isServiceName, type ServiceName } from "./names.js";

declare const kind: unique symbol;
/** A string that only the functions here make, distinct per kind of thing. */
type Id<Kind extends string> = string & { readonly [kind]: Kind };

export type TrackId = Id<"track">;
export type AlbumId = Id<"album">;
export type ArtistId = Id<"artist">;
export type PlaylistId = Id<"playlist">;
/** A playlist entry: one track's place in one playlist. */
export type EntryId = Id<"entry">;
export type UserId = Id<"user">;
export type AnyId = TrackId | AlbumId | ArtistId | PlaylistId | EntryId | UserId;

/** @throws {ServiceError} kind `bad-id` if the native id is empty. */
export function tagId<T extends AnyId>(service: ServiceName, native: string | number): T {
  const text = String(native);
  if (text.length === 0) {
    throw new ServiceError(service, "bad-id", `${labelOf(service)} gave an empty id`);
  }
  return `${service}:${text}` as T;
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

/**
 * An id as shown and as used in stored keys: Qobuz's own, as it always was, or
 * the whole id of any other service.
 */
export function shortId(id: AnyId): string {
  const parsed = parseId(String(id));
  return parsed?.service === "qobuz" ? parsed.native : String(id);
}

/** Service by service; within one, numbers by value and before text. */
export function compareIds(a: AnyId, b: AnyId): number {
  const [x, y] = [parts(a), parts(b)];
  if (x.service !== y.service) {
    return SERVICES.indexOf(x.service) - SERVICES.indexOf(y.service);
  }
  const [m, n] = [x.native, y.native].map((native) => (BARE_NUMBER.test(native) ? Number(native) : NaN)) as [
    number,
    number,
  ];
  if (Number.isNaN(m) !== Number.isNaN(n)) {
    return Number.isNaN(m) ? 1 : -1;
  }
  return Number.isNaN(m) ? (x.native < y.native ? -1 : x.native > y.native ? 1 : 0) : m - n;
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
  return parseId(value) === undefined ? undefined : (value as T);
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
