/**
 * Undo: reverse what one history entry changed.
 *
 * Split like every tool. {@link planUndo} (resolve) reads the playlists the
 * entry touched and builds the steps that reverse it, with notes on what
 * cannot be restored and warnings about later entries that touched the same
 * places; {@link commitUndo} runs the steps, reporting each failure without
 * stopping. {@link applyUndo} runs the commit as an entry of its own ("Undid:
 * ...") and marks the original undone.
 *
 * Per playlist, undo first removes the entries the change added (by their
 * playlist-track ids; ones already gone are skipped and reported), then puts
 * the removed tracks back -- appended, then moved to their old positions --
 * latest removal first, and finally deletes a playlist the change created if
 * it holds nothing else. Removed positions were recorded with the change's own
 * additions at the end of the playlist, which is how every tool adds, so
 * taking those additions out first makes the positions line up again.
 * Favourites are re-added or removed. Reordering of entries the change did
 * not add is reported, not reversed.
 */

import type { Playlist, Track } from "../qobuz/index.js";
import {
  laterConflicts,
  type FavouriteType,
  type HistoryItem,
  type Operation,
} from "./history.js";
import type { Journal } from "./journal.js";

/** The read planning needs. */
export interface UndoPlanClient {
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
}

/** Everything undoing can call; QobuzClient (recorded) satisfies it. */
export interface UndoClient extends UndoPlanClient {
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  deletePlaylist(playlistId: number): Promise<void>;
  addTracksToPlaylist(playlistId: number, trackIds: readonly number[]): Promise<void>;
  removeTracksFromPlaylist(playlistId: number, playlistTrackIds: readonly number[]): Promise<void>;
  movePlaylistTracks?(
    playlistId: number,
    playlistTrackIds: readonly number[],
    insertBefore: number,
  ): Promise<void>;
  addFavoriteTracks(trackIds: readonly number[]): Promise<void>;
  addFavoriteAlbums(albumIds: readonly string[]): Promise<void>;
  addFavoriteArtists(artistIds: readonly number[]): Promise<void>;
  removeFavoriteTracks(trackIds: readonly number[]): Promise<void>;
  removeFavoriteAlbums(albumIds: readonly string[]): Promise<void>;
  removeFavoriteArtists(artistIds: readonly number[]): Promise<void>;
}

/** One reversing step. */
export type UndoStep =
  | { kind: "delete-playlist"; playlistId: number; name: string; trackCount: number }
  | { kind: "remove-tracks"; playlistId: number; name: string; playlistTrackIds: number[] }
  | {
      kind: "restore-tracks";
      playlistId: number;
      name: string;
      /** In ascending order of their old 0-based position. */
      tracks: Array<{ trackId: number; position: number }>;
    }
  | { kind: "recreate-playlist"; name: string; trackIds: number[]; isPublic?: boolean }
  | { kind: "add-favourites"; type: FavouriteType; ids: Array<number | string> }
  | { kind: "remove-favourites"; type: FavouriteType; ids: Array<number | string> };

export interface UndoPlan {
  entryId: string;
  label: string;
  steps: UndoStep[];
  /** What will not be restored, and why. */
  notes: string[];
  /** Later entries that touched the same playlists or favourites. */
  warnings: string[];
  /** Set when the entry cannot be undone at all (e.g. already undone). */
  blocked?: string;
}

export interface UndoResult {
  /** The steps that went through. */
  done: string[];
  failed: Array<{ step: string; reason: string }>;
  /** What went through only in part. */
  notes: string[];
}

