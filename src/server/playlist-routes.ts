/**
 * The playlist manager's routes, under `/api/manager/`.
 *
 * Reads (the list, opening a playlist, finding artists' songs) and writes
 * (saving a draft, copying, details, duplicating, deleting). Each write holds
 * the write lock, so it cannot interleave with a managed playlist's refresh or
 * another save, and is refused on playlists that are not the user's. The
 * router runs each write as one history entry (WRITE_ROUTES).
 */

import { managedKey, readKeys } from "../jobs/dependencies.js";
import { addConfirmed } from "../features/playlist-add.js";
import type { Destination } from "../features/playlist-draft.js";
import {
  commitRemovals,
  duplicatePlaylist,
  openPlaylist,
  resolveArtistLinks,
  resolveRemoveArtists,
  savePlaylist,
  saveProblem,
  type ManagedInfo,
  type ManagerPlaylist,
  type PlaylistRemoval,
  type SaveRequest,
} from "../features/playlist-manager.js";
import type { Playlist, Track } from "../qobuz/index.js";
import type { ApiDeps, ApiRequest, ApiResponse } from "./router.js";

export const MANAGER_PREFIX = "/api/manager/";

/** The write routes; the router gives each its history entry. */
export const MANAGER_WRITES: readonly string[] = [
  "save",
  "copy",
  "favourite",
  "update",
  "duplicate",
  "delete",
  "remove-artists/commit",
].map((name) => `${MANAGER_PREFIX}${name}`);

/** A request that cannot be carried out, with the status to answer. */
class RouteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (message: string): RouteError => new RouteError(400, message);

export const BUSY_MESSAGE =
  "A managed playlist is being refreshed, or another change is being saved. Try again in a moment.";

/** Answer a `/api/manager/` request. */
export async function playlistRoutes(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  try {
    if (MANAGER_WRITES.includes(req.path) && req.method === "POST") {
      return await withWriteLock(deps, () => write(req, deps));
    }
    return await read(req, deps);
  } catch (error) {
    if (error instanceof RouteError) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }
}

