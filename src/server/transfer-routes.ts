/**
 * Copying songs to another service: `/api/transfer/resolve` finds them there
 * (writing nothing) and `/api/transfer/commit` writes what the user reviewed,
 * as one history entry, under the write lock like every other playlist write.
 */

import type { MatchMemory } from "../features/match.js";
import { commitTransfer, resolveTransfer, type Pick, type TransferDestination } from "../features/transfer.js";
import type { ServiceHub } from "../services/hub.js";
import { checkAllOn, isServiceName, readId, type PlaylistId, type ServiceName, type TrackId } from "../services/ids.js";
import type { Track } from "../services/model.js";
import type { ApiRequest, ApiResponse } from "./router.js";

export const TRANSFER_PREFIX = "/api/transfer/";
export const TRANSFER_COMMIT = `${TRANSFER_PREFIX}commit`;

/** The most songs taken at once. */
const MAX_SONGS = 5000;

export interface TransferDeps {
  hub: ServiceHub;
  matches: MatchMemory;
}

const bad = (error: string): ApiResponse => ({ status: 400, body: { error } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function transferRoutes(req: ApiRequest, deps: TransferDeps): Promise<ApiResponse> {
  const body = isRecord(req.body) ? req.body : {};
  const to = body["to"];
  if (req.method !== "POST") {
    return { status: 404, body: { error: "not found" } };
  }
  if (!isServiceName(to)) {
    return bad("to must name a music service");
  }
  if (req.path === `${TRANSFER_PREFIX}resolve`) {
    return resolve(body, to, deps);
  }
  return req.path === TRANSFER_COMMIT ? commit(body, to, deps) : { status: 404, body: { error: "not found" } };
}

async function resolve(body: Record<string, unknown>, to: ServiceName, deps: TransferDeps): Promise<ApiResponse> {
  const target = deps.hub.service(to);
  let tracks: Track[];
  if (body["playlistId"] !== undefined) {
    const playlistId = readId<PlaylistId>(body["playlistId"]);
    if (playlistId === undefined) {
      return bad("playlistId must be an id");
    }
    tracks = await deps.hub.getPlaylistTracks(playlistId);
  } else {
    const read = Array.isArray(body["tracks"]) ? body["tracks"].map(readTrack) : [];
    if (read.length === 0 || read.length > MAX_SONGS || !read.every((track) => track !== undefined)) {
      return bad(`tracks must be a list of 1 to ${MAX_SONGS} songs`);
    }
    tracks = read;
  }
  return { status: 200, body: await resolveTransfer(target, tracks, deps.matches) };
}

/** A song as the page holds it: what matching needs. */
function readTrack(value: unknown): Track | undefined {
  const id = isRecord(value) ? readId<TrackId>(value["id"]) : undefined;
  if (!isRecord(value) || id === undefined || typeof value["title"] !== "string") {
    return undefined;
  }
  const text = (key: string): string | undefined => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const [version, artist, isrc, album] = [text("version"), text("artist"), text("isrc"), text("album")];
  const { duration, other } = value;
  return {
    id,
    title: value["title"],
    ...(version !== undefined && { version }),
    ...(artist !== undefined && { artist }),
    ...(isrc !== undefined && { isrc }),
    ...(album !== undefined && { album }),
    ...(typeof duration === "number" && { duration }),
    ...((other === "episode" || other === "video" || other === "local") && { other }),
  };
}

async function commit(body: Record<string, unknown>, to: ServiceName, deps: TransferDeps): Promise<ApiResponse> {
  const picks = Array.isArray(body["picks"]) ? body["picks"].map(readPick) : [];
  if (picks.length === 0 || picks.length > MAX_SONGS || !picks.every((pick) => pick !== undefined)) {
    return bad(`picks must be a list of 1 to ${MAX_SONGS} songs`);
  }
  const destination = readDestination(body["destination"]);
  if (destination === undefined) {
    return bad("a destination is required: a new playlist, one of yours, or the favourites");
  }
  if (!picks.some((pick) => pick.track !== null)) {
    return bad("There are no songs to copy.");
  }
  const target = deps.hub.service(to);
  if (destination.type === "existing") {
    checkAllOn(target, [destination.playlistId]);
    const playlist = await target.getPlaylist(destination.playlistId);
    const mine = playlist.ownerId === undefined || playlist.ownerId === target.account()?.id;
    if (!mine && playlist.isCollaborative !== true) {
      return { status: 403, body: { error: `"${playlist.name}" belongs to someone else, so it cannot be changed.` } };
    }
  }
  return { status: 200, body: await commitTransfer(target, destination, picks, deps.matches) };
}

function readPick(value: unknown): Pick | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = readId<TrackId>(value["source"]);
  const track = value["track"] === null ? null : readId<TrackId>(value["track"]);
  return source === undefined || track === undefined ? undefined : { source, track, decided: value["decided"] === true };
}

function readDestination(value: unknown): TransferDestination | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value["type"]) {
    case "new": {
      const name = typeof value["name"] === "string" ? value["name"].trim() : "";
      return name.length === 0 ? undefined : { type: "new", name, isPublic: value["isPublic"] === true };
    }
    case "existing": {
      const playlistId = readId<PlaylistId>(value["playlistId"]);
      return playlistId === undefined ? undefined : { type: "existing", playlistId };
    }
    case "favourites":
      return { type: "favourites" };
    default:
      return undefined;
  }
}
