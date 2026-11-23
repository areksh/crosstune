/**
 * Defensive parsers from Spotify's JSON to the neutral model (../model.ts).
 *
 * Nothing is guessed: what a response leaves out stays absent. Spotify gives no
 * quality; `is_playable` is read where it is given (see service.ts).
 */

import { tagId, type AlbumId, type AnyId, type ArtistId, type PlaylistId, type TrackId, type UserId } from "../ids.js";
import { classifyRelease, type Album, type Artist, type Playlist, type Release, type Track } from "../model.js";
import type { Account } from "../service.js";
import { nativeOfUri } from "./uris.js";

/** Covers are shown at about this width. */
const COVER_WIDTH = 200;

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function https(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://") ? value : undefined;
}

function tagged<T extends AnyId>(value: unknown): T | undefined {
  const native = text(value);
  return native === undefined ? undefined : tagId<T>("spotify", native);
}

/** `fields` without those that are undefined. */
function present<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/** The smallest cover that is wide enough, or the first. */
function coverOf(images: unknown): string | undefined {
  const covers = (Array.isArray(images) ? images : []).filter(isRecord).flatMap((image) => {
    const url = https(image["url"]);
    return url === undefined ? [] : [{ url, width: number(image["width"]) ?? 0 }];
  });
  const wide = covers.filter(({ width }) => width >= COVER_WIDTH).sort((a, b) => a.width - b.width);
  return (wide[0] ?? covers[0])?.url;
}

function linkOf(item: Json): string | undefined {
  return isRecord(item["external_urls"]) ? https(item["external_urls"]["spotify"]) : undefined;
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, as precise as Spotify says it is. */
function dateOf(item: Json): string | undefined {
  const date = text(item["release_date"]);
  if (date === undefined || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(date) || date.startsWith("0000")) {
    return undefined;
  }
  const precision = item["release_date_precision"];
  return date.slice(0, precision === "year" ? 4 : precision === "month" ? 7 : 10);
}

function artistsOf(item: Json): Json[] {
  return Array.isArray(item["artists"]) ? item["artists"].filter(isRecord) : [];
}

function secondsOf(item: Json): number | undefined {
  const ms = number(item["duration_ms"]);
  return ms === undefined ? undefined : Math.round(ms / 1000);
}

/** A song, an episode or a local file. */
export function parseTrack(item: unknown): Track | undefined {
  if (!isRecord(item) || typeof item["name"] !== "string") {
    return undefined;
  }
  if (item["is_local"] === true) {
    return parseLocal(item, item["name"]);
  }
  const type = item["type"] ?? "track";
  const native = text(item["id"]);
  if (native === undefined) {
    return undefined;
  }
  if (type === "episode") {
    return parseEpisode(item, native, item["name"]);
  }
  if (type !== "track") {
    return undefined;
  }
  const artists = artistsOf(item);
  const joint = artists.slice(1).flatMap((artist) => text(artist["name"]) ?? []);
  const album = isRecord(item["album"]) ? item["album"] : {};
  return present<Track>({
    id: tagId<TrackId>("spotify", native),
    title: item["name"],
    discNumber: number(item["disc_number"]),
    trackNumber: number(item["track_number"]),
    artist: text(artists[0]?.["name"]),
    artistId: tagged<ArtistId>(artists[0]?.["id"]),
    jointArtists: joint.length > 0 ? joint : undefined,
    isrc: isRecord(item["external_ids"]) ? text(item["external_ids"]["isrc"]) : undefined,
    album: text(album["name"]),
    albumId: tagged<AlbumId>(album["id"]),
    releaseDate: dateOf(album),
    image: coverOf(album["images"]),
    duration: secondsOf(item),
    url: linkOf(item),
    // Whether the user can play it, given without a market (seen live). The
    // service still claims no playability, so tidy-ups leave Spotify alone;
    // a sync takes a removed song that is still playable as removed.
    streamable: typeof item["is_playable"] === "boolean" ? item["is_playable"] : undefined,
  });
}

function parseEpisode(item: Json, native: string, title: string): Track {
  return present<Track>({
    id: tagId<TrackId>("spotify", `episode:${native}`),
    title,
    artist: isRecord(item["show"]) ? text(item["show"]["name"]) : undefined,
    releaseDate: dateOf(item),
    image: coverOf(item["images"]),
    duration: secondsOf(item),
    url: linkOf(item),
    other: "episode",
  });
}

function parseLocal(item: Json, title: string): Track {
  const artist = text(artistsOf(item)[0]?.["name"]);
  const album = isRecord(item["album"]) ? text(item["album"]["name"]) : undefined;
  const duration = secondsOf(item);
  const made = [artist ?? "", album ?? "", title, duration ?? ""].map(encodeURIComponent).join(":");
  return present<Track>({
    id: tagId<TrackId>("spotify", nativeOfUri(item["uri"]) ?? `local:${made}`),
    title,
    artist,
    album,
    duration,
    other: "local",
  });
}

/** The song of a playlist item; undefined when there is none (withdrawn, or of an unknown kind). */
export function parsePlaylistItem(value: unknown): Track | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const item = value["item"] ?? value["track"];
  const track = parseTrack(isRecord(item) && value["is_local"] === true ? { ...item, is_local: true } : item);
  // Very old entries and Spotify's own playlists have no date, or 1970.
  const addedAt = text(value["added_at"]);
  return track === undefined || addedAt === undefined || addedAt.startsWith("1970-") ? track : { ...track, addedAt };
}

