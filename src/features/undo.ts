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
 * Per playlist, the order to return to is worked out by replaying the change's
 * operations backwards over the playlist as it is now: what it added is taken
 * out, what it removed goes back to its old position, and what it moved goes
 * back to where it was. Then the removed tracks are added again (Qobuz appends
 * them), everything is put in that order in as few moves as possible, and the
 * added entries are removed -- last, and never one whose track could not be put
 * back, so undoing a move between playlists cannot lose a song. A playlist the
 * change created is deleted if it holds nothing else. Added entries already
 * gone are skipped and reported, as are tracks Qobuz no longer lets us add, and
 * moves recorded without where their entries came from. Favourites are re-added
 * or removed, and changed playlist details put back.
 */

import {
  shortId,
  type AlbumId,
  type AnyId,
  type ArtistId,
  type EntryId,
  type PlaylistId,
  type TrackId,
} from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import {
  laterConflicts,
  type FavouriteType,
  type HistoryItem,
  type Operation,
  type PlaylistDetails,
} from "./history.js";
import type { Journal } from "./journal.js";
import { addInOrder, missingFrom } from "./playlist-add.js";
import { mergeOrder, planOrder } from "./playlist-order.js";

/** The read planning needs. */
export interface UndoPlanClient {
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

/** Everything undoing can call; QobuzClient (recorded) satisfies it. */
export interface UndoClient extends UndoPlanClient {
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  deletePlaylist(playlistId: PlaylistId): Promise<void>;
  updatePlaylist?(playlistId: PlaylistId, changes: PlaylistDetails): Promise<Playlist>;
  addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void>;
  removeTracksFromPlaylist(playlistId: PlaylistId, playlistTrackIds: readonly EntryId[]): Promise<void>;
  movePlaylistTracks?(
    playlistId: PlaylistId,
    playlistTrackIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void>;
  addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  addFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void>;
  addFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void>;
  removeFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  removeFavoriteAlbums(albumIds: readonly AlbumId[]): Promise<void>;
  removeFavoriteArtists(artistIds: readonly ArtistId[]): Promise<void>;
}

/** One reversing step. */
export type UndoStep =
  | { kind: "delete-playlist"; playlistId: PlaylistId; name: string; trackCount: number; trackIds: TrackId[] }
  | {
      kind: "remove-tracks";
      playlistId: PlaylistId;
      name: string;
      entries: Array<{ playlistTrackId: EntryId; trackId: TrackId }>;
    }
  | {
      kind: "restore-tracks";
      playlistId: PlaylistId;
      name: string;
      /** The removed entries to put back, in the order they were. */
      entries: Array<{ playlistTrackId: EntryId; trackId: TrackId }>;
      /** The entries in the order to return to, by (old) playlist-track id. */
      order: EntryId[];
    }
  | { kind: "reorder-playlist"; playlistId: PlaylistId; name: string; order: EntryId[] }
  | { kind: "update-playlist"; playlistId: PlaylistId; name: string; changes: PlaylistDetails }
  | {
      kind: "recreate-playlist";
      name: string;
      trackIds: TrackId[];
      isPublic?: boolean;
      description?: string;
    }
  | { kind: "add-favourites"; type: FavouriteType; ids: AnyId[] }
  | { kind: "remove-favourites"; type: FavouriteType; ids: AnyId[] };

export interface UndoPlan {
  entryId: string;
  label: string;
  steps: UndoStep[];
  /** What will not be restored, and why. */
  notes: string[];
  /** Later entries that touched the same playlists or favourites. */
  warnings: string[];
  /**
   * Tracks that cannot be put back because the playlist they were in is gone:
   * they are not taken out of where the same change put them.
   */
  unrestorable: TrackId[];
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
      return `Remove ${plural(step.entries.length, "track")} from ${step.name}`;
    case "restore-tracks":
      return `Put ${plural(step.entries.length, "track")} back in ${step.name}, in ${step.entries.length === 1 ? "its old place" : "their old places"}`;
    case "reorder-playlist":
      return `Put ${step.name} back in its old order`;
    case "update-playlist":
      return describeDetails(step.name, step.changes);
    case "recreate-playlist":
      return `Recreate the playlist ${step.name} with ${plural(step.trackIds.length, "track")}`;
    case "add-favourites":
      return `Add ${plural(step.ids.length, NOUNS[step.type])} back to Favourites`;
    case "remove-favourites":
      return `Remove ${plural(step.ids.length, NOUNS[step.type])} from Favourites`;
  }
}

function describeDetails(name: string, changes: PlaylistDetails): string {
  const parts: string[] = [];
  if (changes.name !== undefined) {
    parts.push(`name back to ${changes.name}`);
  }
  if (changes.isPublic !== undefined) {
    parts.push(`visibility back to ${changes.isPublic ? "public" : "private"}`);
  }
  if (changes.description !== undefined) {
    parts.push("old description back");
  }
  return `Set ${name}: ${parts.join(", ")}`;
}

function playlistIdOf(op: Operation): PlaylistId | undefined {
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
  const plan: UndoPlan = { entryId: item.id, label: item.label, steps: [], notes: [], warnings: [], unrestorable: [] };
  if (item.undone !== undefined) {
    plan.blocked = `Already undone (${item.undone.at}).`;
    return plan;
  }
  for (const later of laterConflicts(item, items)) {
    plan.warnings.push(`A later change also touched it: "${later.label}".`);
  }

  const ops = item.ops;
  const names = new Map<PlaylistId, string>();
  for (const op of ops) {
    if (op.kind === "create-playlist" || op.kind === "delete-playlist") {
      names.set(op.playlistId, op.name);
    } else if ("playlistName" in op && op.playlistName !== undefined && !names.has(op.playlistId)) {
      names.set(op.playlistId, op.playlistName);
    }
  }
  const nameOf = (id: PlaylistId): string => names.get(id) ?? `playlist ${shortId(id)}`;

  // Read each playlist the entry changed (a deleted one needs no read).
  const current = new Map<PlaylistId, Track[] | undefined>();
  for (const op of ops) {
    const id = playlistIdOf(op);
    if (id !== undefined && op.kind !== "delete-playlist" && !current.has(id)) {
      try {
        current.set(id, await client.getPlaylistTracks(id));
      } catch (error) {
        if (!isGone(error)) {
          // It may well exist: undoing the rest without it could lose songs.
          plan.blocked = `${nameOf(id)} could not be read (${messageOf(error)}). Nothing was undone; try again.`;
          return plan;
        }
        current.set(id, undefined);
      }
    }
  }

  // Iterate from the last operation; a playlist's whole reversal is planned
  // where its last operation is met.
  const planned = new Set<PlaylistId>();
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
          ...(op.description !== undefined && { description: op.description }),
        });
        break;
      default:
        if (!planned.has(op.playlistId)) {
          planned.add(op.playlistId);
          planPlaylist(plan, op.playlistId, nameOf(op.playlistId), ops, current.get(op.playlistId));
        }
    }
  }
  // Put things back before taking anything out, so that a song which cannot be
  // put back is still where the change put it (see commitUndo).
  const putsBack = (step: UndoStep): boolean =>
    step.kind === "restore-tracks" || step.kind === "reorder-playlist" || step.kind === "recreate-playlist";
  plan.steps = [...plan.steps.filter(putsBack), ...plan.steps.filter((step) => !putsBack(step))];
  return plan;
}

