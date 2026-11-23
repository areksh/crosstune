/**
 * One pass over a managed playlist (ADR-0007, ADR-0008):
 *
 *   1. locate the playlist (a deleted one pauses the job);
 *   2. notice reverts -- a track a tidy-up replaced that is back again was put
 *      back by the user (or an undo), so that finding is ignored from now on;
 *   3. the source step: resolve the source, map it through the substitutions,
 *      reconcile with what the playlist holds (./reconcile.ts) and write the
 *      difference;
 *   4. the tidy step: run the tidy-ups that are due, applying or suggesting
 *      what they find (./tidy.ts).
 *
 * The caller runs a pass inside one history entry (Journal.run with a recording
 * client), so every pass can be undone; an undone pass then looks to the next
 * one like the user's edits, and is respected.
 */

import type { EntryId, PlaylistId, TrackId } from "../services/ids.js";
import { isNotFound } from "../services/errors.js";
import { ServiceError, type Playlist, type Track } from "../services/model.js";
import type { UpgradeResolverClient } from "../features/upgrade.js";
import {
  capList,
  playlistIdOf,
  STATE_LIST_CAP,
  type Finding,
  type Job,
  type JobState,
  type RunResultSummary,
  type SourceDef,
  type Suggestion,
  type TidyKind,
  type TidyMode,
  type TidyState,
} from "./model.js";
import { planMoves, reconcile, settlePending, type PresentEntry } from "./reconcile.js";
import { resolveSource, type SourceClient } from "./recipes/index.js";
import { findReverts, mapDesired } from "./substitutions.js";
import {
  applyFindings,
  dueTidies,
  findTidyFindings,
  screenFindings,
  stillApplies,
  type TidyBook,
  type TidyTarget,
  type TidyWriteClient,
} from "./tidy.js";

export type RefreshClient = SourceClient &
  TidyWriteClient &
  Pick<UpgradeResolverClient, "searchTracks"> & {
    getPlaylist(playlistId: PlaylistId): Promise<Playlist>;
    getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
    getFavoriteTracks(): Promise<Track[]>;
    createPlaylist(
      name: string,
      options?: { description?: string; isPublic?: boolean },
    ): Promise<Playlist>;
    addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void>;
    removeTracksFromPlaylist(playlistId: PlaylistId, playlistTrackIds: readonly EntryId[]): Promise<void>;
    movePlaylistTracks(
      playlistId: PlaylistId,
      playlistTrackIds: readonly EntryId[],
      insertBefore: number,
    ): Promise<void>;
  };

export interface PreviewFinding {
  key: string;
  tidy: TidyKind;
  summary: string;
  mode: TidyMode;
}

export interface RefreshPreview {
  createsPlaylist: boolean;
  add: { trackId: TrackId; source: string }[];
  remove: PresentEntry[];
  newlyDismissed: TrackId[];
  withheldRemovals: number;
  complete: boolean;
  notes: string[];
  /** What the tidy-ups due this pass found, and whether they would apply or suggest it. */
  findings: PreviewFinding[];
}

export interface RefreshOutcome {
  /** The job's new state (unchanged on a dry run). */
  state: JobState;
  result: RunResultSummary;
  preview: RefreshPreview;
}

export interface PassOptions {
  now: Date;
  dryRun?: boolean;
  /** Original dates of favourites the favourites job's tidy-ups replaced. */
  favouriteDates?: ReadonlyMap<TrackId, string>;
}

export const MANAGED_DESCRIPTION = "Managed by qobuz-helper";

/**
 * A pass failed after it may have changed the playlist. `state` is what to
 * save so the next pass carries on from what was done: the playlist (even if
 * just created), the writes in flight (`pending`), and what the source step
 * finished before a tidy-up failed.
 */
export class RefreshWriteError extends Error {
  readonly state: JobState;

  constructor(cause: unknown, state: JobState) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RefreshWriteError";
    this.state = state;
  }
}

function isAuthentication(error: unknown): boolean {
  return error instanceof ServiceError && error.kind === "authentication";
}

