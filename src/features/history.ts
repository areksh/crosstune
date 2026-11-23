/**
 * History: the record of every change qobuz-helper makes to the account.
 *
 * Each user action (a CLI command, or one commit in the web UI) is one
 * {@link HistoryEntry} holding the {@link Operation}s it made, with exactly
 * what is needed to reverse them (see ./undo.ts): the playlists it created, the
 * playlist entries it added (by playlist-track id), the ones it removed (track
 * id and old position), and the favourites it added or removed.
 *
 * Entries are stored as JSON Lines, one record per line, append-only: undoing
 * an entry appends an `undone` marker rather than editing the entry. This
 * module holds the pure parts -- the record shapes, (de)serialisation,
 * pruning, folding the records into a list, and the labels and counts shown
 * for an entry. It imports nothing from Node, so the web UI uses it too; the
 * recording itself is in ./journal.ts and the file in src/cli/history-store.ts.
 */

import {
  readAlbumId,
  readId,
  shortId,
  type AlbumId,
  type AnyId,
  type EntryId,
  type PlaylistId,
  type TrackId,
} from "../services/ids.js";

/** The favourite collections an operation can touch. */
export type FavouriteType = "tracks" | "albums" | "artists";

/** One playlist entry: the track, its entry id, and its 0-based position. */
export interface PlaylistEntryRecord {
  trackId: TrackId;
  playlistTrackId: EntryId;
  /**
   * 0-based index in the playlist: for an added entry, where it landed; for a
   * removed one, where it was just before the removal.
   */
  position: number;
}

/** A playlist's editable details. */
export interface PlaylistDetails {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

/** One change made to the account, recorded with what reversing it needs. */
export type Operation =
  | {
      kind: "create-playlist";
      playlistId: PlaylistId;
      name: string;
      isPublic?: boolean;
      description?: string;
    }
  | {
      kind: "delete-playlist";
      playlistId: PlaylistId;
      name: string;
      /** The playlist's tracks, in order, when it was deleted. */
      trackIds: TrackId[];
      isPublic?: boolean;
      description?: string;
    }
  | {
      kind: "update-playlist";
      playlistId: PlaylistId;
      playlistName?: string;
      /** The details changed, as they were and as they were made. */
      before: PlaylistDetails;
      after: PlaylistDetails;
    }
  | {
      kind: "add-tracks";
      playlistId: PlaylistId;
      playlistName?: string;
      entries: PlaylistEntryRecord[];
      /**
       * Track ids sent but not confirmed (the playlist could not be read back
       * afterwards), so their entries are unknown.
       */
      unconfirmed?: TrackId[];
    }
  | {
      kind: "remove-tracks";
      playlistId: PlaylistId;
      playlistName?: string;
      entries: PlaylistEntryRecord[];
    }
  | {
      kind: "move-tracks";
      playlistId: PlaylistId;
      playlistName?: string;
      playlistTrackIds: EntryId[];
      insertBefore: number;
      /**
       * Where each entry was (0-based) just before the move, for undo. Absent
       * when the playlist could not be read, and in records made before this
       * was kept.
       */
      from?: number[];
    }
  | { kind: "add-favourites"; type: FavouriteType; ids: AnyId[] }
  | { kind: "remove-favourites"; type: FavouriteType; ids: AnyId[] };

/** Where an action came from. */
export type HistorySource = "cli" | "web";

/** One user action and the changes it made. */
export interface HistoryEntry {
  /** Short unique id, used by `undo <id>`. */
  id: string;
  /** When the action finished (ISO 8601). */
  at: string;
  /** The tool (CLI command name, or the web tool) that made the change. */
  tool: string;
  source: HistorySource;
  label: string;
  ops: Operation[];
  /** For an undo, the id of the entry it reversed. */
  undoes?: string;
  /** The action failed part-way; `ops` hold what did happen. */
  error?: string;
}

/** A line of the history file. */
export type HistoryRecord =
  | ({ type: "entry" } & HistoryEntry)
  | { type: "undone"; id: string; by?: string; at: string };

/** An entry as listed: with when (and by which entry) it was undone. */
export interface HistoryItem extends HistoryEntry {
  undone?: { at: string; by?: string };
}

/** How much history is kept: compaction drops the rest. */
export const HISTORY_LIMITS = { maxEntries: 200, maxAgeDays: 90 } as const;

export interface HistoryLimits {
  maxEntries: number;
  maxAgeDays: number;
}

/** The on-disk record format; lines with another version are ignored. */
const FORMAT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Serialise records as JSON Lines (one per line, newline-terminated). */
export function serializeRecords(records: readonly HistoryRecord[]): string {
  return records.map((r) => `${JSON.stringify({ v: FORMAT_VERSION, ...r })}\n`).join("");
}

/**
 * Parse a history file. Blank, malformed, other-version and invalid lines are
 * skipped, so a damaged line costs that line only.
 */
export function parseHistory(text: string): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = toRecord(value);
    if (parsed !== undefined) {
      records.push(parsed);
    }
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isIntArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isInt);
}

