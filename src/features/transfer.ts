/**
 * Copying songs to another service: find them there (phase one, writing
 * nothing), then write what was found and what the user decided (phase two).
 */

import type { PlaylistId, ServiceName, TrackId } from "../services/ids.js";
import { checkAllOn } from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import { countGrades, matchTracks, type MatchClient, type MatchGrade, type MatchMemory, type SongMatch } from "./match.js";
import { addInOrder, missingFrom } from "./playlist-add.js";

export interface TransferPlan {
  to: ServiceName;
  matches: SongMatch[];
  counts: Record<MatchGrade, number>;
}

export async function resolveTransfer(
  client: MatchClient,
  tracks: readonly Track[],
  matches: MatchMemory,
): Promise<TransferPlan> {
  const found = await matchTracks(client, tracks, matches);
  return { to: client.name, matches: found, counts: countGrades(found) };
}

/** One song of a transfer, as reviewed. */
export interface Pick {
  source: TrackId;
  /** What to write; null leaves it out. */
  track: TrackId | null;
  /** The user chose it (or chose to leave it out): remembered. */
  decided: boolean;
}

export type TransferDestination =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: PlaylistId }
  | { type: "favourites" };

export interface TransferClient {
  readonly name: ServiceName;
  createPlaylist(name: string, options?: { isPublic?: boolean }): Promise<Playlist>;
  addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
  addFavoriteTracks(trackIds: readonly TrackId[]): Promise<void>;
  getFavoriteTracks(): Promise<Track[]>;
}

export interface TransferResult {
  playlistId?: PlaylistId;
  /** The new playlist's name. */
  name?: string;
  added: number;
  /** Songs the user left out, or that were not found. */
  leftOut: number;
  /** Songs the service took but did not add. */
  missing: TrackId[];
}

/** @throws {ServiceError} kind `bad-id` for a song of another service, before anything is written. */
export async function commitTransfer(
  client: TransferClient,
  destination: TransferDestination,
  picks: readonly Pick[],
  matches: MatchMemory,
): Promise<TransferResult> {
  const wanted = picks.flatMap((pick) => pick.track ?? []);
  checkAllOn(client, wanted);
  if (wanted.length === 0) {
    throw new Error("There are no songs to copy.");
  }
  // Kept first: a write that fails must not make the user decide again.
  for (const pick of picks) {
    if (pick.decided) {
      matches.remember(pick.source, client.name, pick.track);
    }
  }
  const leftOut = picks.length - wanted.length;
  if (destination.type === "favourites") {
    // Only what is new: re-adding a favourite re-dates it, and undoing would remove it.
    const known = new Set((await client.getFavoriteTracks()).map((track) => track.id));
    const added = [...new Set(wanted)].filter((id) => !known.has(id));
    await client.addFavoriteTracks(added);
    return { added: added.length, leftOut, missing: [] };
  }
  const created =
    destination.type === "new"
      ? await client.createPlaylist(destination.name, { isPublic: destination.isPublic })
      : undefined;
  const playlistId = created?.id ?? (destination as { playlistId: PlaylistId }).playlistId;
  const before =
    created === undefined ? (await client.getPlaylistTracks(playlistId)).map((track) => track.id) : [];
  await addInOrder(client, playlistId, wanted);
  const after = (await client.getPlaylistTracks(playlistId)).map((track) => track.id);
  const missing = missingFrom([...before, ...wanted], after);
  return {
    playlistId,
    ...(created !== undefined && { name: created.name }),
    added: wanted.length - missing.length,
    leftOut,
    missing,
  };
}