async function withWriteLock(deps: ApiDeps, fn: () => Promise<ApiResponse>): Promise<ApiResponse> {
  if (deps.acquireWriteLock === undefined) {
    return fn();
  }
  const lock = await deps.acquireWriteLock();
  if (lock === undefined) {
    throw new RouteError(409, BUSY_MESSAGE);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function read(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const route = `${req.method} ${req.path.slice(MANAGER_PREFIX.length)}`;
  const { service } = deps;
  switch (route) {
    case "GET playlists": {
      const playlists = await service.getUserPlaylists();
      const jobs = jobInfo(deps);
      return { status: 200, body: { playlists: playlists.map((playlist) => describe(playlist, deps, jobs)) } };
    }
    case "POST open": {
      const { playlist, entries } = await openPlaylist(service, playlistId(record(req.body)));
      return { status: 200, body: { playlist: describe(playlist, deps, jobInfo(deps)), entries } };
    }
    case "POST artist-links": {
      const links = await resolveArtistLinks(service, lines(record(req.body)));
      return {
        status: 200,
        body: {
          links: [...links].map(([line, found]) =>
            "problem" in found ? { line, problem: found.problem } : { line, artist: found },
          ),
        },
      };
    }
    case "POST compare": {
      const body = record(req.body);
      const tracks =
        body["favourites"] === true
          ? await service.getFavoriteTracks()
          : await service.getPlaylistTracks(playlistId(body));
      return { status: 200, body: { tracks: tracks.map(identityOf) } };
    }
    case "POST remove-artists/resolve": {
      const body = record(req.body);
      const ids = positiveIds(body["playlistIds"], "playlistIds");
      const names = new Map((await service.getUserPlaylists()).map((p) => [p.id, p.name]));
      const plan = await resolveRemoveArtists(
        service,
        [...new Set(ids)].map((id) => ({ id, name: names.get(id) ?? `playlist ${id}` })),
        lines(body),
      );
      return { status: 200, body: plan };
    }
    default:
      return { status: 404, body: { error: "not found" } };
  }
}

async function write(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const body = record(req.body);
  const { service } = deps;
  switch (req.path.slice(MANAGER_PREFIX.length)) {
    case "save": {
      const request = saveRequest(body);
      const problem = saveProblem(request);
      if (problem !== undefined) {
        throw bad(problem);
      }
      await ownPlaylist(deps, request.playlistId);
      const moves = [];
      for (const move of request.moves) {
        moves.push({ ...move, destination: await allowedDestination(deps, move.destination) });
      }
      return { status: 200, body: await savePlaylist(service, { ...request, moves }) };
    }
    case "copy": {
      const ids = positiveIds(body["trackIds"], "trackIds");
      const to = await allowedDestination(deps, destination(body["destination"]));
      return { status: 200, body: await addConfirmed(service, to, ids) };
    }
    case "favourite": {
      const ids = [...new Set(positiveIds(body["trackIds"], "trackIds"))];
      await service.addFavoriteTracks(ids);
      return { status: 200, body: { added: ids.length } };
    }
    case "update": {
      const id = playlistId(body);
      const changes: { name?: string; description?: string; isPublic?: boolean } = {};
      if (body["name"] !== undefined) {
        changes.name = playlistName(body["name"]);
      }
      if (body["description"] !== undefined) {
        if (typeof body["description"] !== "string") {
          throw bad("description must be text");
        }
        changes.description = body["description"];
      }
      if (body["isPublic"] !== undefined) {
        changes.isPublic = flag(body["isPublic"], "isPublic");
      }
      if (Object.keys(changes).length === 0) {
        throw bad("there is nothing to change");
      }
      await ownPlaylist(deps, id);
      const playlist = await service.updatePlaylist(id, changes);
      return { status: 200, body: { playlist: describe(playlist, deps, jobInfo(deps)) } };
    }
    case "duplicate": {
      const id = playlistId(body);
      const result = await duplicatePlaylist(service, id, {
        name: playlistName(body["name"]),
        isPublic: flag(body["isPublic"] ?? false, "isPublic"),
      });
      return { status: 200, body: result };
    }
    case "delete": {
      const id = playlistId(body);
      await ownPlaylist(deps, id);
      await service.deletePlaylist(id);
      return { status: 200, body: { deleted: id } };
    }
    default: {
      // remove-artists/commit
      const removals = parseRemovals(body["removals"]);
      const reports = [];
      for (const removal of removals) {
        try {
          await ownPlaylist(deps, removal.playlistId);
        } catch (error) {
          reports.push({
            playlistId: removal.playlistId,
            removed: 0,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        reports.push(...(await commitRemovals(service, [removal])));
      }
      return { status: 200, body: { reports } };
    }
  }
}

// ---- What is known of a playlist --------------------------------------------

interface JobInfo {
  managed: Map<string, ManagedInfo>;
  readBy: Map<string, string[]>;
}

function jobInfo(deps: ApiDeps): JobInfo {
  const info: JobInfo = { managed: new Map(), readBy: new Map() };
  let jobs: ReturnType<NonNullable<ApiDeps["jobs"]>["service"]["list"]>["jobs"] = [];
  try {
    jobs = deps.jobs?.service.list().jobs ?? [];
  } catch {
    // An unreadable jobs file is the Managed view's to report.
  }
  for (const { job, state } of jobs) {
    const key = managedKey(job, state);
    if (key !== undefined) {
      info.managed.set(key, { jobName: job.name, mode: job.source === undefined ? "tidy" : job.edits });
    }
    for (const read of readKeys(job)) {
      info.readBy.set(read, [...(info.readBy.get(read) ?? []), job.name]);
    }
  }
  return info;
}

function isOwned(playlist: Playlist, deps: ApiDeps): boolean {
  return deps.ownerId === undefined || playlist.ownerId === undefined || playlist.ownerId === deps.ownerId;
}

function describe(playlist: Playlist, deps: ApiDeps, jobs: JobInfo): ManagerPlaylist {
  const key = `p:${playlist.id}`;
  const managed = jobs.managed.get(key);
  return {
    ...playlist,
    owned: isOwned(playlist, deps),
    ...(managed !== undefined && { managed }),
    readBy: jobs.readBy.get(key) ?? [],
  };
}

async function ownPlaylist(deps: ApiDeps, id: number): Promise<Playlist> {
  const playlist = await deps.service.getPlaylist(id);
  if (!isOwned(playlist, deps)) {
    throw new RouteError(403, `"${playlist.name}" belongs to someone else, so it cannot be changed.`);
  }
  return playlist;
}

/** A destination songs may go to, under its real name. */
async function allowedDestination(deps: ApiDeps, to: Destination): Promise<Destination> {
  if (to.type === "new") {
    return to;
  }
  const playlist = await ownPlaylist(deps, to.playlistId);
  if (jobInfo(deps).managed.get(`p:${to.playlistId}`)?.mode === "mirror") {
    throw bad(`"${playlist.name}" is managed and kept exactly as its source says, so songs put there would be taken out again.`);
  }
  return { ...to, name: playlist.name };
}

/** What telling whether two tracks are the same song needs. */
function identityOf(track: Track): Pick<Track, "id" | "title" | "version" | "artist" | "isrc"> {
  const { id, title, version, artist, isrc } = track;
  return {
    id,
    title,
    ...(version !== undefined && { version }),
    ...(artist !== undefined && { artist }),
    ...(isrc !== undefined && { isrc }),
  };
}

// ---- Validation --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw bad("expected a JSON object");
  }
  return value;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function playlistId(body: Record<string, unknown>): number {
  const id = body["playlistId"];
  if (!isPositiveId(id)) {
    throw bad("a playlistId is required");
  }
  return id;
}

function idList(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || !value.every(isPositiveId)) {
    throw bad(`${what} must be a list of ids`);
  }
  return value;
}

function positiveIds(value: unknown, what: string): number[] {
  const ids = idList(value, what);
  if (ids.length === 0) {
    throw bad(`${what} must not be empty`);
  }
  return ids;
}

/** The most artist lines taken in one request. */
const MAX_LINES = 2000;

function lines(body: Record<string, unknown>): string[] {
  const value = body["lines"];
  if (!Array.isArray(value) || value.length > MAX_LINES || !value.every((line) => typeof line === "string")) {
    throw bad(`lines must be a list of at most ${MAX_LINES} artists`);
  }
  const kept = (value as string[]).map((line) => line.trim()).filter((line) => line.length > 0);
  if (kept.length === 0) {
    throw bad("at least one artist is required");
  }
  return kept;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw bad(`${what} must be a boolean`);
  }
  return value;
}

function playlistName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0) {
    throw bad("a playlist name is required");
  }
  return name;
}