/** A list of ids, tagged or (in older lines) bare; undefined if any is not one. */
function readIds<T extends AnyId>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.map((id) => readId<T>(id));
  return ids.every((id) => id !== undefined) ? ids : undefined;
}

function readAlbumIds(value: unknown): AlbumId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.map(readAlbumId);
  return ids.every((id) => id !== undefined) ? ids : undefined;
}

function toRecord(value: unknown): HistoryRecord | undefined {
  if (!isRecord(value) || value["v"] !== FORMAT_VERSION) {
    return undefined;
  }
  const { id, at } = value;
  if (!isString(id) || !isString(at) || Number.isNaN(Date.parse(at))) {
    return undefined;
  }
  if (value["type"] === "undone") {
    return isString(value["by"]) ? { type: "undone", id, by: value["by"], at } : { type: "undone", id, at };
  }
  if (value["type"] !== "entry") {
    return undefined;
  }
  const { tool, source, label } = value;
  if (!isString(tool) || (source !== "cli" && source !== "web") || !isString(label)) {
    return undefined;
  }
  if (!Array.isArray(value["ops"])) {
    return undefined;
  }
  const ops: Operation[] = [];
  for (const raw of value["ops"]) {
    const op = toOperation(raw);
    if (op === undefined) {
      // An entry whose changes cannot all be read cannot be safely undone.
      return undefined;
    }
    ops.push(op);
  }
  const entry: { type: "entry" } & HistoryEntry = { type: "entry", id, at, tool, source, label, ops };
  if (isString(value["undoes"])) {
    entry.undoes = value["undoes"];
  }
  if (isString(value["error"])) {
    entry.error = value["error"];
  }
  return entry;
}

function toEntries(value: unknown): PlaylistEntryRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: PlaylistEntryRecord[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isInt(item["position"])) {
      return undefined;
    }
    const trackId = readId<TrackId>(item["trackId"]);
    const playlistTrackId = readId<EntryId>(item["playlistTrackId"]);
    if (trackId === undefined || playlistTrackId === undefined) {
      return undefined;
    }
    out.push({ trackId, playlistTrackId, position: item["position"] });
  }
  return out;
}

function toDetails(value: unknown): PlaylistDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(isString(value["name"]) && { name: value["name"] }),
    ...(isString(value["description"]) && { description: value["description"] }),
    ...(typeof value["isPublic"] === "boolean" && { isPublic: value["isPublic"] }),
  };
}

function isFavouriteType(value: unknown): value is FavouriteType {
  return value === "tracks" || value === "albums" || value === "artists";
}

