/**
 * Discover music through Qobuz's "similar artists".
 *
 * Starting from seed artists -- typed names ({@link planFromArtists}) or the
 * artists of an existing playlist ({@link planFromPlaylist}) -- this walks the
 * similar-artists graph breadth-first to a chosen depth, then gathers each
 * similar artist's top tracks. Depth 1 takes artists similar to the seeds;
 * depth 2 also takes artists similar to those, and so on. Every artist appears
 * at most once, attributed to the first artist it was found from, and a hard
 * cap keeps the walk (and the request) bounded.
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

/**
 * The most similar artists the walk will collect in total, across all seeds and
 * levels. Three per artist at depth 3 is already 39 per seed, and each costs a
 * top-track request.
 */
export const MAX_SIMILAR_ARTISTS = 100;

/**
 * Accepted range and default of each setting, shared by the CLI and the API so
 * both validate the same way.
 */
export const SIMILAR_SETTINGS = {
  similarPerArtist: { min: 1, max: 20, fallback: 3 },
  depth: { min: 1, max: 3, fallback: 1 },
  /** The artist page lists at most 30 top tracks. */
  tracksPerSimilar: { min: 1, max: 30, fallback: 3 },
  /** 0 takes no tracks from the seeds themselves. */
  tracksPerSeed: { min: 0, max: 100, fallback: 5 },
  maxSeeds: { min: 1, max: 50, fallback: 10 },
} as const;

/** Spare candidates requested per lookup, to replace ones already used. */
const SPARE_CANDIDATES = 10;

/** The most candidates requested per lookup. */
const MAX_CANDIDATES = 50;

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
  /** Cap on similar artists in total (default {@link MAX_SIMILAR_ARTISTS}). */
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

/** A node of the walk before its tracks are fetched. */
type Found = Omit<SimilarArtist, "tracks" | "excluded">;

/**
 * Walk the similar-artists graph from the seeds, then fetch every found
 * artist's top tracks.
 *
 * Each level looks up the previous level's artists (through a bounded pool, so
 * results stay in input order) and takes, for each, the first
 * `similarPerArtist` candidates not already seen. Seeds and `skipArtistIds`
 * are never suggested.
 */
export async function resolveSimilarArtists(
  client: SimilarArtistsClient,
  options: ResolveSimilarOptions,
): Promise<ResolveSimilarResult> {
  const filter = options.filter ?? NO_FILTER;
  const maxArtists = options.maxArtists ?? MAX_SIMILAR_ARTISTS;
  const candidateLimit = Math.min(options.similarPerArtist + SPARE_CANDIDATES, MAX_CANDIDATES);

  const seen = new Set<number>([
    ...options.seeds.map((seed) => seed.id),
    ...(options.skipArtistIds ?? []),
  ]);
  const found: Found[] = [];
  let truncated = false;
  let frontier = options.seeds.map((seed) => ({ artist: seed, seed }));

  for (let level = 1; level <= options.depth && frontier.length > 0 && !truncated; level += 1) {
    const candidateLists = await mapWithConcurrency(frontier, DEFAULT_CONCURRENCY, (node) =>
      client.getSimilarArtists(node.artist.id, candidateLimit),
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

  const withTracks = await mapWithConcurrency(ordered, DEFAULT_CONCURRENCY, async (node) => ({
    ...node,
    ...(await fetchTopTracks(client, node.artist.id, options.tracksPerSimilar, filter)),
  }));

  const similar: SimilarArtist[] = [];
  const emptyArtists: UnderfilledArtist[] = [];
  const partialArtists: UnderfilledArtist[] = [];
  for (const entry of withTracks) {
    const flag: UnderfilledArtist = {
      query: entry.artist.name,
      artist: entry.artist,
      trackCount: entry.tracks.length,
      requested: options.tracksPerSimilar,
    };
    if (entry.tracks.length === 0 && entry.excluded.length === 0) {
      emptyArtists.push(flag);
      continue;
    }
    similar.push(entry);
    if (entry.tracks.length < options.tracksPerSimilar) {
      partialArtists.push(flag);
    }
  }
  return { similar, emptyArtists, partialArtists, truncated };
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
  filter?: TrackFilter;
}

/** A reviewable plan: the seeds (with any tracks of their own) and what was found. */
export interface SimilarPlan {
  /** Seeds in input order; `tracks` is empty when none were wanted or available. */
  seeds: ResolvedArtistTracks[];
  similar: SimilarArtist[];
  /** Seed names that matched no artist. */
  unresolvedArtists: string[];
  /** Seeds and similar artists Qobuz returned no tracks for. */
  emptyArtists: UnderfilledArtist[];
  /** Seeds and similar artists with fewer tracks than requested. */
  partialArtists: UnderfilledArtist[];
  truncated: boolean;
}

/**
 * Plan from typed artist names: resolve them (with `tracksPerSeed` of their own
 * top tracks; 0 for none), then walk their similar artists. A seed with no
 * tracks of its own is flagged but still walked.
 */
export async function planFromArtists(
  client: SimilarArtistsClient & ArtistResolverClient,
  options: WalkOptions & { artists: string[]; tracksPerSeed: number },
): Promise<SimilarPlan> {
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

  const walk = await resolveSimilarArtists(client, {
    ...options,
    seeds: seeds.map((seed) => seed.artist),
  });
  return {
    seeds,
    similar: walk.similar,
    unresolvedArtists: resolved.unresolvedArtists,
    emptyArtists: [...resolved.emptyArtists, ...walk.emptyArtists],
    partialArtists: [...resolved.partialArtists, ...walk.partialArtists],
    truncated: walk.truncated,
  };
}

/**
 * Plan from an existing playlist: seed from its `maxSeeds` most frequent
 * artists and never suggest an artist already in it. The seeds contribute no
 * tracks (they are already in the playlist).
 */
export async function planFromPlaylist(
  client: SimilarArtistsClient & { getPlaylistTracks(playlistId: number): Promise<Track[]> },
  options: WalkOptions & { playlistId: number; maxSeeds: number },
): Promise<SimilarPlan> {
  const tracks = await client.getPlaylistTracks(options.playlistId);
  const { seeds, presentIds } = seedsFromPlaylist(tracks, options.maxSeeds);
  const walk = await resolveSimilarArtists(client, {
    ...options,
    seeds,
    skipArtistIds: presentIds,
  });
  return {
    seeds: seeds.map((artist) => ({ query: artist.name, artist, tracks: [], excluded: [] })),
    similar: walk.similar,
    unresolvedArtists: [],
    emptyArtists: walk.emptyArtists,
    partialArtists: walk.partialArtists,
    truncated: walk.truncated,
  };
}
