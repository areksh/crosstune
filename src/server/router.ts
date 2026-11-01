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
  RELEASE_TYPES,
  type Album,
  type Artist,
  type ArtistReleases,
  type Playlist,
  type ReleaseType,
  type Track,
} from "../qobuz/index.js";
import {
  deduplicateTracks,
  enrichReleaseDates,
  removePlaylistEntries,
  resolveDuplicateGroups,
  scanAllPlaylists,
  strategyNeedsReleaseDates,
  KEEP_STRATEGIES,
  type KeepStrategy,
  type PlaylistEntry,
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
  effectiveImportFormat,
  exportAllPlaylists,
  extensionFor,
  parseBackup,
  parseCollection,
  resolveImport,
  restoreBackup,
  serializeBackup,
  serializeCollection,
  FORMATS,
  IMPORT_FORMATS,
  type CollectionKind,
  type ExportSource,
  type Format,
  type ImportFormat,
  type ImportPlan,
  type ImportTarget,
  type MatchedItem,
} from "../features/import-export.js";
import { createZip } from "../features/zip.js";
import {
  createSongPicker,
  parseSongPickerState,
  SongPicker,
  type SongPickerOptions,
  type SongPickerState,
} from "../features/song-picker.js";
import {
  describeEstimate,
  estimateSimilar,
  favouriteArtistIds,
  fetchArtistTracks,
  SIMILAR_SETTINGS,
  walkFromArtists,
  walkFromPlaylist,
  type SettingBounds,
  type WalkOptions,
} from "../features/similar-artists.js";
import {
  COMBINE_KEEPS,
  COMBINE_MODES,
  COMBINE_ORDERS,
  resolveCombine,
  seededRandom,
  sourcesProblem,
  type CombineKeep,
  type CombineMode,
  type CombineOrder,
  type CombineSource,
} from "../features/combine.js";
import { collectLibrary, computeStats, type StatsSource } from "../features/stats.js";
import {
  commitWordPlay,
  resolveWordPlay,
  DEFAULT_MATCH_OPTIONS,
  SPLIT_OBJECTIVES,
  WORD_PLAY_COUNT,
  WORD_PLAY_MAX_SPAN,
  WORD_PLAY_MODES,
  type MatchOptions,
  type SplitObjective,
  type WordPlayMode,
  type WordPlayRequest,
  type WordPlaySource,
} from "../features/word-play.js";
import { resolveDiscography } from "../features/discography.js";
import {
  commitNewReleases,
  DEFAULT_NEW_RELEASE_INCLUDE,
  findNewReleases,
  isIsoDate,
  type ArtistSource,
  type NewReleasesTarget,
} from "../features/new-releases.js";
import {
  commitUpgrades,
  resolveUpgrades,
  type TrackLocation,
  type UpgradeChange,
  type UpgradeSource,
} from "../features/upgrade.js";
import { authorise, type RequestHeaders } from "./security.js";

/** The Qobuz client capabilities the API needs; QobuzClient satisfies it. */
export interface QobuzApiService {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
  getSimilarArtists(artistId: number, limit: number): Promise<Artist[]>;
  getArtistReleases(artistId: number, maxReleases?: number): Promise<ArtistReleases>;
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getFavoriteTracks(): Promise<Track[]>;
  getAlbumReleaseDate(albumId: string): Promise<string | undefined>;
  searchAlbums(query: string, limit?: number): Promise<Album[]>;
  searchTracks(query: string, limit?: number, offset?: number): Promise<Track[]>;
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
  /**
   * Move playlist entries into place (upgrade & repair). Optional: its endpoint
   * is unverified, and without it replacements stay at the end of a playlist.
   */
  movePlaylistTracks?(
    playlistId: number,
    playlistTrackIds: readonly number[],
    insertBefore: number,
  ): Promise<void>;
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
  /** A file to download; when set it is sent as raw bytes instead of `body`. */
  file?: DownloadFile;
}

