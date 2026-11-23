/**
 * Finding a song on another service (ADR-0012).
 *
 * A match is *exact* (the same recording, by ISRC, with nothing contradicting
 * it; or one the user confirmed before), *likely* (shown to the user, never
 * written unseen) or *missing*. The search ranking is not trusted: a candidate
 * counts only by its ISRC, or by its artist and title.
 */

import { ServiceError } from "../services/errors.js";
import { serviceOf, type ServiceName, type TrackId } from "../services/ids.js";
import { normaliseIsrc } from "../services/isrc.js";
import type { QualityTier, Track } from "../services/model.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { normalise } from "./deduplicate.js";
import { baseTitle, titleKeys, tokens, tokensOverlap, withoutFeaturing } from "./song-text.js";

/** The service songs are matched on. */
export interface MatchClient {
  readonly name: ServiceName;
  findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>>;
  searchTracks(query: string, limit?: number): Promise<Track[]>;
  getTrack(trackId: TrackId): Promise<Track>;
}

/**
 * Matches the user confirmed, swapped or ruled out: ids only, and only in the
 * direction they were made (two masters on one service can match one song).
 */
export interface MatchMemory {
  /** The song on `to`; null when the user wants none; undefined when not asked yet. */
  recall(source: TrackId, to: ServiceName): TrackId | null | undefined;
  remember(source: TrackId, to: ServiceName, match: TrackId | null): void;
  forget(source: TrackId, to: ServiceName): void;
  /** Drop every match from or to a service. */
  forgetService(service: ServiceName): void;
}

export type MatchGrade = "exact" | "likely" | "missing";
/** `same`: it is on the service already. */
export type MatchVia = "same" | "remembered" | "isrc" | "search";

export interface SongMatch {
  source: Track;
  grade: MatchGrade;
  via?: MatchVia;
  /** The song on the other service; absent when missing. */
  track?: Track;
  /** What the user may choose instead, best first, `track` included. */
  options: Track[];
  /** Why it is not exact. */
  reason?: string;
  /** The service could not be asked about this song. */
  failed?: string;
}

const SEARCH_LIMIT = 10;
/** Recordings whose lengths differ by more than this (seconds) may differ. */
export const LENGTH_SLACK = 5;
const MAX_OPTIONS = 8;

/** Find each song on `client`'s service, in the order given. */
export async function matchTracks(
  client: MatchClient,
  tracks: readonly Track[],
  memory: MatchMemory,
): Promise<SongMatch[]> {
  const toFind = tracks.filter((track) => track.other === undefined && serviceOf(track.id) !== client.name);
  const isrcs = toFind
    .filter((track) => memory.recall(track.id, client.name) !== null)
    .flatMap((track) => (track.isrc === undefined ? [] : [normaliseIsrc(track.isrc)]));
  const byIsrc = isrcs.length === 0 ? new Map<string, Track[]>() : await client.findByIsrc([...new Set(isrcs)]);
  // A song that appears more than once is asked about once.
  const known = new Map<TrackId, Promise<SongMatch>>();
  return mapWithConcurrency(tracks, DEFAULT_CONCURRENCY, async (source) => {
    let match = known.get(source.id);
    if (match === undefined) {
      match = matchOne(client, source, byIsrc, memory);
      known.set(source.id, match);
    }
    return { ...(await match), source };
  });
}

