/**
 * The "discovery radio" source: each rotation (a day or a week), some artists
 * similar to the seeds and their top tracks -- skipping favourite songs and
 * whatever the last few rotations served.
 *
 * Deterministic: the picks are drawn with a PRNG seeded from the job id and
 * the rotation number, and stored, so every pass within a rotation resolves the
 * same list without reading Qobuz (and a retry, or another machine, agrees).
 */

import { shortId } from "../../services/ids.js";
import type { Artist, Track } from "../../services/model.js";
import { seededRandom, shuffle } from "../../features/combine.js";
import { fetchArtistTracks, type SimilarArtistsClient } from "../../features/similar-artists.js";
import { SongPicker, songKeys } from "../../features/song-picker.js";
import { artistExclusion, compileTrackFilter, NO_FILTER } from "../../features/track-filter.js";
import type { DiscoverySource, SourceState } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";
import { hashText, seedArtists, similarSnapshot, type SeedArtistsClient, type SourceResult } from "./common.js";

export type DiscoveryClient = SeedArtistsClient &
  SimilarArtistsClient & { getFavoriteTracks(): Promise<Track[]> };

const DAY_MS = 86_400_000;
/** Earlier rotations remembered (more than any avoidRepeatsFor). */
const SERVED_KEPT = 60;

function dayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function mondayIndex(date: Date): number {
  return dayIndex(date) - ((date.getDay() + 6) % 7);
}

/** Whole local days, or ISO weeks (from Monday), since the job was created. */
export function rotationNumber(rotation: "day" | "week", createdAt: string, now: Date): number {
  const created = new Date(createdAt);
  const n =
    rotation === "day"
      ? dayIndex(now) - dayIndex(created)
      : Math.floor((mondayIndex(now) - mondayIndex(created)) / 7);
  return Math.max(0, n);
}

export async function resolveDiscovery(
  client: DiscoveryClient,
  def: DiscoverySource,
  ctx: { now: Date; jobId: string; createdAt: string; state: SourceState },
): Promise<SourceResult> {
  const number = rotationNumber(def.rotation, ctx.createdAt, ctx.now);
  const current = ctx.state.rotation;
  if (current !== undefined && current.number === number) {
    return { tracks: current.tracks, complete: true, notes: [], state: ctx.state };
  }

  const notes: string[] = [];
  let complete = true;
  const filter = def.exclude === undefined ? NO_FILTER : compileTrackFilter(def.exclude);
  const seeds = await seedArtists(client, def.seeds);
  const snap = await similarSnapshot(client, seeds, def.similar, ctx.state.similar, ctx.now, filter);
  if (snap.failure !== undefined) {
    complete = false;
    notes.push(snap.failure);
  }

  const seedIds = new Set(seeds.map((artist) => artist.id));
  const candidates: Artist[] = (snap.similar?.artists ?? [])
    .filter((artist) => !seedIds.has(artist.id) && artistExclusion(artist.name, filter) === undefined)
    .map(({ id, name }) => ({ id, name }));
  const random = seededRandom(hashText(`${ctx.jobId}:${number}`));
  const recent = new Set(current?.artistIds ?? []);
  const shuffled = shuffle(candidates, random);
  // Prefer artists the last rotation did not play, when there are enough.
  const fresh = shuffled.filter((artist) => !recent.has(artist.id));
  const picks = [...fresh, ...shuffled.filter((artist) => recent.has(artist.id))].slice(0, def.artistsPerRotation);
  if (candidates.length === 0) {
    notes.push("No similar artists to pick from yet.");
  }

  const served = (ctx.state.served ?? []).filter((entry) => entry.rotation >= number - def.avoidRepeatsFor);
  const favourites = def.skipFavouriteTracks ? (await client.getFavoriteTracks()).flatMap(songKeys) : undefined;
  const picker = new SongPicker({
    oneCopy: true,
    ...(favourites !== undefined && { favourites }),
    seen: served.flatMap((entry) => entry.trackIds.map((id) => [`id:${id}`, "served earlier"] as const)),
  });
  const { fetched, failedArtists } = await fetchArtistTracks(client, picks, def.tracksPerArtist, filter, picker);
  if (failedArtists.length > 0) {
    // The rotation is kept until the next one: fail the run (to be retried)
    // rather than keep one short of these artists.
    throw new Error(
      `Could not read the top tracks of ${failedArtists.map((artist) => artist.name).join(", ")}.`,
    );
  }

  const tracks: DesiredTrack[] = fetched.flatMap((entry) =>
    entry.tracks.map((track) => ({
      trackId: track.id,
      source: `artist:${shortId(entry.artist.id)}`,
      ...(track.duration !== undefined && { durationSeconds: track.duration }),
    })),
  );
  const state: SourceState = {
    ...ctx.state,
    rotation: { number, artistIds: picks.map((artist) => artist.id), tracks },
    served: [...served, { rotation: number, trackIds: tracks.map((track) => track.trackId) }].slice(-SERVED_KEPT),
  };
  if (snap.similar !== undefined) {
    state.similar = snap.similar;
  }
  return { tracks, complete, notes, state };
}