const EMPTY_PREVIEW: RefreshPreview = {
  createsPlaylist: false,
  add: [],
  remove: [],
  newlyDismissed: [],
  withheldRemovals: 0,
  complete: true,
  notes: [],
  findings: [],
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

function deletedNote(job: Job): string {
  return job.target.type === "adopted"
    ? "Paused: the playlist was deleted or cannot be read. Resume to try again, or remove the job."
    : "Paused: the playlist was deleted. Resume to create a new one, or remove the job.";
}

function entriesOf(tracks: readonly Track[]): PresentEntry[] {
  return tracks.flatMap((track) =>
    track.playlistTrackId === undefined ? [] : [{ playlistTrackId: track.playlistTrackId, trackId: track.id }],
  );
}

export async function runPass(
  client: RefreshClient,
  job: Job,
  state: JobState,
  options: PassOptions,
): Promise<RefreshOutcome> {
  const { now } = options;
  const dryRun = options.dryRun === true;
  if (state.paused !== undefined) {
    return paused(state, now, deletedNote(job));
  }

  // 1. Locate.
  let playlistId = playlistIdOf(job, state);
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
        deletedNote(job),
      );
    }
  }
  const due = dueTidies(job.tidy, state.tidy, now);
  if (job.target.type === "favourites" && due.length === 0) {
    return nothingDue(state, now);
  }
  let tracks: Track[] =
    job.target.type === "favourites"
      ? await client.getFavoriteTracks()
      : playlistId === undefined
        ? []
        : await client.getPlaylistTracks(playlistId);

  // 2. Reverts.
  const reverts = findReverts(state.substitutions, new Set(tracks.map((track) => track.id)));
  let next: JobState = {
    ...state,
    substitutions: reverts.kept,
    ignored: capList([...state.ignored, ...reverts.revertedKeys], STATE_LIST_CAP),
  };
  const notes: string[] = [];
  if (reverts.revertedKeys.length > 0) {
    notes.push(`${reverts.revertedKeys.length} tidy-up change(s) were put back by hand; they are left alone from now on.`);
  }

  // 3. Source step.
  let preview: RefreshPreview = { ...EMPTY_PREVIEW, notes };
  let counts = { added: 0, removed: 0, dismissed: 0 };
  let complete = true;
  if (job.source !== undefined) {
    const step = await sourceStep(client, { ...job, source: job.source }, next, tracks, playlistId, options);
    next = step.state;
    playlistId = step.playlistId;
    tracks = step.tracks;
    complete = step.preview.complete;
    preview = { ...step.preview, notes: [...notes, ...step.preview.notes] };
    counts = step.counts;
  }

  // 4. Tidy step.
  const target: TidyTarget | undefined =
    job.target.type === "favourites"
      ? { type: "favourites" }
      : playlistId === undefined
        ? undefined
        : { type: "playlist", playlistId };
  let tidyCounts = { replaced: 0, tidyRemoved: 0, suggested: 0 };
  if (target !== undefined && due.length > 0) {
    try {
      const step = await tidyStep(client, job, next, due, target, tracks, options);
      next = step.state;
      preview = { ...preview, findings: step.findings, notes: [...preview.notes, ...step.notes] };
      tidyCounts = step.counts;
    } catch (error) {
      if (isAuthentication(error) && !dryRun) {
        throw new RefreshWriteError(error, next);
      }
      if (isAuthentication(error)) {
        throw error;
      }
      complete = false;
      preview = {
        ...preview,
        notes: [...preview.notes, `Tidy-ups could not run (${error instanceof Error ? error.message : String(error)}).`],
      };
    }
  }

  const result: RunResultSummary = {
    at: now.toISOString(),
    status: complete ? "ok" : "partial",
    ...counts,
    ...(tidyCounts.replaced > 0 && { replaced: tidyCounts.replaced }),
    ...(tidyCounts.tidyRemoved > 0 && { tidyRemoved: tidyCounts.tidyRemoved }),
    ...(tidyCounts.suggested > 0 && { suggested: tidyCounts.suggested }),
    notes: preview.notes,
  };
  if (dryRun) {
    return { state, result, preview };
  }
  next = { ...next, lastRunAt: now.toISOString(), lastResult: result };
  if (playlistId !== undefined && job.target.type === "created") {
    next.playlistId = playlistId;
  }
  return { state: next, result, preview };
}

/** @deprecated the v1 name of {@link runPass}. */
export const refreshManagedPlaylist = runPass;

function nothingDue(state: JobState, now: Date): RefreshOutcome {
  const result: RunResultSummary = {
    at: now.toISOString(),
    status: "ok",
    added: 0,
    removed: 0,
    dismissed: 0,
    notes: ["No tidy-up is due yet."],
  };
  return { state: { ...state, lastRunAt: now.toISOString(), lastResult: result }, result, preview: { ...EMPTY_PREVIEW, notes: result.notes } };
}

