/**
 * The "smart playlist" source: the tracks of some playlists and/or the
 * favourites that meet every rule, e.g. "hi-res favourites added in the last
 * 30 days" -- re-evaluated each pass, so tracks come and go as they start or
 * stop matching.
 */

import type { Track } from "../../qobuz/index.js";
import { decadeOf, qualityOf } from "../../features/stats.js";
import { normaliseArtistName } from "../../features/track-filter.js";
import type { ArtistRef, SmartRule, SmartSource } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";
import { describeInput, inputLabel, readInputs, type PlaylistInputsClient } from "./combined.js";
import { stableShuffle, type SourceResult } from "./common.js";

const DAY_MS = 86_400_000;

interface Candidate {
  track: Track;
  source: string;
  index: number;
}

function artistMatches(track: Track, artists: readonly ArtistRef[]): boolean {
  return artists.some((artist) =>
    track.artistId !== undefined
      ? track.artistId === artist.id
      : track.artist !== undefined && normaliseArtistName(track.artist) === normaliseArtistName(artist.name),
  );
}

/** Whether a track meets a rule (unknown values never match). */
export function meetsRule(track: Track, rule: SmartRule, now: Date): boolean {
  switch (rule.type) {
    case "quality":
      return qualityOf(track) === rule.quality;
    case "decades":
      return rule.decades.includes(decadeOf(track.releaseDate));
    case "genres": {
      const genre = track.genre?.toLowerCase();
      return genre !== undefined && rule.genres.some((wanted) => wanted.toLowerCase() === genre);
    }
    case "favourited-within":
      return (
        track.favouritedAt !== undefined &&
        Date.parse(track.favouritedAt) >= now.getTime() - rule.days * DAY_MS
      );
    case "artists":
      return (
        (rule.include === undefined || artistMatches(track, rule.include)) &&
        (rule.exclude === undefined || !artistMatches(track, rule.exclude))
      );
    case "duration":
      return (
        track.duration !== undefined &&
        (rule.minSeconds === undefined || track.duration >= rule.minSeconds) &&
        (rule.maxSeconds === undefined || track.duration <= rule.maxSeconds)
      );
  }
}

/** Newest first, unknown last, ties in listed order. */
function byNewest(key: (track: Track) => string | undefined) {
  return (a: Candidate, b: Candidate): number => {
    const ka = key(a.track);
    const kb = key(b.track);
    if (ka === kb) {
      return a.index - b.index;
    }
    if (ka === undefined) {
      return 1;
    }
    if (kb === undefined) {
      return -1;
    }
    return ka < kb ? 1 : -1;
  };
}

function order(candidates: Candidate[], def: SmartSource, jobId: string): Candidate[] {
  switch (def.order) {
    case "as-listed":
      return candidates;
    case "newest-favourited":
      return [...candidates].sort(byNewest((track) => track.favouritedAt));
    case "newest-release":
      return [...candidates].sort(byNewest((track) => track.releaseDate));
    case "by-artist": {
      const name = (track: Track) => normaliseArtistName(track.artist ?? "￿");
      return [...candidates].sort(
        (a, b) =>
          name(a.track).localeCompare(name(b.track)) ||
          (a.track.album ?? "").localeCompare(b.track.album ?? "") ||
          a.index - b.index,
      );
    }
    case "shuffle":
      return stableShuffle(jobId, candidates, (candidate) => candidate.track.id);
  }
}

export async function resolveSmart(
  client: PlaylistInputsClient,
  def: SmartSource,
  ctx: {
    now: Date;
    jobId: string;
    /** Original dates of favourites a tidy-up replaced (see TidyState favouriteDates). */
    favouriteDates?: ReadonlyMap<number, string>;
  },
): Promise<SourceResult> {
  const read = await readInputs(client, def.from);
  const notes = read
    .filter((entry) => entry.error !== undefined)
    .map((entry) => `Could not read ${describeInput(entry.input)} (${entry.error ?? "unknown error"}).`);
  // A track may be in a playlist and in the favourites: only the favourites
  // say when it was added, so carry that over to whichever copy comes first.
  const favouritedAt = new Map<number, string>();
  for (const entry of read) {
    if (entry.input.type === "favourites") {
      for (const track of entry.tracks ?? []) {
        const at = ctx.favouriteDates?.get(track.id) ?? track.favouritedAt;
        if (at !== undefined) {
          favouritedAt.set(track.id, at);
        }
      }
    }
  }
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const entry of read) {
    for (const raw of entry.tracks ?? []) {
      if (seen.has(raw.id)) {
        continue;
      }
      seen.add(raw.id);
      const added = favouritedAt.get(raw.id);
      const track = added !== undefined && raw.favouritedAt !== added ? { ...raw, favouritedAt: added } : raw;
      if (def.rules.every((rule) => meetsRule(track, rule, ctx.now))) {
        candidates.push({ track, source: inputLabel(entry.input), index: candidates.length });
      }
    }
  }
  const tracks: DesiredTrack[] = order(candidates, def, ctx.jobId).map(({ track, source }) => ({
    trackId: track.id,
    source,
    ...(track.duration !== undefined && { durationSeconds: track.duration }),
  }));
  return { tracks, complete: notes.length === 0, notes, state: {} };
}
