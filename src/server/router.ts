/**
 * The local web server's JSON API.
 *
 * `handleApi` is a pure function from a parsed request to a response, so it can
 * be unit-tested without a live socket. The thin node:http glue in `http.ts`
 * reads the request off the wire, calls this, and writes the response back.
 *
 * Every route is guarded by {@link authorise} first, then dispatched. The API
 * exposes only what the playlist UI needs: who is signed in, the user's
 * playlists, resolving artists to tracks, and committing a selection to a new
 * or existing playlist. Inputs are validated defensively (the caller is a
 * browser); upstream Qobuz failures map to 502 so the UI can surface them.
 */

import {
  QobuzError,
  type Album,
  type Artist,
  type Playlist,
  type Track,
} from "../qobuz/index.js";
import {
  deduplicateTracks,
  enrichReleaseDates,
  resolveDuplicateGroups,
  strategyNeedsReleaseDates,
  KEEP_STRATEGIES,
  type KeepStrategy,
} from "../features/deduplicate.js";
import {
  addTracksToExistingPlaylist,
  createPlaylistWithTracks,
  resolveArtistTracks,
} from "../features/playlist-from-artists.js";
import {
  fetchAlbumTracks,
  parseAlbumEntry,
  resolveAlbumVersions,
  type AlbumEntry,
} from "../features/playlist-from-albums.js";
import {
  compileTrackFilter,
  NO_FILTER,
  parseDiscList,
  type TrackFilter,
} from "../features/track-filter.js";
import {
  buildBackup,
  collectCollection,
  commitImport,
  parseBackup,
  parseCollection,
  resolveImport,
  restoreBackup,
  serializeBackup,
  serializeCollection,
  FORMATS,
  type CollectionKind,
  type ExportSource,
  type Format,
  type ImportPlan,
  type ImportTarget,
  type MatchedItem,
} from "../features/import-export.js";
import {
  describeEstimate,
  estimateSimilar,
  fetchArtistTracks,
  SIMILAR_SETTINGS,
  walkFromArtists,
  walkFromPlaylist,
  type SettingBounds,
  type WalkOptions,
} from "../features/similar-artists.js";
import { authorise, type RequestHeaders } from "./security.js";

/** The Qobuz client capabilities the API needs; QobuzClient satisfies it. */
export interface QobuzApiService {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
  getSimilarArtists(artistId: number, limit: number): Promise<Artist[]>;
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getFavoriteTracks(): Promise<Track[]>;
  getAlbumReleaseDate(albumId: string): Promise<string | undefined>;
  searchAlbums(query: string, limit?: number): Promise<Album[]>;
  searchTracks(query: string, limit?: number): Promise<Track[]>;
  getAlbumTracks(albumId: string): Promise<Track[]>;
  getFavoriteAlbums(): Promise<Album[]>;
  getFavoriteArtists(): Promise<Artist[]>;
  addFavoriteTracks(trackIds: readonly number[]): Promise<void>;
  addFavoriteAlbums(albumIds: readonly string[]): Promise<void>;
  addFavoriteArtists(artistIds: readonly number[]): Promise<void>;
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  addTracksToPlaylist(
    playlistId: number,
    trackIds: readonly number[],
  ): Promise<void>;
  removeTracksFromPlaylist(
    playlistId: number,
    playlistTrackIds: readonly number[],
  ): Promise<void>;
  removeFavoriteTracks(trackIds: readonly number[]): Promise<void>;
}

export interface SessionInfo {
  displayName: string;
  subscriptionLabel: string;
}

export interface ApiDeps {
  service: QobuzApiService;
  session: SessionInfo;
  nonce: string;
  port: number;
}

export interface ApiRequest {
  method: string;
  path: string;
  headers: RequestHeaders;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Bounds for how many top tracks may be requested per artist. */
const MIN_TRACKS_PER_ARTIST = 1;
const MAX_TRACKS_PER_ARTIST = 100;
const DEFAULT_TRACKS_PER_ARTIST = 10;

/** Authorise, then dispatch an API request, mapping upstream failures to 5xx. */
export async function handleApi(
  req: ApiRequest,
  deps: ApiDeps,
): Promise<ApiResponse> {
  const auth = authorise(req.headers, {
    expectedNonce: deps.nonce,
    port: deps.port,
  });
  if (!auth.ok) {
    return { status: 403, body: { error: `forbidden: ${auth.reason}` } };
  }
  try {
    return await dispatch(req, deps);
  } catch (error) {
    if (error instanceof QobuzError) {
      return { status: 502, body: { error: error.message, kind: error.kind } };
    }
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : "internal error" },
    };
  }
}

