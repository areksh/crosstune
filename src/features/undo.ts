/**
 * Undo: reverse what one history entry changed.
 *
 * Split like every tool. {@link planUndo} (resolve) reads the playlists the
 * entry touched and builds the steps that reverse it, with notes on what
 * cannot be restored and warnings about later entries that touched the same
 * places; {@link commitUndo} runs the steps, reporting each failure without
 * stopping. {@link applyUndo} runs the commit as an entry of its own ("Undid:
 * ...") and marks the original undone once nothing is left to do.
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
 *
 * **Ids that changed since.** A track that is put back is a new entry: its
 * service gives it a new id, and every record made before names it by the old
 * one. So an undo keeps, on its own entry, the new id of each entry it put back
 * (`renamed`), and planning reads an entry's ids through what the undos made
 * after it renamed ({@link renamesSince}). Undoing "moved a song to the top"
 * after undoing "removed that song" then moves the song that was put back,
 * rather than finding nothing under the old id.
 *
 * **An undo that failed part-way** leaves its entry not undone, to be undone
 * again: marking it would leave what did not come back in the history file
 * only, and simply planning it afresh would put back a second time what the
 * first try already did. There is no list of finished steps to keep in step
 * with the account. Instead a try is an entry like any other -- it went through
 * the recording client, so its own operations say exactly which writes went
 * through, even of a step that failed half-way -- and planning replays the
 * earlier tries ({@link earlierTries}) along with the entry itself: a track a
 * try put back stands for the removed one (and is only moved into place if it
 * is not there yet), an entry a try took out is not looked for again, and the
 * favourites and details a try set back are left alone. A deleted playlist
 * that a try began to make again is known by `recreated` on the try's entry,
 * and is filled rather than made a second time. What is planned is therefore
 * only what is left, however far the tries got.
 */