/** Plan the reversal of everything `ops` did to one playlist. */
function planPlaylist(
  plan: UndoPlan,
  playlistId: PlaylistId,
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
        : `${name} no longer exists, so its changes are not undone.`,
    );
    for (const op of mine) {
      if (op.kind === "remove-tracks") {
        plan.unrestorable.push(...op.entries.map((entry) => entry.trackId));
      }
    }
    return;
  }
  const present = new Set(tracks.map((t) => t.playlistTrackId));
  const added = new Set<EntryId>();
  const removed = new Set<EntryId>();
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
    plan.steps.push({
      kind: "delete-playlist",
      playlistId,
      name,
      trackCount: tracks.length,
      trackIds: tracks.map((t) => t.id),
    });
    return;
  }
  if (created) {
    plan.notes.push(
      `Kept the playlist ${name}: it now has tracks this change did not add, so only the added ones are removed.`,
    );
  }

  // 1. Put back what it removed, in the order the playlist was in.
  const current = tracks.flatMap((t) => (t.playlistTrackId === undefined ? [] : [t.playlistTrackId]));
  const { order, removedTracks, unknownMoves } = replayBackwards(current, mine);
  const restore = order.flatMap((id) => (present.has(id) ? [] : [{ playlistTrackId: id, trackId: removedTracks.get(id)! }]));
  if (restore.length > 0) {
    plan.steps.push({ kind: "restore-tracks", playlistId, name, entries: restore, order });
  } else if (planOrder(current, mergeOrder(current, order)).length > 0) {
    plan.steps.push({ kind: "reorder-playlist", playlistId, name, order });
  }

  // 2. Take out what it added (and did not itself remove again).
  const doomed = tracks.flatMap((t) =>
    t.playlistTrackId !== undefined && added.has(t.playlistTrackId)
      ? [{ playlistTrackId: t.playlistTrackId, trackId: t.id }]
      : [],
  );
  const gone = [...added].filter((id) => !removed.has(id) && !present.has(id)).length;
  if (gone > 0) {
    plan.notes.push(`${gone} of the tracks added to ${name} ${gone === 1 ? "is" : "are"} no longer in it.`);
  }
  if (unconfirmed > 0) {
    plan.notes.push(
      `${plural(unconfirmed, "track")} sent to ${name} could not be confirmed when added, so ${unconfirmed === 1 ? "it is" : "they are"} not removed.`,
    );
  }
  if (doomed.length > 0) {
    plan.steps.push({ kind: "remove-tracks", playlistId, name, entries: doomed });
  }

  // 3. Moves recorded without where their entries were cannot be reversed.
  const reordered = new Set([...unknownMoves].filter((id) => !added.has(id) && present.has(id)));
  if (reordered.size > 0) {
    plan.notes.push(`The order of ${plural(reordered.size, "track")} in ${name} is not restored.`);
  }

  // 4. Its details, as they were before the first change.
  const changes: PlaylistDetails = {};
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const op = mine[i]!;
    if (op.kind === "update-playlist") {
      Object.assign(changes, op.before);
    }
  }
  if (Object.keys(changes).length > 0) {
    plan.steps.push({ kind: "update-playlist", playlistId, name, changes });
  }
}

