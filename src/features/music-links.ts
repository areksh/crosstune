/**
 * Links to music: recognising a pasted link to an artist, album, playlist,
 * track or label on Qobuz, Spotify or TIDAL, wherever a list is typed. The id
 * a link gives names its service, so a tool running on another service can
 * find the same thing there (src/services/gap-filler.ts).
 *
 * Qobuz shares items under several shapes:
 *
 *   - the players: `https://play.qobuz.com/<kind>/<id>` and
 *     `https://open.qobuz.com/<kind>/<id>` (kind: artist, album, playlist,
 *     track, label);
 *   - the store: `https://www.qobuz.com/<locale>/album/<slug>/<albumId>`,
 *     `.../interpreter/<slug>/<artistId>`, `.../playlists/<slug>/<id>` and
 *     `.../label/<slug>/[download-streaming-albums/]<id>` (the locale, such as
 *     `gb-en`, may be missing, as in the API's own relative URLs).
 *
 * Album ids are text (often alphanumeric, such as `pvsb64n704d0b`, sometimes a
 * long number); the others are numbers.
 *
 * Spotify: `https://open.spotify.com/[intl-xx/][embed/]<kind>/<id>`, the old
 * `.../user/<name>/playlist/<id>`, and `spotify:<kind>:<id>`; every id is 22
 * letters and digits.
 *
 * TIDAL: `https://tidal.com/[browse/]<kind>/<id>[/u]` and
 * `https://listen.tidal.com/<kind>/<id>`, where a track may sit under its album
 * (`album/<id>/track/<id>`); playlist ids are UUIDs, the others numbers.
 *
 * The scheme may be missing, and trailing slashes, query strings and fragments
 * are ignored.
 *
 * Pure and free of Node dependencies, so the web UI's home paste box uses it
 * ({@link classifyPaste}) as well as the server and the CLI.
 */

import { labelOf, ServiceError } from "../services/errors.js";
import { parseId, readId, tagId, type AlbumId, type ArtistId, type PlaylistId, type TrackId } from "../services/ids.js";

/** A link to one item on a service. */
export type MusicLink =
  | { kind: "album"; id: AlbumId }
  | { kind: "artist"; id: ArtistId }
  | { kind: "playlist"; id: PlaylistId }
  | { kind: "track"; id: TrackId }
  | { kind: "label"; id: string };

export type MusicLinkKind = MusicLink["kind"];

const PLAYER_HOSTS = new Set(["play.qobuz.com", "open.qobuz.com"]);
const STORE_HOSTS = new Set(["www.qobuz.com", "qobuz.com"]);
const LOCALE = /^[a-z]{2}-[a-z]{2}$/;
const ALBUM_ID = /^[a-z0-9]+$/i;
const NUMERIC_ID = /^[1-9]\d*$/;

