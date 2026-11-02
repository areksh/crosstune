/**
 * Refresh one managed playlist: resolve its recipe, see what the playlist
 * holds now, reconcile the two (./reconcile.ts) and write the difference.
 *
 * The caller runs this inside a history entry (Journal.run with a recording
 * client), so every refresh can be undone; an undone refresh then looks to the
 * next one exactly like the user removing the tracks, and they are dismissed.
 */

import { QobuzError, type Playlist, type Track } from "../qobuz/index.js";
import type { JobState, ManagedPlaylistJob, RunResultSummary } from "./model.js";
import { planMoves, reconcile, settlePending, type PresentEntry } from "./reconcile.js";
import { resolveNewReleasesFeed, type FeedClient } from "./recipes/new-releases.js";

export type RefreshClient = FeedClient & {
  getPlaylist(playlistId: number): Promise<Playlist>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  addTracksToPlaylist(playlistId: number, trackIds: readonly number[]): Promise<void>;
  removeTracksFromPlaylist(playlistId: number, playlistTrackIds: readonly number[]): Promise<void>;
  movePlaylistTracks(
    playlistId: number,
    playlistTrackIds: readonly number[],
    insertBefore: number,
  ): Promise<void>;
};

export interface RefreshPreview {
  createsPlaylist: boolean;
  add: { trackId: number; source: string }[];
  remove: PresentEntry[];
  newlyDismissed: number[];
  withheldRemovals: number;
  complete: boolean;
  notes: string[];
}

export interface RefreshOutcome {
  /** The job's new state (unchanged on a dry run). */
  state: JobState;
  result: RunResultSummary;
  preview: RefreshPreview;
}

export const MANAGED_DESCRIPTION = "Managed by qobuz-helper";

/**
 * A refresh failed after it may have changed the playlist. `state` is what to
 * save so the next refresh carries on from what was done: the playlist (even
 * if just created) and the writes in flight (`pending`).
 */
export class RefreshWriteError extends Error {
  readonly state: JobState;

  constructor(cause: unknown, state: JobState) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RefreshWriteError";
    this.state = state;
  }
}

/** True for Qobuz's "no such thing" (HTTP 404). */
export function isNotFound(error: unknown): boolean {
  return error instanceof QobuzError && error.kind === "api-response" && /HTTP 404/.test(error.message);
}

const EMPTY_PREVIEW: RefreshPreview = {
  createsPlaylist: false,
  add: [],
  remove: [],
  newlyDismissed: [],
  withheldRemovals: 0,
  complete: true,
  notes: [],
};

function paused(state: JobState, now: Date, note: string): RefreshOutcome {
  const result: RunResultSummary = {
    at: now.toISOString(),
    status: "paused",
    added: 0,
    removed: 0,
    dismissed: 0,
    notes: [note],
  };
  return { state, result, preview: { ...EMPTY_PREVIEW, notes: [note] } };
}

const DELETED_NOTE = "Paused: the playlist was deleted. Resume to create a new one, or remove the job.";