interface SourceStepResult {
  state: JobState;
  playlistId: PlaylistId | undefined;
  /** The playlist's tracks after the step. */
  tracks: Track[];
  preview: RefreshPreview;
  counts: { added: number; removed: number; dismissed: number };
}

async function sourceStep(
  client: RefreshClient,
  job: Job & { source: SourceDef },
  state: JobState,
  tracks0: readonly Track[],
  playlistId0: PlaylistId | undefined,
  options: PassOptions,
): Promise<SourceStepResult> {
  const recipe = await resolveSource(client, job, state.source ?? {}, {
    now: options.now,
    ...(options.favouriteDates !== undefined && { favouriteDates: options.favouriteDates }),
  });
  const desired = mapDesired(recipe.tracks, state.substitutions);
  const present = entriesOf(tracks0);
  const owned0 =
    state.pending === undefined ? state.owned : settlePending(state.owned, present, state.pending);
  const plan = reconcile({
    mode: job.edits,
    desired,
    complete: recipe.complete,
    present,
    owned: owned0,
    dismissed: state.dismissed,
  });

  const notes = [...recipe.notes];
  if (plan.withheldRemovals > 0) {
    notes.push(`Kept ${plan.withheldRemovals} track(s) that may no longer belong, as not everything could be read.`);
  }
  const sourceOf = new Map(desired.map((track) => [track.trackId, track.source]));
  const removing = new Set(plan.remove);
  const preview: RefreshPreview = {
    ...EMPTY_PREVIEW,
    createsPlaylist: playlistId0 === undefined,
    add: plan.add.map((trackId) => ({ trackId, source: sourceOf.get(trackId) ?? "" })),
    remove: present.filter((entry) => removing.has(entry.playlistTrackId)),
    newlyDismissed: plan.newlyDismissed,
    withheldRemovals: plan.withheldRemovals,
    complete: recipe.complete,
    notes,
  };
  const counts = { added: plan.add.length, removed: plan.remove.length, dismissed: plan.newlyDismissed.length };
  const sourceState = Object.keys(recipe.state).length > 0 ? recipe.state : undefined;

  if (options.dryRun === true) {
    return { state, playlistId: playlistId0, tracks: [...tracks0], preview, counts };
  }

  let playlistId = playlistId0;
  let owned = plan.keptOwned;
  let tracks: Track[] = [...tracks0];
  try {
    if (playlistId === undefined) {
      const isPublic = job.target.type === "created" && job.target.isPublic;
      playlistId = (await client.createPlaylist(job.name, { description: MANAGED_DESCRIPTION, isPublic })).id;
    }
    if (plan.remove.length > 0) {
      await client.removeTracksFromPlaylist(playlistId, plan.remove);
      tracks = tracks.filter((track) => track.playlistTrackId === undefined || !removing.has(track.playlistTrackId));
    }
    if (plan.add.length > 0) {
      await client.addTracksToPlaylist(playlistId, plan.add);
      const before = new Set(present.map((entry) => entry.playlistTrackId));
      const adding = new Set(plan.add);
      tracks = await client.getPlaylistTracks(playlistId);
      owned = [
        ...owned,
        ...entriesOf(tracks).filter((entry) => !before.has(entry.playlistTrackId) && adding.has(entry.trackId)),
      ];
    }
    // New tracks go into place; a mirrored playlist is kept in order even when
    // nothing was added (a respected one keeps the order the user gave it).
    if (plan.add.length > 0 || job.edits === "mirror") {
      const reordered = await reorder(client, playlistId, entriesOf(tracks), owned, desired.map((t) => t.trackId));
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
    if (playlistId !== undefined && job.target.type === "created") {
      partial.playlistId = playlistId;
    }
    if (sourceState !== undefined) {
      partial.source = sourceState;
    }
    throw new RefreshWriteError(cause, partial);
  }

  const next: JobState = { ...state, owned, dismissed: plan.dismissed };
  if (playlistId !== undefined && job.target.type === "created") {
    next.playlistId = playlistId;
  }
  delete next.pending;
  if (sourceState !== undefined) {
    next.source = sourceState;
  } else {
    delete next.source;
  }
  return { state: next, playlistId, tracks, preview, counts };
}

/** Move the job's entries into the desired order; false if a move failed. */
async function reorder(
  client: RefreshClient,
  playlistId: PlaylistId,
  entries: readonly PresentEntry[],
  owned: readonly { playlistTrackId: EntryId }[],
  desiredOrder: readonly TrackId[],
): Promise<boolean> {
  const rank = new Map<TrackId, number>();
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

interface TidyStepResult {
  state: JobState;
  findings: PreviewFinding[];
  notes: string[];
  counts: { replaced: number; tidyRemoved: number; suggested: number };
}

export function bookOf(state: JobState): TidyBook {
  return {
    owned: state.owned,
    substitutions: state.substitutions,
    applied: state.applied,
    ignored: state.ignored,
    favouriteDates: new Map((state.favouriteDates ?? []).map((entry) => [entry.trackId, entry.at])),
  };
}

export function withBook(state: JobState, book: TidyBook): JobState {
  const next: JobState = {
    ...state,
    owned: book.owned,
    substitutions: book.substitutions,
    applied: book.applied,
    ignored: book.ignored,
  };
  if (book.favouriteDates.size > 0) {
    next.favouriteDates = capList(
      [...book.favouriteDates].map(([trackId, at]) => ({ trackId, at })),
      STATE_LIST_CAP,
    );
  } else {
    delete next.favouriteDates;
  }
  return next;
}

async function tidyStep(
  client: RefreshClient,
  job: Job,
  state: JobState,
  due: readonly TidyKind[],
  target: TidyTarget,
  tracks: readonly Track[],
  options: PassOptions,
): Promise<TidyStepResult> {
  const { now } = options;
  const book = bookOf(state);
  const found = await findTidyFindings(client, job.tidy, due, target, tracks, {
    now,
    state: state.tidy,
    favouriteDates: target.type === "favourites" ? book.favouriteDates : (options.favouriteDates ?? new Map()),
  });
  const screened = screenFindings(found.findings, book);
  const modeOf = (finding: Finding): TidyMode => job.tidy[finding.tidy]?.mode ?? "apply";
  const toApply = screened.fresh.filter((finding) => modeOf(finding) === "apply");
  const toSuggest = screened.fresh.filter((finding) => modeOf(finding) === "suggest");
  const findings = screened.fresh.map((finding) => ({
    key: finding.key,
    tidy: finding.tidy,
    summary: finding.summary,
    mode: modeOf(finding),
  }));
  const notes = [...found.notes];
  const counts = { replaced: 0, tidyRemoved: 0, suggested: toSuggest.length };
  if (options.dryRun === true) {
    return { state, findings, notes, counts };
  }

  let nextBook: TidyBook = { ...book, ignored: capList([...book.ignored, ...screened.newlyIgnored], STATE_LIST_CAP) };
  if (toApply.length > 0) {
    const applied = await applyFindings(client, target, toApply, tracks, nextBook);
    nextBook = applied.book;
    counts.replaced = applied.replaced;
    counts.tidyRemoved = applied.removed;
    notes.push(...applied.notes);
  }

  // Each due tidy-up's suggestions are replaced by what it found this time --
  // but an upgrade not searched again this time (checked recently) stays
  // suggested while it still applies.
  const earlier = new Map(state.suggestions.map((suggestion) => [suggestion.key, suggestion]));
  const searched = new Set(found.searched);
  const fresh = new Set(toSuggest.map((finding) => finding.key));
  const carried = state.suggestions.filter(
    (suggestion) =>
      due.includes(suggestion.tidy) &&
      suggestion.tidy === "upgrade" &&
      job.tidy.upgrade?.mode === "suggest" &&
      !fresh.has(suggestion.key) &&
      suggestion.change.type === "replace" &&
      !searched.has(suggestion.change.trackId) &&
      stillApplies(suggestion, target, tracks),
  );
  const suggestions: Suggestion[] = [
    ...state.suggestions.filter((suggestion) => !due.includes(suggestion.tidy)),
    ...carried,
    ...toSuggest.map((finding) => ({ ...finding, foundAt: earlier.get(finding.key)?.foundAt ?? now.toISOString() })),
  ];
  counts.suggested += carried.length;
  const at = now.toISOString();
  const tidy: TidyState = { ...state.tidy };
  for (const kind of due) {
    if (kind === "upgrade") {
      tidy.upgrade = { lastRunAt: at, checked: found.checked ?? state.tidy.upgrade?.checked ?? [] };
    } else {
      tidy[kind] = { lastRunAt: at };
    }
  }
  return { state: { ...withBook(state, nextBook), suggestions, tidy }, findings, notes, counts };
}
