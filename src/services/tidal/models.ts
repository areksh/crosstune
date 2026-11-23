/**
 * TIDAL's JSON:API documents read into the neutral model (../model.ts).
 *
 * A resource's fields are read defensively: one that is missing or malformed
 * is left out. A *list* is not: an answer whose list cannot be read is an
 * error, as reading it as empty or shorter would say that songs are gone. An
 * item of the user's own lists that TIDAL says nothing about (not available in
 * their country, say) keeps its place under a stand-in title.
 */

import { ServiceError } from "../errors.js";
import { nativeOf, tagId } from "../ids.js";
import {
  classifyRelease,
  type Album,
  type AlbumId,
  type Artist,
  type ArtistId,
  type EntryId,
  type Playlist,
  type PlaylistId,
  type QualityTier,
  type Release,
  type Track,
  type TrackId,
  type UserId,
} from "../model.js";
import type { Account } from "../service.js";

/**
 * What TIDAL's media tags say of the sound. UNVERIFIED: the document lists no
 * values, and these two are only its examples. Any other tag says nothing, so
 * that a tag TIDAL adds is never taken for a quality.
 */
const TIER_OF_TAG: Record<string, QualityTier> = {
  HIRES_LOSSLESS: "hires",
  LOSSLESS: "lossless",
};
const TIERS: readonly QualityTier[] = ["hires", "lossless", "lossy"];

/** Covers are shown at about this size (pixels). */
const COVER_SIZE = 230;

/** A resource as a list or a relationship names it. */
export interface ResourceRef {
  type: string;
  id: string;
}

export interface Identifier extends ResourceRef {
  /** What the list says of it (itemId, addedAt, ...). */
  meta: Record<string, unknown>;
}

/** The resources a document includes, by {@link keyOf}. */
export type Index = ReadonlyMap<string, unknown>;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const momentOf = (value: unknown): string | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;

const dateOf = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;

const keyOf = (ref: ResourceRef): string => `${ref.type}:${ref.id}`;

const refIn = (value: unknown): ResourceRef | undefined =>
  isRecord(value) && textOf(value["type"]) !== undefined && textOf(value["id"]) !== undefined
    ? { type: value["type"] as string, id: value["id"] as string }
    : undefined;

const attributesOf = (resource: unknown): Fields => {
  const attributes = isRecord(resource) ? resource["attributes"] : undefined;
  return isRecord(attributes) ? attributes : {};
};

/** A relationship as it comes inside a resource: `{ data, links }`. */
export function relationshipOf(resource: unknown, name: string): unknown {
  const relationships = isRecord(resource) ? resource["relationships"] : undefined;
  return isRecord(relationships) ? relationships[name] : undefined;
}

/** What a resource is related to; empty when the answer does not say. */
export function relatedOf(resource: unknown, name: string): Identifier[] {
  const relationship = relationshipOf(resource, name);
  const data = isRecord(relationship) ? relationship["data"] : undefined;
  return (Array.isArray(data) ? data : [data]).flatMap((item: unknown) => {
    const ref = refIn(item);
    return ref === undefined ? [] : [{ ...ref, meta: metaOf(item) }];
  });
}

function metaOf(item: unknown): Fields {
  const meta = isRecord(item) ? item["meta"] : undefined;
  return isRecord(meta) ? meta : {};
}

export function indexIncluded(document: unknown): Index {
  const included = isRecord(document) ? document["included"] : undefined;
  const index = new Map<string, unknown>();
  for (const resource of Array.isArray(included) ? included : []) {
    const ref = refIn(resource);
    if (ref !== undefined) {
      index.set(keyOf(ref), resource);
    }
  }
  return index;
}

function unreadable(what: string): ServiceError {
  return new ServiceError("tidal", "api-response", `TIDAL's answer could not be read (${what})`);
}

/**
 * The resources a list document names.
 *
 * @throws {ServiceError} if any part of the list cannot be read.
 */
export function identifiersOf(document: unknown): Identifier[] {
  return resourcesOf(document).map((item) => {
    const ref = refIn(item);
    if (ref === undefined) {
      throw unreadable("an item without an id");
    }
    return { ...ref, meta: metaOf(item) };
  });
}