import { isNotFound, labelOf } from "../services/errors.js";
import {
  checkAllOn,
  shortId,
  type AlbumId,
  type AnyId,
  type ArtistId,
  type EntryId,
  type PlaylistId,
  type ServiceName,
  type TrackId,
} from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import {
  laterConflicts,
  type FavouriteType,
  type HistoryItem,
  type Operation,
  type PlaylistDetails,
  type RecreatedPlaylist,
  type RenamedEntries,
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
      /** The id the deleted playlist had. */
      was: PlaylistId;
      name: string;
      /** The tracks to add, in order. */
      trackIds: TrackId[];
      isPublic?: boolean;
      description?: string;
      /**
       * Set when an earlier try made the playlist again but did not fill it:
       * the playlist it made, and everything that belongs in it (`trackIds`
       * are then those still missing).
       */
      begun?: { playlistId: PlaylistId; all: TrackId[] };
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
  /**
   * Whether the entry is now marked undone: when nothing failed that undoing
   * it again could still do. Otherwise it is left to be undone again, which
   * does what is left.
   */
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
      return step.begun === undefined
        ? `Recreate the playlist ${step.name} with ${plural(step.trackIds.length, "track")}`
        : `Put the ${plural(step.trackIds.length, "track")} still missing back in ${step.name}`;
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
 * playlist it touched). `items` is the whole history: for the warnings, for
 * the ids that undos made since have changed, and for the earlier tries at
 * undoing `item`, whose work is not planned again.
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
  if (item.forgotten !== undefined) {
    plan.blocked = `Part of this changed ${labelOf(item.forgotten)}, which was forgotten, so it can no longer be undone.`;
    return plan;
  }
  for (const later of laterConflicts(item, items)) {
    plan.warnings.push(`A later change also touched it: "${later.label}".`);
  }

  // As the entries are called now: undos made since may have put some back.
  const ops = item.ops.map(renamesSince(item, items));
  const tries = earlierTries(item, items);
  const tried = tries.flatMap((one) => one.ops.map(renamesSince(one, items)));
  const recreated = new Map<PlaylistId, PlaylistId>();
  for (const one of tries) {
    one.recreated?.forEach(({ was, now }) => recreated.set(was, now));
  }
  const names = new Map<PlaylistId, string>();
  for (const op of ops) {
    if (op.kind === "create-playlist" || op.kind === "delete-playlist") {
      names.set(op.playlistId, op.name);
    } else if ("playlistName" in op && op.playlistName !== undefined && !names.has(op.playlistId)) {
      names.set(op.playlistId, op.playlistName);
    }
  }
  const nameOf = (id: PlaylistId): string => names.get(id) ?? `playlist ${shortId(id)}`;

  // Read each playlist the entry changed. A deleted one needs no read, unless
  // an earlier try began to make it again: then that one is read.
  const current = new Map<PlaylistId, Track[] | undefined>();
  for (const op of ops) {
    const own = playlistIdOf(op);
    const id = op.kind === "delete-playlist" ? recreated.get(op.playlistId) : own;
    if (own !== undefined && id !== undefined && !current.has(id)) {
      try {
        current.set(id, await client.getPlaylistTracks(id));
      } catch (error) {
        if (!isGone(error)) {
          // It may well exist: undoing the rest without it could lose songs.
          plan.blocked = `${nameOf(own)} could not be read (${messageOf(error)}). Nothing was undone; try again.`;
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
      case "add-favourites": {
        const ids = notYet(op.ids, tried, "remove-favourites", op.type);
        if (ids.length > 0) {
          plan.steps.push({ kind: "remove-favourites", type: op.type, ids });
        }
        break;
      }
      case "remove-favourites": {
        const ids = notYet(op.ids, tried, "add-favourites", op.type);
        if (ids.length > 0) {
          plan.steps.push({ kind: "add-favourites", type: op.type, ids });
        }
        break;
      }
      case "delete-playlist": {
        const begun = recreated.get(op.playlistId);
        planRecreate(plan, op, begun, begun === undefined ? undefined : current.get(begun));
        break;
      }
      default:
        if (!planned.has(op.playlistId)) {
          planned.add(op.playlistId);
          const here = (other: Operation): boolean => playlistIdOf(other) === op.playlistId;
          planPlaylist(
            plan,
            op.playlistId,
            nameOf(op.playlistId),
            ops.filter(here),
            tried.filter(here),
            current.get(op.playlistId),
          );
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

/**
 * The undos of `item` so far, oldest first. `item` is not marked undone, so
 * none of them got through all of it; what each did is in its operations. One
 * that was itself undone is left out: what it did was reversed.
 */
function earlierTries(item: HistoryItem, items: readonly HistoryItem[]): HistoryItem[] {
  return items
    .filter((other) => other.undoes === item.id && other.undone === undefined && other.forgotten === undefined)
    .reverse();
}

/** The favourites of `ids` that no earlier try has already added back (or removed). */
function notYet(
  ids: readonly AnyId[],
  tried: readonly Operation[],
  kind: "add-favourites" | "remove-favourites",
  type: FavouriteType,
): AnyId[] {
  const done = new Set(tried.flatMap((op) => (op.kind === kind && op.type === type ? op.ids : [])));
  return ids.filter((id) => !done.has(id));
}

/**
 * Plan making a deleted playlist again -- or, when an earlier try made it
 * (`begun`, with what it holds now) and could not fill it, adding what is
 * still missing. If that one is gone too, it is made anew.
 */
function planRecreate(
  plan: UndoPlan,
  op: Extract<Operation, { kind: "delete-playlist" }>,
  begun: PlaylistId | undefined,
  there: readonly Track[] | undefined,
): void {
  const step = {
    kind: "recreate-playlist" as const,
    was: op.playlistId,
    name: op.name,
    ...(op.isPublic !== undefined && { isPublic: op.isPublic }),
    ...(op.description !== undefined && { description: op.description }),
  };
  if (begun === undefined || there === undefined) {
    plan.steps.push({ ...step, trackIds: [...op.trackIds] });
    return;
  }
  const missing = missingFrom(
    op.trackIds,
    there.map((track) => track.id),
  );
  if (missing.length > 0) {
    plan.steps.push({ ...step, trackIds: missing, begun: { playlistId: begun, all: [...op.trackIds] } });
  }
}

/**
 * Plan the reversal of everything `mine` (the entry's operations on one
 * playlist) did to it, less what `tried` (the earlier tries' operations on it)
 * already reversed.
 */
function planPlaylist(
  plan: UndoPlan,
  playlistId: PlaylistId,
  name: string,
  mine: readonly Operation[],
  tried: readonly Operation[],
  tracks: Track[] | undefined,
): void {
  const created = mine.some((op) => op.kind === "create-playlist");
  if (tracks === undefined) {
    // Deleted by an earlier try: that is the undoing of it, with nothing to add.
    if (!tried.some((op) => op.kind === "delete-playlist")) {
      plan.notes.push(
        created
          ? `${name} no longer exists, so there is nothing to undo there.`
          : `${name} no longer exists, so its changes are not undone.`,
      );
    }
    for (const op of mine) {
      if (op.kind === "remove-tracks") {
        plan.unrestorable.push(...op.entries.map((entry) => entry.trackId));
      }
    }
    return;
  }
  const cells: Cell[] = tracks.flatMap((t) =>
    t.playlistTrackId === undefined ? [] : [{ id: t.playlistTrackId, trackId: t.id, state: "here" as const }],
  );
  const { order, restore, doomed, gone, unknownMoves } = replayBackwards(cells, mine, tried);

  if (created && doomed.size === tracks.length) {
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
  const current = cells.map((cell) => cell.id);
  if (restore.length > 0) {
    plan.steps.push({ kind: "restore-tracks", playlistId, name, entries: restore, order });
    if (tried.some((op) => op.kind === "add-tracks" && op.unconfirmed !== undefined)) {
      plan.warnings.push(
        `An earlier try at undoing this may already have put tracks back in ${name} without being able to check; look for songs that are in it twice afterwards.`,
      );
    }
  } else if (planOrder(current, mergeOrder(current, order)).length > 0) {
    plan.steps.push({ kind: "reorder-playlist", playlistId, name, order });
  }

  // 2. Take out what it added (and did not itself remove again).
  if (gone > 0) {
    plan.notes.push(`${gone} of the tracks added to ${name} ${gone === 1 ? "is" : "are"} no longer in it.`);
  }
  const unconfirmed = mine.reduce((n, op) => n + (op.kind === "add-tracks" ? (op.unconfirmed?.length ?? 0) : 0), 0);
  if (unconfirmed > 0) {
    plan.notes.push(
      `${plural(unconfirmed, "track")} sent to ${name} could not be confirmed when added, so ${unconfirmed === 1 ? "it is" : "they are"} not removed.`,
    );
  }
  if (doomed.size > 0) {
    plan.steps.push({
      kind: "remove-tracks",
      playlistId,
      name,
      entries: cells.filter((cell) => doomed.has(cell)).map((cell) => ({ playlistTrackId: cell.id, trackId: cell.trackId })),
    });
  }

  // 3. Moves recorded without where their entries were cannot be reversed.
  const staying = new Set(cells.filter((cell) => !doomed.has(cell)).map((cell) => cell.id));
  const reordered = [...unknownMoves].filter((id) => staying.has(id)).length;
  if (reordered > 0) {
    plan.notes.push(`The order of ${plural(reordered, "track")} in ${name} is not restored.`);
  }

  // 4. Its details, as they were before the first change -- less what an
  // earlier try already set back.
  const changes: PlaylistDetails = {};
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const op = mine[i]!;
    if (op.kind === "update-playlist") {
      Object.assign(changes, op.before);
    }
  }
  for (const op of tried) {
    if (op.kind === "update-playlist") {
      for (const key of Object.keys(op.after) as Array<keyof PlaylistDetails>) {
        delete changes[key];
      }
    }
  }
  if (Object.keys(changes).length > 0) {
    plan.steps.push({ kind: "update-playlist", playlistId, name, changes });
  }
}

/** One place in a playlist while its changes are replayed backwards. */
interface Cell {
  /** The id it goes by: its own, or the id its record gives it when it is not in the playlist. */
  id: EntryId;
  trackId: TrackId;
  /**
   * `here`: in the playlist now. `back`: the change removed it, and it is to
   * be put back. `taken`: the change added it, and an earlier try at undoing
   * already took it out.
   */
  state: "here" | "back" | "taken";
}

interface Replayed {
  /** The entries in the order to return to; one to put back goes by the id its record gives it. */
  order: EntryId[];
  /** The removed entries that are not back yet, in that order. */
  restore: Array<{ playlistTrackId: EntryId; trackId: TrackId }>;
  /** The entries the change added that are still in the playlist. */
  doomed: Set<Cell>;
  /** How many it added are in it no longer, without an earlier try having taken them out. */
  gone: number;
  /** The entries it moved without recording from where. */
  unknownMoves: Set<EntryId>;
}

/**
 * Replay one playlist's operations backwards over its entries as they are now
 * (`cells`): first what the earlier tries at undoing did (`tried`), then what
 * the change itself did (`mine`). The result is the order the playlist was in
 * before the change, what is still to be put back, and what is still to be
 * taken out.
 *
 * Going back over a try: an entry it added is one it put back, and is set
 * aside to stand for the removed entry it was added for; an entry it removed
 * was one the change had added, and is put in again as `taken`, so that the
 * change's own addition finds it there and nothing more is done about it.
 */
function replayBackwards(cells: readonly Cell[], mine: readonly Operation[], tried: readonly Operation[]): Replayed {
  let list: Cell[] = [...cells];
  const inList = new Set(cells);
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  /** What the earlier tries put back, until it is known for which removed entry. */
  const putBack: Cell[] = [];
  /** The ids the change's removed entries go by now. */
  const removedIds = new Set(
    mine.flatMap((op) => (op.kind === "remove-tracks" ? op.entries.map((e) => e.playlistTrackId) : [])),
  );
  const doomed = new Set<Cell>();
  const unknownMoves = new Set<EntryId>();
  let gone = 0;

  const find = (id: EntryId): Cell | undefined => {
    const cell = byId.get(id);
    return cell !== undefined && inList.has(cell) ? cell : undefined;
  };
  const absent = (id: EntryId, trackId: TrackId, state: "back" | "taken"): Cell => {
    const cell: Cell = { id, trackId, state };
    byId.set(id, cell);
    return cell;
  };
  const takeOut = (out: readonly Cell[]): void => {
    if (out.length > 0) {
      const going = new Set(out);
      going.forEach((cell) => inList.delete(cell));
      list = list.filter((cell) => !going.has(cell));
    }
  };
  const putIn = (items: ReadonlyArray<{ cell: Cell; position: number }>): void => {
    for (const { cell, position } of [...items].sort((a, b) => a.position - b.position)) {
      list.splice(Math.min(position, list.length), 0, cell);
      inList.add(cell);
    }
  };
  const claim = (matches: (cell: Cell) => boolean): Cell | undefined => {
    const at = putBack.findIndex(matches);
    return at < 0 ? undefined : putBack.splice(at, 1)[0];
  };

  const steps = [...mine.map((op) => ({ op, own: true })), ...tried.map((op) => ({ op, own: false }))];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const { op, own } = steps[i]!;
    if (op.kind === "add-tracks") {
      const found = op.entries.map((e) => find(e.playlistTrackId));
      for (const cell of found) {
        if (!own) {
          if (cell?.state === "here") {
            putBack.push(cell);
          }
        } else if (cell === undefined) {
          gone += 1;
        } else if (cell.state === "here") {
          doomed.add(cell);
        }
      }
      takeOut(found.filter((cell): cell is Cell => cell !== undefined));
    } else if (op.kind === "remove-tracks") {
      if (!own) {
        putIn(op.entries.map((e) => ({ cell: absent(e.playlistTrackId, e.trackId, "taken"), position: e.position })));
        continue;
      }
      // Each removed entry: the one a try put back for it (by its new id --
      // also when it is in the playlist without the try's add being on
      // record -- else any it put back of that track, unless that one is
      // another removed entry's by id), or one still to put back.
      const back: Array<Cell | undefined> = op.entries.map(
        (e) => claim((cell) => cell.id === e.playlistTrackId) ?? find(e.playlistTrackId),
      );
      op.entries.forEach((e, k) => {
        back[k] ??=
          claim((cell) => cell.trackId === e.trackId && !removedIds.has(cell.id)) ??
          absent(e.playlistTrackId, e.trackId, "back");
      });
      takeOut(back.filter((cell): cell is Cell => cell !== undefined && inList.has(cell)));
      putIn(op.entries.map((e, k) => ({ cell: back[k]!, position: e.position })));
    } else if (op.kind === "move-tracks") {
      const { from } = op;
      if (from === undefined) {
        if (own) {
          op.playlistTrackIds.forEach((id) => unknownMoves.add(id));
        }
        continue;
      }
      const back = op.playlistTrackIds.flatMap((id, k) => {
        const cell = find(id);
        return cell === undefined ? [] : [{ cell, position: from[k]! }];
      });
      takeOut(back.map((item) => item.cell));
      putIn(back);
    }
  }
  // Anything a try put back that the change's record does not account for stays.
  list.push(...putBack);
  const staying = list.filter((cell) => cell.state !== "taken");
  return {
    order: staying.map((cell) => cell.id),
    restore: staying.flatMap((cell) => (cell.state === "back" ? [{ playlistTrackId: cell.id, trackId: cell.trackId }] : [])),
    doomed,
    gone,
    unknownMoves,
  };
}

/**
 * How to read an operation recorded by `item` now: with each entry id replaced
 * by the one it has since, following what the undos made after `item` put back
 * under new ids (oldest first, so an entry put back twice is followed through
 * both). An undo that was itself undone still counts: its new id is then simply
 * no longer in the playlist.
 */
function renamesSince(item: HistoryItem, items: readonly HistoryItem[]): (op: Operation) => Operation {
  const at = items.findIndex((other) => other.id === item.id);
  const renames = new Map<PlaylistId, Map<EntryId, EntryId>>();
  // `items` is newest first; what was written after `item` comes before it.
  for (const later of items.slice(0, Math.max(at, 0)).reverse()) {
    for (const { playlistId, entries } of later.renamed ?? []) {
      const known = renames.get(playlistId) ?? new Map<EntryId, EntryId>();
      renames.set(playlistId, known);
      entries.forEach(([was, now]) => known.set(was, now));
    }
  }
  const now = (playlistId: PlaylistId, id: EntryId): EntryId => {
    const known = renames.get(playlistId);
    let current = id;
    // Bounded, should a damaged file ever name ids in a circle.
    for (let hops = 0; known !== undefined && hops < known.size; hops += 1) {
      const next = known.get(current);
      if (next === undefined) {
        break;
      }
      current = next;
    }
    return current;
  };
  return (op) => {
    if (renames.size === 0) {
      return op;
    }
    switch (op.kind) {
      case "add-tracks":
      case "remove-tracks":
        return {
          ...op,
          entries: op.entries.map((e) => ({ ...e, playlistTrackId: now(op.playlistId, e.playlistTrackId) })),
        };
      case "move-tracks":
        return { ...op, playlistTrackIds: op.playlistTrackIds.map((id) => now(op.playlistId, id)) };
      default:
        return op;
    }
  };
}

/**
 * Whether an error says the playlist does not exist (rather than a failure to
 * read it), however its service puts that: Qobuz answers an HTTP 404, TIDAL
 * and Spotify raise a `not-found`.
 */
function isGone(error: unknown): boolean {
  return isNotFound(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ids of the tracks that could not be put back. */
type Unrestored = Set<TrackId>;

/** What an undo made that later undos need to know of; kept on its entry. */
interface Made {
  /** The new ids of the entries it put back. */
  renamed: RenamedEntries[];
  /** The playlists it made again, filled or not. */
  recreated: RecreatedPlaylist[];
}

/**
 * A step left undone on purpose, because doing it would lose a song. Trying
 * again would not change that, so it does not keep the entry from being
 * marked undone; if the song could not be put back because of an error, that
 * error does.
 */
class Kept extends Error {}

/**
 * Run the steps of a plan in order, reporting each failure and carrying on. A
 * track that could not be put back is never taken out of where it is now.
 */
export async function commitUndo(client: UndoClient, plan: UndoPlan): Promise<UndoResult> {
  return (await runPlan(client, plan)).result;
}

/**
 * {@link commitUndo}, with what it made and how many of its failures undoing
 * again could still get past (`open`).
 */
async function runPlan(
  client: UndoClient,
  plan: UndoPlan,
): Promise<{ result: UndoResult; made: Made; open: number }> {
  const result: UndoResult = { done: [], failed: [], notes: [] };
  const made: Made = { renamed: [], recreated: [] };
  const unrestored: Unrestored = new Set(plan.unrestorable);
  let settled = 0;
  for (const step of plan.steps) {
    const text = describeStep(step);
    try {
      const done = await runStep(client, step, result, unrestored, made);
      if (done !== false) {
        result.done.push(done === true ? text : done);
      }
    } catch (error) {
      result.failed.push({ step: text, reason: messageOf(error) });
      settled += error instanceof Kept ? 1 : 0;
    }
  }
  return { result, made, open: result.failed.length - settled };
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
  made: Made,
): Promise<boolean | string> {
  switch (step.kind) {
    case "delete-playlist":
      if (step.trackIds.some((id) => unrestored.has(id))) {
        throw new Kept("kept, as it holds tracks that could not be put back where they were");
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
      await recreate(client, step, result, unrestored, made);
      return true;
    case "restore-tracks":
      return restoreTracks(client, step, result, unrestored, made);
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

/**
 * Create a deleted playlist again (or go on filling the one an earlier try
 * made), and say what did not come back with it. The playlist made is noted
 * as soon as it exists, so that a failure to fill it is finished in it.
 */
async function recreate(
  client: UndoClient,
  step: Extract<UndoStep, { kind: "recreate-playlist" }>,
  result: UndoResult,
  unrestored: Unrestored,
  made: Made,
): Promise<void> {
  try {
    checkAllOn(client as { name?: ServiceName }, step.trackIds);
    let playlistId = step.begun?.playlistId;
    if (playlistId === undefined) {
      playlistId = (
        await client.createPlaylist(step.name, {
          isPublic: step.isPublic ?? false,
          ...(step.description !== undefined && { description: step.description }),
        })
      ).id;
      made.recreated.push({ was: step.was, now: playlistId });
    }
    await addInOrder(client, playlistId, step.trackIds);
    const missing = missingFrom(
      step.begun?.all ?? step.trackIds,
      (await client.getPlaylistTracks(playlistId)).map((t) => t.id),
    );
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
 *
 * The new ids of those that arrived are noted even when adding failed part-way
 * or the order could not be restored: they are in the playlist, and the next
 * try must find them there rather than add them again.
 */
async function restoreTracks(
  client: UndoClient,
  step: Extract<UndoStep, { kind: "restore-tracks" }>,
  result: UndoResult,
  unrestored: Unrestored,
  made: Made,
): Promise<boolean | string> {
  let before: Track[];
  try {
    before = await client.getPlaylistTracks(step.playlistId);
  } catch (error) {
    step.entries.forEach((e) => unrestored.add(e.trackId));
    throw error;
  }
  let failure: { error: unknown } | undefined;
  let after: Track[] | undefined;
  try {
    await addInOrder(
      client,
      step.playlistId,
      step.entries.map((e) => e.trackId),
    );
  } catch (error) {
    failure = { error };
  }
  try {
    // Also after a failed add: some of it may have arrived.
    after = await client.getPlaylistTracks(step.playlistId);
  } catch (error) {
    failure ??= { error };
  }
  if (after === undefined) {
    // What arrived is unknown, so nothing is taken out elsewhere.
    step.entries.forEach((e) => unrestored.add(e.trackId));
    throw failure!.error;
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
  if (newId.size > 0) {
    // Kept whatever comes next: they are in the playlist under these ids now.
    made.renamed.push({ playlistId: step.playlistId, entries: [...newId] });
  }
  if (failure !== undefined) {
    throw failure.error;
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
 * undo can itself be undone), then mark the original undone -- unless
 * something failed that undoing it again could still do. It is then left as it
 * was, and planning it again plans what is left: the entry just written says
 * what went through.
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
  const { result, open } = await journal.run({ tool: "undo", label, undoes: item.id }, async (entry) => {
    entryId = entry.id;
    const ran = await runPlan(client, plan);
    entry.keep(ran.made);
    return ran;
  });
  const undone = open === 0;
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