function toOperation(value: unknown): Operation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value["kind"];
  if (kind === "add-favourites" || kind === "remove-favourites") {
    const { type } = value;
    if (!isFavouriteType(type)) {
      return undefined;
    }
    const ids = type === "albums" ? readAlbumIds(value["ids"]) : readIds<AnyId>(value["ids"]);
    return ids === undefined ? undefined : { kind, type, ids };
  }
  const playlistId = readId<PlaylistId>(value["playlistId"]);
  if (playlistId === undefined) {
    return undefined;
  }
  const playlistName = isString(value["playlistName"]) ? { playlistName: value["playlistName"] } : {};
  switch (kind) {
    case "create-playlist": {
      if (!isString(value["name"])) {
        return undefined;
      }
      return {
        kind: "create-playlist",
        playlistId,
        name: value["name"],
        ...(typeof value["isPublic"] === "boolean" && { isPublic: value["isPublic"] }),
        ...(isString(value["description"]) && { description: value["description"] }),
      };
    }
    case "delete-playlist": {
      const trackIds = readIds<TrackId>(value["trackIds"]);
      if (!isString(value["name"]) || trackIds === undefined) {
        return undefined;
      }
      return {
        kind: "delete-playlist",
        playlistId,
        name: value["name"],
        trackIds,
        ...(typeof value["isPublic"] === "boolean" && { isPublic: value["isPublic"] }),
        ...(isString(value["description"]) && { description: value["description"] }),
      };
    }
    case "update-playlist": {
      const before = toDetails(value["before"]);
      const after = toDetails(value["after"]);
      return before === undefined || after === undefined
        ? undefined
        : { kind: "update-playlist", playlistId, ...playlistName, before, after };
    }
    case "add-tracks":
    case "remove-tracks": {
      const entries = toEntries(value["entries"]);
      if (entries === undefined) {
        return undefined;
      }
      if (value["kind"] === "remove-tracks") {
        return { kind: "remove-tracks", playlistId, ...playlistName, entries };
      }
      const unconfirmed = value["unconfirmed"] === undefined ? undefined : readIds<TrackId>(value["unconfirmed"]);
      if (value["unconfirmed"] !== undefined && unconfirmed === undefined) {
        return undefined;
      }
      return {
        kind: "add-tracks",
        playlistId,
        ...playlistName,
        entries,
        ...(unconfirmed !== undefined && { unconfirmed }),
      };
    }
    case "move-tracks": {
      const playlistTrackIds = readIds<EntryId>(value["playlistTrackIds"]);
      if (playlistTrackIds === undefined || !isInt(value["insertBefore"])) {
        return undefined;
      }
      return {
        kind: "move-tracks",
        playlistId,
        ...playlistName,
        playlistTrackIds,
        insertBefore: value["insertBefore"],
        ...(isIntArray(value["from"]) &&
          value["from"].length === playlistTrackIds.length && { from: value["from"] }),
      };
    }
    default:
      return undefined;
  }
}

/** Fold records into the entry list, newest first, with undone markers applied. */
export function foldHistory(records: readonly HistoryRecord[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const undone = new Map<string, { at: string; by?: string }>();
  for (const record of records) {
    if (record.type === "undone") {
      undone.set(record.id, record.by === undefined ? { at: record.at } : { at: record.at, by: record.by });
    } else {
      const { type: _type, ...entry } = record;
      items.push(entry);
    }
  }
  for (const item of items) {
    const marker = undone.get(item.id);
    if (marker !== undefined) {
      item.undone = marker;
    }
  }
  // Stable: entries written in the same millisecond keep file order.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Date.parse(b.item.at) - Date.parse(a.item.at) || b.index - a.index)
    .map(({ item }) => item);
}

/**
 * Keep the entries younger than `maxAgeDays`, at most the newest `maxEntries`
 * of them, and the undone markers of the entries kept.
 */
export function pruneRecords(
  records: readonly HistoryRecord[],
  now: Date,
  limits: HistoryLimits = HISTORY_LIMITS,
): HistoryRecord[] {
  const cutoff = now.getTime() - limits.maxAgeDays * DAY_MS;
  const fresh = records.filter((r) => r.type === "entry" && Date.parse(r.at) >= cutoff);
  const keep = new Set(
    fresh
      .map((r, index) => ({ r, index }))
      .sort((a, b) => Date.parse(b.r.at) - Date.parse(a.r.at) || b.index - a.index)
      .slice(0, limits.maxEntries)
      .map(({ r }) => r.id),
  );
  return records.filter((r) => keep.has(r.id) && (r.type === "undone" || Date.parse(r.at) >= cutoff));
}

/** How many items an entry added and removed (tracks, albums and artists alike). */
export function summarise(entry: HistoryEntry): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of entry.ops) {
    switch (op.kind) {
      case "add-tracks":
        added += op.entries.length + (op.unconfirmed?.length ?? 0);
        break;
      case "add-favourites":
        added += op.ids.length;
        break;
      case "remove-tracks":
        removed += op.entries.length;
        break;
      case "remove-favourites":
        removed += op.ids.length;
        break;
      case "delete-playlist":
        removed += op.trackIds.length;
        break;
      default:
        break;
    }
  }
  return { added, removed };
}