export interface UndoOutcome extends UndoResult {
  /** Whether the entry is now marked undone (not when every step failed). */
  undone: boolean;
  /** The id of the "Undid: ..." entry. */
  entryId: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const NOUNS: Record<FavouriteType, string> = { tracks: "track", albums: "album", artists: "artist" };

/** A step in words, e.g. "Remove 2 tracks from Late Night". */
export function describeStep(step: UndoStep): string {
  switch (step.kind) {
    case "delete-playlist":
      return `Delete the playlist ${step.name} (${plural(step.trackCount, "track")})`;
    case "remove-tracks":
      return `Remove ${plural(step.playlistTrackIds.length, "track")} from ${step.name}`;
    case "restore-tracks":
      return `Put ${plural(step.tracks.length, "track")} back in ${step.name}, in their old places`;
    case "recreate-playlist":
      return `Recreate the playlist ${step.name} with ${plural(step.trackIds.length, "track")}`;
    case "add-favourites":
      return `Add ${plural(step.ids.length, NOUNS[step.type])} back to Favourites`;
    case "remove-favourites":
      return `Remove ${plural(step.ids.length, NOUNS[step.type])} from Favourites`;
  }
}

function playlistIdOf(op: Operation): number | undefined {
  return op.kind === "add-favourites" || op.kind === "remove-favourites" ? undefined : op.playlistId;
}

/**
 * Plan the undo of `item` against the account as it is now (reading each
 * playlist it touched). `items` is the whole history, for the warnings.
 */
export async function planUndo(
  client: UndoPlanClient,
  item: HistoryItem,
  items: readonly HistoryItem[],
): Promise<UndoPlan> {
  const plan: UndoPlan = { entryId: item.id, label: item.label, steps: [], notes: [], warnings: [] };
  if (item.undone !== undefined) {
    plan.blocked = `Already undone (${item.undone.at}).`;
    return plan;
  }
  for (const later of laterConflicts(item, items)) {
    plan.warnings.push(`A later change also touched it: "${later.label}".`);
  }

  const ops = item.ops;
  const names = new Map<number, string>();
  for (const op of ops) {
    if (op.kind === "create-playlist" || op.kind === "delete-playlist") {
      names.set(op.playlistId, op.name);
    } else if ("playlistName" in op && op.playlistName !== undefined && !names.has(op.playlistId)) {
      names.set(op.playlistId, op.playlistName);
    }
  }
  const nameOf = (id: number): string => names.get(id) ?? `playlist ${id}`;

  // Read each playlist the entry changed (a deleted one needs no read).
  const current = new Map<number, Track[] | undefined>();
  for (const op of ops) {
    const id = playlistIdOf(op);
    if (id !== undefined && op.kind !== "delete-playlist" && !current.has(id)) {
      try {
        current.set(id, await client.getPlaylistTracks(id));
      } catch {
        current.set(id, undefined);
      }
    }
  }

  // Iterate from the last operation; a playlist's whole reversal is planned
  // where its last operation is met.
  const planned = new Set<number>();
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]!;
    switch (op.kind) {
      case "add-favourites":
        plan.steps.push({ kind: "remove-favourites", type: op.type, ids: [...op.ids] });
        break;
      case "remove-favourites":
        plan.steps.push({ kind: "add-favourites", type: op.type, ids: [...op.ids] });
        break;
      case "delete-playlist":
        plan.steps.push({
          kind: "recreate-playlist",
          name: op.name,
          trackIds: [...op.trackIds],
          ...(op.isPublic !== undefined && { isPublic: op.isPublic }),
        });
        break;
      default:
        if (!planned.has(op.playlistId)) {
          planned.add(op.playlistId);
          planPlaylist(plan, op.playlistId, nameOf(op.playlistId), ops, current.get(op.playlistId));
        }
    }
  }
  return plan;
}

/** Plan the reversal of everything `ops` did to one playlist. */
function planPlaylist(
  plan: UndoPlan,
  playlistId: number,
  name: string,
  ops: readonly Operation[],
  tracks: Track[] | undefined,
): void {
  const mine = ops.filter((op) => playlistIdOf(op) === playlistId);
  const created = mine.some((op) => op.kind === "create-playlist");
  if (tracks === undefined) {
    plan.notes.push(
      created
        ? `${name} no longer exists, so there is nothing to undo there.`
        : `${name} no longer exists (or cannot be read), so its changes are not undone.`,
    );
    return;
  }
  const present = new Set(tracks.map((t) => t.playlistTrackId));
  const added = new Set<number>();
  const removed = new Set<number>();
  let unconfirmed = 0;
  for (const op of mine) {
    if (op.kind === "add-tracks") {
      op.entries.forEach((e) => added.add(e.playlistTrackId));
      unconfirmed += op.unconfirmed?.length ?? 0;
    } else if (op.kind === "remove-tracks") {
      op.entries.forEach((e) => removed.add(e.playlistTrackId));
    }
  }

  const onlyOurs = tracks.every((t) => t.playlistTrackId !== undefined && added.has(t.playlistTrackId));
  if (created && onlyOurs) {
    plan.steps.push({ kind: "delete-playlist", playlistId, name, trackCount: tracks.length });
    return;
  }
  if (created) {
    plan.notes.push(
      `Kept the playlist ${name}: it now has tracks this change did not add, so only the added ones are removed.`,
    );
  }

  // 1. Take out what the change added (and did not itself remove again).
  const toRemove = [...added].filter((id) => !removed.has(id) && present.has(id));
  const gone = [...added].filter((id) => !removed.has(id) && !present.has(id)).length;
  if (gone > 0) {
    plan.notes.push(`${gone} of the tracks added to ${name} ${gone === 1 ? "is" : "are"} no longer in it.`);
  }
  if (unconfirmed > 0) {
    plan.notes.push(
      `${plural(unconfirmed, "track")} sent to ${name} could not be confirmed when added, so ${unconfirmed === 1 ? "it is" : "they are"} not removed.`,
    );
  }
  if (toRemove.length > 0) {
    plan.steps.push({ kind: "remove-tracks", playlistId, name, playlistTrackIds: toRemove });
  }

  // 2. Put back what it removed, latest removal first.
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const op = mine[i]!;
    if (op.kind !== "remove-tracks") {
      continue;
    }
    const restore = op.entries
      .filter((e) => !added.has(e.playlistTrackId))
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ trackId: e.trackId, position: e.position }));
    if (restore.length > 0) {
      plan.steps.push({ kind: "restore-tracks", playlistId, name, tracks: restore });
    }
  }

  // 3. Reordering of entries it did not add is not reversed.
  const reordered = new Set<number>();
  for (const op of mine) {
    if (op.kind === "move-tracks") {
      op.playlistTrackIds.filter((id) => !added.has(id) && present.has(id)).forEach((id) => reordered.add(id));
    }
  }
  if (reordered.size > 0) {
    plan.notes.push(`The order of ${plural(reordered.size, "track")} in ${name} is not restored.`);
  }
}

