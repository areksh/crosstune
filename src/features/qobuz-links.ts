/**
 * Qobuz links: recognising a pasted link to an artist, album, playlist, track
 * or label, wherever a list is typed.
 *
 * Qobuz shares items under several shapes, all accepted here:
 *
 *   - the players: `https://play.qobuz.com/<kind>/<id>` and
 *     `https://open.qobuz.com/<kind>/<id>` (kind: artist, album, playlist,
 *     track, label);
 *   - the store: `https://www.qobuz.com/<locale>/album/<slug>/<albumId>`,
 *     `.../interpreter/<slug>/<artistId>`, `.../playlists/<slug>/<id>` and
 *     `.../label/<slug>/[download-streaming-albums/]<id>` (the locale, such as
 *     `gb-en`, may be missing, as in the API's own relative URLs).
 *
 * The scheme may be missing, and trailing slashes, query strings and fragments
 * are ignored. Album ids are text (often alphanumeric, such as
 * `pvsb64n704d0b`, sometimes a long number); the others are numbers.
 *
 * Pure and free of Node dependencies, so the web UI's home paste box uses it
 * ({@link classifyPaste}) as well as the server and the CLI.
 */

import { readId, tagId, type AlbumId, type ArtistId, type PlaylistId, type TrackId } from "../services/ids.js";

/** A link to one Qobuz item. */
export type QobuzLink =
  | { kind: "album"; id: AlbumId }
  | { kind: "artist"; id: ArtistId }
  | { kind: "playlist"; id: PlaylistId }
  | { kind: "track"; id: TrackId }
  | { kind: "label"; id: string };

export type QobuzLinkKind = QobuzLink["kind"];

const PLAYER_HOSTS = new Set(["play.qobuz.com", "open.qobuz.com"]);
const STORE_HOSTS = new Set(["www.qobuz.com", "qobuz.com"]);
const LOCALE = /^[a-z]{2}-[a-z]{2}$/;
const ALBUM_ID = /^[a-z0-9]+$/i;
const NUMERIC_ID = /^[1-9]\d*$/;

/** The store's name for each kind of page. */
const STORE_KINDS: Record<string, QobuzLinkKind> = {
  album: "album",
  interpreter: "artist",
  playlists: "playlist",
  label: "label",
};

/** Parse a line holding a Qobuz link, or return undefined if it is not one. */
export function parseQobuzLink(line: string): QobuzLink | undefined {
  let text = line.trim().replace(/^<(.*)>$/, "$1");
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

function toLink(kind: string | undefined, id: string | undefined): QobuzLink | undefined {
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
 * pasted playlist link; undefined when it is neither.
 */
export function parsePlaylistId(raw: string | undefined): PlaylistId | undefined {
  const text = raw?.trim() ?? "";
  const link = parseQobuzLink(text);
  return link?.kind === "playlist" ? link.id : readId<PlaylistId>(text);
}

const ARTICLE: Record<QobuzLinkKind, string> = {
  album: "an album",
  artist: "an artist",
  playlist: "a playlist",
  track: "a track",
  label: "a label",
};

/** Why a link does not fit where it was typed: "an album link, not an artist". */
export function describeLinkMismatch(link: QobuzLink, wanted: QobuzLinkKind): string {
  return `${ARTICLE[link.kind]} link, not ${ARTICLE[wanted]}`;
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
  /** Other Qobuz links (labels). */
  other: string[];
  /** "Found 1 playlist, 1 album and 1 artist." */
  summary: string;
}

/**
 * Sort pasted lines: Qobuz links by kind; then a line with " - " is an
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
    const link = parseQobuzLink(line);
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
    counted(result.other.length, "other Qobuz link"),
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
