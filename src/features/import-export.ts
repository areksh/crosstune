/**
 * Import and export a Qobuz library: playlists, favourites, and full-account
 * backups, in several interchange formats.
 *
 * Like the other feature modules this is pure (it depends only on small injected
 * client interfaces, never the whole {@link QobuzClient}) so every part is
 * unit-testable against stubs. It has three concerns:
 *
 *   1. *Serialise* -- turn a collection (tracks, albums or artists) or a whole
 *      backup into a string in one of the supported {@link Format}s.
 *   2. *Parse* -- read one of those formats back into items that may or may not
 *      carry Qobuz ids.
 *   3. *Resolve then commit* -- the two-phase import shared with the other tools.
 *      Phase one turns parsed items into Qobuz ids (using the id when the input
 *      carried one, else searching and best-matching); phase two writes the
 *      matched ids to a destination (favourites or a playlist). A full backup is
 *      just an export of every collection at once, and restoring it replays the
 *      commit phase for each part.
 *
 * JSON is the lossless format and the only one that can hold a whole-account
 * backup; CSV, plain text and M3U carry a single flat collection and are handy
 * for hand-editing or moving lists between services.
 */

import type { AlbumId, ArtistId, PlaylistId, TrackId } from "../services/ids.js";
import type { Album, Artist, Playlist, Track } from "../services/model.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { normalise } from "./deduplicate.js";
import {
  resolveAlbumVersions,
  selectAlbumVersion,
} from "./playlist-from-albums.js";
import {
  addTracksToExistingPlaylist,
  createPlaylistWithTracks,
  type ExistingPlaylistClient,
  type PlaylistWriterClient,
} from "./playlist-from-artists.js";
import { compareQuality } from "./upgrade.js";

/** The interchange formats a collection can be written to and read from. */
export const FORMATS = ["json", "csv", "text", "m3u"] as const;
export type Format = (typeof FORMATS)[number];

/**
 * The formats an import can read: every export format, plus `spotify` -- a CSV
 * written by Exportify (exportify.net) from a Spotify playlist. Spotify is
 * import-only; a plain `csv` import whose header is Exportify's is read as one.
 */