/** "1 track", "2 tracks". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const FAVOURITE_NOUNS: Record<FavouriteType, string> = {
  tracks: "track",
  albums: "album",
  artists: "artist",
};

/** Favourites counts by type, as "100 tracks and 3 albums". */
function favouriteCounts(ops: readonly Operation[], kind: "add-favourites" | "remove-favourites"): string {
  const counts = new Map<FavouriteType, number>();
  for (const op of ops) {
    if (op.kind === kind) {
      counts.set(op.type, (counts.get(op.type) ?? 0) + op.ids.length);
    }
  }
  return joinAnd(
    (["tracks", "albums", "artists"] as const)
      .filter((type) => (counts.get(type) ?? 0) > 0)
      .map((type) => plural(counts.get(type)!, FAVOURITE_NOUNS[type])),
  );
}

/** A playlist's name as the ops know it, else "playlist <id>". */
function playlistNamer(ops: readonly Operation[]): (id: PlaylistId) => string {
  const names = new Map<PlaylistId, string>();
  for (const op of ops) {
    if (op.kind === "create-playlist" || op.kind === "delete-playlist") {
      names.set(op.playlistId, op.name);
    } else if ("playlistName" in op && op.playlistName !== undefined && !names.has(op.playlistId)) {
      names.set(op.playlistId, op.playlistName);
    }
  }
  return (id) => names.get(id) ?? `playlist ${shortId(id)}`;
}

/** Sum of entries per playlist for one op kind, in first-seen order. */
function countByPlaylist(ops: readonly Operation[], kind: "add-tracks" | "remove-tracks"): Map<PlaylistId, number> {
  const counts = new Map<PlaylistId, number>();
  for (const op of ops) {
    if (op.kind === kind) {
      const n = op.entries.length + (op.kind === "add-tracks" ? (op.unconfirmed?.length ?? 0) : 0);
      counts.set(op.playlistId, (counts.get(op.playlistId) ?? 0) + n);
    }
  }
  return counts;
}

/** Where a set of changes happened: "Favourites", a playlist's name, "2 playlists". */
function placeOf(playlistIds: readonly PlaylistId[], favourites: boolean, name: (id: PlaylistId) => string): string {
  const playlists =
    playlistIds.length === 1 ? name(playlistIds[0]!) : plural(playlistIds.length, "playlist");
  if (!favourites) {
    return playlists;
  }
  return playlistIds.length === 0 ? "Favourites" : `Favourites and ${playlists}`;
}

/**
 * A one-line label for an entry, e.g. "Created Road Trip with 15 tracks" or
 * "Removed 12 duplicates from Favourites", built from its operations (and the
 * tool, which picks the wording for the deduplicator, upgrade and import).
 */