/**
 * The resources a document is about, whole.
 *
 * @throws {ServiceError} if it has no list of them.
 */
export function resourcesOf(document: unknown): unknown[] {
  const data = isRecord(document) ? document["data"] : undefined;
  if (!Array.isArray(data)) {
    throw unreadable("no list");
  }
  return data;
}

/** The one resource a document is about. */
export function resourceOf(document: unknown): unknown {
  const data = isRecord(document) ? document["data"] : undefined;
  return isRecord(data) ? data : undefined;
}

/** Seconds in an ISO 8601 duration ("PT3M5S"), to the nearest. */
export function parseDuration(value: unknown): number | undefined {
  const parts =
    typeof value === "string"
      ? /^P(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value)
      : null;
  if (parts === null || value === "P") {
    return undefined;
  }
  const [days, hours, minutes, seconds] = parts.slice(1).map((part) => Number(part ?? 0));
  return Math.round(((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!);
}

/**
 * The id of something a playlist holds. TIDAL's tracks and videos can share an
 * id, so anything but a track carries its type; so does a track whose own id
 * could be taken for that.
 */
export function itemId(ref: ResourceRef): TrackId {
  const bare = ref.type === "tracks" && !TYPED.test(ref.id);
  return tagId<TrackId>("tidal", bare ? ref.id : keyOf(ref));
}

/**
 * What {@link itemId} made the id of.
 *
 * @throws {ServiceError} kind `bad-id` if it is another service's.
 */
export function refOf(id: TrackId): ResourceRef {
  const native = nativeOf("tidal", id);
  const typed = TYPED.exec(native);
  return typed === null ? { type: "tracks", id: native } : { type: typed[1]!, id: typed[2]! };
}

const TYPED = /^([a-z][A-Za-z]*):(.+)$/s;

function urlOf(attributes: Fields): string | undefined {
  const links = attributes["externalLinks"];
  for (const link of Array.isArray(links) ? links : []) {
    const href = isRecord(link) ? link["href"] : undefined;
    if (metaOf(link)["type"] === "TIDAL_SHARING" && isHttps(href)) {
      return href;
    }
  }
  return undefined;
}

const isHttps = (value: unknown): value is string => typeof value === "string" && value.startsWith("https://");

function tierOf(attributes: Fields): QualityTier | undefined {
  const tags = attributes["mediaTags"];
  const named = (Array.isArray(tags) ? tags : []).flatMap((tag: unknown) =>
    typeof tag === "string" ? tag.split(",").map((part) => TIER_OF_TAG[part.trim()]) : [],
  );
  return TIERS.find((tier) => named.includes(tier));
}

/** The cover: the smallest file that is large enough, else the largest. */
function coverOf(resource: unknown, index: Index): string | undefined {
  for (const ref of relatedOf(resource, "coverArt")) {
    const { mediaType, files } = attributesOf(index.get(keyOf(ref)));
    if (mediaType === "VIDEO" || !Array.isArray(files)) {
      continue;
    }
    const covers = files
      .flatMap((file: unknown) => {
        const href = isRecord(file) ? file["href"] : undefined;
        return isHttps(href) ? [{ href, width: countOf(metaOf(file)["width"]) ?? 0 }] : [];
      })
      .sort((a, b) => a.width - b.width);
    const cover = covers.find(({ width }) => width >= COVER_SIZE) ?? covers[covers.length - 1];
    if (cover !== undefined) {
      return cover.href;
    }
  }
  return undefined;
}

/** The main artist, and the names of the others credited with them. */
function artistsOf(resource: unknown, index: Index): { id?: ArtistId; name?: string; others: string[] } {
  const [main, ...others] = relatedOf(resource, "artists").map((ref) => ({
    id: tagId<ArtistId>("tidal", ref.id),
    name: textOf(attributesOf(index.get(keyOf(ref)))["name"]),
  }));
  return {
    ...(main !== undefined && { id: main.id }),
    ...(main?.name !== undefined && { name: main.name }),
    others: others.flatMap(({ name }) => (name === undefined ? [] : [name])),
  };
}

/** A track or a video; undefined when it has no id or title. */
export function parseTrack(resource: unknown, index: Index): Track | undefined {
  const ref = refIn(resource);
  const attributes = attributesOf(resource);
  const title = textOf(attributes["title"]);
  if (ref === undefined || title === undefined) {
    return undefined;
  }
  const isTrack = ref.type === "tracks";
  const track: Track = { id: itemId(ref), title };

  const version = textOf(attributes["version"]);
  if (version !== undefined) {
    track.version = version;
  }
  const artists = artistsOf(resource, index);
  if (artists.name !== undefined) {
    track.artist = artists.name;
  }
  if (artists.id !== undefined) {
    track.artistId = artists.id;
  }
  if (artists.others.length > 0) {
    track.jointArtists = artists.others;
  }
  // A video's code is not a recording's, and a video is never matched.
  const isrc = isTrack ? textOf(attributes["isrc"]) : undefined;
  if (isrc !== undefined) {
    track.isrc = isrc;
  }
  const [albumRef] = relatedOf(resource, "albums");
  const album = albumRef === undefined ? undefined : index.get(keyOf(albumRef));
  const albumTitle = textOf(attributesOf(album)["title"]);
  if (albumTitle !== undefined) {
    track.album = albumTitle;
  }
  if (albumRef !== undefined) {
    track.albumId = tagId<AlbumId>("tidal", albumRef.id);
  }
  const released = dateOf(attributesOf(album)["releaseDate"]) ?? dateOf(attributes["releaseDate"]);
  if (released !== undefined) {
    track.releaseDate = released;
  }
  const image = coverOf(album, index);
  if (image !== undefined) {
    track.image = image;
  }
  const duration = parseDuration(attributes["duration"]);
  if (duration !== undefined) {
    track.duration = duration;
  }
  const quality = tierOf(attributes);
  if (quality !== undefined) {
    track.quality = quality;
  }
  const url = urlOf(attributes);
  if (url !== undefined) {
    track.url = url;
  }
  if (!isTrack) {
    track.other = "video";
  }
  const uses = attributes["availability"];
  if (Array.isArray(uses)) {
    track.streamable = uses.includes("STREAM");
  }
  return track;
}

/** An item of a list, with what the list says of it. */
export function toItem(item: Identifier, index: Index, list: "playlist" | "favourites" | "album"): Track {
  const track: Track = parseTrack(index.get(keyOf(item)), index) ?? {
    id: itemId(item),
    title: `Unavailable ${item.type === "tracks" ? "track" : "video"}`,
    ...(item.type !== "tracks" && { other: "video" as const }),
  };
  const { meta } = item;
  const added = momentOf(meta["addedAt"]);
  if (list === "album") {
    const number = countOf(meta["trackNumber"]);
    const disc = countOf(meta["volumeNumber"]);
    return {
      ...track,
      ...(disc !== undefined && { discNumber: disc }),
      ...(number !== undefined && { trackNumber: number }),
    };
  }
  if (list === "favourites") {
    return { ...track, ...(added !== undefined && { favouritedAt: added }) };
  }
  const entry = textOf(meta["itemId"]);
  return {
    ...track,
    ...(entry !== undefined && { playlistTrackId: tagId<EntryId>("tidal", entry) }),
    ...(added !== undefined && { addedAt: added }),
  };
}

export function parseAlbum(resource: unknown, index: Index): Album | undefined {
  const ref = refIn(resource);
  const attributes = attributesOf(resource);
  const title = textOf(attributes["title"]);
  if (ref === undefined || title === undefined) {
    return undefined;
  }
  const version = textOf(attributes["version"]);
  const releaseDate = dateOf(attributes["releaseDate"]);
  const trackCount = countOf(attributes["numberOfItems"]);
  const image = coverOf(resource, index);
  const quality = tierOf(attributes);
  const upc = textOf(attributes["barcodeId"]);
  const url = urlOf(attributes);
  const uses = attributes["availability"];
  return {
    id: tagId<AlbumId>("tidal", ref.id),
    title,
    artist: artistsOf(resource, index).name ?? "",
    ...(version !== undefined && { version }),
    ...(releaseDate !== undefined && { releaseDate }),
    ...(trackCount !== undefined && { trackCount }),
    ...(image !== undefined && { image }),
    ...(Array.isArray(uses) && { streamable: uses.includes("STREAM") }),
    ...(quality !== undefined && { quality }),
    ...(upc !== undefined && { upc }),
    ...(url !== undefined && { url }),
  };
}

export function parseRelease(resource: unknown, index: Index): Release | undefined {
  const album = parseAlbum(resource, index);
  if (album === undefined) {
    return undefined;
  }
  const attributes = attributesOf(resource);
  const type = textOf(attributes["albumType"]) ?? textOf(attributes["type"]);
  const { id } = artistsOf(resource, index);
  return {
    ...album,
    releaseType: classifyRelease({
      title: album.title,
      ...(type !== undefined && { type }),
      ...(album.version !== undefined && { version: album.version }),
      ...(album.trackCount !== undefined && { trackCount: album.trackCount }),
    }),
    ...(id !== undefined && { artistId: id }),
  };
}

export function toAlbum(item: ResourceRef, index: Index): Album {
  return (
    parseAlbum(index.get(keyOf(item)), index) ?? {
      id: tagId<AlbumId>("tidal", item.id),
      title: "Unavailable album",
      artist: "",
    }
  );
}

export function parseArtist(resource: unknown): Artist | undefined {
  const ref = refIn(resource);
  const name = textOf(attributesOf(resource)["name"]);
  return ref === undefined || name === undefined ? undefined : { id: tagId<ArtistId>("tidal", ref.id), name };
}

export function toArtist(item: ResourceRef, index: Index): Artist {
  return (
    parseArtist(index.get(keyOf(item))) ?? { id: tagId<ArtistId>("tidal", item.id), name: "Unavailable artist" }
  );
}

/** What parse makes of the included resources, in the list's order; the rest left out. */
export function pick<T>(items: readonly ResourceRef[], index: Index, parse: (resource: unknown, index: Index) => T | undefined): T[] {
  return items.flatMap((item) => parse(index.get(keyOf(item)), index) ?? []);
}

const VISIBILITY: Record<string, boolean> = { PUBLIC: true, UNLISTED: false, PRIVATE: false };

export function parsePlaylist(resource: unknown): Playlist | undefined {
  const ref = refIn(resource);
  const attributes = attributesOf(resource);
  const name = textOf(attributes["name"]);
  if (ref === undefined || name === undefined) {
    return undefined;
  }
  // The tools list videos too, so every item counts.
  const trackCount = countOf(attributes["numberOfItems"]) ?? countOf(attributes["numberOfTrackItems"]);
  const description = textOf(attributes["description"]);
  const isPublic = VISIBILITY[String(attributes["accessType"])];
  const duration = parseDuration(attributes["duration"]);
  const updatedAt = momentOf(attributes["lastModifiedAt"]);
  const [owner] = relatedOf(resource, "owners");
  const url = urlOf(attributes);
  return {
    id: tagId<PlaylistId>("tidal", ref.id),
    name,
    ...(trackCount !== undefined && { trackCount }),
    ...(description !== undefined && { description }),
    ...(isPublic !== undefined && { isPublic }),
    ...(duration !== undefined && { duration }),
    ...(updatedAt !== undefined && { updatedAt }),
    ...(owner !== undefined && { ownerId: tagId<UserId>("tidal", owner.id) }),
    ...(url !== undefined && { url }),
  };
}

/**
 * Who a `/users/me` answer says is signed in, and the country their catalogue is.
 *
 * @throws {ServiceError} if it does not say who.
 */
export function parseAccount(document: unknown): { account: Account; countryCode?: string } {
  const resource = resourceOf(document);
  const ref = refIn(resource);
  if (ref === undefined) {
    throw unreadable("who is signed in");
  }
  const attributes = attributesOf(resource);
  const name = [attributes["firstName"], attributes["lastName"]].flatMap((part) => textOf(part) ?? []).join(" ");
  const country = attributes["country"];
  return {
    account: {
      id: tagId<UserId>("tidal", ref.id),
      // The user name can be an email address, so a name is preferred.
      displayName: textOf(name) ?? textOf(attributes["username"]) ?? ref.id,
    },
    ...(typeof country === "string" && /^[A-Z]{2}$/.test(country) && { countryCode: country }),
  };
}
