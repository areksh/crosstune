/**
 * The "live combined playlist" source: the combination of some playlists
 * and/or the favourites, kept in sync with them (spec section 4).
 *
 * Each input is read on its own. With `merge` a failed input only makes the
 * result incomplete (add what was read, remove nothing); with `only-first` and
 * `common` a missing input would change which songs qualify, so a failure
 * fails the pass, which is then retried with backoff.
 */

import { shortId, type PlaylistId } from "../../services/ids.js";
import type { Track } from "../../services/model.js";
import { combineTracks, type CombineInput } from "../../features/combine.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../../features/concurrency.js";
import { compileTrackFilter, trackExclusion } from "../../features/track-filter.js";
import type { CombinedSource, PlaylistInput } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";
import { message, stableShuffle, type SourceResult } from "./common.js";

export interface PlaylistInputsClient {
  getFavoriteTracks(): Promise<Track[]>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

export function inputLabel(input: PlaylistInput): string {
  return input.type === "favourites" ? "favourites" : `playlist:${shortId(input.playlistId)}`;
}

/** Read each input; failures are returned rather than thrown. */
export async function readInputs(
  client: PlaylistInputsClient,
  inputs: readonly PlaylistInput[],
): Promise<{ input: PlaylistInput; tracks?: Track[]; error?: string }[]> {
  return mapWithConcurrency(inputs, DEFAULT_CONCURRENCY, async (input) => {
    try {
      const tracks =
        input.type === "favourites"
          ? await client.getFavoriteTracks()
          : await client.getPlaylistTracks(input.playlistId);
      return { input, tracks };
    } catch (error) {
      return { input, error: message(error) };
    }
  });
}

export function describeInput(input: PlaylistInput): string {
  return input.type === "favourites" ? "the favourites" : `playlist ${shortId(input.playlistId)}`;
}

export async function resolveCombined(
  client: PlaylistInputsClient,
  def: CombinedSource,
  ctx: { jobId: string },
): Promise<SourceResult> {
  const read = await readInputs(client, def.inputs);
  const failed = read.filter((entry) => entry.tracks === undefined);
  const notes: string[] = [];
  if (failed.length > 0) {
    const what = failed.map((entry) => `${describeInput(entry.input)} (${entry.error ?? "unknown error"})`).join(", ");
    if (def.mode !== "merge" || failed.length === read.length) {
      throw new Error(`Could not read ${what}.`);
    }
    notes.push(`Could not read ${what}; kept every track for now.`);
  }
  const ok = read.filter((entry): entry is { input: PlaylistInput; tracks: Track[] } => entry.tracks !== undefined);
  const inputs: CombineInput[] = ok.map((entry) => ({ label: inputLabel(entry.input), tracks: entry.tracks }));
  const plan = combineTracks(inputs, {
    mode: def.mode,
    keep: def.keep,
    matchSongs: def.matchSongs,
    order: def.order === "shuffle" ? "sequential" : def.order,
  });
  const filter = def.exclude === undefined ? undefined : compileTrackFilter(def.exclude);
  let kept = plan.tracks.filter((entry) => filter === undefined || trackExclusion(entry.track, filter) === undefined);
  if (def.order === "shuffle") {
    kept = stableShuffle(ctx.jobId, kept, (entry) => entry.track.id);
  }
  const tracks: DesiredTrack[] = kept.map((entry) => ({
    trackId: entry.track.id,
    source: inputs[entry.inputs[0] ?? 0]?.label ?? "",
    ...(entry.track.duration !== undefined && { durationSeconds: entry.track.duration }),
  }));
  return { tracks, complete: failed.length === 0, notes, state: {} };
}