/**
 * Replay one playlist's operations backwards over its current entries: the
 * order it was in, by playlist-track id (removed entries under their old id).
 */
function replayBackwards(
  current: readonly EntryId[],
  ops: readonly Operation[],
): { order: EntryId[]; removedTracks: Map<EntryId, TrackId>; unknownMoves: Set<EntryId> } {
  let list: EntryId[] = [...current];
  const removedTracks = new Map<EntryId, TrackId>();
  const unknownMoves = new Set<EntryId>();
  const putIn = (items: ReadonlyArray<{ id: EntryId; position: number }>): void => {
    for (const { id, position } of [...items].sort((a, b) => a.position - b.position)) {
      list.splice(Math.min(position, list.length), 0, id);
    }
  };
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]!;
    if (op.kind === "add-tracks") {
      const ids = new Set(op.entries.map((e) => e.playlistTrackId));
      list = list.filter((id) => !ids.has(id));
    } else if (op.kind === "remove-tracks") {
      const here = new Set(list);
      const back = op.entries.filter((e) => !here.has(e.playlistTrackId));
      back.forEach((e) => removedTracks.set(e.playlistTrackId, e.trackId));
      putIn(back.map((e) => ({ id: e.playlistTrackId, position: e.position })));
    } else if (op.kind === "move-tracks") {
      const { from } = op;
      if (from === undefined) {
        op.playlistTrackIds.forEach((id) => unknownMoves.add(id));
        continue;
      }
      const here = new Set(list);
      const back = op.playlistTrackIds.flatMap((id, k) => (here.has(id) ? [{ id, position: from[k]! }] : []));
      const moved = new Set(back.map((item) => item.id));
      list = list.filter((id) => !moved.has(id));
      putIn(back);
    }
  }
  return { order: list, removedTracks, unknownMoves };
}