/** A move that puts restored entries back: `count` of them from index `from`. */
export interface RestoreMove {
  /** Index into the restored entries (in ascending position order). */
  from: number;
  count: number;
  /** 1-based position of the entry to insert in front of (Qobuz's insert_before). */
  insertBefore: number;
}

/**
 * The moves that put restored entries back at their old 0-based `positions`
 * (ascending), after they were appended to a playlist of `kept` other
 * entries. Moved in ascending order, every earlier position is settled and the
 * not-yet-moved ones are still at the end, so the entry now at the target
 * index is the one to go in front of. Consecutive targets move together;
 * entries whose target is at or past the end stay where they are.
 */
export function restoreMoves(kept: number, positions: readonly number[]): RestoreMove[] {
  const moves: RestoreMove[] = [];
  positions.forEach((position, i) => {
    if (position >= kept + i) {
      return;
    }
    const last = moves[moves.length - 1];
    if (last !== undefined && last.from + last.count === i && last.insertBefore - 1 + last.count === position) {
      last.count += 1;
    } else {
      moves.push({ from: i, count: 1, insertBefore: position + 1 });
    }
  });
  return moves;
}

/**
 * Add tracks in order, in as few requests as possible with no track id twice
 * in one: Qobuz adds a track repeated within one request only once, while
 * separate requests may add it again (checked live, November 2026).
 */
