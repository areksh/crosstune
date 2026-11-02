/**
 * Suggestions: findings of tidy-ups in "suggest" mode, waiting for the user.
 *
 * Accepting re-reads the playlist, drops suggestions that no longer apply (the
 * entry is gone) and writes the rest exactly as "apply" mode would, with the
 * same book-keeping. Ignoring remembers the keys, so they are never suggested
 * again. The caller runs an accept inside one history entry, under the jobs
 * lock.
 */

import { capList, playlistIdOf, STATE_LIST_CAP, type Job, type JobState } from "./model.js";
import { bookOf, withBook, type RefreshClient } from "./refresh.js";
import { applyFindings, stillApplies, type TidyTarget } from "./tidy.js";

export type SuggestionKeys = readonly string[] | "all";

function picks(state: JobState, keys: SuggestionKeys): Set<string> {
  return new Set(keys === "all" ? state.suggestions.map((suggestion) => suggestion.key) : keys);
}

/** Forget suggestions and never make them again. */
export function ignoreSuggestions(state: JobState, keys: SuggestionKeys): JobState {
  const chosen = picks(state, keys);
  const known = state.suggestions.filter((suggestion) => chosen.has(suggestion.key)).map((s) => s.key);
  return {
    ...state,
    suggestions: state.suggestions.filter((suggestion) => !chosen.has(suggestion.key)),
    ignored: capList([...state.ignored, ...known.filter((key) => !state.ignored.includes(key))], STATE_LIST_CAP),
  };
}

export interface AcceptResult {
  state: JobState;
  applied: number;
  /** Suggestions dropped because they no longer apply. */
  stale: number;
  replaced: number;
  removed: number;
  notes: string[];
}

export async function acceptSuggestions(
  client: RefreshClient,
  job: Job,
  state: JobState,
  keys: SuggestionKeys,
  now: Date,
): Promise<AcceptResult> {
  const chosen = picks(state, keys);
  const wanted = state.suggestions.filter((suggestion) => chosen.has(suggestion.key));
  const playlistId = playlistIdOf(job, state);
  let target: TidyTarget;
  if (job.target.type === "favourites") {
    target = { type: "favourites" };
  } else if (playlistId === undefined) {
    throw new Error("The playlist has not been created yet.");
  } else {
    target = { type: "playlist", playlistId };
  }
  const tracks =
    target.type === "favourites" ? await client.getFavoriteTracks() : await client.getPlaylistTracks(target.playlistId);
  const applicable = wanted.filter((suggestion) => stillApplies(suggestion, target, tracks));
  const stale = wanted.length - applicable.length;

  let next: JobState = {
    ...state,
    suggestions: state.suggestions.filter((suggestion) => !chosen.has(suggestion.key)),
  };
  if (applicable.length === 0) {
    return { state: next, applied: 0, stale, replaced: 0, removed: 0, notes: [] };
  }
  const result = await applyFindings(client, target, applicable, tracks, bookOf(next));
  next = withBook(next, result.book);
  // A suggestion whose write failed is offered again.
  const failed = applicable.filter((suggestion) => !result.appliedKeys.includes(suggestion.key));
  next.suggestions = [...next.suggestions, ...failed];
  next.lastRunAt = next.lastRunAt ?? now.toISOString();
  return {
    state: next,
    applied: result.appliedKeys.length,
    stale,
    replaced: result.replaced,
    removed: result.removed,
    notes: result.notes,
  };
}