async function dispatch(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  if (req.method === "GET" && req.path === "/api/session") {
    return { status: 200, body: deps.session };
  }
  if (req.method === "GET" && req.path === "/api/playlists") {
    const playlists = await deps.service.getUserPlaylists();
    return { status: 200, body: { playlists } };
  }
  if (req.method === "POST" && req.path === "/api/resolve") {
    return resolve(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/commit") {
    return commit(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/resolve-albums") {
    return resolveAlbums(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/album-tracks") {
    return albumTracks(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/similar/estimate") {
    return estimateSimilarRun(req.body);
  }
  if (req.method === "POST" && req.path === "/api/similar/walk") {
    return walkSimilar(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/similar/tracks") {
    return similarTracks(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/deduplicate/scan") {
    return scan(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/deduplicate/apply") {
    return apply(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/export") {
    return exportData(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/import/resolve") {
    return importResolve(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/import/commit") {
    return importCommit(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/restore") {
    return restore(req.body, deps);
  }
  return { status: 404, body: { error: "not found" } };
}

async function resolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseResolveInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const result = await resolveArtistTracks(deps.service, {
    artists: input.value.artists,
    tracksPerArtist: input.value.tracksPerArtist,
    filter: input.value.filter,
  });
  return { status: 200, body: result };
}

async function commit(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseCommitInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  return writeTracksToTarget(deps.service, input.value.target, input.value.trackIds);
}

async function resolveAlbums(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseResolveAlbumsInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const result = await resolveAlbumVersions(deps.service, {
    entries: input.value.entries,
    filter: input.value.filter,
  });
  return {
    status: 200,
    body: {
      resolvedAlbums: result.resolvedAlbums,
      excludedAlbums: result.excludedAlbums,
      // Lines that were not in the expected format are surfaced alongside the
      // ones that matched nothing, so the user sees every entry accounted for.
      unresolvedAlbums: [...result.unresolvedAlbums, ...input.value.malformed],
    },
  };
}

/**
 * Fetch the tracks of the given albums without writing anything.
 *
 * The album view calls this first and only writes (via `/api/commit`) once every
 * album has been fetched, so a retried album keeps its place in the user's
 * order instead of being appended after an earlier partial write.
 */
async function albumTracks(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseAlbumTracksInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const result = await fetchAlbumTracks(
    deps.service,
    input.value.albumIds,
    input.value.filter,
  );
  return { status: 200, body: result };
}

/**
 * Walk the similar artists of typed artists or an existing playlist, without
 * fetching the found artists' tracks (seeds' own tracks are included). The
 * view then fetches tracks in batches via `/api/similar/tracks`, so no single
 * request runs long enough for the browser to abort it, and commits via
 * `/api/commit`.
 */
async function walkSimilar(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseSimilarInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, walk } = input.value;
  const result =
    source.type === "artists"
      ? await walkFromArtists(deps.service, {
          ...walk,
          artists: source.artists,
          tracksPerSeed: source.tracksPerSeed,
        })
      : await walkFromPlaylist(deps.service, {
          ...walk,
          playlistId: source.playlistId,
          maxSeeds: source.maxSeeds,
        });
  return { status: 200, body: result };
}

/** The most artists `/api/similar/tracks` takes per request. */
const MAX_TRACK_BATCH = 50;

/** Fetch the top tracks of a batch of (walked) artists. */
async function similarTracks(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  if (!isRecord(body)) {
    return { status: 400, body: { error: "expected a JSON object" } };
  }
  const raw = body["artists"];
  const artists = Array.isArray(raw)
    ? raw.filter(
        (a): a is Artist =>
          isRecord(a) && Number.isSafeInteger(a["id"]) && typeof a["name"] === "string",
      )
    : [];
  if (!Array.isArray(raw) || artists.length === 0 || artists.length !== raw.length) {
    return { status: 400, body: { error: "artists must be a non-empty array of { id, name }" } };
  }
  if (artists.length > MAX_TRACK_BATCH) {
    return {
      status: 400,
      body: { error: `at most ${MAX_TRACK_BATCH} artists per request` },
    };
  }
  const tracksPerSimilar = intField(
    body,
    "tracksPerSimilar",
    "tracksPerSimilar",
    SIMILAR_SETTINGS.tracksPerSimilar,
  );
  if (!tracksPerSimilar.ok) {
    return { status: 400, body: { error: tracksPerSimilar.error } };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return { status: 400, body: { error: filter.error } };
  }
  const result = await fetchArtistTracks(
    deps.service,
    artists.map((a) => ({ id: a.id, name: a.name })),
    tracksPerSimilar.value,
    filter.value,
  );
  return { status: 200, body: result };
}

/**
 * Estimate the largest outcome of a similar-artists run from its settings,
 * without calling Qobuz, so the view can warn before a very large run. A
 * playlist source counts its seed cap as the seed count.
 */
function estimateSimilarRun(body: unknown): ApiResponse {
  const input = parseSimilarInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, walk } = input.value;
  const estimate = estimateSimilar({
    seedCount: source.type === "artists" ? source.artists.length : source.maxSeeds,
    tracksPerSeed: source.type === "artists" ? source.tracksPerSeed : 0,
    ...walk,
  });
  return { status: 200, body: { ...estimate, summary: describeEstimate(estimate) } };
}

/** Create a new playlist from the tracks, or add them to an existing one. */
async function writeTracksToTarget(
  service: QobuzApiService,
  target: CommitTarget,
  trackIds: readonly number[],
): Promise<ApiResponse> {
  if (target.type === "new") {
    const playlist = await createPlaylistWithTracks(service, {
      name: target.name,
      trackIds,
      isPublic: target.isPublic,
      ...(target.description !== undefined && { description: target.description }),
    });
    return { status: 200, body: { playlist, added: trackIds, skipped: [] } };
  }
  const { added, skipped } = await addTracksToExistingPlaylist(service, {
    playlistId: target.playlistId,
    trackIds,
  });
  return { status: 200, body: { playlistId: target.playlistId, added, skipped } };
}

async function scan(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseScanInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, keep } = input.value;
  const tracks =
    source.type === "playlist"
      ? await deps.service.getPlaylistTracks(source.playlistId)
      : await deps.service.getFavoriteTracks();

  let groups = deduplicateTracks(tracks);
  if (strategyNeedsReleaseDates(keep) && groups.length > 0) {
    groups = await enrichReleaseDates(groups, (albumId) =>
      deps.service.getAlbumReleaseDate(albumId),
    );
  }
  const resolved = resolveDuplicateGroups(groups, keep);
  return { status: 200, body: { groups: resolved } };
}

async function apply(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseApplyInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, removals } = input.value;
  if (source.type === "playlist") {
    const ids = removals
      .map((removal) => removal.playlistTrackId)
      .filter((id): id is number => id !== undefined);
    await deps.service.removeTracksFromPlaylist(source.playlistId, ids);
    return { status: 200, body: { removed: ids.length } };
  }
  const ids = removals.map((removal) => removal.id);
  await deps.service.removeFavoriteTracks(ids);
  return { status: 200, body: { removed: ids.length } };
}

/**
 * Export a collection or a full-account backup, returning the serialised text
 * and a suggested filename for the browser to download.
 */
async function exportData(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseExportInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, format } = input.value;
  if (source.type === "account") {
    const backup = await buildBackup(deps.service);
    return {
      status: 200,
      body: {
        filename: `qobuz-backup-${today()}.json`,
        content: serializeBackup(backup),
      },
    };
  }
  const collection = await collectCollection(deps.service, source);
  if (format === "m3u" && collection.kind !== "tracks") {
    return { status: 400, body: { error: "M3U can only hold tracks" } };
  }
  return {
    status: 200,
    body: {
      filename: `${exportBasename(source)}.${extensionFor(format)}`,
      content: serializeCollection(collection, format),
    },
  };
}

/** Parse and resolve an import to a plan (phase one), without writing. */
async function importResolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseImportResolveInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  let parsed;
  try {
    parsed = parseCollection(input.value.content, input.value.format, input.value.kind);
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "could not parse" },
    };
  }
  const plan = await resolveImport(deps.service, parsed);
  return { status: 200, body: plan };
}

/** Write a resolved import plan to its destination (phase two). */
async function importCommit(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseImportCommitInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  try {
    const result = await commitImport(
      deps.service,
      input.value.plan,
      input.value.target,
    );
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof QobuzError) {
      throw error;
    }
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "could not import" },
    };
  }
}