/** The store's name for each kind of page. */
const STORE_KINDS: Record<string, MusicLinkKind> = {
  album: "album",
  interpreter: "artist",
  playlists: "playlist",
  label: "label",
};

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URI = /^spotify:(artist|album|playlist|track):([A-Za-z0-9]{22})$/i;
const TIDAL_HOSTS = new Set(["tidal.com", "www.tidal.com", "listen.tidal.com"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The kinds Spotify and TIDAL share as links (labels are Qobuz's alone). */
const SHARED_KINDS = new Set(["artist", "album", "playlist", "track"]);

/** Parse a line holding a link to music, or return undefined if it is not one. */
export function parseMusicLink(line: string): MusicLink | undefined {
  let text = line.trim().replace(/^<(.*)>$/, "$1");
  const uri = SPOTIFY_URI.exec(text);
  if (uri !== null) {
    return spotifyLink(uri[1]?.toLowerCase(), uri[2]);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (SPOTIFY_HOSTS.has(host)) {
    return spotifyPath(segments);
  }
  if (TIDAL_HOSTS.has(host)) {
    return tidalPath(segments);
  }
  if (PLAYER_HOSTS.has(host)) {
    const [kind, id] = segments;
    return segments.length === 2 ? toLink(kind, id) : undefined;
  }
  if (!STORE_HOSTS.has(host)) {
    return undefined;
  }
  const path = LOCALE.test(segments[0] ?? "") ? segments.slice(1) : segments;
  const kind = STORE_KINDS[path[0] ?? ""];
  // <kind>/<slug>/<id>, or a label's <slug>/download-streaming-albums/<id>.
  const fits = path.length === 3 || (kind === "label" && path.length === 4);
  return kind !== undefined && fits ? toLink(kind, path[path.length - 1]) : undefined;
}

/** `[intl-xx/][embed/]<kind>/<id>`, or `user/<name>/playlist/<id>`. */
function spotifyPath(segments: string[]): MusicLink | undefined {
  let path = segments;
  if (/^intl-[a-z]{2}(-[a-z]+)?$/i.test(path[0] ?? "")) {
    path = path.slice(1);
  }
  if (path[0] === "embed") {
    path = path.slice(1);
  }
  if (path[0] === "user" && path.length === 4) {
    path = path.slice(2);
  }
  return path.length === 2 ? spotifyLink(path[0], path[1]) : undefined;
}

function spotifyLink(kind: string | undefined, id: string | undefined): MusicLink | undefined {
  return id !== undefined && SPOTIFY_ID.test(id) ? shared("spotify", kind, id) : undefined;
}

/** `[browse/]<kind>/<id>[/u]`, or `[browse/]album/<id>/track/<id>`. */
function tidalPath(segments: string[]): MusicLink | undefined {
  let path = segments[0] === "browse" ? segments.slice(1) : segments;
  if (path[path.length - 1] === "u") {
    path = path.slice(0, -1);
  }
  if (path.length === 4 && path[0] === "album" && path[2] === "track") {
    path = path.slice(2);
  }
  const [kind, id] = path;
  if (path.length !== 2 || id === undefined) {
    return undefined;
  }
  const fits = kind === "playlist" ? UUID.test(id) : NUMERIC_ID.test(id);
  return fits ? shared("tidal", kind, id.toLowerCase()) : undefined;
}

function shared(service: "spotify" | "tidal", kind: string | undefined, id: string): MusicLink | undefined {
  if (kind === undefined || !SHARED_KINDS.has(kind)) {
    return undefined;
  }
  return { kind, id: tagId(service, id) } as MusicLink;
}

function toLink(kind: string | undefined, id: string | undefined): MusicLink | undefined {
  if (id === undefined) {
    return undefined;
  }
  if (kind === "album") {
    return ALBUM_ID.test(id) ? { kind, id: tagId<AlbumId>("qobuz", id) } : undefined;
  }
  if (!NUMERIC_ID.test(id)) {
    return undefined;
  }
  switch (kind) {
    case "artist":
      return { kind, id: tagId<ArtistId>("qobuz", id) };
    case "playlist":
      return { kind, id: tagId<PlaylistId>("qobuz", id) };
    case "track":
      return { kind, id: tagId<TrackId>("qobuz", id) };
    case "label":
      return { kind, id };
    default:
      return undefined;
  }
}

/**
 * A playlist id -- a number of Qobuz's, or one that names its service -- or a
 * pasted playlist link to any service; undefined when it is neither.
 */
export function parsePlaylistId(raw: string | undefined): PlaylistId | undefined {
  const text = raw?.trim() ?? "";
  const link = parseMusicLink(text);
  return link?.kind === "playlist" ? link.id : readId<PlaylistId>(text);
}

const ARTICLE: Record<MusicLinkKind, string> = {
  album: "an album",
  artist: "an artist",
  playlist: "a playlist",
  track: "a track",
  label: "a label",
};

/** Why a link does not fit where it was typed: "an album link, not an artist". */
export function describeLinkMismatch(link: MusicLink, wanted: MusicLinkKind): string {
  return `${ARTICLE[link.kind]} link, not ${ARTICLE[wanted]}`;
}

/**
 * Why a link's item could not be read: what the service said when it was
 * looked for on another (src/services/gap-filler.ts), else that its service
 * has no such item. "no Qobuz artist has this id".
 */
export function linkNotFound(link: MusicLink, error: unknown): string {
  if (error instanceof ServiceError && ["not-found", "not-connected", "ambiguous"].includes(error.kind)) {
    return error.message;
  }
  const service = link.kind === "label" ? "qobuz" : parseId(link.id)?.service;
  return `no ${service === undefined ? "" : `${labelOf(service)} `}${link.kind} has this id`;
}

/** What a pasted block holds, sorted for the tools that take it. */
export interface PasteSummary {
  /** Artist links and plain names, for the artists tools. */
  artists: string[];
  /** Album links and "Artist - Album" lines, for the albums tool. */
  albums: string[];
  /** Playlist links, with their ids. */
  playlists: { line: string; id: PlaylistId }[];
  /** Track links (no tool takes them yet). */
  tracks: string[];
  /** Other links (Qobuz labels). */
  other: string[];
  /** "Found 1 playlist, 1 album and 1 artist." */
  summary: string;
}

/**
 * Sort pasted lines: links by kind; then a line with " - " is an
 * "Artist - Album" line, and any other line an artist name. Blank lines are
 * ignored; each list keeps the pasted order.
 */
export function classifyPaste(text: string): PasteSummary {
  const result: Omit<PasteSummary, "summary"> = {
    artists: [],
    albums: [],
    playlists: [],
    tracks: [],
    other: [],
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const link = parseMusicLink(line);
    if (link === undefined) {
      (line.includes(" - ") ? result.albums : result.artists).push(line);
    } else if (link.kind === "artist") {
      result.artists.push(line);
    } else if (link.kind === "album") {
      result.albums.push(line);
    } else if (link.kind === "playlist") {
      result.playlists.push({ line, id: link.id });
    } else if (link.kind === "track") {
      result.tracks.push(line);
    } else {
      result.other.push(line);
    }
  }
  const parts = [
    counted(result.playlists.length, "playlist"),
    counted(result.albums.length, "album"),
    counted(result.artists.length, "artist"),
    counted(result.tracks.length, "track"),
    counted(result.other.length, "other link"),
  ].filter((part): part is string => part !== undefined);
  const summary =
    parts.length === 0
      ? "Paste links or a list to begin."
      : `Found ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}.`;
  return { ...result, summary };
}

function counted(count: number, noun: string): string | undefined {
  return count === 0 ? undefined : `${count} ${noun}${count === 1 ? "" : "s"}`;
}