export function describeEntry(tool: string, ops: readonly Operation[]): string {
  const name = playlistNamer(ops);
  const added = countByPlaylist(ops, "add-tracks");
  const removed = countByPlaylist(ops, "remove-tracks");
  const favAdded = ops.filter((op) => op.kind === "add-favourites").reduce((n, op) => n + op.ids.length, 0);
  const favRemoved = ops.filter((op) => op.kind === "remove-favourites").reduce((n, op) => n + op.ids.length, 0);

  if (tool === "deduplicate" && added.size === 0 && favAdded === 0 && (removed.size > 0 || favRemoved > 0)) {
    const total = [...removed.values()].reduce((a, b) => a + b, 0) + favRemoved;
    return `Removed ${plural(total, "duplicate")} from ${placeOf([...removed.keys()], favRemoved > 0, name)}`;
  }
  if (tool === "upgrade" && (added.size > 0 || favAdded > 0)) {
    const replaced = [...added.values()].reduce((a, b) => a + b, 0) + favAdded;
    const gone = [...removed.values()].reduce((a, b) => a + b, 0) + favRemoved;
    const places = placeOf([...new Set([...added.keys(), ...removed.keys()])], favAdded + favRemoved > 0, name);
    const extra = gone > replaced ? ` and removed ${gone - replaced}` : "";
    return `Upgraded ${plural(replaced, "track")} in ${places}${extra}`;
  }

  const importing = tool === "import" || tool === "restore";
  const clauses: string[] = [];
  const favAddText = favouriteCounts(ops, "add-favourites");
  if (favAddText.length > 0) {
    clauses.push(importing ? `imported ${favAddText} into Favourites` : `added ${favAddText} to Favourites`);
  }
  const created = ops.filter((op) => op.kind === "create-playlist");
  const createdIds = new Set(created.map((op) => op.playlistId));
  if (created.length === 1) {
    const only = created[0]!;
    const n = added.get(only.playlistId) ?? 0;
    clauses.push(`created ${only.name}${n > 0 ? ` with ${plural(n, "track")}` : ""}`);
  } else if (created.length > 1) {
    const n = created.reduce((sum, op) => sum + (added.get(op.playlistId) ?? 0), 0);
    clauses.push(`created ${plural(created.length, "playlist")}${n > 0 ? ` with ${plural(n, "track")}` : ""}`);
  }
  for (const [id, n] of added) {
    if (!createdIds.has(id)) {
      clauses.push(importing ? `imported ${plural(n, "track")} into ${name(id)}` : `added ${plural(n, "track")} to ${name(id)}`);
    }
  }
  for (const [id, n] of removed) {
    clauses.push(`removed ${plural(n, "track")} from ${name(id)}`);
  }
  const favRemoveText = favouriteCounts(ops, "remove-favourites");
  if (favRemoveText.length > 0) {
    clauses.push(`removed ${favRemoveText} from Favourites`);
  }
  for (const op of ops) {
    if (op.kind === "delete-playlist") {
      clauses.push(`deleted ${op.name}`);
    } else if (op.kind === "update-playlist") {
      clauses.push(...describeDetails(op, name(op.playlistId)));
    }
  }
  if (tool === "playlist-manager") {
    const reordered = new Set(ops.flatMap((op) => (op.kind === "move-tracks" ? [op.playlistId] : [])));
    reordered.forEach((id) => clauses.push(`reordered ${name(id)}`));
  }
  if (clauses.length === 0) {
    const moved = ops.find((op) => op.kind === "move-tracks");
    if (moved === undefined) {
      return "No changes";
    }
    clauses.push(`reordered ${name(moved.playlistId)}`);
  }
  const text = clauses.length > 3 ? [...clauses.slice(0, 2), `${clauses.length - 2} more changes`] : clauses;
  const joined = text.join("; ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** What a change of details did, as clauses ("renamed A to B"). */
function describeDetails(
  op: Extract<Operation, { kind: "update-playlist" }>,
  fallback: string,
): string[] {
  const { before, after } = op;
  const was = before.name ?? op.playlistName ?? fallback;
  const clauses: string[] = [];
  if (after.name !== undefined && after.name !== before.name) {
    clauses.push(`renamed ${was} to ${after.name}`);
  }
  if (after.isPublic !== undefined && after.isPublic !== before.isPublic) {
    clauses.push(`made ${after.name ?? was} ${after.isPublic ? "public" : "private"}`);
  }
  if (after.description !== undefined && after.description !== before.description) {
    clauses.push(`changed the description of ${after.name ?? was}`);
  }
  return clauses;
}

/** The playlists and favourite collections an entry touched, as keys. */
export function touchedTargets(entry: HistoryEntry): Set<string> {
  const targets = new Set<string>();
  for (const op of entry.ops) {
    if (op.kind === "add-favourites" || op.kind === "remove-favourites") {
      targets.add(`favourites:${op.type}`);
    } else {
      targets.add(`playlist:${op.playlistId}`);
    }
  }
  return targets;
}

/**
 * The entries made after `item` (and not undone, nor undoing it) that touched
 * one of the same playlists or favourite collections: undoing `item` may then
 * not restore exactly what it found.
 */
export function laterConflicts(item: HistoryEntry, items: readonly HistoryItem[]): HistoryItem[] {
  const mine = touchedTargets(item);
  const at = Date.parse(item.at);
  return items
    .filter(
      (other) =>
        other.id !== item.id &&
        other.undone === undefined &&
        other.undoes !== item.id &&
        Date.parse(other.at) > at &&
        [...touchedTargets(other)].some((target) => mine.has(target)),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The entry `undo` acts on: the one with `id`, or else the latest that is not
 * undone and is not itself an undo (so repeated undos walk back in time).
 */
export function selectEntry(items: readonly HistoryItem[], id?: string): HistoryItem | undefined {
  if (id !== undefined) {
    return items.find((item) => item.id === id);
  }
  return items.find((item) => item.undone === undefined && item.undoes === undefined);
}

/** An entry for listing: no operations, just what they amount to. */
export interface HistorySummary {
  id: string;
  at: string;
  tool: string;
  toolName: string;
  source: HistorySource;
  label: string;
  added: number;
  removed: number;
  undoes?: string;
  undoneAt?: string;
  error?: string;
}

/** Summarise an item for a list (the web UI, `history --json`). */
export function toSummary(item: HistoryItem): HistorySummary {
  const summary: HistorySummary = {
    id: item.id,
    at: item.at,
    tool: item.tool,
    toolName: toolName(item.tool),
    source: item.source,
    label: item.label,
    ...summarise(item),
  };
  if (item.undoes !== undefined) {
    summary.undoes = item.undoes;
  }
  if (item.undone !== undefined) {
    summary.undoneAt = item.undone.at;
  }
  if (item.error !== undefined) {
    summary.error = item.error;
  }
  return summary;
}

const TOOL_NAMES: Record<string, string> = {
  "playlist-from-artists": "Playlist from artists",
  "playlist-from-albums": "Playlist from albums",
  "similar-artists": "Similar artists",
  "word-play": "Word play",
  deduplicate: "Deduplicator",
  combine: "Combine playlists",
  upgrade: "Upgrade & repair",
  stats: "Library stats",
  "new-releases": "New releases",
  managed: "Managed playlist",
  "playlist-manager": "Playlist manager",
  "remove-artists": "Remove artists",
  import: "Import",
  restore: "Restore backup",
  undo: "Undo",
  playlist: "Playlist",
  other: "Other",
};

/** The tools a web commit may name itself as. */
export const HISTORY_TOOLS: readonly string[] = Object.keys(TOOL_NAMES);

/** A tool's display name, e.g. "Deduplicator" for `deduplicate`. */
export function toolName(tool: string): string {
  return TOOL_NAMES[tool] ?? tool;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", "28 October", or "31 December 2025" (local time). */
export function dayLabel(at: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  const base = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? base : `${base} ${at.getFullYear()}`;
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago". */
export function timeAgo(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${plural(minutes, "minute")} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${plural(hours, "hour")} ago`;
  }
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  return days <= 1 ? "yesterday" : `${days} days ago`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "21:26" (local time). */
export function clockTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "2026-11-02 21:26" (local time). */
function dateTime(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockTime(at)}`;
}

/** "+15 -4", "+15", "-12", or "" when nothing was added or removed. */
export function countsText(counts: { added: number; removed: number }): string {
  return [counts.added > 0 ? `+${counts.added}` : "", counts.removed > 0 ? `-${counts.removed}` : ""]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** The `history` command's list: one line per entry, newest first. */
export function formatHistoryList(items: readonly HistoryItem[]): string {
  if (items.length === 0) {
    return "No changes recorded yet.";
  }
  return items
    .map((item) => {
      const counts = countsText(summarise(item));
      const parts = [item.id, dateTime(new Date(item.at)), item.label];
      if (counts.length > 0) {
        parts.push(counts);
      }
      parts.push(`(${toolName(item.tool)})`);
      if (item.error !== undefined) {
        parts.push("[failed part-way]");
      }
      if (item.undone !== undefined) {
        parts.push("[undone]");
      }
      return parts.join("  ");
    })
    .join("\n");
}