export const IMPORT_FORMATS = [...FORMATS, "spotify"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** The current backup document version, bumped if the shape changes. */
export const BACKUP_FORMAT_VERSION = 1;

// --- Portable models -------------------------------------------------------

/** A track as it appears in an export (a subset of {@link Track}). */
export interface ExportTrack {
  id: number;
  title: string;
  artist?: string;
  album?: string;
  isrc?: string;
}

/** An album as it appears in an export. */
export interface ExportAlbum {
  id: string;
  title: string;
  artist?: string;
}

/** An artist as it appears in an export. */
export interface ExportArtist {
  id: number;
  name: string;
}

/** A playlist and its tracks as they appear in a backup. */
export interface ExportPlaylist {
  name: string;
  description?: string;
  isPublic?: boolean;
  tracks: ExportTrack[];
}

/** A flat collection of one item kind, the unit CSV/text/M3U carry. */
export type Collection =
  | { kind: "tracks"; items: ExportTrack[] }
  | { kind: "albums"; items: ExportAlbum[] }
  | { kind: "artists"; items: ExportArtist[] };

/** A full-account backup: every favourite collection plus every playlist. */
export interface LibraryBackup {
  formatVersion: number;
  exportedAt: string;
  favourites: {
    tracks: ExportTrack[];
    albums: ExportAlbum[];
    artists: ExportArtist[];
  };
  playlists: ExportPlaylist[];
}

// --- Domain -> portable ----------------------------------------------------

/** Narrow a {@link Track} to the fields an export keeps, dropping absent ones. */
export function toExportTrack(track: Track): ExportTrack {
  const out: ExportTrack = { id: track.id, title: track.title };
  if (track.artist !== undefined) out.artist = track.artist;
  if (track.album !== undefined) out.album = track.album;
  if (track.isrc !== undefined) out.isrc = track.isrc;
  return out;
}

/** Narrow an {@link Album} to the fields an export keeps. */
export function toExportAlbum(album: Album): ExportAlbum {
  const out: ExportAlbum = { id: album.id, title: album.title };
  if (album.artist.length > 0) out.artist = album.artist;
  return out;
}

/** Narrow an {@link Artist} to the fields an export keeps. */
export function toExportArtist(artist: Artist): ExportArtist {
  return { id: artist.id, name: artist.name };
}

// --- Serialisation ---------------------------------------------------------

/**
 * Serialise a collection to the given format.
 *
 * @throws {Error} if M3U is requested for a non-track collection (M3U is a
 *   track-only playlist format).
 */
export function serializeCollection(
  collection: Collection,
  format: Format,
): string {
  switch (format) {
    case "json":
      return serializeCollectionJson(collection);
    case "csv":
      return serializeCollectionCsv(collection);
    case "text":
      return serializeCollectionText(collection);
    case "m3u":
      if (collection.kind !== "tracks") {
        throw new Error("M3U can only hold tracks");
      }
      return serializeTracksM3u(collection.items);
  }
}

/** Serialise a full backup (JSON only -- it is the lossless format). */
export function serializeBackup(backup: LibraryBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

function serializeCollectionJson(collection: Collection): string {
  const body = { [collection.kind]: collection.items };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Column layout per collection kind, shared by the CSV writer and reader. */
const CSV_COLUMNS = {
  tracks: ["title", "artist", "album", "isrc", "id"],
  albums: ["title", "artist", "id"],
  artists: ["name", "id"],
} as const;

function serializeCollectionCsv(collection: Collection): string {
  const columns = CSV_COLUMNS[collection.kind];
  const rows: string[] = [columns.map(csvEscape).join(",")];
  for (const item of collection.items) {
    const record = item as unknown as Record<string, unknown>;
    rows.push(
      columns
        .map((column) => csvEscape(stringField(record[column])))
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}

function serializeCollectionText(collection: Collection): string {
  const lines = collection.items.map((item) => {
    if (collection.kind === "artists") {
      return (item as ExportArtist).name;
    }
    return artistTitleLine(item as ExportTrack | ExportAlbum);
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Serialise tracks to extended M3U. Each entry pairs an `#EXTINF` display line
 * with a `qobuz://track/<id>` URI, so the id round-trips losslessly while the
 * file still reads as a normal playlist.
 */
function serializeTracksM3u(tracks: readonly ExportTrack[]): string {
  const lines = ["#EXTM3U"];
  for (const track of tracks) {
    lines.push(`#EXTINF:-1,${artistTitleLine(track)}`);
    lines.push(`qobuz://track/${track.id}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render "Artist - Title" (or just the title/album when the artist is absent). */
function artistTitleLine(item: {
  title: string;
  artist?: string | undefined;
}): string {
  return item.artist !== undefined && item.artist.length > 0
    ? `${item.artist} - ${item.title}`
    : item.title;
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Quote a CSV field when it contains a comma, quote or newline; double quotes. */
function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// --- Parsing ---------------------------------------------------------------

/** A parsed track that may carry a Qobuz id or only metadata to resolve. */
export interface ParsedTrack {
  id?: number;
  title?: string;
  /** The artist credit as displayed (several artists joined with ", "). */
  artist?: string;
  /** Each credited artist, when the source lists them separately (Spotify). */
  artists?: string[];
  album?: string;
  isrc?: string;
}

/** A parsed album that may carry a Qobuz id or only metadata to resolve. */
export interface ParsedAlbum {
  id?: string;
  title?: string;
  artist?: string;
}

/** A parsed artist that may carry a Qobuz id or only a name to resolve. */
export interface ParsedArtist {
  id?: number;
  name?: string;
}

/** The kind of collection an import targets. */
export type CollectionKind = "tracks" | "albums" | "artists";

export type ParsedCollection =
  | { kind: "tracks"; items: ParsedTrack[] }
  | { kind: "albums"; items: ParsedAlbum[] }
  | { kind: "artists"; items: ParsedArtist[] };

/**
 * Parse `content` in `format` into items of the given `kind`.
 *
 * JSON is self-describing (the `kind` argument is only a fallback for the
 * key to read); the other formats are read as the requested kind. A `csv`
 * whose header is Exportify's is read as a Spotify export (see
 * {@link effectiveImportFormat}). Blank lines and unparseable rows are skipped
 * rather than fatal.
 *
 * @throws {Error} if JSON content is malformed, or a Spotify export is read as
 *   anything but tracks.
 */
export function parseCollection(
  content: string,
  format: ImportFormat,
  kind: CollectionKind,
): ParsedCollection {
  switch (effectiveImportFormat(content, format)) {
    case "json":
      return parseCollectionJson(content, kind);
    case "csv":
      return parseCollectionCsv(content, kind);
    case "text":
      return parseCollectionText(content, kind);
    case "m3u":
      return { kind: "tracks", items: parseTracksM3u(content) };
    case "spotify":
      if (kind !== "tracks") {
        throw new Error(
          "A Spotify export holds tracks; import it into favourite tracks or a playlist",
        );
      }
      return { kind: "tracks", items: parseSpotifyCsv(content) };
  }
}

/**
 * The format `content` will actually be read as: `csv` becomes `spotify` when
 * the header is an Exportify one; anything else is returned unchanged.
 */
export function effectiveImportFormat(content: string, format: ImportFormat): ImportFormat {
  return format === "csv" && isSpotifyExport(content) ? "spotify" : format;
}

/**
 * Exportify's column names (lower-cased) for each field, in preference order.
 * Its header has changed over the years ("Artist Name" became "Artist Name(s)"),
 * so columns are found by name, never by position.
 */
const SPOTIFY_COLUMNS = {
  title: ["track name"],
  artists: ["artist name(s)", "artist name", "artist names"],
  album: ["album name"],
  isrc: ["isrc"],
} as const;

/** Whether `content` is a CSV with Exportify's header (a track name and artist column). */
export function isSpotifyExport(content: string): boolean {
  const header = csvHeader(content);
  return (
    header.includes("track name") &&
    SPOTIFY_COLUMNS.artists.some((column) => header.includes(column))
  );
}

/** The first CSV row, trimmed and lower-cased, without a leading byte-order mark. */
function csvHeader(content: string): string[] {
  const firstLine = stripBom(content).split(/\r?\n/, 1)[0] ?? "";
  return (parseCsv(firstLine)[0] ?? []).map((h) => h.trim().toLowerCase());
}

/** Read an Exportify CSV: one track per row, its artists split on commas. */
function parseSpotifyCsv(content: string): ParsedTrack[] {
  const rows = parseCsv(stripBom(content));
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const column = (names: readonly string[]): number =>
    names.map((name) => header.indexOf(name)).find((index) => index !== -1) ?? -1;
  const at = (row: string[], index: number): string | undefined => {
    const value = index === -1 ? undefined : row[index]?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const titleAt = column(SPOTIFY_COLUMNS.title);
  const artistsAt = column(SPOTIFY_COLUMNS.artists);
  const albumAt = column(SPOTIFY_COLUMNS.album);
  const isrcAt = column(SPOTIFY_COLUMNS.isrc);

  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => {
      const item: ParsedTrack = {};
      const title = at(row, titleAt);
      if (title !== undefined) item.title = title;
      const artists = (at(row, artistsAt) ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (artists.length > 0) {
        item.artist = artists.join(", ");
        item.artists = artists;
      }
      const album = at(row, albumAt);
      if (album !== undefined) item.album = album;
      const isrc = at(row, isrcAt);
      if (isrc !== undefined) item.isrc = isrc;
      return item;
    });
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function parseCollectionJson(
  content: string,
  fallbackKind: CollectionKind,
): ParsedCollection {
  const data: unknown = JSON.parse(content);
  if (!isRecord(data)) {
    throw new Error("expected a JSON object");
  }
  const kind: CollectionKind = Array.isArray(data["tracks"])
    ? "tracks"
    : Array.isArray(data["albums"])
      ? "albums"
      : Array.isArray(data["artists"])
        ? "artists"
        : fallbackKind;
  const raw = Array.isArray(data[kind]) ? (data[kind] as unknown[]) : [];
  if (kind === "tracks") {
    return { kind, items: raw.map(parsedTrackFromJson) };
  }
  if (kind === "albums") {
    return { kind, items: raw.map(parsedAlbumFromJson) };
  }
  return { kind, items: raw.map(parsedArtistFromJson) };
}

function parseCollectionCsv(
  content: string,
  kind: CollectionKind,
): ParsedCollection {
  const rows = parseCsv(stripBom(content));
  if (rows.length === 0) {
    return emptyParsed(kind);
  }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const at = (row: string[], column: string): string | undefined => {
    const index = header.indexOf(column);
    if (index === -1) return undefined;
    const value = row[index];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const body = rows.slice(1).filter((row) => row.some((cell) => cell.length > 0));
  if (kind === "tracks") {
    return {
      kind,
      items: body.map((row) => ({
        ...numberIf(at(row, "id"), "id"),
        ...stringIf(at(row, "title"), "title"),
        ...stringIf(at(row, "artist"), "artist"),
        ...stringIf(at(row, "album"), "album"),
        ...stringIf(at(row, "isrc"), "isrc"),
      })),
    };
  }
  if (kind === "albums") {
    return {
      kind,
      items: body.map((row) => ({
        ...stringIf(at(row, "id"), "id"),
        ...stringIf(at(row, "title"), "title"),
        ...stringIf(at(row, "artist"), "artist"),
      })),
    };
  }
  return {
    kind,
    items: body.map((row) => ({
      ...numberIf(at(row, "id"), "id"),
      ...stringIf(at(row, "name"), "name"),
    })),
  };
}

function parseCollectionText(
  content: string,
  kind: CollectionKind,
): ParsedCollection {
  const lines = splitLines(content);
  if (kind === "artists") {
    return { kind, items: lines.map((name) => ({ name })) };
  }
  const items = lines.map((line) => splitArtistTitle(line));
  return kind === "tracks"
    ? { kind, items: items as ParsedTrack[] }
    : {
        kind,
        items: items.map((item) => ({
          ...(item.artist !== undefined && { artist: item.artist }),
          ...(item.title !== undefined && { title: item.title }),
        })),
      };
}

/** Read `qobuz://track/<id>` URIs (and #EXTINF display lines) from M3U. */
function parseTracksM3u(content: string): ParsedTrack[] {
  const items: ParsedTrack[] = [];
  let pending: { artist?: string; title?: string } | undefined;
  for (const line of splitLines(content)) {
    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      pending =
        comma === -1 ? {} : splitArtistTitle(line.slice(comma + 1).trim());
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const match = /^qobuz:\/\/track\/(\d+)$/.exec(line);
    const item: ParsedTrack = {};
    if (match) item.id = Number(match[1]);
    if (pending?.artist !== undefined) item.artist = pending.artist;
    if (pending?.title !== undefined) item.title = pending.title;
    // A bare non-comment line with no Qobuz URI is treated as "Artist - Title".
    if (match === null && pending === undefined) {
      Object.assign(item, splitArtistTitle(line));
    }
    items.push(item);
    pending = undefined;
  }
  return items;
}

/**
 * Parse a full backup document.
 *
 * @throws {Error} if the JSON is malformed or is not a backup object.
 */
export function parseBackup(content: string): LibraryBackup {
  const data: unknown = JSON.parse(content);
  if (!isRecord(data) || !isRecord(data["favourites"])) {
    throw new Error("not a qobuz-helper backup");
  }
  const favourites = data["favourites"];
  const playlistsRaw = Array.isArray(data["playlists"]) ? data["playlists"] : [];
  return {
    formatVersion:
      typeof data["formatVersion"] === "number" ? data["formatVersion"] : 0,
    exportedAt:
      typeof data["exportedAt"] === "string" ? data["exportedAt"] : "",
    favourites: {
      tracks: arrayOf(favourites["tracks"]).map(exportTrackFromJson),
      albums: arrayOf(favourites["albums"]).map(exportAlbumFromJson),
      artists: arrayOf(favourites["artists"]).map(exportArtistFromJson),
    },
    playlists: playlistsRaw.map(exportPlaylistFromJson),
  };
}

// --- Resolution (phase one) ------------------------------------------------

/** The client surface import resolution needs to turn metadata into ids. */
export interface ImportResolverClient {
  searchTracks(query: string, limit?: number): Promise<Track[]>;
  searchAlbums(query: string, limit?: number): Promise<Album[]>;
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
}

/**
 * How an item was matched: `id` -- the input carried its Qobuz id; `isrc` -- a
 * search by its ISRC found the same recording; `search` -- an artist and title
 * (or name) search, which can occasionally pick the wrong item.
 */
export type MatchMethod = "id" | "isrc" | "search";

/** A single matched item: its display label and the Qobuz id it resolved to. */
export interface MatchedItem {
  label: string;
  id: number | string;
  /** How it was matched (always set by {@link resolveImport}). */
  via?: MatchMethod;
}

/** The outcome of resolving a parsed collection to Qobuz ids. */
export interface ImportPlan {
  kind: CollectionKind;
  /** Items resolved to a Qobuz id, in input order (duplicates removed). */
  matched: MatchedItem[];
  /** Display labels of items that could not be resolved. */
  unmatched: string[];
}

/** How many matched items each method found, plus how many did not match. */
export type MatchCounts = Record<MatchMethod | "unmatched", number>;

/** Count a plan's matches by method (an item without `via` counts as a search). */
export function countMatchMethods(plan: ImportPlan): MatchCounts {
  const counts: MatchCounts = { id: 0, isrc: 0, search: 0, unmatched: plan.unmatched.length };
  for (const item of plan.matched) {
    counts[item.via ?? "search"] += 1;
  }
  return counts;
}

/**
 * Describe how matches were found, e.g. "12 by ISRC, 3 by artist and title"
 * (methods that found nothing are left out; empty when nothing matched).
 */
export function describeMatchCounts(counts: MatchCounts): string {
  return [
    counts.id > 0 ? `${counts.id} by Qobuz id` : undefined,
    counts.isrc > 0 ? `${counts.isrc} by ISRC` : undefined,
    counts.search > 0 ? `${counts.search} by artist and title` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

/** How many search results to weigh when matching an item to Qobuz. */
const IMPORT_SEARCH_LIMIT = 10;

/**
 * Results to weigh for an ISRC search. One recording is often on many releases
 * (the album, its remasters, compilations), so this is wider than a name search.
 */
const ISRC_SEARCH_LIMIT = 20;

/**
 * Resolve a parsed collection to Qobuz ids (phase one).
 *
 * An item that already carries an id is taken as-is; otherwise it is searched
 * for and best-matched. Items that resolve to no id are reported in `unmatched`
 * rather than being fatal, and ids repeated across items are kept once.
 */
export async function resolveImport(
  client: ImportResolverClient,
  parsed: ParsedCollection,
): Promise<ImportPlan> {
  const matched: MatchedItem[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  const add = (label: string, match: Match | undefined): void => {
    if (match === undefined) {
      unmatched.push(label);
      return;
    }
    const key = String(match.id);
    if (seen.has(key)) return;
    seen.add(key);
    matched.push({ label, id: match.id, via: match.via });
  };

  // Resolve items through a bounded pool (results stay in input order), then run
  // the order-sensitive `add` reduction over them. A large import therefore does
  // not hold a single web request open long enough for the browser to abort the
  // fetch, while the first-occurrence de-duplication and reporting order are
  // unchanged.
  if (parsed.kind === "tracks") {
    const resolved = await mapWithConcurrency(
      parsed.items,
      DEFAULT_CONCURRENCY,
      async (item) => ({
        label: trackLabel(item),
        match: await resolveTrack(client, item),
      }),
    );
    for (const { label, match } of resolved) add(label, match);
  } else if (parsed.kind === "albums") {
    const resolved = await mapWithConcurrency(
      parsed.items,
      DEFAULT_CONCURRENCY,
      async (item) => ({
        label: albumLabel(item),
        match: await resolveAlbum(client, item),
      }),
    );
    for (const { label, match } of resolved) add(label, match);
  } else {
    const resolved = await mapWithConcurrency(
      parsed.items,
      DEFAULT_CONCURRENCY,
      async (item) => ({
        label: item.name ?? "(unknown)",
        match: await resolveArtist(client, item),
      }),
    );
    for (const { label, match } of resolved) add(label, match);
  }
  return { kind: parsed.kind, matched, unmatched };
}

/** A resolved Qobuz id and how it was found. */
interface Match {
  id: number | string;
  via: MatchMethod;
}

/**
 * Resolve one parsed track: its own id; else a search by its ISRC (the same
 * recording, see {@link pickByIsrc}); else an artist and title search.
 */
async function resolveTrack(
  client: ImportResolverClient,
  item: ParsedTrack,
): Promise<Match | undefined> {
  if (item.id !== undefined) {
    return { id: item.id, via: "id" };
  }
  if (item.isrc !== undefined && normaliseIsrc(item.isrc).length > 0) {
    const isrc = normaliseIsrc(item.isrc);
    const byIsrc = pickByIsrc(await client.searchTracks(isrc, ISRC_SEARCH_LIMIT), isrc, item);
    if (byIsrc !== undefined) {
      return { id: byIsrc.id, via: "isrc" };
    }
  }
  if (item.title === undefined) {
    return undefined;
  }
  // Search by the first credited artist and the title without its "feat." part:
  // Qobuz keeps featured artists in the version or artist, not the title.
  const artist = item.artists?.[0] ?? item.artist;
  const title = withoutFeaturing(item.title);
  const query = artist !== undefined ? `${artist} ${title}` : title;
  const candidates = await client.searchTracks(query, IMPORT_SEARCH_LIMIT);
  const picked = pickTrack(candidates, item);
  return picked === undefined ? undefined : { id: picked.id, via: "search" };
}

/** Resolve one parsed album to a Qobuz album id, choosing its best version. */
async function resolveAlbum(
  client: ImportResolverClient,
  item: ParsedAlbum,
): Promise<Match | undefined> {
  if (item.id !== undefined) {
    return { id: item.id, via: "id" };
  }
  if (item.title === undefined || item.artist === undefined) {
    return undefined;
  }
  const { resolvedAlbums } = await resolveAlbumVersions(client, {
    entries: [{ artist: item.artist, album: item.title }],
  });
  const resolved = resolvedAlbums[0];
  const id =
    resolved === undefined
      ? undefined
      : selectAlbumVersion(resolved.versions, "highest-quality")?.id;
  return id === undefined ? undefined : { id, via: "search" };
}

/** Resolve one parsed artist to a Qobuz artist id (exact name, else first hit). */
async function resolveArtist(
  client: ImportResolverClient,
  item: ParsedArtist,
): Promise<Match | undefined> {
  if (item.id !== undefined) {
    return { id: item.id, via: "id" };
  }
  if (item.name === undefined) {
    return undefined;
  }
  const candidates = await client.searchArtists(item.name, IMPORT_SEARCH_LIMIT);
  const wanted = item.name.trim().toLowerCase();
  const exact = candidates.find((a) => a.name.toLowerCase() === wanted);
  const id = (exact ?? candidates[0])?.id;
  return id === undefined ? undefined : { id, via: "search" };
}

/** ISRCs compare case-insensitively, ignoring hyphens and spaces. */
function normaliseIsrc(isrc: string): string {
  return isrc.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Of the results of an ISRC search, pick the best release of that recording.
 * Only results carrying exactly that ISRC count (a search can also return
 * near-misses). Among them: one Qobuz can stream (an unplayable release is no
 * use in a library), then the release whose album title matches the wanted
 * album, then the highest quality; ties keep Qobuz's order.
 */
function pickByIsrc(
  candidates: readonly Track[],
  isrc: string,
  want: ParsedTrack,
): Track | undefined {
  const wantAlbum = want.album === undefined ? undefined : normalise(want.album);
  const albumScore = (track: Track): number => {
    if (wantAlbum === undefined || wantAlbum.length === 0 || track.album === undefined) return 0;
    const album = normalise(track.album);
    if (album === wantAlbum) return 2;
    return tokensOverlap(tokens(album), tokens(wantAlbum)) ? 1 : 0;
  };
  const same = candidates.filter(
    (track) => track.isrc !== undefined && normaliseIsrc(track.isrc) === isrc,
  );
  return [...same].sort(
    (a, b) =>
      Number(b.streamable !== false) - Number(a.streamable !== false) ||
      albumScore(b) - albumScore(a) ||
      compareQuality(b, a),
  )[0];
}

/**
 * A trailing featured-artist credit in a title: "(feat. X)", "[with X]",
 * " - feat. X". Spotify keeps these in the title; Qobuz in the version.
 */
const FEATURING =
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+-\s+(?:feat\.?|ft\.?|featuring)\s.*$/gi;

function withoutFeaturing(title: string): string {
  const stripped = title.replace(FEATURING, "").trim();
  return stripped.length > 0 ? stripped : title;
}

/**
 * Pick the search result that best matches a wanted track. An ISRC match wins
 * outright; otherwise the title must match (with or without a "feat." credit,
 * and against Qobuz's title alone or title plus version, so Spotify's
 * "Song - Live" finds "Song" [Live]) and the artist tokens must overlap with
 * the credit or any one credited artist. A streamable match beats one that is
 * not.
 */
function pickTrack(candidates: readonly Track[], want: ParsedTrack): Track | undefined {
  if (want.isrc !== undefined) {
    const isrc = normaliseIsrc(want.isrc);
    const byIsrc = candidates.find(
      (c) => c.isrc !== undefined && normaliseIsrc(c.isrc) === isrc,
    );
    if (byIsrc !== undefined) return byIsrc;
  }
  const wantTitles = titleKeys(want.title ?? "");
  const wantArtists =
    want.artist === undefined
      ? undefined
      : [want.artist, ...(want.artists ?? [])].map(tokens);
  const matches = candidates.filter((candidate) => {
    const candidateTitles = [
      ...titleKeys(candidate.title),
      ...(candidate.version === undefined
        ? []
        : titleKeys(`${candidate.title} ${candidate.version}`)),
    ];
    if (!candidateTitles.some((key) => wantTitles.includes(key))) return false;
    if (wantArtists === undefined) return true;
    if (candidate.artist === undefined) return false;
    const candidateArtist = tokens(candidate.artist);
    return wantArtists.some((artist) => tokensOverlap(artist, candidateArtist));
  });
  return matches.find((track) => track.streamable !== false) ?? matches[0];
}

/** Normalised forms a title may be compared by: as given, and without "feat.". */
function titleKeys(title: string): string[] {
  const keys = [normalise(title), normalise(withoutFeaturing(title))];
  return keys.filter((key, index) => key.length > 0 && keys.indexOf(key) === index);
}

function tokens(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((token) => token.length > 0);
}

/** True when either token list is a subset of the other (catches band prefixes). */
function tokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) || b.every((t) => setA.has(t));
}

function trackLabel(item: ParsedTrack): string {
  return artistTitleLine({
    title: item.title ?? "(unknown)",
    artist: item.artist,
  });
}

function albumLabel(item: ParsedAlbum): string {
  return artistTitleLine({
    title: item.title ?? "(unknown)",
    artist: item.artist,
  });
}

// --- Commit (phase two) ----------------------------------------------------

/** The client surface needed to write imported items to a destination. */
export interface ImportWriterClient
  extends PlaylistWriterClient,
    ExistingPlaylistClient {
  addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void>;
  addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void>;
}

/** Where a matched set of ids is written. */
export type ImportTarget =
  | { type: "favourites" }
  | { type: "playlist-new"; name: string; isPublic?: boolean; description?: string }
  | { type: "playlist-existing"; playlistId: PlaylistId };

/** The result of committing an import. */
export interface CommitResult {
  /** How many items were written (favourites added, or playlist tracks added). */
  written: number;
  /** The playlist created or added to, when the target was a playlist. */
  playlist?: Playlist;
}

/**
 * Write a resolved plan to its destination (phase two).
 *
 * Favourites accept any kind (tracks, albums or artists route to the matching
 * favourite endpoint); a playlist target only accepts a track plan.
 *
 * @throws {Error} if a playlist target is given a non-track plan.
 */
export async function commitImport(
  client: ImportWriterClient,
  plan: ImportPlan,
  target: ImportTarget,
): Promise<CommitResult> {
  if (target.type === "favourites") {
    return commitToFavourites(client, plan);
  }
  if (plan.kind !== "tracks") {
    throw new Error("only tracks can be added to a playlist");
  }
  const trackIds = plan.matched.map((m) => m.id as number);
  if (target.type === "playlist-new") {
    const playlist = await createPlaylistWithTracks(client, {
      name: target.name,
      trackIds,
      isPublic: target.isPublic ?? false,
      ...(target.description !== undefined && { description: target.description }),
    });
    return { written: trackIds.length, playlist };
  }
  const { added } = await addTracksToExistingPlaylist(client, {
    playlistId: target.playlistId,
    trackIds,
  });
  return { written: added.length };
}

async function commitToFavourites(
  client: ImportWriterClient,
  plan: ImportPlan,
): Promise<CommitResult> {
  if (plan.kind === "tracks") {
    const ids = plan.matched.map((m) => m.id as number);
    await client.addFavoriteTracks(ids);
    return { written: ids.length };
  }
  if (plan.kind === "albums") {
    const ids = plan.matched.map((m) => m.id as string);
    await client.addFavoriteAlbums(ids);
    return { written: ids.length };
  }
  const ids = plan.matched.map((m) => m.id as number);
  await client.addFavoriteArtists(ids);
  return { written: ids.length };
}

// --- Export orchestration --------------------------------------------------

/** The client surface needed to read a collection or build a backup. */
export interface ExportClient {
  getFavoriteTracks(): Promise<Track[]>;
  getFavoriteAlbums(): Promise<Album[]>;
  getFavoriteArtists(): Promise<Artist[]>;
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

/** What to export. `account` is the full backup; the rest are single collections. */
export type ExportSource =
  | { type: "favourite-tracks" }
  | { type: "favourite-albums" }
  | { type: "favourite-artists" }
  | { type: "playlist"; playlistId: PlaylistId }
  | { type: "account" };

/** Read a single collection (not a full backup) from Qobuz. */
export async function collectCollection(
  client: ExportClient,
  source: Exclude<ExportSource, { type: "account" }>,
): Promise<Collection> {
  switch (source.type) {
    case "favourite-tracks":
      return { kind: "tracks", items: (await client.getFavoriteTracks()).map(toExportTrack) };
    case "favourite-albums":
      return { kind: "albums", items: (await client.getFavoriteAlbums()).map(toExportAlbum) };
    case "favourite-artists":
      return { kind: "artists", items: (await client.getFavoriteArtists()).map(toExportArtist) };
    case "playlist":
      return {
        kind: "tracks",
        items: (await client.getPlaylistTracks(source.playlistId)).map(toExportTrack),
      };
  }
}

/** Read every favourite collection and every owned playlist into a backup. */
export async function buildBackup(
  client: ExportClient,
  now: () => Date = () => new Date(),
): Promise<LibraryBackup> {
  const [tracks, albums, artists, playlists] = await Promise.all([
    client.getFavoriteTracks(),
    client.getFavoriteAlbums(),
    client.getFavoriteArtists(),
    client.getUserPlaylists(),
  ]);
  const exportPlaylists: ExportPlaylist[] = [];
  for (const playlist of playlists) {
    const playlistTracks = await client.getPlaylistTracks(playlist.id);
    exportPlaylists.push({ name: playlist.name, tracks: playlistTracks.map(toExportTrack) });
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now().toISOString(),
    favourites: {
      tracks: tracks.map(toExportTrack),
      albums: albums.map(toExportAlbum),
      artists: artists.map(toExportArtist),
    },
    playlists: exportPlaylists,
  };
}

/** One playlist written to its own file by {@link exportAllPlaylists}. */
export interface PlaylistFile {
  /** A safe file name, unique within the set (see {@link playlistFilenames}). */
  filename: string;
  playlist: Playlist;
  trackCount: number;
  content: string;
}

/**
 * Serialise every owned playlist to its own file in `format`, in playlist
 * order. Track lists are fetched through a small concurrency pool.
 */
export async function exportAllPlaylists(
  client: ExportClient,
  format: Format,
): Promise<PlaylistFile[]> {
  const playlists = await client.getUserPlaylists();
  const filenames = playlistFilenames(
    playlists.map((playlist) => playlist.name),
    extensionFor(format),
  );
  const trackLists = await mapWithConcurrency(playlists, DEFAULT_CONCURRENCY, (playlist) =>
    client.getPlaylistTracks(playlist.id),
  );
  return playlists.map((playlist, index) => {
    const items = trackLists[index]!.map(toExportTrack);
    return {
      filename: filenames[index]!,
      playlist,
      trackCount: items.length,
      content: serializeCollection({ kind: "tracks", items }, format),
    };
  });
}

/** The file extension for a format (plain text is `.txt`). */
export function extensionFor(format: Format): string {
  return format === "text" ? "txt" : format;
}

/** Longest file name stem kept, so names stay well inside filesystem limits. */
const MAX_FILENAME_STEM = 100;

/** Device names Windows reserves, with or without an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Turn playlist names into safe, unique file names with `extension`.
 *
 * Characters not allowed in file names on common systems (`/ \ : * ? " < > |`
 * and control characters) become `_`; leading and trailing spaces and dots are
 * trimmed; long names are capped; an empty name becomes "playlist"; a name
 * Windows reserves ("CON", "nul.txt") is prefixed with `_`. Repeated names --
 * compared ignoring case, as on macOS and Windows -- get " (2)", " (3)", ...
 */
export function playlistFilenames(names: readonly string[], extension: string): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const stem = safeStem(name);
    let candidate = `${stem}.${extension}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      candidate = `${stem} (${n}).${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function safeStem(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, MAX_FILENAME_STEM)
    .replace(/[\s.]+$/, "");
  if (cleaned.length === 0) {
    return "playlist";
  }
  return RESERVED_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
}

// --- Backup restore --------------------------------------------------------

/** The client surface a full-backup restore needs (favourites + playlists). */
export type RestoreClient = ImportWriterClient;

export interface RestoreResult {
  favouriteTracks: number;
  favouriteAlbums: number;
  favouriteArtists: number;
  /** One entry per playlist recreated, with the tracks added to it. */
  playlists: Array<{ name: string; trackCount: number }>;
}

/**
 * Restore a backup: re-favourite its tracks, albums and artists and recreate
 * each playlist. Ids in a backup are trusted (it was written by an export), so
 * no searching is needed. Playlists are always created anew.
 */
export async function restoreBackup(
  client: RestoreClient,
  backup: LibraryBackup,
): Promise<RestoreResult> {
  const trackIds = backup.favourites.tracks.map((t) => t.id);
  const albumIds = backup.favourites.albums.map((a) => a.id);
  const artistIds = backup.favourites.artists.map((a) => a.id);
  await client.addFavoriteTracks(trackIds);
  await client.addFavoriteAlbums(albumIds);
  await client.addFavoriteArtists(artistIds);

  const playlists: RestoreResult["playlists"] = [];
  for (const playlist of backup.playlists) {
    const ids = playlist.tracks.map((t) => t.id);
    await createPlaylistWithTracks(client, {
      name: playlist.name,
      trackIds: ids,
      isPublic: playlist.isPublic ?? false,
      ...(playlist.description !== undefined && { description: playlist.description }),
    });
    playlists.push({ name: playlist.name, trackCount: ids.length });
  }
  return {
    favouriteTracks: trackIds.length,
    favouriteAlbums: albumIds.length,
    favouriteArtists: artistIds.length,
    playlists,
  };
}

// --- Format helpers --------------------------------------------------------

/** Infer a format from a file name's extension, or undefined if unknown. */
export function formatFromFilename(filename: string): Format | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  switch (match?.[1]?.toLowerCase()) {
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "txt":
    case "text":
      return "text";
    case "m3u":
    case "m3u8":
      return "m3u";
    default:
      return undefined;
  }
}

/** Whether a byte string looks like a full backup rather than a plain collection. */
export function looksLikeBackup(content: string): boolean {
  try {
    const data: unknown = JSON.parse(content);
    return isRecord(data) && isRecord(data["favourites"]);
  } catch {
    return false;
  }
}

// --- Low-level parsing helpers ---------------------------------------------

/** Split into trimmed, non-empty lines (shared by the text and M3U readers). */
function splitLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Split "Artist - Title" on the first " - "; a lone value becomes the title. */
function splitArtistTitle(line: string): { artist?: string; title?: string } {
  const index = line.indexOf(" - ");
  if (index === -1) {
    return line.length > 0 ? { title: line } : {};
  }
  const artist = line.slice(0, index).trim();
  const title = line.slice(index + 3).trim();
  const out: { artist?: string; title?: string } = {};
  if (artist.length > 0) out.artist = artist;
  if (title.length > 0) out.title = title;
  return out;
}

/**
 * Parse CSV into rows of fields, honouring quoted fields (which may contain
 * commas, quotes as `""`, and newlines). Tolerant: a trailing newline yields no
 * empty final row.
 */
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

function emptyParsed(kind: CollectionKind): ParsedCollection {
  return kind === "tracks"
    ? { kind, items: [] }
    : kind === "albums"
      ? { kind, items: [] }
      : { kind, items: [] };
}

// --- JSON item readers -----------------------------------------------------

function parsedTrackFromJson(item: unknown): ParsedTrack {
  const out: ParsedTrack = {};
  if (!isRecord(item)) return out;
  if (typeof item["id"] === "number") out.id = item["id"];
  if (typeof item["title"] === "string") out.title = item["title"];
  if (typeof item["artist"] === "string") out.artist = item["artist"];
  if (typeof item["album"] === "string") out.album = item["album"];
  if (typeof item["isrc"] === "string") out.isrc = item["isrc"];
  return out;
}

function parsedAlbumFromJson(item: unknown): ParsedAlbum {
  const out: ParsedAlbum = {};
  if (!isRecord(item)) return out;
  if (typeof item["id"] === "string") out.id = item["id"];
  if (typeof item["title"] === "string") out.title = item["title"];
  if (typeof item["artist"] === "string") out.artist = item["artist"];
  return out;
}

function parsedArtistFromJson(item: unknown): ParsedArtist {
  const out: ParsedArtist = {};
  if (!isRecord(item)) return out;
  if (typeof item["id"] === "number") out.id = item["id"];
  if (typeof item["name"] === "string") out.name = item["name"];
  return out;
}

function exportTrackFromJson(item: unknown): ExportTrack {
  const parsed = parsedTrackFromJson(item);
  const out: ExportTrack = { id: parsed.id ?? 0, title: parsed.title ?? "" };
  if (parsed.artist !== undefined) out.artist = parsed.artist;
  if (parsed.album !== undefined) out.album = parsed.album;
  if (parsed.isrc !== undefined) out.isrc = parsed.isrc;
  return out;
}

function exportAlbumFromJson(item: unknown): ExportAlbum {
  const parsed = parsedAlbumFromJson(item);
  const out: ExportAlbum = { id: parsed.id ?? "", title: parsed.title ?? "" };
  if (parsed.artist !== undefined) out.artist = parsed.artist;
  return out;
}

function exportArtistFromJson(item: unknown): ExportArtist {
  const parsed = parsedArtistFromJson(item);
  return { id: parsed.id ?? 0, name: parsed.name ?? "" };
}

function exportPlaylistFromJson(item: unknown): ExportPlaylist {
  if (!isRecord(item)) {
    return { name: "", tracks: [] };
  }
  const out: ExportPlaylist = {
    name: typeof item["name"] === "string" ? item["name"] : "",
    tracks: arrayOf(item["tracks"]).map(exportTrackFromJson),
  };
  if (typeof item["description"] === "string") out.description = item["description"];
  if (typeof item["isPublic"] === "boolean") out.isPublic = item["isPublic"];
  return out;
}

// --- Misc helpers ----------------------------------------------------------

function numberIf(value: string | undefined, key: string): Record<string, number> {
  if (value === undefined) return {};
  const n = Number(value);
  return Number.isFinite(n) ? { [key]: n } : {};
}

function stringIf(value: string | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
