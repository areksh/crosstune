/**
 * Reordering a playlist in as few requests as possible.
 *
 * Qobuz moves entries with `playlist/updateTracksPosition`: the given entries
 * are placed, in the order given, in front of a position. {@link applyMove} is
 * that operation on a list of entry ids, as checked against the live API;
 * {@link planOrder} finds moves that turn one order into another. Entries are
 * moved, never removed and re-added, so they keep their ids and added dates.
 *
 * Pure and free of Node dependencies, so the web UI can use it too.
 */

import type { EntryId } from "../services/ids.js";

/** One `playlist/updateTracksPosition` request. */
export interface OrderMove {
  playlistTrackIds: EntryId[];
  /** 1-based position in the list before the move; its length + 1 is the end. */
  insertBefore: number;
}

/** The most ids sent in one move (220 worked live; they all go in the URL). */
export const MAX_MOVE_IDS = 200;

/**
 * The list after a move: `moved` (those that are in it) in the order given,
 * after the unmoved entries that were ahead of position `insertBefore`.
 */
export function applyMove(
  ids: readonly EntryId[],
  moved: readonly EntryId[],
  insertBefore: number,
): EntryId[] {
  const present = new Set(ids);
  const moving = [...new Set(moved)].filter((id) => present.has(id));
  const movingSet = new Set(moving);
  const ahead = ids.slice(0, Math.max(0, insertBefore - 1)).filter((id) => !movingSet.has(id)).length;
  const rest = ids.filter((id) => !movingSet.has(id));
  return [...rest.slice(0, ahead), ...moving, ...rest.slice(ahead)];
}

/**
 * The ids that can stay put when `current` is reordered to `wanted`: a longest
 * run already in relative order. Every other id has to move.
 */
export function stayingIds(current: readonly EntryId[], wanted: readonly EntryId[]): Set<EntryId> {
  const rank = new Map(wanted.map((id, index) => [id, index]));
  const ids = current.filter((id) => rank.has(id));
  // Patience sorting: tails[k] is the index (in ids) of the lowest-ranked end
  // of an increasing run of length k + 1; previous links each run back.
  const tails: number[] = [];
  const previous: number[] = [];
  ids.forEach((id, i) => {
    const r = rank.get(id)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rank.get(ids[tails[mid]!]!)! < r) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    previous[i] = low === 0 ? -1 : tails[low - 1]!;
    tails[low] = i;
  });
  const staying = new Set<EntryId>();
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = previous[i]!) {
    staying.add(ids[i]!);
  }
  return staying;
}

/**
 * `wanted` with the ids only `current` has put in, each after the id it follows
 * in `current` (at the top when it leads), and the ids `current` lacks left out.
 */
export function mergeOrder(current: readonly EntryId[], wanted: readonly EntryId[]): EntryId[] {
  const inCurrent = new Set(current);
  const kept = wanted.filter((id) => inCurrent.has(id));
  const inWanted = new Set(kept);
  const leading: EntryId[] = [];
  const followers = new Map<EntryId, EntryId[]>();
  let list = leading;
  for (const id of current) {
    if (inWanted.has(id)) {
      list = [];
      followers.set(id, list);
    } else {
      list.push(id);
    }
  }
  return [...leading, ...kept.flatMap((id) => [id, ...(followers.get(id) ?? [])])];
}

/**
 * The moves that turn `current` into `wanted` (the same ids in another order).
 *
 * Usually only the ids that must move are moved, those that end up side by side
 * together. When that takes more requests than re-sending the whole changed
 * stretch in blocks (a shuffle or a sort), the blocks are planned instead: each
 * goes in front of the entry after the stretch, so they line up in turn. No
 * move is anchored on an entry that is itself moved.
 *
 * @throws {Error} if the two do not hold the same ids, each once.
 */
export function planOrder(
  current: readonly EntryId[],
  wanted: readonly EntryId[],
  blockSize: number = MAX_MOVE_IDS,
): OrderMove[] {
  const ids = new Set(current);
  if (
    ids.size !== current.length ||
    current.length !== wanted.length ||
    new Set(wanted).size !== wanted.length ||
    wanted.some((id) => !ids.has(id))
  ) {
    throw new Error("the new order must hold the playlist's entries, each once");
  }
  let start = 0;
  while (start < current.length && current[start] === wanted[start]) {
    start += 1;
  }
  if (start === current.length) {
    return [];
  }
  let end = current.length;
  while (current[end - 1] === wanted[end - 1]) {
    end -= 1;
  }
  const blocks = Math.ceil((end - start) / blockSize);
  return groupedMoves(current, wanted, start, end, blockSize, blocks) ?? blockMoves(wanted, start, end, blockSize);
}

/** Re-send the stretch [start, end) in blocks, each in front of what follows it. */
function blockMoves(
  wanted: readonly EntryId[],
  start: number,
  end: number,
  blockSize: number,
): OrderMove[] {
  const moves: OrderMove[] = [];
  for (let at = start; at < end; at += blockSize) {
    moves.push({ playlistTrackIds: wanted.slice(at, Math.min(at + blockSize, end)), insertBefore: end + 1 });
  }
  return moves;
}

/**
 * Move only what must move, in runs that end up side by side; undefined when
 * that takes more than `limit` requests.
 */
function groupedMoves(
  current: readonly EntryId[],
  wanted: readonly EntryId[],
  start: number,
  end: number,
  blockSize: number,
  limit: number,
): OrderMove[] | undefined {
  const staying = stayingIds(current.slice(start, end), wanted.slice(start, end));
  const runs: EntryId[][] = [];
  for (let i = start; i < end; i += 1) {
    const id = wanted[i]!;
    if (staying.has(id)) {
      continue;
    }
    const last = runs[runs.length - 1];
    if (last !== undefined && i > start && last[last.length - 1] === wanted[i - 1] && last.length < blockSize) {
      last.push(id);
    } else {
      runs.push([id]);
      if (runs.length > limit) {
        return undefined;
      }
    }
  }
  // First to last, so each run's predecessor in `wanted` is already in place:
  // it goes right after it, i.e. in front of the position after it.
  const placeOf = new Map(wanted.map((id, index) => [id, index]));
  let list = [...current];
  const moves: OrderMove[] = [];
  for (const run of runs) {
    const before = placeOf.get(run[0]!)!;
    const predecessor = before === 0 ? undefined : wanted[before - 1]!;
    const at = predecessor === undefined ? 0 : list.indexOf(predecessor) + 1;
    // The entry now at `at` may be one of the run's own; go in front of the
    // next that is not (the same place, without anchoring on a moved entry).
    const moving = new Set(run);
    let anchor = at;
    while (anchor < list.length && moving.has(list[anchor]!)) {
      anchor += 1;
    }
    const insertBefore = anchor + 1;
    const next = applyMove(list, run, insertBefore);
    if (next.some((id, i) => id !== list[i])) {
      moves.push({ playlistTrackIds: run, insertBefore });
      list = next;
    }
  }
  return moves;
}