/** Restore a full-account backup document. */
async function restore(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  if (!isRecord(body) || typeof body["content"] !== "string") {
    return { status: 400, body: { error: "content must be a string" } };
  }
  let backup;
  try {
    backup = parseBackup(body["content"]);
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "invalid backup" },
    };
  }
  const result = await restoreBackup(deps.service, backup);
  return { status: 200, body: result };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse the optional `filter` of a playlist request:
 * `{ excludeTracks?: string[], excludeAlbums?: string[], discs?: string }`,
 * where `discs` is a list as the user typed it ("1", "1,3-4"). Absent means no
 * filter; an invalid regex term or disc list is a 400 naming the problem.
 */
function parseFilterInput(raw: unknown): Parsed<TrackFilter> {
  if (raw === undefined) {
    return { ok: true, value: NO_FILTER };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "filter must be an object" };
  }
  const terms = (key: string): string[] | undefined => {
    const value = raw[key];
    if (value === undefined) {
      return [];
    }
    return Array.isArray(value) && value.every((term) => typeof term === "string")
      ? value
      : undefined;
  };
  const excludeTracks = terms("excludeTracks");
  const excludeAlbums = terms("excludeAlbums");
  if (excludeTracks === undefined || excludeAlbums === undefined) {
    return {
      ok: false,
      error: "filter.excludeTracks and filter.excludeAlbums must be arrays of strings",
    };
  }
  const discs = raw["discs"];
  if (discs !== undefined && typeof discs !== "string") {
    return { ok: false, error: 'filter.discs must be a string such as "1" or "1,3-4"' };
  }
  try {
    return {
      ok: true,
      value: compileTrackFilter({
        excludeTracks,
        excludeAlbums,
        discs: parseDiscList(discs ?? ""),
      }),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Read an optional integer field, defaulting when absent.
 * Fails unless it is an integer within the bounds (`max` absent: no upper bound).
 */
function intField(
  record: Record<string, unknown>,
  key: string,
  label: string,
  bounds: SettingBounds,
): Parsed<number> {
  const raw = record[key];
  if (raw === undefined) {
    return { ok: true, value: bounds.fallback };
  }
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < bounds.min ||
    (bounds.max !== undefined && raw > bounds.max)
  ) {
    return {
      ok: false,
      error:
        bounds.max === undefined
          ? `${label} must be an integer of at least ${bounds.min}`
          : `${label} must be an integer between ${bounds.min} and ${bounds.max}`,
    };
  }
  return { ok: true, value: raw };
}

type SimilarSource =
  | { type: "artists"; artists: string[]; tracksPerSeed: number }
  | { type: "playlist"; playlistId: number; maxSeeds: number };

interface SimilarInput {
  source: SimilarSource;
  walk: Required<WalkOptions>;
}

function parseSimilarInput(body: unknown): Parsed<SimilarInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const rawSource = body["source"];
  if (!isRecord(rawSource)) {
    return { ok: false, error: "source is required" };
  }
  let source: SimilarSource;
  if (rawSource["type"] === "artists") {
    if (!Array.isArray(rawSource["artists"])) {
      return { ok: false, error: "source.artists must be an array" };
    }
    const artists = rawSource["artists"]
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (artists.length === 0) {
      return { ok: false, error: "at least one artist is required" };
    }
    const tracksPerSeed = intField(
      rawSource,
      "tracksPerSeed",
      "source.tracksPerSeed",
      SIMILAR_SETTINGS.tracksPerSeed,
    );
    if (!tracksPerSeed.ok) {
      return tracksPerSeed;
    }
    source = { type: "artists", artists, tracksPerSeed: tracksPerSeed.value };
  } else if (rawSource["type"] === "playlist") {
    const playlistId = rawSource["playlistId"];
    if (typeof playlistId !== "number" || !Number.isInteger(playlistId) || playlistId <= 0) {
      return { ok: false, error: "source.playlistId must be a playlist id" };
    }
    const maxSeeds = intField(rawSource, "maxSeeds", "source.maxSeeds", SIMILAR_SETTINGS.maxSeeds);
    if (!maxSeeds.ok) {
      return maxSeeds;
    }
    source = { type: "playlist", playlistId, maxSeeds: maxSeeds.value };
  } else {
    return { ok: false, error: "source.type must be artists or playlist" };
  }

  const similarPerArtist = intField(
    body,
    "similarPerArtist",
    "similarPerArtist",
    SIMILAR_SETTINGS.similarPerArtist,
  );
  if (!similarPerArtist.ok) {
    return similarPerArtist;
  }
  const depth = intField(body, "depth", "depth", SIMILAR_SETTINGS.depth);
  if (!depth.ok) {
    return depth;
  }
  const maxArtists = intField(body, "maxArtists", "maxArtists", SIMILAR_SETTINGS.maxArtists);
  if (!maxArtists.ok) {
    return maxArtists;
  }
  const tracksPerSimilar = intField(
    body,
    "tracksPerSimilar",
    "tracksPerSimilar",
    SIMILAR_SETTINGS.tracksPerSimilar,
  );
  if (!tracksPerSimilar.ok) {
    return tracksPerSimilar;
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  return {
    ok: true,
    value: {
      source,
      walk: {
        similarPerArtist: similarPerArtist.value,
        depth: depth.value,
        tracksPerSimilar: tracksPerSimilar.value,
        maxArtists: maxArtists.value,
        filter: filter.value,
      },
    },
  };
}

interface ResolveInput {
  artists: string[];
  tracksPerArtist: number;
  filter: TrackFilter;
}

function parseResolveInput(body: unknown): Parsed<ResolveInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (!Array.isArray(body["artists"])) {
    return { ok: false, error: "artists must be an array" };
  }
  const artists = body["artists"]
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (artists.length === 0) {
    return { ok: false, error: "at least one artist is required" };
  }

  let tracksPerArtist = DEFAULT_TRACKS_PER_ARTIST;
  const raw = body["tracksPerArtist"];
  if (raw !== undefined) {
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < MIN_TRACKS_PER_ARTIST ||
      raw > MAX_TRACKS_PER_ARTIST
    ) {
      return {
        ok: false,
        error: `tracksPerArtist must be an integer between ${MIN_TRACKS_PER_ARTIST} and ${MAX_TRACKS_PER_ARTIST}`,
      };
    }
    tracksPerArtist = raw;
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  return { ok: true, value: { artists, tracksPerArtist, filter: filter.value } };
}