function destination(value: unknown): Destination {
  if (isRecord(value)) {
    if (value["type"] === "new") {
      return {
        type: "new",
        name: playlistName(value["name"]),
        isPublic: flag(value["isPublic"] ?? false, "isPublic"),
      };
    }
    if (value["type"] === "existing") {
      return { type: "existing", playlistId: playlistId(value), name: "" };
    }
  }
  throw bad("a destination is required: a playlist of yours, or a new one");
}

function saveRequest(body: Record<string, unknown>): SaveRequest {
  const moves = body["moves"] ?? [];
  if (!Array.isArray(moves)) {
    throw bad("moves must be a list");
  }
  return {
    playlistId: playlistId(body),
    base: idList(body["base"], "base"),
    order: idList(body["order"], "order"),
    remove: idList(body["remove"] ?? [], "remove"),
    moves: moves.map((move) => {
      const item = record(move);
      return {
        destination: destination(item["destination"]),
        entries: positiveIds(item["entries"], "entries"),
      };
    }),
  };
}

function parseRemovals(value: unknown): PlaylistRemoval[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw bad("removals must not be empty");
  }
  return value.map((item) => {
    const removal = record(item);
    return { playlistId: playlistId(removal), entries: positiveIds(removal["entries"], "entries") };
  });
}