/** A binary response body the browser saves as a file. */
export interface DownloadFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
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
  if (req.method === "POST" && req.path === "/api/resolve-discography") {
    return resolveDiscographyRoute(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/new-releases") {
    return newReleases(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/new-releases/commit") {
    return commitNewReleasesRoute(req.body, deps);
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
  if (req.method === "POST" && req.path === "/api/upgrade/resolve") {
    return upgradeResolve(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/upgrade/commit") {
    return upgradeCommit(req.body, deps);
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
  if (req.method === "POST" && req.path === "/api/combine/resolve") {
    return combineResolve(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/stats") {
    return libraryStats(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/word-play/resolve") {
    return wordPlayResolve(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/word-play/commit") {
    return wordPlayCommit(req.body, deps);
  }
  return { status: 404, body: { error: "not found" } };
}

async function resolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseResolveInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const plan = parsePlanOptions(body);
  if (!plan.ok) {
    return { status: 400, body: { error: plan.error } };
  }
  const result = await resolveArtistTracks(deps.service, {
    artists: input.value.artists,
    tracksPerArtist: input.value.tracksPerArtist,
    filter: input.value.filter,
    picker: await pickerFor(deps.service, plan.value),
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
  const plan = parsePlanOptions(body);
  if (!plan.ok) {
    return { status: 400, body: { error: plan.error } };
  }
  const picker = await pickerFor(deps.service, plan.value);
  const result = await fetchAlbumTracks(
    deps.service,
    input.value.albumIds,
    input.value.filter,
    picker,
  );
  return { status: 200, body: withPicker(result, picker) };
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
  const plan = parsePlanOptions(body);
  if (!plan.ok) {
    return { status: 400, body: { error: plan.error } };
  }
  const { source, walk, skipFavouriteArtists } = input.value;
  const picker = await pickerFor(deps.service, plan.value);
  const extras = {
    ...(picker !== undefined && { picker }),
    ...(skipFavouriteArtists && { skipArtistIds: await favouriteArtistIds(deps.service) }),
  };
  const result =
    source.type === "artists"
      ? await walkFromArtists(deps.service, {
          ...walk,
          ...extras,
          artists: source.artists,
          tracksPerSeed: source.tracksPerSeed,
        })
      : await walkFromPlaylist(deps.service, {
          ...walk,
          ...extras,
          playlistId: source.playlistId,
          maxSeeds: source.maxSeeds,
        });
  return { status: 200, body: withPicker(result, picker) };
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
  const plan = parsePlanOptions(body);
  if (!plan.ok) {
    return { status: 400, body: { error: plan.error } };
  }
  const picker = await pickerFor(deps.service, plan.value);
  const result = await fetchArtistTracks(
    deps.service,
    artists.map((a) => ({ id: a.id, name: a.name })),
    tracksPerSimilar.value,
    filter.value,
    picker,
  );
  return { status: 200, body: withPicker(result, picker) };
}

/**
 * The plan-wide options of a playlist request: `skipFavourites` and `oneCopy`
 * (booleans) start a run; `picker`, the state a previous response returned,
 * carries one on across requests (so favourites are fetched once per run).
 */
type PlanOptions = { type: "start"; options: SongPickerOptions } | { type: "resume"; state: SongPickerState };

function parsePlanOptions(body: unknown): Parsed<PlanOptions> {
  if (!isRecord(body)) {
    return { ok: true, value: { type: "start", options: {} } };
  }
  if (body["picker"] !== undefined) {
    try {
      return { ok: true, value: { type: "resume", state: parseSongPickerState(body["picker"]) } };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
  const skipFavourites = body["skipFavourites"] ?? false;
  const oneCopy = body["oneCopy"] ?? false;
  if (typeof skipFavourites !== "boolean" || typeof oneCopy !== "boolean") {
    return { ok: false, error: "skipFavourites and oneCopy must be booleans" };
  }
  return { ok: true, value: { type: "start", options: { skipFavourites, oneCopy } } };
}

/** The picker for these options, or undefined when it would exclude nothing. */
async function pickerFor(
  service: QobuzApiService,
  plan: PlanOptions,
): Promise<SongPicker | undefined> {
  const picker =
    plan.type === "resume"
      ? SongPicker.fromState(plan.state)
      : await createSongPicker(service, plan.options);
  return picker.active ? picker : undefined;
}

/** Add the picker's state to a response body, for the next request of the run. */
function withPicker<T extends object>(body: T, picker: SongPicker | undefined): T {
  return picker === undefined ? body : { ...body, picker: picker.state() };
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
  if (source.type === "all-playlists") {
    // { within: [{ playlist, groups }], across: [...], playlistCount }
    return { status: 200, body: await scanAllPlaylists(deps.service, keep) };
  }
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
  if (source.type === "all-playlists") {
    const entries: PlaylistEntry[] = removals.flatMap((removal) =>
      removal.playlistId !== undefined && removal.playlistTrackId !== undefined
        ? [{ playlistId: removal.playlistId, playlistTrackId: removal.playlistTrackId }]
        : [],
    );
    const removed = await removePlaylistEntries(deps.service, entries);
    return { status: 200, body: { removed } };
  }
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

/** Resolve an upgrade & repair plan for a source (phase one), without writing. */
async function upgradeResolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseUpgradeResolveInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, allowSignatureMatch, removeUnplayable } = input.value;
  const plan = await resolveUpgrades(deps.service, source, {
    allowSignatureMatch,
    removeUnplayable,
  });
  return { status: 200, body: plan };
}

/** Write the chosen upgrade & repair changes (phase two). */
async function upgradeCommit(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseUpgradeCommitInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const result = await commitUpgrades(deps.service, input.value);
  return { status: 200, body: result };
}

/**
 * Export a collection or a full-account backup, returning the serialised text
 * and a suggested filename for the browser to download. Every playlist at once
 * comes back as a zip download (a file per playlist) instead.
 */
async function exportData(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseExportInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { source, format } = input.value;
  if (source.type === "all-playlists") {
    const files = await exportAllPlaylists(deps.service, format);
    const encoder = new TextEncoder();
    const bytes = createZip(
      files.map((file) => ({ name: file.filename, data: encoder.encode(file.content) })),
    );
    return {
      status: 200,
      body: undefined,
      file: { filename: `qobuz-playlists-${today()}.zip`, contentType: "application/zip", bytes },
    };
  }
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
  const { content, kind } = input.value;
  // Report the format actually read (a CSV may turn out to be a Spotify export).
  const format = effectiveImportFormat(content, input.value.format);
  let parsed;
  try {
    parsed = parseCollection(content, format, kind);
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "could not parse" },
    };
  }
  const plan = await resolveImport(deps.service, parsed);
  return { status: 200, body: { ...plan, format } };
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
 * `{ excludeTracks?: string[], excludeAlbums?: string[], excludeArtists?: string[],
 * discs?: string }`,
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
  const excludeArtists = terms("excludeArtists");
  if (excludeTracks === undefined || excludeAlbums === undefined || excludeArtists === undefined) {
    return {
      ok: false,
      error:
        "filter.excludeTracks, filter.excludeAlbums and filter.excludeArtists must be arrays of strings",
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
        excludeArtists,
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
  walk: Required<Omit<WalkOptions, "skipArtistIds" | "picker">>;
  /** Never suggest the user's favourite artists. */
  skipFavouriteArtists: boolean;
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
  const replaceRepeats = body["replaceRepeats"] ?? false;
  if (typeof replaceRepeats !== "boolean") {
    return { ok: false, error: "replaceRepeats must be a boolean" };
  }
  const skipFavouriteArtists = body["skipFavouriteArtists"] ?? false;
  if (typeof skipFavouriteArtists !== "boolean") {
    return { ok: false, error: "skipFavouriteArtists must be a boolean" };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  return {
    ok: true,
    value: {
      skipFavouriteArtists,
      source,
      walk: {
        similarPerArtist: similarPerArtist.value,
        depth: depth.value,
        tracksPerSimilar: tracksPerSimilar.value,
        maxArtists: maxArtists.value,
        replaceRepeats,
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
  | { type: "favourites" }
  | { type: "all-playlists" };

/** Parse the shared source discriminator used by scan and apply. */
function parseSource(value: unknown): Parsed<DedupeSource> {
  if (!isRecord(value)) {
    return { ok: false, error: "source is required" };
  }
  if (value["type"] === "favourites" || value["type"] === "all-playlists") {
    return { ok: true, value: { type: value["type"] } };
  }
  if (value["type"] === "playlist") {
    if (typeof value["playlistId"] !== "number") {
      return { ok: false, error: "playlistId is required" };
    }
    return { ok: true, value: { type: "playlist", playlistId: value["playlistId"] } };
  }
  return { ok: false, error: "source.type must be 'playlist', 'favourites' or 'all-playlists'" };
}

interface ScanInput {
  source: DedupeSource;
  /** Keep strategies in order; later ones break the earlier ones' ties. */
  keep: KeepStrategy[];
}

function parseScanInput(body: unknown): Parsed<ScanInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const source = parseSource(body["source"]);
  if (!source.ok) {
    return source;
  }
  // One strategy, a comma-separated chain, or an array of strategies.
  const rawKeep = body["keep"] ?? "first-added";
  const parts =
    typeof rawKeep === "string"
      ? rawKeep.split(",").map((part) => part.trim())
      : Array.isArray(rawKeep)
        ? rawKeep
        : [];
  if (parts.length === 0 || !parts.every(isKeepStrategy)) {
    return {
      ok: false,
      error: `keep must be one of: ${KEEP_STRATEGIES.join(", ")}, or a list of them`,
    };
  }
  return { ok: true, value: { source: source.value, keep: parts } };
}

interface Removal {
  id: number;
  playlistTrackId?: number;
  /** The playlist an entry is in (all-playlists removals). */
  playlistId?: number;
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
    if (typeof item["playlistId"] === "number") {
      removal.playlistId = item["playlistId"];
    }
    if (
      source.value.type === "all-playlists" &&
      (removal.playlistId === undefined || removal.playlistTrackId === undefined)
    ) {
      return {
        ok: false,
        error: "removals across playlists need a playlistId and a playlistTrackId",
      };
    }
    removals.push(removal);
  }
  if (removals.length === 0) {
    return { ok: false, error: "at least one track to remove is required" };
  }
  return { ok: true, value: { source: source.value, removals } };
}

interface UpgradeResolveInput {
  source: UpgradeSource;
  allowSignatureMatch: boolean;
  removeUnplayable: boolean;
}

function parseUpgradeResolveInput(body: unknown): Parsed<UpgradeResolveInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = body["source"];
  let source: UpgradeSource;
  if (!isRecord(raw)) {
    return { ok: false, error: "source is required" };
  } else if (raw["type"] === "favourites" || raw["type"] === "all-playlists") {
    source = { type: raw["type"] };
  } else if (raw["type"] === "playlist") {
    if (!isPositiveInteger(raw["playlistId"])) {
      return { ok: false, error: "source.playlistId must be a playlist id" };
    }
    source = { type: "playlist", playlistId: raw["playlistId"] };
  } else {
    return {
      ok: false,
      error: "source.type must be 'favourites', 'playlist' or 'all-playlists'",
    };
  }
  const allowSignatureMatch = body["allowSignatureMatch"] ?? false;
  const removeUnplayable = body["removeUnplayable"] ?? false;
  if (typeof allowSignatureMatch !== "boolean" || typeof removeUnplayable !== "boolean") {
    return { ok: false, error: "allowSignatureMatch and removeUnplayable must be booleans" };
  }
  return { ok: true, value: { source, allowSignatureMatch, removeUnplayable } };
}

/**
 * Parse `{ changes: [...] }` for an upgrade commit. Every change must be valid
 * (a malformed one fails the request rather than being dropped, since a
 * half-applied plan would surprise the user).
 */
function parseUpgradeCommitInput(body: unknown): Parsed<UpgradeChange[]> {
  if (!isRecord(body) || !Array.isArray(body["changes"])) {
    return { ok: false, error: "changes must be an array" };
  }
  const changes: UpgradeChange[] = [];
  for (const [index, item] of body["changes"].entries()) {
    const change = parseUpgradeChange(item);
    if (change === undefined) {
      return { ok: false, error: `changes[${index}] is not a valid change` };
    }
    changes.push(change);
  }
  if (changes.length === 0) {
    return { ok: false, error: "at least one change is required" };
  }
  return { ok: true, value: changes };
}

function parseUpgradeChange(item: unknown): UpgradeChange | undefined {
  if (!isRecord(item) || !isPositiveInteger(item["trackId"])) {
    return undefined;
  }
  const location = parseTrackLocation(item["location"]);
  if (location === undefined) {
    return undefined;
  }
  const trackId = item["trackId"];
  if (item["action"] === "remove") {
    return { action: "remove", location, trackId };
  }
  if (item["action"] === "replace" && isPositiveInteger(item["newTrackId"])) {
    if (item["newTrackId"] === trackId) {
      return undefined;
    }
    return { action: "replace", location, trackId, newTrackId: item["newTrackId"] };
  }
  return undefined;
}

function parseTrackLocation(value: unknown): TrackLocation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["type"] === "favourites") {
    return { type: "favourites" };
  }
  if (
    value["type"] === "playlist" &&
    isPositiveInteger(value["playlistId"]) &&
    isPositiveInteger(value["playlistTrackId"])
  ) {
    return {
      type: "playlist",
      playlistId: value["playlistId"],
      playlistTrackId: value["playlistTrackId"],
    };
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

interface ExportInput {
  source: ExportSource | { type: "all-playlists" };
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

function parseExportSource(value: unknown): Parsed<ExportInput["source"]> {
  if (!isRecord(value)) {
    return { ok: false, error: "source is required" };
  }
  switch (value["type"]) {
    case "favourite-tracks":
    case "favourite-albums":
    case "favourite-artists":
    case "account":
    case "all-playlists":
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
          "source.type must be favourite-tracks, favourite-albums, favourite-artists, playlist, all-playlists or account",
      };
  }
}

interface ImportResolveInput {
  format: ImportFormat;
  content: string;
  kind: CollectionKind;
}

function parseImportResolveInput(body: unknown): Parsed<ImportResolveInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (!isImportFormat(body["format"])) {
    return { ok: false, error: `format must be one of: ${IMPORT_FORMATS.join(", ")}` };
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

function isImportFormat(value: unknown): value is ImportFormat {
  return typeof value === "string" && (IMPORT_FORMATS as readonly string[]).includes(value);
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

/**
 * Combine playlists (phase one): fetch the chosen sources and return the
 * reviewable plan. The view saves the ticked tracks through `/api/commit`.
 */
async function combineResolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseCombineInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { sources, seed, ...options } = input.value;
  const plan = await resolveCombine(deps.service, sources, {
    ...options,
    random: seededRandom(seed),
  });
  return { status: 200, body: plan };
}

interface CombineInput {
  sources: CombineSource[];
  mode: CombineMode;
  order: CombineOrder;
  keep: CombineKeep;
  matchSongs: boolean;
  /** Seed for a shuffle; random when absent. */
  seed: number;
}

/**
 * Parse `{ sources: [{ type: "favourites" } | { type: "playlist", playlistId }],
 * mode?, order?, keep?, matchSongs?, seed? }`.
 */
function parseCombineInput(body: unknown): Parsed<CombineInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (!Array.isArray(body["sources"])) {
    return { ok: false, error: "sources must be an array" };
  }
  const sources: CombineSource[] = [];
  for (const raw of body["sources"]) {
    if (isRecord(raw) && raw["type"] === "favourites") {
      sources.push({ type: "favourites" });
    } else if (
      isRecord(raw) &&
      raw["type"] === "playlist" &&
      Number.isSafeInteger(raw["playlistId"]) &&
      (raw["playlistId"] as number) > 0
    ) {
      sources.push({ type: "playlist", playlistId: raw["playlistId"] as number });
    } else {
      return {
        ok: false,
        error: "each source must be { type: 'favourites' } or { type: 'playlist', playlistId }",
      };
    }
  }
  const problem = sourcesProblem(sources);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  const choice = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): Parsed<T> => {
    const value = body[key] ?? fallback;
    return (allowed as readonly unknown[]).includes(value)
      ? { ok: true, value: value as T }
      : { ok: false, error: `${key} must be one of: ${allowed.join(", ")}` };
  };
  const mode = choice("mode", COMBINE_MODES, "merge");
  if (!mode.ok) return mode;
  const order = choice("order", COMBINE_ORDERS, "sequential");
  if (!order.ok) return order;
  const keep = choice("keep", COMBINE_KEEPS, "highest-quality");
  if (!keep.ok) return keep;
  const matchSongs = body["matchSongs"] ?? true;
  if (typeof matchSongs !== "boolean") {
    return { ok: false, error: "matchSongs must be a boolean" };
  }
  const seed = body["seed"] ?? Math.floor(Math.random() * 2 ** 32);
  if (!Number.isSafeInteger(seed)) {
    return { ok: false, error: "seed must be an integer" };
  }
  return {
    ok: true,
    value: {
      sources,
      mode: mode.value,
      order: order.value,
      keep: keep.value,
      matchSongs,
      seed: seed as number,
    },
  };
}

/**
 * Library stats for a source (`{ source: { type: "favourites" | "everything" }
 * | { type: "playlist", playlistId } }`). Each decade and top-artist bucket
 * carries its track ids, which the view saves through `/api/commit`.
 */
async function libraryStats(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const source = isRecord(body) ? body["source"] : undefined;
  let parsed: StatsSource;
  if (isRecord(source) && (source["type"] === "favourites" || source["type"] === "everything")) {
    parsed = { type: source["type"] };
  } else if (
    isRecord(source) &&
    source["type"] === "playlist" &&
    Number.isSafeInteger(source["playlistId"]) &&
    (source["playlistId"] as number) > 0
  ) {
    parsed = { type: "playlist", playlistId: source["playlistId"] as number };
  } else {
    return {
      status: 400,
      body: { error: "source must be favourites, everything, or a playlist with a playlistId" },
    };
  }
  const library = await collectLibrary(deps.service, parsed);
  return { status: 200, body: computeStats(library) };
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

// ---------------------------------------------------------------------------
// Word play: playlists made out of song titles.

/** The longest word-play text accepted, in characters. */
const MAX_WORD_PLAY_TEXT = 1000;

/**
 * Build a word-play plan. Input the feature rejects (an empty or overlong
 * sentence, an acrostic without letters) is a 400; Qobuz failures stay 502.
 */
async function wordPlayResolve(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseWordPlayInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  try {
    const plan = await resolveWordPlay(deps.service, input.value.request, {
      match: input.value.match,
      filter: input.value.filter,
    });
    return { status: 200, body: plan };
  } catch (error) {
    if (error instanceof QobuzError) {
      throw error;
    }
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "invalid request" },
    };
  }
}

/** Write the chosen songs, in order, to a new or existing playlist. */
async function wordPlayCommit(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseCommitInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const result = await commitWordPlay(deps.service, {
    target: input.value.target,
    trackIds: input.value.trackIds,
  });
  return { status: 200, body: result };
}

// --- Playlist from albums: an artist's discography -------------------------

/**
 * Resolve an artist's discography into the same album groups as
 * `/api/resolve-albums`, so the album view's review flow takes over unchanged.
 * Body: `{ artist: string, include?: ReleaseType[], oneVersion?: boolean,
 * filter? }`.
 */
async function resolveDiscographyRoute(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  if (!isRecord(body)) {
    return { status: 400, body: { error: "expected a JSON object" } };
  }
  const artist = typeof body["artist"] === "string" ? body["artist"].trim() : "";
  if (artist.length === 0) {
    return { status: 400, body: { error: "an artist name is required" } };
  }
  const include = parseReleaseTypes(body["include"], ["album"]);
  if (!include.ok) {
    return { status: 400, body: { error: include.error } };
  }
  const oneVersion = body["oneVersion"] ?? true;
  if (typeof oneVersion !== "boolean") {
    return { status: 400, body: { error: "oneVersion must be a boolean" } };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return { status: 400, body: { error: filter.error } };
  }
  const result = await resolveDiscography(deps.service, {
    artist,
    include: include.value,
    oneVersion,
    filter: filter.value,
  });
  return { status: 200, body: result };
}

interface WordPlayInput {
  request: WordPlayRequest;
  match: MatchOptions;
  filter: TrackFilter;
}

/**
 * Parse `{ mode, text?, count?, split?, maxSpan?, source?, match?, filter? }`:
 * `text` for every mode but `a-to-z`; `count` for contains/exact; `split` and
 * `maxSpan` for sentence; `source` (`{ type: "favourites" }` or
 * `{ type: "playlist", playlistId }`) for acrostic and a-to-z; `match` holds
 * optional booleans overriding {@link DEFAULT_MATCH_OPTIONS}.
 */
function parseWordPlayInput(body: unknown): Parsed<WordPlayInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const mode = body["mode"];
  if (typeof mode !== "string" || !(WORD_PLAY_MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: `mode must be one of: ${WORD_PLAY_MODES.join(", ")}` };
  }
  const match = parseMatchOptions(body["match"]);
  if (!match.ok) {
    return match;
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return filter;
  }
  const request = parseWordPlayRequest(mode as WordPlayMode, body);
  if (!request.ok) {
    return request;
  }
  return {
    ok: true,
    value: { request: request.value, match: match.value, filter: filter.value },
  };
}

function parseWordPlayRequest(
  mode: WordPlayMode,
  body: Record<string, unknown>,
): Parsed<WordPlayRequest> {
  if (mode === "a-to-z") {
    const source = parseWordPlaySource(body["source"]);
    return source.ok ? { ok: true, value: { mode, source: source.value } } : source;
  }
  const raw = body["text"];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    return {
      ok: false,
      error: mode === "sentence" ? "a sentence is required" : "a word is required",
    };
  }
  if (text.length > MAX_WORD_PLAY_TEXT) {
    return { ok: false, error: `text must be at most ${MAX_WORD_PLAY_TEXT} characters` };
  }
  if (mode === "contains" || mode === "exact") {
    const count = intField(body, "count", "count", WORD_PLAY_COUNT);
    return count.ok ? { ok: true, value: { mode, text, count: count.value } } : count;
  }
  if (mode === "sentence") {
    const split = body["split"] ?? "fewest";
    if (typeof split !== "string" || !(SPLIT_OBJECTIVES as readonly string[]).includes(split)) {
      return { ok: false, error: `split must be one of: ${SPLIT_OBJECTIVES.join(", ")}` };
    }
    const maxSpan = intField(body, "maxSpan", "maxSpan", WORD_PLAY_MAX_SPAN);
    if (!maxSpan.ok) {
      return maxSpan;
    }
    return {
      ok: true,
      value: { mode, text, split: split as SplitObjective, maxSpan: maxSpan.value },
    };
  }
  const source = parseWordPlaySource(body["source"]);
  return source.ok ? { ok: true, value: { mode, text, source: source.value } } : source;
}

function parseWordPlaySource(value: unknown): Parsed<WordPlaySource> {
  if (isRecord(value) && value["type"] === "favourites") {
    return { ok: true, value: { type: "favourites" } };
  }
  if (isRecord(value) && value["type"] === "playlist") {
    const id = value["playlistId"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, error: "source.playlistId must be a playlist id" };
    }
    return { ok: true, value: { type: "playlist", playlistId: id } };
  }
  return { ok: false, error: "source.type must be favourites or playlist" };
}

function parseMatchOptions(value: unknown): Parsed<MatchOptions> {
  if (value === undefined) {
    return { ok: true, value: { ...DEFAULT_MATCH_OPTIONS } };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "match must be an object" };
  }
  const options: MatchOptions = { ...DEFAULT_MATCH_OPTIONS };
  for (const key of Object.keys(DEFAULT_MATCH_OPTIONS) as (keyof MatchOptions)[]) {
    const raw = value[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "boolean") {
      return { ok: false, error: `match.${key} must be a boolean` };
    }
    options[key] = raw;
  }
  return { ok: true, value: options };
}

/** Parse an optional, non-empty list of release types, defaulting when absent. */
function parseReleaseTypes(
  raw: unknown,
  fallback: readonly ReleaseType[],
): Parsed<ReleaseType[]> {
  if (raw === undefined) {
    return { ok: true, value: [...fallback] };
  }
  const known = RELEASE_TYPES as readonly unknown[];
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((type) => known.includes(type))) {
    return {
      ok: false,
      error: `include must be a non-empty array of: ${RELEASE_TYPES.join(", ")}`,
    };
  }
  return { ok: true, value: [...new Set(raw as ReleaseType[])] };
}

// --- New releases ------------------------------------------------------------

/** The most releases one commit takes. */
const MAX_COMMIT_RELEASES = 500;

/**
 * Find recent releases of the user's artists, without writing anything.
 * Body: `{ source: { type: "favourites" } | { type: "playlist", playlistId },
 * since?: "YYYY-MM-DD", include?: ReleaseType[], filter? }`.
 */
async function newReleases(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  if (!isRecord(body)) {
    return { status: 400, body: { error: "expected a JSON object" } };
  }
  const source = parseArtistSource(body["source"]);
  if (!source.ok) {
    return { status: 400, body: { error: source.error } };
  }
  const since = body["since"];
  if (since !== undefined && (typeof since !== "string" || !isIsoDate(since))) {
    return { status: 400, body: { error: "since must be a date as YYYY-MM-DD" } };
  }
  const include = parseReleaseTypes(body["include"], DEFAULT_NEW_RELEASE_INCLUDE);
  if (!include.ok) {
    return { status: 400, body: { error: include.error } };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return { status: 400, body: { error: filter.error } };
  }
  const plan = await findNewReleases(deps.service, {
    source: source.value,
    include: include.value,
    filter: filter.value,
    ...(since !== undefined && { since }),
  });
  return { status: 200, body: plan };
}

/**
 * Put chosen releases in a new playlist or the favourite albums.
 * Body: `{ albumIds: string[], target: { type: "playlist", name, isPublic? } |
 * { type: "favourite-albums" }, filter? }`.
 */
async function commitNewReleasesRoute(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  if (!isRecord(body)) {
    return { status: 400, body: { error: "expected a JSON object" } };
  }
  const raw = body["albumIds"];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return { status: 400, body: { error: "albumIds must be a non-empty array of album ids" } };
  }
  if (raw.length > MAX_COMMIT_RELEASES) {
    return {
      status: 400,
      body: { error: `at most ${MAX_COMMIT_RELEASES} releases per request` },
    };
  }
  const target = parseNewReleasesTarget(body["target"]);
  if (!target.ok) {
    return { status: 400, body: { error: target.error } };
  }
  const filter = parseFilterInput(body["filter"]);
  if (!filter.ok) {
    return { status: 400, body: { error: filter.error } };
  }
  const result = await commitNewReleases(deps.service, {
    albumIds: raw as string[],
    target: target.value,
    filter: filter.value,
  });
  return { status: 200, body: result };
}

function parseArtistSource(value: unknown): Parsed<ArtistSource> {
  if (!isRecord(value)) {
    return { ok: false, error: "source is required" };
  }
  if (value["type"] === "favourites") {
    return { ok: true, value: { type: "favourites" } };
  }
  if (value["type"] === "playlist") {
    const playlistId = value["playlistId"];
    if (typeof playlistId !== "number" || !Number.isInteger(playlistId) || playlistId <= 0) {
      return { ok: false, error: "source.playlistId must be a playlist id" };
    }
    return { ok: true, value: { type: "playlist", playlistId } };
  }
  return { ok: false, error: "source.type must be favourites or playlist" };
}

function parseNewReleasesTarget(value: unknown): Parsed<NewReleasesTarget> {
  if (!isRecord(value)) {
    return { ok: false, error: "target is required" };
  }
  if (value["type"] === "favourite-albums") {
    return { ok: true, value: { type: "favourite-albums" } };
  }
  if (value["type"] === "playlist") {
    const name = typeof value["name"] === "string" ? value["name"].trim() : "";
    if (name.length === 0) {
      return { ok: false, error: "a playlist name is required" };
    }
    const isPublic = value["isPublic"] ?? false;
    if (typeof isPublic !== "boolean") {
      return { ok: false, error: "target.isPublic must be a boolean" };
    }
    return { ok: true, value: { type: "playlist", name, isPublic } };
  }
  return { ok: false, error: "target.type must be playlist or favourite-albums" };
}
