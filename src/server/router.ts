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

import { QobuzError, type Artist, type Playlist, type Track } from "../qobuz/index.js";
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
import { authorise, type RequestHeaders } from "./security.js";

/** The Qobuz client capabilities the API needs; QobuzClient satisfies it. */
export interface QobuzApiService {
  searchArtists(query: string, limit?: number): Promise<Artist[]>;
  getArtistTopTracks(artistId: number, limit?: number): Promise<Track[]>;
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getFavoriteTracks(): Promise<Track[]>;
  getAlbumReleaseDate(albumId: string): Promise<string | undefined>;
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
  if (req.method === "POST" && req.path === "/api/deduplicate/scan") {
    return scan(req.body, deps);
  }
  if (req.method === "POST" && req.path === "/api/deduplicate/apply") {
    return apply(req.body, deps);
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
  });
  return { status: 200, body: result };
}

async function commit(body: unknown, deps: ApiDeps): Promise<ApiResponse> {
  const input = parseCommitInput(body);
  if (!input.ok) {
    return { status: 400, body: { error: input.error } };
  }
  const { target, trackIds } = input.value;
  if (target.type === "new") {
    const playlist = await createPlaylistWithTracks(deps.service, {
      name: target.name,
      trackIds,
      isPublic: target.isPublic,
      ...(target.description !== undefined && { description: target.description }),
    });
    return { status: 200, body: { playlist, added: trackIds, skipped: [] } };
  }
  const { added, skipped } = await addTracksToExistingPlaylist(deps.service, {
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

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface ResolveInput {
  artists: string[];
  tracksPerArtist: number;
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
  return { ok: true, value: { artists, tracksPerArtist } };
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

  const target = body["target"];
  if (!isRecord(target)) {
    return { ok: false, error: "target is required" };
  }
  if (target["type"] === "new") {
    const name = typeof target["name"] === "string" ? target["name"].trim() : "";
    if (name.length === 0) {
      return { ok: false, error: "a playlist name is required" };
    }
    const parsedTarget: CommitTarget = { type: "new", name };
    if (typeof target["isPublic"] === "boolean") {
      parsedTarget.isPublic = target["isPublic"];
    }
    if (typeof target["description"] === "string" && target["description"].length > 0) {
      parsedTarget.description = target["description"];
    }
    return { ok: true, value: { target: parsedTarget, trackIds } };
  }
  if (target["type"] === "existing") {
    if (typeof target["playlistId"] !== "number") {
      return { ok: false, error: "playlistId is required" };
    }
    return {
      ok: true,
      value: { target: { type: "existing", playlistId: target["playlistId"] }, trackIds },
    };
  }
  return { ok: false, error: "target.type must be 'new' or 'existing'" };
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

function isKeepStrategy(value: unknown): value is KeepStrategy {
  return (
    typeof value === "string" &&
    (KEEP_STRATEGIES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