type CommitTarget =
  | { type: "new"; name: string; isPublic?: boolean; description?: string }
  | { type: "existing"; playlistId: number };

interface CommitInput {
  target: CommitTarget;
  trackIds: number[];
}

function parseCommitInput(body: unknown): Parsed<CommitInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const trackIds = Array.isArray(body["trackIds"])
    ? body["trackIds"].filter(
        (id): id is number => typeof id === "number" && Number.isFinite(id),
      )
    : undefined;
  if (trackIds === undefined || trackIds.length === 0) {
    return { ok: false, error: "at least one track id is required" };
  }

  const target = parseCommitTarget(body["target"]);
  if (!target.ok) {
    return target;
  }
  return { ok: true, value: { target: target.value, trackIds } };
}

/** Parse the new/existing destination shared by both commit routes. */
function parseCommitTarget(value: unknown): Parsed<CommitTarget> {
  if (!isRecord(value)) {
    return { ok: false, error: "target is required" };
  }
  if (value["type"] === "new") {
    const name = typeof value["name"] === "string" ? value["name"].trim() : "";
    if (name.length === 0) {
      return { ok: false, error: "a playlist name is required" };
    }
    const target: CommitTarget = { type: "new", name };
    if (typeof value["isPublic"] === "boolean") {
      target.isPublic = value["isPublic"];
    }
    if (typeof value["description"] === "string" && value["description"].length > 0) {
      target.description = value["description"];
    }
    return { ok: true, value: target };
  }
  if (value["type"] === "existing") {
    if (typeof value["playlistId"] !== "number") {
      return { ok: false, error: "playlistId is required" };
    }
    return { ok: true, value: { type: "existing", playlistId: value["playlistId"] } };
  }
  return { ok: false, error: "target.type must be 'new' or 'existing'" };
}

