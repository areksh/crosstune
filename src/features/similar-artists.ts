/**
 * Discover music through Qobuz's "similar artists".
 *
 * Starting from seed artists -- typed names ({@link planFromArtists}) or the
 * artists of an existing playlist ({@link planFromPlaylist}) -- this walks the
 * similar-artists graph breadth-first to a chosen depth, then gathers each
 * similar artist's top tracks. Depth 1 takes artists similar to the seeds;
 * depth 2 also takes artists similar to those, and so on. Every artist appears
 * at most once, attributed to the first artist it was found from, and a
 * user-set cap on the number of artists keeps the walk bounded.
 *
 * Like the other tools this is the *resolve* half: it returns a plan to review.
 * Committing reuses {@link createPlaylistWithTracks} and
 * {@link addTracksToExistingPlaylist} with {@link similarTrackIds}.
 */

import type { Artist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import {
  fetchTopTracks,
  resolveArtistTracks,
  type ArtistResolverClient,
  type ExcludedTrack,
  type ResolvedArtistTracks,
  type UnderfilledArtist,
} from "./playlist-from-artists.js";
import { NO_FILTER, type TrackFilter } from "./track-filter.js";

/** The client surface needed to walk similar artists and fetch their tracks. */
export interface SimilarArtistsClient {
  getSimilarArtists(artistId: number, limit: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
}

/** An accepted range (no `max` means unbounded) and the default of a setting. */
export interface SettingBounds {
  readonly min: number;
  readonly max?: number;
  readonly fallback: number;
}

/**
 * Accepted range and default of each setting, shared by the CLI and the API so
 * both validate the same way. The per-artist count, the depth and the artist
 * cap are deliberately unbounded: the user chooses, and
 * {@link estimateSimilar} warns when the choice is very large.
 */
export const SIMILAR_SETTINGS = {
  similarPerArtist: { min: 1, fallback: 3 },
  depth: { min: 1, fallback: 1 },
  /** The most similar artists the walk collects in total, across seeds and levels. */
  maxArtists: { min: 1, fallback: 100 },
  /** The artist page lists at most 30 top tracks. */
  tracksPerSimilar: { min: 1, max: 30, fallback: 3 },
  /** 0 takes no tracks from the seeds themselves. */
  tracksPerSeed: { min: 0, max: 100, fallback: 5 },
  maxSeeds: { min: 1, max: 50, fallback: 10 },
} as const satisfies Record<string, SettingBounds>;

/**
 * Candidates requested per similar-artists lookup. Qobuz returns an artist's
 * whole list in one page whatever is asked (about 70 for a well-known artist),
 * so asking for more than it has costs nothing and leaves spares to replace
 * artists already used.
 */
export const SIMILAR_CANDIDATE_LIMIT = 500;

/**
 * When a run counts as large enough to need a confirmation: about this many
 * tracks, or this many Qobuz requests (around a minute and a half of work).
 */
export const LARGE_RUN = { tracks: 1000, requests: 1500 } as const;

/** Rough wall-clock cost of one Qobuz request through the bounded pool (measured). */
const SECONDS_PER_REQUEST = 0.06;

/** The most a run could produce, worked out from its settings before running it. */
export interface SimilarEstimate {
  /** Most similar artists the walk could collect. */
  artists: number;
  /** Most tracks the plan could hold (seeds' own plus the similar artists'). */
  tracks: number;
  /** Rough upper bound on Qobuz requests. */
  requests: number;
  /** Rough duration in seconds. */
  seconds: number;
  /** True past {@link LARGE_RUN}: worth a warning and a confirmation. */
  large: boolean;
}

/**
 * Estimate the largest outcome of a run: `seedCount` seeds (for a playlist, its
 * seed cap) each fanning out `similarPerArtist` per level for `depth` levels,
 * limited by `maxArtists`. It is an upper bound -- Qobuz lists a finite number
 * of similar artists per artist (about 70 for a well-known one), and artists
 * shared between branches are only used once.
 */
export function estimateSimilar(options: {
  seedCount: number;
  tracksPerSeed: number;
  similarPerArtist: number;
  depth: number;
  tracksPerSimilar: number;
  maxArtists: number;
}): SimilarEstimate {
  const { seedCount, similarPerArtist: n, depth } = options;
  // Geometric series n + n^2 + ... + n^depth per seed, in closed form so an
  // absurd depth cannot loop; overflow to Infinity is clamped by the cap.
  const perSeed = n === 1 ? depth : (n * (Math.pow(n, depth) - 1)) / (n - 1);
  const artists = Math.min(options.maxArtists, seedCount * perSeed);
  // Seed searches and seed tracks; one lookup and one top-track fetch per artist.
  const requests = seedCount * 2 + artists * 2;
  const tracks = seedCount * options.tracksPerSeed + artists * options.tracksPerSimilar;
  return {
    artists,
    tracks,
    requests,
    seconds: requests * SECONDS_PER_REQUEST,
    large: tracks > LARGE_RUN.tracks || requests > LARGE_RUN.requests,
  };
}

/** A one-line, human-readable summary of an estimate. */
export function describeEstimate(estimate: SimilarEstimate): string {
  const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const duration =
    estimate.seconds < 60
      ? "under a minute"
      : `about ${plural(Math.round(estimate.seconds / 60), "minute")}`;
  return (
    `up to ${plural(estimate.artists, "similar artist")} and ${plural(estimate.tracks, "track")}, ` +
    `about ${estimate.requests} Qobuz requests (${duration})`
  );
}

/** An artist found through the walk, with its top tracks. */
export interface SimilarArtist {
  artist: Artist;
  /** The seed this artist was ultimately reached from. */
  seed: Artist;
  /** The artist it was listed as similar to (the seed itself at level 1). */
  via: Artist;
  /** 1 = similar to a seed, 2 = similar to a level-1 artist, and so on. */
  level: number;
  /** The kept top tracks, most popular first. */
  tracks: Track[];
  /** Tracks the filter excluded, ranked above the last kept one. */
  excluded: ExcludedTrack[];
}

export interface ResolveSimilarOptions {
  seeds: readonly Artist[];
  /** Similar artists to take per artist expanded (1-20 in the UI). */
  similarPerArtist: number;
  /** How many levels to walk (1 = artists similar to the seeds). */
  depth: number;
  /** Top tracks to take per similar artist. */
  tracksPerSimilar: number;
  /** Artists never to suggest (e.g. those already in a playlist). Seeds always are. */
  skipArtistIds?: ReadonlySet<number>;
  filter?: TrackFilter;
  /** Cap on similar artists in total (default `SIMILAR_SETTINGS.maxArtists`). */
  maxArtists?: number;
}

export interface ResolveSimilarResult {
  /** Similar artists with at least one track (kept or excluded): by seed, then level. */
  similar: SimilarArtist[];
  /** Similar artists Qobuz returned no tracks for (left out of `similar`). */
  emptyArtists: UnderfilledArtist[];
  /** Similar artists with fewer tracks than requested. */
  partialArtists: UnderfilledArtist[];
  /** True when the walk stopped at the artist cap with more still to take. */
  truncated: boolean;
}

/** An artist found by the walk, before its tracks are fetched. */
export type FoundArtist = Omit<SimilarArtist, "tracks" | "excluded">;

/** An artist with the top tracks fetched for it. */
export interface ArtistTracks {
  artist: Artist;
  tracks: Track[];
  excluded: ExcludedTrack[];
}

/**
 * Walk the similar-artists graph from the seeds, then fetch every found
 * artist's top tracks: {@link walkSimilarArtists} then {@link fetchArtistTracks}.
 */
export async function resolveSimilarArtists(
  client: SimilarArtistsClient,
  options: ResolveSimilarOptions,
): Promise<ResolveSimilarResult> {
  const { found, truncated } = await walkSimilarArtists(client, options);
  const fetched = await fetchArtistTracks(
    client,
    found.map((node) => node.artist),
    options.tracksPerSimilar,
    options.filter,
  );
  return { ...attachTracks(found, fetched), truncated };
}

/**
 * Walk the similar-artists graph breadth-first from the seeds, without
 * fetching any tracks.
 *
 * Each level looks up the previous level's artists (through a bounded pool, so
 * results stay in input order) and takes, for each, the first
 * `similarPerArtist` candidates not already seen. Seeds and `skipArtistIds`
 * are never suggested. The result is grouped by seed (in seed order), level by
 * level within a seed.
 */
export async function walkSimilarArtists(
  client: Pick<SimilarArtistsClient, "getSimilarArtists">,
  options: Omit<ResolveSimilarOptions, "tracksPerSimilar" | "filter">,
): Promise<{ found: FoundArtist[]; truncated: boolean }> {
  const maxArtists = options.maxArtists ?? SIMILAR_SETTINGS.maxArtists.fallback;

  const seen = new Set<number>([
    ...options.seeds.map((seed) => seed.id),
    ...(options.skipArtistIds ?? []),
  ]);
  const found: FoundArtist[] = [];
  let truncated = false;
  let frontier = options.seeds.map((seed) => ({ artist: seed, seed }));

  for (let level = 1; level <= options.depth && frontier.length > 0 && !truncated; level += 1) {
    const candidateLists = await mapWithConcurrency(frontier, DEFAULT_CONCURRENCY, (node) =>
      client.getSimilarArtists(node.artist.id, SIMILAR_CANDIDATE_LIMIT),
    );
    const next: typeof frontier = [];
    frontier.forEach((node, index) => {
      let taken = 0;
      for (const candidate of candidateLists[index] ?? []) {
        if (truncated || taken >= options.similarPerArtist) {
          break;
        }
        if (seen.has(candidate.id)) {
          continue;
        }
        if (found.length >= maxArtists) {
          truncated = true;
          break;
        }
        seen.add(candidate.id);
        found.push({ artist: candidate, seed: node.seed, via: node.artist, level });
        next.push({ artist: candidate, seed: node.seed });
        taken += 1;
      }
    });
    frontier = next;
  }

  // Group by seed (in seed order); within a seed, discovery order is already
  // level by level.
  const seedOrder = new Map(options.seeds.map((seed, index) => [seed.id, index]));
  const ordered = [...found].sort(
    (a, b) => (seedOrder.get(a.seed.id) ?? 0) - (seedOrder.get(b.seed.id) ?? 0),
  );
  return { found: ordered, truncated };
}

/**
 * Fetch each artist's top tracks (in input order, through a bounded pool),
 * leaving out artists Qobuz returned no tracks for and flagging short ones.
 */
export async function fetchArtistTracks(
  client: Pick<SimilarArtistsClient, "getArtistTopTracks">,
  artists: readonly Artist[],
  tracksPerArtist: number,
  filter: TrackFilter = NO_FILTER,
): Promise<{
  fetched: ArtistTracks[];
  emptyArtists: UnderfilledArtist[];
  partialArtists: UnderfilledArtist[];
}> {
  const outcomes = await mapWithConcurrency(artists, DEFAULT_CONCURRENCY, async (artist) => ({
    artist,
    ...(await fetchTopTracks(client, artist.id, tracksPerArtist, filter)),
  }));
  const fetched: ArtistTracks[] = [];
  const emptyArtists: UnderfilledArtist[] = [];
  const partialArtists: UnderfilledArtist[] = [];
  for (const entry of outcomes) {
    const flag: UnderfilledArtist = {
      query: entry.artist.name,
      artist: entry.artist,
      trackCount: entry.tracks.length,
      requested: tracksPerArtist,
    };
    if (entry.tracks.length === 0 && entry.excluded.length === 0) {
      emptyArtists.push(flag);
      continue;
    }
    fetched.push(entry);
    if (entry.tracks.length < tracksPerArtist) {
      partialArtists.push(flag);
    }
  }
  return { fetched, emptyArtists, partialArtists };
}

/** Join walked artists with their fetched tracks, dropping those with none. */
function attachTracks(
  found: readonly FoundArtist[],
  result: Awaited<ReturnType<typeof fetchArtistTracks>>,
): Omit<ResolveSimilarResult, "truncated"> {
  const byId = new Map(result.fetched.map((entry) => [entry.artist.id, entry]));
  const similar: SimilarArtist[] = [];
  for (const node of found) {
    const entry = byId.get(node.artist.id);
    if (entry !== undefined) {
      similar.push({ ...node, tracks: entry.tracks, excluded: entry.excluded });
    }
  }
  return {
    similar,
    emptyArtists: result.emptyArtists,
    partialArtists: result.partialArtists,
  };
}

/**
 * Pick a playlist's artists to seed from: its performers ranked by how many
 * tracks they have (ties by first appearance), up to `maxSeeds`. `presentIds`
 * holds *every* performer, so none is suggested back. Tracks without a
 * performer id are ignored.
 */
export function seedsFromPlaylist(
  tracks: readonly Track[],
  maxSeeds: number,
): { seeds: Artist[]; presentIds: Set<number> } {
  const counts = new Map<number, { artist: Artist; count: number }>();
  for (const track of tracks) {
    if (track.artistId === undefined) {
      continue;
    }
    const entry = counts.get(track.artistId);
    if (entry === undefined) {
      counts.set(track.artistId, {
        artist: { id: track.artistId, name: track.artist ?? `Unknown artist (${track.artistId})` },
        count: 1,
      });
    } else {
      entry.count += 1;
    }
  }
  // Map iteration is insertion order and the sort is stable, so ties keep the
  // order of first appearance.
  const seeds = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSeeds)
    .map((entry) => entry.artist);
  return { seeds, presentIds: new Set(counts.keys()) };
}

/**
 * Flatten a plan to an ordered, de-duplicated list of track ids: each seed's
 * own tracks, then its similar artists' tracks, seed by seed.
 */
export function similarTrackIds(
  seeds: readonly { artist: Artist; tracks: readonly Track[] }[],
  similar: readonly { seed: Artist; tracks: readonly Track[] }[],
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const add = (tracks: readonly Track[]): void => {
    for (const track of tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        ids.push(track.id);
      }
    }
  };
  for (const seed of seeds) {
    add(seed.tracks);
    for (const entry of similar) {
      if (entry.seed.id === seed.artist.id) {
        add(entry.tracks);
      }
    }
  }
  return ids;
}