export async function refreshManagedPlaylist(
  client: RefreshClient,
  job: ManagedPlaylistJob,
  state: JobState,
  options: { now: Date; dryRun?: boolean },
): Promise<RefreshOutcome> {
  const { now } = options;
  if (state.paused !== undefined) {
    return paused(state, now, DELETED_NOTE);
  }
  let playlistId = state.playlistId;
  if (playlistId !== undefined) {
    try {
      await client.getPlaylist(playlistId);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      return paused(
        { ...state, paused: { reason: "playlist-deleted", since: now.toISOString() } },
        now,
        DELETED_NOTE,
      );
    }
  }

  const recipe = await resolveNewReleasesFeed(client, job.recipe, job.shape, {
    now,
    jobId: job.id,
    state: state.similar === undefined ? {} : { similar: state.similar },
  });
  const present = playlistId === undefined ? [] : entriesOf(await client.getPlaylistTracks(playlistId));
  const owned0 =
    state.pending === undefined ? state.owned : settlePending(state.owned, present, state.pending);
  const plan = reconcile({
    mode: job.edits,
    desired: recipe.tracks,
    complete: recipe.complete,
    present,
    owned: owned0,
    dismissed: state.dismissed,
  });

  const notes = [...recipe.notes];
  if (plan.withheldRemovals > 0) {
    notes.push(`Kept ${plan.withheldRemovals} track(s) that may no longer belong, as not everything could be read.`);
  }
  const sourceOf = new Map(recipe.tracks.map((track) => [track.trackId, track.source]));
  const removing = new Set(plan.remove);
  const preview: RefreshPreview = {
    createsPlaylist: playlistId === undefined,
    add: plan.add.map((trackId) => ({ trackId, source: sourceOf.get(trackId) ?? "" })),
    remove: present.filter((entry) => removing.has(entry.playlistTrackId)),
    newlyDismissed: plan.newlyDismissed,
    withheldRemovals: plan.withheldRemovals,
    complete: recipe.complete,
    notes,
  };
  const status = recipe.complete ? "ok" : "partial";

  if (options.dryRun === true) {
    return {
      state,
      result: {
        at: now.toISOString(),
        status,
        added: plan.add.length,
        removed: plan.remove.length,
        dismissed: plan.newlyDismissed.length,
        notes,
      },
      preview,
    };
  }

  let owned = plan.keptOwned;
  try {
    if (playlistId === undefined) {
      playlistId = (
        await client.createPlaylist(job.name, { description: MANAGED_DESCRIPTION, isPublic: job.isPublic })
      ).id;
    }
    if (plan.remove.length > 0) {
      await client.removeTracksFromPlaylist(playlistId, plan.remove);
    }
    let after: PresentEntry[];
    if (plan.add.length > 0) {
      await client.addTracksToPlaylist(playlistId, plan.add);
      const before = new Set(present.map((entry) => entry.playlistTrackId));
      const adding = new Set(plan.add);
      after = entriesOf(await client.getPlaylistTracks(playlistId));
      owned = [
        ...owned,
        ...after.filter((entry) => !before.has(entry.playlistTrackId) && adding.has(entry.trackId)),
      ];
    } else {
      const removed = new Set(plan.remove);
      after = present.filter((entry) => !removed.has(entry.playlistTrackId));
    }
    // New tracks go into place; a mirrored playlist is kept in order even when
    // nothing was added (a respected one keeps the order the user gave it).
    if (plan.add.length > 0 || job.edits === "mirror") {
      const reordered = await reorder(client, playlistId, after, owned, recipe.tracks.map((t) => t.trackId));
      if (!reordered) {
        notes.push("The tracks could not be moved into place; new ones are at the end.");
      }
    }
  } catch (cause) {
    const partial: JobState = {
      ...state,
      owned: owned0,
      dismissed: plan.dismissed,
      pending: { removed: plan.remove, added: plan.add },
    };
    if (playlistId !== undefined) {
      partial.playlistId = playlistId;
    }
    if (recipe.similar !== undefined) {
      partial.similar = recipe.similar;
    }
    throw new RefreshWriteError(cause, partial);
  }

  const result: RunResultSummary = {
    at: now.toISOString(),
    status,
    added: plan.add.length,
    removed: plan.remove.length,
    dismissed: plan.newlyDismissed.length,
    notes,
  };
  const next: JobState = {
    ...state,
    playlistId,
    owned,
    dismissed: plan.dismissed,
    lastRunAt: now.toISOString(),
    lastResult: result,
  };
  delete next.pending;
  if (recipe.similar !== undefined) {
    next.similar = recipe.similar;
  }
  return { state: next, result, preview };
}

function entriesOf(tracks: readonly Track[]): PresentEntry[] {
  return tracks.flatMap((track) =>
    track.playlistTrackId === undefined ? [] : [{ playlistTrackId: track.playlistTrackId, trackId: track.id }],
  );
}

/** Move the job's entries into the desired order; false if a move failed. */
async function reorder(
  client: RefreshClient,
  playlistId: number,
  entries: readonly PresentEntry[],
  owned: readonly { playlistTrackId: number }[],
  desiredOrder: readonly number[],
): Promise<boolean> {
  const rank = new Map<number, number>();
  desiredOrder.forEach((trackId, index) => {
    if (!rank.has(trackId)) {
      rank.set(trackId, index);
    }
  });
  const ownedIds = new Set(owned.map((entry) => entry.playlistTrackId));
  const moves = planMoves(
    entries.map((entry) => {
      const r = ownedIds.has(entry.playlistTrackId) ? rank.get(entry.trackId) : undefined;
      return { playlistTrackId: entry.playlistTrackId, ...(r !== undefined && { rank: r }) };
    }),
  );
  try {
    for (const move of moves) {
      await client.movePlaylistTracks(playlistId, move.playlistTrackIds, move.insertBefore);
    }
    return true;
  } catch {
    return false;
  }
}
