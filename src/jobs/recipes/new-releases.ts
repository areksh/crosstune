/**
 * The "new releases feed" recipe: the tracks of what a set of artists (and,
 * optionally, a snapshot of their similar artists) released in a window.
 *
 * Deterministic for the same inputs and state: the similar artists are a
 * snapshot taken once and refreshed every `refreshDays`, not re-walked each
 * run, so changes in Qobuz's similar lists do not churn the playlist.
 * Anything that failed to load makes the result incomplete, which stops the
 * refresh from removing tracks (see ../reconcile.ts).
 */

import { findNewReleases, type NewReleasesClient } from "../../features/new-releases.js";
import {
  fetchAlbumTracks,
  type AlbumTracksClient,
} from "../../features/playlist-from-albums.js";
import type { SimilarArtistsClient } from "../../features/similar-artists.js";
import { compileTrackFilter, NO_FILTER } from "../../features/track-filter.js";
import type { NewReleasesRecipeDef, Shape, SourceState } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";
import {
  applyShape,
  seedArtists,
  similarSnapshot,
  type RecipeContext,
  type RecipeResult,
} from "./common.js";

export type { RecipeContext, RecipeResult };

export type FeedClient = NewReleasesClient &
  AlbumTracksClient &
  Pick<SimilarArtistsClient, "getSimilarArtists">;

/** The most artists (seeds and similar) a feed checks per refresh. */
export const MAX_FEED_ARTISTS = 1_000;

export async function resolveNewReleasesFeed(
  client: FeedClient,
  def: NewReleasesRecipeDef,
  shape: Shape | undefined,
  ctx: RecipeContext<Pick<SourceState, "similar">>,
): Promise<RecipeResult> {
  const notes: string[] = [];
  let complete = true;
  const filter = def.exclude === undefined ? NO_FILTER : compileTrackFilter(def.exclude);

  const seeds = await seedArtists(client, def.artists);
  let similar: SourceState["similar"] = ctx.state.similar;
  if (def.similar !== undefined) {
    const snap = await similarSnapshot(client, seeds, def.similar, similar, ctx.now, filter);
    similar = snap.similar;
    if (snap.failure !== undefined) {
      complete = false;
      notes.push(snap.failure);
    }
  }
  const snapshot = def.similar === undefined ? [] : (similar?.artists ?? []);

  const plan = await findNewReleases(client, {
    source: { type: "artists", artists: [...seeds, ...snapshot] },
    now: ctx.now,
    window: def.window,
    include: def.include,
    filter,
    hideFavourites: def.hideFavourites,
    maxArtists: MAX_FEED_ARTISTS,
  });
  if (plan.failedArtists.length > 0) {
    complete = false;
    notes.push(`Could not read the releases of ${plan.failedArtists.join(", ")}.`);
  }
  if (plan.capped) {
    // Which artists fall past the cap shifts as the list changes: removing
    // their releases would churn the playlist, so remove nothing.
    complete = false;
    notes.push(
      `Only the first ${plan.checkedArtists.toLocaleString("en-GB")} of ${plan.totalArtists.toLocaleString("en-GB")} artists were checked.`,
    );
  }

  const releases =
    shape?.maxReleases === undefined ? plan.releases : plan.releases.slice(0, shape.maxReleases);
  const { fetched, failedAlbumIds } = await fetchAlbumTracks(
    client,
    releases.map((release) => release.id),
    filter,
  );
  if (failedAlbumIds.length > 0) {
    complete = false;
    notes.push(`Could not read the tracks of ${failedAlbumIds.length} release(s).`);
  }

  let tracks: DesiredTrack[] = [];
  const seen = new Set<number>();
  for (const album of fetched) {
    for (const { track, exclusion } of album.tracks) {
      if (exclusion === undefined && !seen.has(track.id)) {
        seen.add(track.id);
        tracks.push({
          trackId: track.id,
          source: `album:${album.albumId}`,
          ...(track.duration !== undefined && { durationSeconds: track.duration }),
        });
      }
    }
  }
  tracks = applyShape(tracks, shape);

  return { tracks, complete, notes, ...(similar !== undefined && { similar }) };
}