interface ResolveAlbumsInput {
  entries: AlbumEntry[];
  /** Input lines that were not in the "Artist - Album" format. */
  malformed: string[];
  filter: TrackFilter;
}

function parseResolveAlbumsInput(body: unknown): Parsed<ResolveAlbumsInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (!Array.isArray(body["entries"])) {
    return { ok: false, error: "entries must be an array" };
  }
  const lines = body["entries"]
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const entries: AlbumEntry[] = [];
  const malformed: string[] = [];
  for (const line of lines) {
    const entry = parseAlbumEntry(line);
    if (entry === undefined) {
      malformed.push(line);
    } else {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return {
      ok: false,
      error: "at least one album in 'Artist - Album' format is required",
    };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  return { ok: true, value: { entries, malformed, filter: filter.value } };
}

interface AlbumTracksInput {
  albumIds: string[];
  filter: TrackFilter;
}

function parseAlbumTracksInput(body: unknown): Parsed<AlbumTracksInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const albumIds = Array.isArray(body["albumIds"])
    ? body["albumIds"].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : undefined;
  if (albumIds === undefined || albumIds.length === 0) {
    return { ok: false, error: "at least one album id is required" };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  return { ok: true, value: { albumIds, filter: filter.value } };
}

type DedupeSource =
  | { type: "playlist"; playlistId: number }
  | { type: "favourites" };

/** Parse the shared source discriminator used by scan and apply. */
function parseSource(value: unknown): Parsed<DedupeSource> {
  if (!isRecord(value)) {
    return { ok: false, error: "source is required" };
  }
  if (value["type"] === "favourites") {
    return { ok: true, value: { type: "favourites" } };
  }
  if (value["type"] === "playlist") {
    if (typeof value["playlistId"] !== "number") {
      return { ok: false, error: "playlistId is required" };
    }
    return { ok: true, value: { type: "playlist", playlistId: value["playlistId"] } };
  }
  return { ok: false, error: "source.type must be 'playlist' or 'favourites'" };
}

interface ScanInput {
  source: DedupeSource;
  keep: KeepStrategy;
}

function parseScanInput(body: unknown): Parsed<ScanInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const source = parseSource(body["source"]);
  if (!source.ok) {
    return source;
  }
  const rawKeep = body["keep"];
  const keep = rawKeep === undefined ? "first-added" : rawKeep;
  if (!isKeepStrategy(keep)) {
    return {
      ok: false,
      error: `keep must be one of: ${KEEP_STRATEGIES.join(", ")}`,
    };
  }
  return { ok: true, value: { source: source.value, keep } };
}