/** Whether an error says the playlist does not exist (rather than a failure to read it). */
function isGone(error: unknown): boolean {
  return messageOf(error).includes("HTTP 404");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ids of the tracks that could not be put back. */
type Unrestored = Set<TrackId>;

/**
 * Run the steps of a plan in order, reporting each failure and carrying on. A
 * track that could not be put back is never taken out of where it is now.
 */
export async function commitUndo(client: UndoClient, plan: UndoPlan): Promise<UndoResult> {
  const result: UndoResult = { done: [], failed: [], notes: [] };
  const unrestored: Unrestored = new Set(plan.unrestorable);
  for (const step of plan.steps) {
    const text = describeStep(step);
    try {
      const done = await runStep(client, step, result, unrestored);
      if (done !== false) {
        result.done.push(done === true ? text : done);
      }
    } catch (error) {
      result.failed.push({ step: text, reason: messageOf(error) });
    }
  }
  return result;
}

/**
 * Run a step; false when there was nothing left of it to do, or what it did do
 * when that is not all of it.
 */
async function runStep(
  client: UndoClient,
  step: UndoStep,
  result: UndoResult,
  unrestored: Unrestored,
): Promise<boolean | string> {
  switch (step.kind) {
    case "delete-playlist":
      if (step.trackIds.some((id) => unrestored.has(id))) {
        throw new Error("kept, as it holds tracks that could not be put back where they were");
      }
      await client.deletePlaylist(step.playlistId);
      return true;
    case "remove-tracks": {
      const going = step.entries.filter((e) => !unrestored.has(e.trackId));
      const staying = step.entries.length - going.length;
      if (staying > 0) {
        result.notes.push(
          `${plural(staying, "track")} ${staying === 1 ? "stays" : "stay"} in ${step.name}, as ${staying === 1 ? "it" : "they"} could not be put back where ${staying === 1 ? "it was" : "they were"}.`,
        );
      }
      await client.removeTracksFromPlaylist(
        step.playlistId,
        going.map((e) => e.playlistTrackId),
      );
      return going.length > 0;
    }
    case "recreate-playlist":
      await recreate(client, step, result, unrestored);
      return true;
    case "restore-tracks":
      return restoreTracks(client, step, result, unrestored);
    case "reorder-playlist": {
      const current = entryIds(await client.getPlaylistTracks(step.playlistId));
      await moveInto(client, step.playlistId, current, mergeOrder(current, step.order));
      return true;
    }
    case "update-playlist":
      if (client.updatePlaylist === undefined) {
        throw new Error("playlist details cannot be changed here");
      }
      await client.updatePlaylist(step.playlistId, step.changes);
      return true;
    case "add-favourites":
      await (step.type === "tracks"
        ? client.addFavoriteTracks(step.ids as TrackId[])
        : step.type === "albums"
          ? client.addFavoriteAlbums(step.ids as AlbumId[])
          : client.addFavoriteArtists(step.ids as ArtistId[]));
      return true;
    case "remove-favourites":
      await (step.type === "tracks"
        ? client.removeFavoriteTracks(step.ids as TrackId[])
        : step.type === "albums"
          ? client.removeFavoriteAlbums(step.ids as AlbumId[])
          : client.removeFavoriteArtists(step.ids as ArtistId[]));
      return true;
  }
}

function entryIds(tracks: readonly Track[]): EntryId[] {
  return tracks.flatMap((t) => (t.playlistTrackId === undefined ? [] : [t.playlistTrackId]));
}

async function moveInto(
  client: UndoClient,
  playlistId: PlaylistId,
  current: readonly EntryId[],
  wanted: readonly EntryId[],
): Promise<void> {
  for (const move of planOrder(current, wanted)) {
    if (client.movePlaylistTracks === undefined) {
      throw new Error("playlists cannot be reordered here");
    }
    await client.movePlaylistTracks(playlistId, move.playlistTrackIds, move.insertBefore);
  }
}

function couldNotPutBack(count: number, name: string): string {
  return `${plural(count, "track")} could not be put back in ${name}: Qobuz no longer offers ${count === 1 ? "it" : "them"}.`;
}

/** Create a deleted playlist again, and say what did not come back with it. */
async function recreate(
  client: UndoClient,
  step: Extract<UndoStep, { kind: "recreate-playlist" }>,
  result: UndoResult,
  unrestored: Unrestored,
): Promise<void> {
  try {
    const playlist = await client.createPlaylist(step.name, {
      isPublic: step.isPublic ?? false,
      ...(step.description !== undefined && { description: step.description }),
    });
    await addInOrder(client, playlist.id, step.trackIds);
    const missing = missingFrom(step.trackIds, (await client.getPlaylistTracks(playlist.id)).map((t) => t.id));
    missing.forEach((id) => unrestored.add(id));
    if (missing.length > 0) {
      result.notes.push(couldNotPutBack(missing.length, step.name));
    }
  } catch (error) {
    step.trackIds.forEach((id) => unrestored.add(id));
    throw error;
  }
}

/**
 * Add removed tracks again (they land at the end), then put the playlist in the
 * order it was in (a failure to is reported as a failed step of its own). False
 * when none came back.
 */
async function restoreTracks(
  client: UndoClient,
  step: Extract<UndoStep, { kind: "restore-tracks" }>,
  result: UndoResult,
  unrestored: Unrestored,
): Promise<boolean | string> {
  let before: Track[];
  let after: Track[];
  try {
    before = await client.getPlaylistTracks(step.playlistId);
    await addInOrder(
      client,
      step.playlistId,
      step.entries.map((e) => e.trackId),
    );
    after = await client.getPlaylistTracks(step.playlistId);
  } catch (error) {
    // What arrived is unknown, so nothing is taken out elsewhere.
    step.entries.forEach((e) => unrestored.add(e.trackId));
    throw error;
  }
  // Match the new entries to the old ones, in order.
  const known = new Set(entryIds(before));
  const arrived = new Map<TrackId, EntryId[]>();
  for (const track of after) {
    if (track.playlistTrackId !== undefined && !known.has(track.playlistTrackId)) {
      arrived.set(track.id, [...(arrived.get(track.id) ?? []), track.playlistTrackId]);
    }
  }
  const newId = new Map<EntryId, EntryId>();
  let missing = 0;
  for (const entry of step.entries) {
    const id = arrived.get(entry.trackId)?.shift();
    if (id === undefined) {
      missing += 1;
      unrestored.add(entry.trackId);
    } else {
      newId.set(entry.playlistTrackId, id);
    }
  }
  if (missing > 0) {
    result.notes.push(couldNotPutBack(missing, step.name));
  }
  try {
    const current = entryIds(after);
    const order = step.order.map((id) => newId.get(id) ?? id);
    await moveInto(client, step.playlistId, current, mergeOrder(current, order));
  } catch (error) {
    const count = newId.size;
    result.failed.push({ step: `Put ${step.name} back in its old order`, reason: messageOf(error) });
    if (count === 0) {
      return false;
    }
    result.notes.push(
      `${plural(count, "track")} ${count === 1 ? "was" : "were"} put back at the end of ${step.name}, not in ${count === 1 ? "its old place" : "their old places"}.`,
    );
    return `Put ${plural(count, "track")} back in ${step.name}`;
  }
  return newId.size > 0;
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
