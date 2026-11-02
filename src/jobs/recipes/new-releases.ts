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

import type { Artist } from "../../qobuz/index.js";
import { findNewReleases, type NewReleasesClient } from "../../features/new-releases.js";
import {
  fetchAlbumTracks,
  type AlbumTracksClient,
} from "../../features/playlist-from-albums.js";
import { fitToLength } from "../../features/playlist-shape.js";
import {
  seedsFromPlaylist,
  walkSimilarArtists,
  type SimilarArtistsClient,
} from "../../features/similar-artists.js";
import { compileTrackFilter, NO_FILTER } from "../../features/track-filter.js";
import type { ArtistRef, JobState, NewReleasesRecipeDef, Shape } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";

export interface RecipeContext<S> {
  now: Date;
  jobId: string;
  state: S;
}

export interface RecipeResult {
  /** The desired tracks, in order. */
  tracks: DesiredTrack[];
  /** False when something failed to load: the refresh then removes nothing. */
  complete: boolean;
  notes: string[];
  /** The similar-artist snapshot to keep (unchanged unless refreshed). */
  similar?: JobState["similar"];
}

export type FeedClient = NewReleasesClient &
  AlbumTracksClient &
  Pick<SimilarArtistsClient, "getSimilarArtists">;

const DAY_MS = 86_400_000;

export async function resolveNewReleasesFeed(
  client: FeedClient,
  def: NewReleasesRecipeDef,
  shape: Shape | undefined,
  ctx: RecipeContext<Pick<JobState, "similar">>,
): Promise<RecipeResult> {
  const notes: string[] = [];
  let complete = true;
  const filter = def.exclude === undefined ? NO_FILTER : compileTrackFilter(def.exclude);

  const seeds = await seedArtists(client, def);
  let similar = ctx.state.similar;
  if (def.similar !== undefined) {
    const age =
      similar === undefined ? Infinity : ctx.now.getTime() - Date.parse(similar.takenAt);
    if (!(age <= def.similar.refreshDays * DAY_MS)) {
      try {
        const walk = await walkSimilarArtists(client, {
          seeds,
          similarPerArtist: def.similar.perArtist,
          depth: 1,
          filter,
        });
        similar = {
          takenAt: ctx.now.toISOString(),
          artists: walk.found.map(({ artist }) => ({ id: artist.id, name: artist.name })),
        };
      } catch (error) {
        complete = false;
        notes.push(
          `Similar artists could not be refreshed (${message(error)}); kept the previous list.`,
        );
      }
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
  });
  if (plan.failedArtists.length > 0) {
    complete = false;
    notes.push(`Could not read the releases of ${plan.failedArtists.join(", ")}.`);
  }
  if (plan.capped) {
    notes.push(`Only the first ${plan.checkedArtists} of ${plan.totalArtists} artists were checked.`);
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
  if (shape?.maxTracks !== undefined) {
    tracks = tracks.slice(0, shape.maxTracks);
  }
  if (shape?.maxMinutes !== undefined && tracks.length > 0) {
    tracks = fitToLength([tracks], shape.maxMinutes * 60, (t) => t.durationSeconds).kept[0] ?? [];
  }

  return { tracks, complete, notes, ...(similar !== undefined && { similar }) };
}

/** The recipe's own artists: as listed, or read live (favourites, a playlist's). */
async function seedArtists(client: FeedClient, def: NewReleasesRecipeDef): Promise<Artist[]> {
  const artists: readonly ArtistRef[] =
    def.artists.type === "list"
      ? def.artists.artists
      : def.artists.type === "favourites"
        ? await client.getFavoriteArtists()
        : seedsFromPlaylist(await client.getPlaylistTracks(def.artists.playlistId), Infinity).seeds;
  const seen = new Set<number>();
  return artists
    .filter((artist) => !seen.has(artist.id) && seen.add(artist.id))
    .map(({ id, name }) => ({ id, name }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
