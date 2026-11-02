/**
 * Reconcile a managed playlist with what its recipe wants (spec section 4).
 *
 * Pure: given the desired tracks, the playlist's current entries and what the
 * job owns (entries it added) and has dismissed (tracks the user took out), say
 * what to add and remove. In *respect* mode the job only ever removes its own
 * entries, and an owned entry the user removed is dismissed for good; in
 * *mirror* mode the playlist is made to equal the desired list. A resolve that
 * was not complete (some source failed) never removes anything, so a Qobuz
 * hiccup cannot empty a playlist.
 */

import type { EditMode, OwnedEntry } from "./model.js";

export interface DesiredTrack {
  trackId: number;
  /** Where the track came from, for reports (e.g. "album:123"). */
  source: string;
  durationSeconds?: number;
}

export interface PresentEntry {
  playlistTrackId: number;
  trackId: number;
}

export interface ReconcileInput {
  mode: EditMode;
  desired: readonly DesiredTrack[];
  complete: boolean;
  present: readonly PresentEntry[];
  owned: readonly OwnedEntry[];
  dismissed: readonly number[];
}

export interface ReconcilePlan {
  /** Track ids to add, in desired order, each once. */
  add: number[];
  /** Playlist-track ids to remove. */
  remove: number[];
  /** Owned entries that stay (still present and not removed). */
  keptOwned: OwnedEntry[];
  /** The whole dismissed list after this run (empty in mirror mode). */
  dismissed: number[];
  /** Tracks dismissed by this run (the user removed them since last time). */
  newlyDismissed: number[];
  /** Removals skipped because the resolve was incomplete. */
  withheldRemovals: number;
}

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const desiredIds = new Set(input.desired.map((track) => track.trackId));
  const presentIds = new Set(input.present.map((entry) => entry.trackId));
  const presentEntries = new Set(input.present.map((entry) => entry.playlistTrackId));

  let candidates: PresentEntry[];
  let kept: OwnedEntry[];
  let dismissed: number[];
  let newlyDismissed: number[] = [];

  if (input.mode === "respect") {
    const stillThere = input.owned.filter((entry) => presentEntries.has(entry.playlistTrackId));
    const known = new Set(input.dismissed);
    newlyDismissed = unique(
      input.owned
        .filter((entry) => !presentEntries.has(entry.playlistTrackId))
        .map((entry) => entry.trackId)
        .filter((trackId) => !known.has(trackId)),
    );
    dismissed = [...input.dismissed, ...newlyDismissed];
    candidates = stillThere.filter((entry) => !desiredIds.has(entry.trackId));
    kept = stillThere;
  } else {
    // The job owns the whole playlist: anything undesired goes, and so does
    // every copy of a desired track after the first.
    const seen = new Set<number>();
    candidates = [];
    kept = [];
    for (const entry of input.present) {
      if (desiredIds.has(entry.trackId) && !seen.has(entry.trackId)) {
        seen.add(entry.trackId);
        kept.push({ playlistTrackId: entry.playlistTrackId, trackId: entry.trackId });
      } else {
        candidates.push(entry);
      }
    }
    dismissed = [];
  }

  const removing = input.complete ? candidates : [];
  const removed = new Set(removing.map((entry) => entry.playlistTrackId));
  const blocked = new Set(input.mode === "respect" ? dismissed : []);
  const keptOwned = input.complete
    ? kept.filter((entry) => !removed.has(entry.playlistTrackId))
    : input.mode === "respect"
      ? kept
      : // Mirror, incomplete: everything present stays and is the job's.
        input.present.map(({ playlistTrackId, trackId }) => ({ playlistTrackId, trackId }));

  return {
    add: unique(
      input.desired
        .map((track) => track.trackId)
        .filter((trackId) => !presentIds.has(trackId) && !blocked.has(trackId)),
    ),
    remove: removing.map((entry) => entry.playlistTrackId),
    keptOwned,
    dismissed,
    newlyDismissed,
    withheldRemovals: input.complete ? 0 : candidates.length,
  };
}

/**
 * Settle what a refresh that failed part-way was writing, before reconciling:
 * owned entries it was removing that are gone are dropped (they are not the
 * user's removals, so not dismissed), and entries of the tracks it was adding
 * are owned (one per track, not already owned) -- otherwise they would look
 * added by hand and never age out.
 */