/** The walk settings shared by both sources. */
export interface WalkOptions {
  similarPerArtist: number;
  depth: number;
  tracksPerSimilar: number;
  /** Cap on similar artists in total (default `SIMILAR_SETTINGS.maxArtists`). */
  maxArtists?: number;
  filter?: TrackFilter;
}

/** The walk of a plan: seeds and the artists found, before their tracks are fetched. */
export interface SimilarWalk {
  /** Seeds in input order; `tracks` is empty when none were wanted or available. */
  seeds: ResolvedArtistTracks[];
  found: FoundArtist[];
  /** Seed names that matched no artist. */
  unresolvedArtists: string[];
  /** Seeds Qobuz returned no tracks for. */
  emptyArtists: UnderfilledArtist[];
  /** Seeds with fewer tracks than requested. */
  partialArtists: UnderfilledArtist[];
  truncated: boolean;
}

/** A reviewable plan: the seeds (with any tracks of their own) and what was found. */
export interface SimilarPlan extends Omit<SimilarWalk, "found"> {
  similar: SimilarArtist[];
}

/**
 * Walk from typed artist names: resolve them (with `tracksPerSeed` of their own
 * top tracks; 0 for none), then walk their similar artists. A seed with no
 * tracks of its own is flagged but still walked.
 */