interface Removal {
  id: number;
  playlistTrackId?: number;
}

interface ApplyInput {
  source: DedupeSource;
  removals: Removal[];
}

function parseApplyInput(body: unknown): Parsed<ApplyInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const source = parseSource(body["source"]);
  if (!source.ok) {
    return source;
  }
  if (!Array.isArray(body["removals"])) {
    return { ok: false, error: "removals must be an array" };
  }
  const removals: Removal[] = [];
  for (const item of body["removals"]) {
    if (!isRecord(item) || typeof item["id"] !== "number") {
      continue;
    }
    const removal: Removal = { id: item["id"] };
    if (typeof item["playlistTrackId"] === "number") {
      removal.playlistTrackId = item["playlistTrackId"];
    }
    removals.push(removal);
  }
  if (removals.length === 0) {
    return { ok: false, error: "at least one track to remove is required" };
  }
  return { ok: true, value: { source: source.value, removals } };
}

interface ExportInput {
  source: ExportSource;
  format: Format;
}

function parseExportInput(body: unknown): Parsed<ExportInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const source = parseExportSource(body["source"]);
  if (!source.ok) {
    return source;
  }
  const format = body["format"];
  if (source.value.type === "account") {
    // A backup is always JSON; ignore any format sent alongside it.
    return { ok: true, value: { source: source.value, format: "json" } };
  }
  if (!isFormat(format)) {
    return { ok: false, error: `format must be one of: ${FORMATS.join(", ")}` };
  }
  return { ok: true, value: { source: source.value, format } };
}

function parseExportSource(value: unknown): Parsed<ExportSource> {
  if (!isRecord(value)) {
    return { ok: false, error: "source is required" };
  }
  switch (value["type"]) {
    case "favourite-tracks":
    case "favourite-albums":
    case "favourite-artists":
    case "account":
      return { ok: true, value: { type: value["type"] } };
    case "playlist":
      if (typeof value["playlistId"] !== "number") {
        return { ok: false, error: "playlistId is required" };
      }
      return { ok: true, value: { type: "playlist", playlistId: value["playlistId"] } };
    default:
      return {
        ok: false,
        error:
          "source.type must be favourite-tracks, favourite-albums, favourite-artists, playlist or account",
      };
  }
}