async function matchOne(
  client: MatchClient,
  source: Track,
  byIsrc: ReadonlyMap<string, Track[]>,
  memory: MatchMemory,
): Promise<SongMatch> {
  if (serviceOf(source.id) === client.name) {
    return { source, grade: "exact", via: "same", track: source, options: [] };
  }
  if (source.other !== undefined) {
    return missing(source, "It is not a song.");
  }
  try {
    const remembered = memory.recall(source.id, client.name);
    if (remembered === null) {
      return missing(source, "You chose to leave it out.");
    }
    if (remembered !== undefined) {
      const track = await stillPlays(client, remembered);
      if (track !== undefined) {
        return { source, grade: "exact", via: "remembered", track, options: [track] };
      }
    }
    const sameRecording = source.isrc === undefined ? [] : (byIsrc.get(normaliseIsrc(source.isrc)) ?? []);
    const playable = sameRecording.filter((track) => track.streamable !== false);
    if (playable.length > 0) {
      return byRecording(source, playable);
    }
    const byName = await matchByName(client, source);
    return byName.grade === "missing" && sameRecording.length > 0
      ? missing(source, "It is there, but cannot be played.")
      : byName;
  } catch (error) {
    if (stopsEverySong(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ...missing(source, "It could not be looked up."), failed: message };
  }
}

/** Errors that every song would run into. */
const STOPS_EVERY_SONG = new Set(["authentication", "quota", "rate-limited", "not-connected", "forbidden"]);

/**
 * True for an error that every other song would run into as well -- signed
 * out, out of quota, rate-limited, not connected, refused. A tool that looks
 * songs up one by one records any other failure against that one song and
 * carries on, but rethrows these: carrying on would only turn every remaining
 * song into the same failure, one wasted request each, and hide the one thing
 * the user has to do (sign in again, or wait).
 */
export function stopsEverySong(error: unknown): boolean {
  return error instanceof ServiceError && STOPS_EVERY_SONG.has(error.kind);
}

function missing(source: Track, reason: string): SongMatch {
  return { source, grade: "missing", options: [], reason };
}

/** A remembered match, unless it is gone or no longer plays. */
async function stillPlays(client: MatchClient, id: TrackId): Promise<Track | undefined> {
  try {
    const track = await client.getTrack(id);
    return track.streamable === false ? undefined : track;
  } catch (error) {
    if (error instanceof ServiceError && (error.kind === "not-found" || /HTTP 404/.test(error.message))) {
      return undefined;
    }
    throw error;
  }
}

/** A match by ISRC: exact, unless the title, artist or length says otherwise. */
function byRecording(source: Track, candidates: readonly Track[]): SongMatch {
  const ranked = rank(source, candidates);
  const agreeing = ranked.filter((track) => contradiction(source, track) === undefined);
  const track = agreeing[0] ?? ranked[0]!;
  const reason = contradiction(source, track);
  return {
    source,
    grade: reason === undefined ? "exact" : "likely",
    via: "isrc",
    track,
    options: ranked.slice(0, MAX_OPTIONS),
    ...(reason !== undefined && { reason }),
  };
}

async function matchByName(client: MatchClient, source: Track): Promise<SongMatch> {
  const title = withoutFeaturing(source.title);
  const query = source.artist === undefined ? title : `${source.artist} ${title}`;
  const candidates = (await client.searchTracks(query, SEARCH_LIMIT)).filter(
    (track) => track.streamable !== false && track.other === undefined && sameArtist(source, track),
  );
  const same = rank(source, candidates.filter((track) => sameTitle(source, track)));
  const versions = rank(
    source,
    candidates.filter((track) => !same.includes(track) && baseTitle(track.title) === baseTitle(source.title)),
  );
  const options = [...same, ...versions].slice(0, MAX_OPTIONS);
  const track = options[0];
  if (track === undefined) {
    return missing(source, "Nothing there has this artist and title.");
  }
  const reason =
    same.length === 0
      ? "It is another version."
      : differentLength(source, track)
        ? "Matched by name; the length differs."
        : "Matched by name.";
  return { source, grade: "likely", via: "search", track, options, reason };
}

/** What speaks against two tracks with one ISRC being the same song. */
function contradiction(source: Track, track: Track): string | undefined {
  if (!sameTitle(source, track)) {
    return "The title differs.";
  }
  if (!sameArtist(source, track)) {
    return "The artist differs.";
  }
  return differentLength(source, track) ? "The length differs." : undefined;
}

function titlesOf(track: Track): string[] {
  return [track.title, ...(track.version === undefined ? [] : [`${track.title} ${track.version}`])].flatMap(titleKeys);
}

function sameTitle(a: Track, b: Track): boolean {
  const titles = new Set(titlesOf(a));
  return titlesOf(b).some((title) => titles.has(title));
}

function artistsOf(track: Track): string[][] {
  return [track.artist, ...(track.jointArtists ?? []), ...(track.guestArtists ?? [])]
    .filter((name): name is string => name !== undefined && name.length > 0)
    .map(tokens);
}

/** Whether they share an artist; an unknown one contradicts nothing. */
function sameArtist(a: Track, b: Track): boolean {
  const [mine, theirs] = [artistsOf(a), artistsOf(b)];
  return mine.length === 0 || theirs.length === 0 || mine.some((x) => theirs.some((y) => tokensOverlap(x, y)));
}

function differentLength(a: Track, b: Track): boolean {
  return a.duration !== undefined && b.duration !== undefined && Math.abs(a.duration - b.duration) > LENGTH_SLACK;
}

const TIERS: Record<QualityTier, number> = { lossy: 0, lossless: 1, hires: 2 };

/** Best first: the same album, then quality, then the earliest release. */
function rank(source: Track, candidates: readonly Track[]): Track[] {
  const album = source.album === undefined ? undefined : normalise(source.album);
  const onAlbum = (track: Track): number =>
    album !== undefined && track.album !== undefined && normalise(track.album) === album ? 1 : 0;
  const tier = (track: Track): number => (track.quality === undefined ? -1 : TIERS[track.quality]);
  return [...candidates].sort(
    (a, b) =>
      onAlbum(b) - onAlbum(a) ||
      (b.bitDepth ?? 0) - (a.bitDepth ?? 0) ||
      (b.samplingRate ?? 0) - (a.samplingRate ?? 0) ||
      tier(b) - tier(a) ||
      (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"),
  );
}

/** What may be written without asking: exact matches, in order. */
export function writable(matches: readonly SongMatch[]): TrackId[] {
  return matches.flatMap((match) => (match.grade === "exact" && match.track !== undefined ? [match.track.id] : []));
}

/** How a list of matches came out, for a report. */
export function countGrades(matches: readonly SongMatch[]): Record<MatchGrade, number> {
  const counts: Record<MatchGrade, number> = { exact: 0, likely: 0, missing: 0 };
  for (const match of matches) {
    counts[match.grade] += 1;
  }
  return counts;
}

/** Remembered matches in memory (and the base of the file-backed ones). */
export class MemoryMatches implements MatchMemory {
  readonly #matches = new Map<string, TrackId | null>();

  recall(source: TrackId, to: ServiceName): TrackId | null | undefined {
    return this.#matches.get(`${to} ${source}`);
  }

  remember(source: TrackId, to: ServiceName, match: TrackId | null): void {
    this.#matches.set(`${to} ${source}`, match);
  }

  forget(source: TrackId, to: ServiceName): void {
    this.#matches.delete(`${to} ${source}`);
  }

  forgetService(service: ServiceName): void {
    for (const key of [...this.#matches.keys()]) {
      const [to, source] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
      if (to === service || source.startsWith(`${service}:`)) {
        this.#matches.delete(key);
      }
    }
  }
}