export async function walkFromArtists(
  client: SimilarArtistsClient & ArtistResolverClient,
  options: Omit<WalkOptions, "tracksPerSimilar"> & { artists: string[]; tracksPerSeed: number },
): Promise<SimilarWalk> {
  const resolved = await resolveArtistTracks(client, {
    artists: options.artists,
    tracksPerArtist: options.tracksPerSeed,
    ...(options.filter !== undefined && { filter: options.filter }),
  });
  // Seeds in input order, including those that matched but had no tracks.
  const byQuery = new Map<string, ResolvedArtistTracks>();
  for (const entry of resolved.resolvedArtists) {
    byQuery.set(entry.query, entry);
  }
  for (const empty of resolved.emptyArtists) {
    byQuery.set(empty.query, { query: empty.query, artist: empty.artist, tracks: [], excluded: [] });
  }
  const seeds = options.artists
    .map((query) => byQuery.get(query))
    .filter((seed): seed is ResolvedArtistTracks => seed !== undefined);

  const walk = await walkSimilarArtists(client, {
    ...options,
    seeds: seeds.map((seed) => seed.artist),
  });
  return {
    seeds,
    found: walk.found,
    unresolvedArtists: resolved.unresolvedArtists,
    emptyArtists: resolved.emptyArtists,
    partialArtists: resolved.partialArtists,
    truncated: walk.truncated,
  };
}