interface ImportResolveInput {
  format: Format;
  content: string;
  kind: CollectionKind;
}

function parseImportResolveInput(body: unknown): Parsed<ImportResolveInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (!isFormat(body["format"])) {
    return { ok: false, error: `format must be one of: ${FORMATS.join(", ")}` };
  }
  if (typeof body["content"] !== "string" || body["content"].trim().length === 0) {
    return { ok: false, error: "content must be a non-empty string" };
  }
  const kind = body["kind"];
  if (kind !== "tracks" && kind !== "albums" && kind !== "artists") {
    return { ok: false, error: "kind must be tracks, albums or artists" };
  }
  return { ok: true, value: { format: body["format"], content: body["content"], kind } };
}

interface ImportCommitInput {
  plan: ImportPlan;
  target: ImportTarget;
}

function parseImportCommitInput(body: unknown): Parsed<ImportCommitInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const plan = parseImportPlan(body["plan"]);
  if (!plan.ok) {
    return plan;
  }
  const target = parseImportTarget(body["target"]);
  if (!target.ok) {
    return target;
  }
  return { ok: true, value: { plan: plan.value, target: target.value } };
}

function parseImportPlan(value: unknown): Parsed<ImportPlan> {
  if (!isRecord(value)) {
    return { ok: false, error: "plan is required" };
  }
  const kind = value["kind"];
  if (kind !== "tracks" && kind !== "albums" && kind !== "artists") {
    return { ok: false, error: "plan.kind must be tracks, albums or artists" };
  }
  if (!Array.isArray(value["matched"])) {
    return { ok: false, error: "plan.matched must be an array" };
  }
  const matched: MatchedItem[] = [];
  for (const item of value["matched"]) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item["id"];
    // Track and artist ids are numbers; album ids are strings.
    if (typeof id !== "number" && typeof id !== "string") {
      continue;
    }
    const label = typeof item["label"] === "string" ? item["label"] : String(id);
    matched.push({ label, id });
  }
  if (matched.length === 0) {
    return { ok: false, error: "at least one matched item is required" };
  }
  return { ok: true, value: { kind, matched, unmatched: [] } };
}

function parseImportTarget(value: unknown): Parsed<ImportTarget> {
  if (!isRecord(value)) {
    return { ok: false, error: "target is required" };
  }
  switch (value["type"]) {
    case "favourites":
      return { ok: true, value: { type: "favourites" } };
    case "playlist-new": {
      const name = typeof value["name"] === "string" ? value["name"].trim() : "";
      if (name.length === 0) {
        return { ok: false, error: "a playlist name is required" };
      }
      const target: ImportTarget = { type: "playlist-new", name };
      if (typeof value["isPublic"] === "boolean") {
        target.isPublic = value["isPublic"];
      }
      if (typeof value["description"] === "string" && value["description"].length > 0) {
        target.description = value["description"];
      }
      return { ok: true, value: target };
    }
    case "playlist-existing":
      if (typeof value["playlistId"] !== "number") {
        return { ok: false, error: "playlistId is required" };
      }
      return {
        ok: true,
        value: { type: "playlist-existing", playlistId: value["playlistId"] },
      };
    default:
      return {
        ok: false,
        error: "target.type must be favourites, playlist-new or playlist-existing",
      };
  }
}

function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value);
}

/** File extension for a format (text is `.txt`). */
function extensionFor(format: Format): string {
  return format === "text" ? "txt" : format;
}

/** A stable, human-readable base filename for an exported collection. */
function exportBasename(source: Exclude<ExportSource, { type: "account" }>): string {
  switch (source.type) {
    case "favourite-tracks":
      return "qobuz-favourite-tracks";
    case "favourite-albums":
      return "qobuz-favourite-albums";
    case "favourite-artists":
      return "qobuz-favourite-artists";
    case "playlist":
      return `qobuz-playlist-${source.playlistId}`;
  }
}

/** Today's date as YYYY-MM-DD, for backup filenames. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isKeepStrategy(value: unknown): value is KeepStrategy {
  return (
    typeof value === "string" &&
    (KEEP_STRATEGIES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