export function parseAlbum(item: unknown): Album | undefined {
  if (!isRecord(item) || typeof item["name"] !== "string") {
    return undefined;
  }
  const id = tagged<AlbumId>(item["id"]);
  if (id === undefined) {
    return undefined;
  }
  return present<Album>({
    id,
    title: item["name"],
    artist: text(artistsOf(item)[0]?.["name"]) ?? "",
    releaseDate: dateOf(item),
    trackCount: number(item["total_tracks"]),
    image: coverOf(item["images"]),
    upc: isRecord(item["external_ids"]) ? text(item["external_ids"]["upc"]) : undefined,
    url: linkOf(item),
  });
}

export function parseRelease(item: unknown): Release | undefined {
  const album = parseAlbum(item);
  if (album === undefined || !isRecord(item)) {
    return undefined;
  }
  const { title, trackCount } = album;
  const type = text(item["album_type"]);
  const artistId = tagged<ArtistId>(artistsOf(item)[0]?.["id"]);
  return {
    ...album,
    releaseType: classifyRelease({
      title,
      ...(type !== undefined && { type }),
      ...(trackCount !== undefined && { trackCount }),
    }),
    ...(artistId !== undefined && { artistId }),
  };
}

export function parseArtist(item: unknown): Artist | undefined {
  if (!isRecord(item) || typeof item["name"] !== "string") {
    return undefined;
  }
  const id = tagged<ArtistId>(item["id"]);
  return id === undefined ? undefined : { id, name: item["name"] };
}

export function parsePlaylist(item: unknown): Playlist | undefined {
  if (!isRecord(item) || typeof item["name"] !== "string") {
    return undefined;
  }
  const id = tagged<PlaylistId>(item["id"]);
  if (id === undefined) {
    return undefined;
  }
  const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  return present<Playlist>({
    id,
    name: item["name"],
    trackCount: isRecord(item["items"]) ? number(item["items"]["total"]) : undefined,
    description: text(typeof item["description"] === "string" ? item["description"].trim() : undefined),
    // `public` is not read: live, every read says true, of private playlists
    // too (it means "shown on the profile", and reads do not report it).
    isCollaborative: flag(item["collaborative"]),
    ownerId: isRecord(item["owner"]) ? tagged<UserId>(item["owner"]["id"]) : undefined,
    url: linkOf(item),
  });
}

/** Who is signed in. Spotify no longer says which plan they are on. */
export function parseAccount(item: unknown): Account | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const id = tagged<UserId>(item["id"]);
  return id === undefined ? undefined : { id, displayName: text(item["display_name"]) ?? String(item["id"]) };
}