/**
 * Walk from an existing playlist: seed from its `maxSeeds` most frequent
 * artists and never suggest an artist already in it. The seeds contribute no
 * tracks (they are already in the playlist).
 */
export async function walkFromPlaylist(
  client: Pick<SimilarArtistsClient, "getSimilarArtists"> & {
    getPlaylistTracks(playlistId: number): Promise<Track[]>;
  },
  options: Omit<WalkOptions, "tracksPerSimilar"> & { playlistId: number; maxSeeds: number },
): Promise<SimilarWalk> {
  const tracks = await client.getPlaylistTracks(options.playlistId);
  const { seeds, presentIds } = seedsFromPlaylist(tracks, options.maxSeeds);
  const walk = await walkSimilarArtists(client, {
    ...options,
    seeds,
    skipArtistIds: presentIds,
  });
  return {
    seeds: seeds.map((artist) => ({ query: artist.name, artist, tracks: [], excluded: [] })),
    found: walk.found,
    unresolvedArtists: [],
    emptyArtists: [],
    partialArtists: [],
    truncated: walk.truncated,
  };
}

/** {@link walkFromArtists}, then the found artists' tracks: a complete plan. */
export async function planFromArtists(
  client: SimilarArtistsClient & ArtistResolverClient,
  options: WalkOptions & { artists: string[]; tracksPerSeed: number },
): Promise<SimilarPlan> {
  return completePlan(client, await walkFromArtists(client, options), options);
}

/** {@link walkFromPlaylist}, then the found artists' tracks: a complete plan. */
export async function planFromPlaylist(
  client: SimilarArtistsClient & { getPlaylistTracks(playlistId: number): Promise<Track[]> },
  options: WalkOptions & { playlistId: number; maxSeeds: number },
): Promise<SimilarPlan> {
  return completePlan(client, await walkFromPlaylist(client, options), options);
}

async function completePlan(
  client: SimilarArtistsClient,
  walk: SimilarWalk,
  options: WalkOptions,
): Promise<SimilarPlan> {
  const result = attachTracks(
    walk.found,
    await fetchArtistTracks(
      client,
      walk.found.map((node) => node.artist),
      options.tracksPerSimilar,
      options.filter,
    ),
  );
  const { found: _found, ...rest } = walk;
  return {
    ...rest,
    similar: result.similar,
    emptyArtists: [...walk.emptyArtists, ...result.emptyArtists],
    partialArtists: [...walk.partialArtists, ...result.partialArtists],
  };
}