export function settlePending(
  owned: readonly OwnedEntry[],
  present: readonly PresentEntry[],
  pending: { removed: readonly number[]; added: readonly number[] },
): OwnedEntry[] {
  const presentIds = new Set(present.map((entry) => entry.playlistTrackId));
  const removing = new Set(pending.removed);
  const kept = owned.filter(
    (entry) => presentIds.has(entry.playlistTrackId) || !removing.has(entry.playlistTrackId),
  );
  const ownedIds = new Set(kept.map((entry) => entry.playlistTrackId));
  const ownedTracks = new Set(kept.map((entry) => entry.trackId));
  const adding = new Set(pending.added);
  const adopted: OwnedEntry[] = [];
  for (const entry of present) {
    if (!ownedIds.has(entry.playlistTrackId) && adding.has(entry.trackId) && !ownedTracks.has(entry.trackId)) {
      ownedTracks.add(entry.trackId);
      adopted.push({ playlistTrackId: entry.playlistTrackId, trackId: entry.trackId });
    }
  }
  return [...kept, ...adopted];
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/** One `movePlaylistTracks` call: in front of the 1-based position, counted before the move. */
export interface Move {
  playlistTrackIds: number[];
  insertBefore: number;
}

interface Ranked {
  playlistTrackId: number;
  rank?: number;
}

/**
 * The moves that put ranked entries in rank order (lowest first), leaving
 * entries without a rank (added by hand) where they are.
 *
 * A longest increasing run of ranks that ends at the highest-ranked entry stays
 * put; every other ranked entry is moved, lowest rank first, in front of the
 * first already-ordered entry ranked above it. Ending the kept run at the highest rank means
 * every moved entry has such an entry, so no move targets past the end of the
 * playlist (whose behaviour on Qobuz is unverified).
 */
export function planMoves(entries: readonly Ranked[]): Move[] {
  const ranked = entries.filter((entry): entry is Required<Ranked> => entry.rank !== undefined);
  if (ranked.length < 2) {
    return [];
  }
  const keep = increasingRunEndingAtMax(ranked);
  const movers = ranked.filter((entry) => !keep.has(entry.playlistTrackId)).sort((a, b) => a.rank - b.rank);

  // Entries already in order: the kept run, plus each mover once placed. The
  // anchor must come from these -- an entry still to be moved may sit in front
  // of lower-ranked placed ones.
  const placed = new Set(keep);
  let list: Ranked[] = [...entries];
  const moves: Move[] = [];
  for (const mover of movers) {
    placed.add(mover.playlistTrackId);
    const anchorIndex = list.findIndex(
      (entry) =>
        entry.playlistTrackId !== mover.playlistTrackId &&
        placed.has(entry.playlistTrackId) &&
        entry.rank !== undefined &&
        entry.rank > mover.rank,
    );
    const anchor = list[anchorIndex];
    if (anchor === undefined) {
      continue; // Unreachable while the highest rank is kept; never move past the end.
    }
    const from = list.findIndex((entry) => entry.playlistTrackId === mover.playlistTrackId);
    if (from === anchorIndex - 1) {
      continue; // Already right in front of it.
    }
    moves.push({ playlistTrackIds: [mover.playlistTrackId], insertBefore: anchorIndex + 1 });
    const rest = list.filter((entry) => entry.playlistTrackId !== mover.playlistTrackId);
    const at = rest.indexOf(anchor);
    list = [...rest.slice(0, at), mover, ...rest.slice(at)];
  }
  return moves;
}

/** Playlist-track ids of a longest increasing (by rank) subsequence ending at the max rank. */
function increasingRunEndingAtMax(ranked: readonly Required<Ranked>[]): Set<number> {
  // Patience sorting with predecessors: for each entry, `previous` links an
  // increasing run ending there that is as long as any.
  const tails: number[] = []; // indexes into `ranked`, by run length - 1
  const previous: number[] = new Array<number>(ranked.length).fill(-1);
  let maxIndex = 0;
  ranked.forEach((entry, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((ranked[tails[middle] ?? 0]?.rank ?? 0) < entry.rank) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[index] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = index;
    if (entry.rank > (ranked[maxIndex]?.rank ?? -Infinity)) {
      maxIndex = index;
    }
  });
  const keep = new Set<number>();
  for (let index = maxIndex; index >= 0; index = previous[index] ?? -1) {
    const entry = ranked[index];
    if (entry !== undefined) {
      keep.add(entry.playlistTrackId);
    }
  }
  return keep;
}