async function addInOrder(
  client: UndoClient,
  playlistId: number,
  trackIds: readonly number[],
): Promise<void> {
  let request: number[] = [];
  for (const id of trackIds) {
    if (request.includes(id)) {
      await client.addTracksToPlaylist(playlistId, request);
      request = [];
    }
    request.push(id);
  }
  await client.addTracksToPlaylist(playlistId, request);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the steps of a plan in order, reporting each failure and carrying on. */
export async function commitUndo(client: UndoClient, plan: UndoPlan): Promise<UndoResult> {
  const result: UndoResult = { done: [], failed: [], notes: [] };
  for (const step of plan.steps) {
    const text = describeStep(step);
    try {
      await runStep(client, step, result);
      result.done.push(text);
    } catch (error) {
      result.failed.push({ step: text, reason: messageOf(error) });
    }
  }
  return result;
}

async function runStep(client: UndoClient, step: UndoStep, result: UndoResult): Promise<void> {
  switch (step.kind) {
    case "delete-playlist":
      return client.deletePlaylist(step.playlistId);
    case "remove-tracks":
      return client.removeTracksFromPlaylist(step.playlistId, step.playlistTrackIds);
    case "recreate-playlist": {
      const playlist = await client.createPlaylist(step.name, { isPublic: step.isPublic ?? false });
      return addInOrder(client, playlist.id, step.trackIds);
    }
    case "restore-tracks":
      return restoreTracks(client, step, result);
    case "add-favourites":
      return step.type === "tracks"
        ? client.addFavoriteTracks(step.ids.map(Number))
        : step.type === "albums"
          ? client.addFavoriteAlbums(step.ids.map(String))
          : client.addFavoriteArtists(step.ids.map(Number));
    case "remove-favourites":
      return step.type === "tracks"
        ? client.removeFavoriteTracks(step.ids.map(Number))
        : step.type === "albums"
          ? client.removeFavoriteAlbums(step.ids.map(String))
          : client.removeFavoriteArtists(step.ids.map(Number));
  }
}

/** Re-add removed tracks (they land at the end), then move them back into place. */
async function restoreTracks(
  client: UndoClient,
  step: Extract<UndoStep, { kind: "restore-tracks" }>,
  result: UndoResult,
): Promise<void> {
  const before = await client.getPlaylistTracks(step.playlistId);
  await addInOrder(
    client,
    step.playlistId,
    step.tracks.map((t) => t.trackId),
  );
  const atEnd = (count: number): void => {
    result.notes.push(
      `${plural(count, "track")} ${count === 1 ? "was" : "were"} put back at the end of ${step.name}, not in ${count === 1 ? "its old place" : "their old places"}.`,
    );
  };
  const moves = restoreMoves(
    before.length,
    step.tracks.map((t) => t.position),
  );
  if (moves.length === 0) {
    return;
  }
  if (client.movePlaylistTracks === undefined) {
    atEnd(moves.reduce((n, m) => n + m.count, 0));
    return;
  }
  // Find the new entries: those not there before, matched to the tracks in order.
  let after: Track[];
  try {
    after = await client.getPlaylistTracks(step.playlistId);
  } catch {
    atEnd(moves.reduce((n, m) => n + m.count, 0));
    return;
  }
  const known = new Set(before.map((t) => t.playlistTrackId));
  const arrived = new Map<number, number[]>();
  for (const track of after) {
    if (track.playlistTrackId !== undefined && !known.has(track.playlistTrackId)) {
      arrived.set(track.id, [...(arrived.get(track.id) ?? []), track.playlistTrackId]);
    }
  }
  const entryIds = step.tracks.map((t) => arrived.get(t.trackId)?.shift());
  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i]!;
    const ids = entryIds.slice(move.from, move.from + move.count);
    if (ids.some((id) => id === undefined)) {
      atEnd(moves.slice(i).reduce((n, m) => n + m.count, 0));
      return;
    }
    try {
      await client.movePlaylistTracks(step.playlistId, ids as number[], move.insertBefore);
    } catch {
      atEnd(moves.slice(i).reduce((n, m) => n + m.count, 0));
      return;
    }
  }
}

const UNDID = "Undid: ";

/**
 * Undo an entry: commit the plan as an "Undid: ..." entry of its own (so the
 * undo can itself be undone), then mark the original undone -- unless every
 * step failed, so it can be tried again.
 *
 * `client` should record into `journal` (see recordingClient).
 *
 * @throws {Error} if the plan is blocked (e.g. the entry is already undone).
 */
export async function applyUndo(
  journal: Journal,
  client: UndoClient,
  item: HistoryItem,
  plan: UndoPlan,
): Promise<UndoOutcome> {
  if (plan.blocked !== undefined) {
    throw new Error(plan.blocked);
  }
  let entryId = "";
  // Undoing an undo redoes the original change.
  const label =
    item.undoes !== undefined && item.label.startsWith(UNDID)
      ? `Redid: ${item.label.slice(UNDID.length)}`
      : `${UNDID}${item.label}`;
  const result = await journal.run(
    { tool: "undo", label, undoes: item.id },
    (entry) => {
      entryId = entry.id;
      return commitUndo(client, plan);
    },
  );
  const undone = result.failed.length === 0 || result.done.length > 0;
  if (undone) {
    journal.markUndone(item.id, entryId);
  }
  return { ...result, undone, entryId };
}

/** A plan for the CLI: the steps, then notes and warnings. */
export function formatUndoPlan(plan: UndoPlan): string {
  if (plan.blocked !== undefined) {
    return `Cannot undo ${plan.entryId}: ${plan.blocked}`;
  }
  const lines = [`Undo ${plan.entryId}: ${plan.label}`];
  if (plan.steps.length === 0) {
    lines.push("  (nothing left to change)");
  }
  for (const step of plan.steps) {
    lines.push(`  - ${describeStep(step)}`);
  }
  for (const note of plan.notes) {
    lines.push(`Note: ${note}`);
  }
  for (const warning of plan.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

/** What an undo did, for the CLI. */
export function formatUndoResult(result: UndoResult): string {
  return [
    ...result.done.map((step) => `Done: ${step}`),
    ...result.failed.map((f) => `Failed: ${f.step} (${f.reason})`),
    ...result.notes.map((note) => `Note: ${note}`),
  ].join("\n");
}
