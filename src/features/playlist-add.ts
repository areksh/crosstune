/**
 * Adding tracks to a playlist and knowing that they arrived.
 *
 * Two things about Qobuz (checked live, November 2026) make a plain add unsafe
 * to build on: a track id repeated within one request is added once, and a
 * track it cannot play is dropped without an error. So adds that something
 * depends on are confirmed by reading the playlist back.
 */

import type { PlaylistId, TrackId } from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import type { Destination } from "./playlist-draft.js";

/** Adds tracks; QobuzClient satisfies it. */
export interface AddClient {
  addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void>;
}

/** Adds tracks, new playlists included, and reads them back. */
export interface ConfirmedAddClient extends AddClient {
  createPlaylist(
    name: string,
    options?: { description?: string; isPublic?: boolean },
  ): Promise<Playlist>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

/**
 * Add tracks in order, repeats included, in as few requests as possible with
 * no track id twice in one.
 */
export async function addInOrder(
  client: AddClient,
  playlistId: PlaylistId,
  trackIds: readonly TrackId[],
): Promise<void> {
  let request: TrackId[] = [];
  let sent = new Set<TrackId>();
  for (const id of trackIds) {
    if (sent.has(id)) {
      await client.addTracksToPlaylist(playlistId, request);
      request = [];
      sent = new Set();
    }
    request.push(id);
    sent.add(id);
  }
  await client.addTracksToPlaylist(playlistId, request);
}

/** The `wanted` ids not in `got`, counting repeats. */
export function missingFrom(wanted: readonly TrackId[], got: readonly TrackId[]): TrackId[] {
  const left = new Map<TrackId, number>();
  got.forEach((id) => left.set(id, (left.get(id) ?? 0) + 1));
  return wanted.filter((id) => {
    const n = left.get(id) ?? 0;
    left.set(id, n - 1);
    return n <= 0;
  });
}

/** What became of tracks added to a destination. */
export interface ConfirmedAdd {
  playlistId: PlaylistId;
  name: string;
  /** Whether the playlist was made for this. */
  created: boolean;
  /** Track ids that arrived. */
  added: TrackId[];
  /** Track ids that were there already (and not added again). */
  already: TrackId[];
  /** Track ids that did not arrive: Qobuz no longer offers them. */
  missing: TrackId[];
}

/**
 * Add tracks to a destination, each once and not if it is there already, and
 * read it back to see what arrived. `onCreated` hears of a new playlist as soon
 * as it is made, in case adding to it fails.
 */
export async function addConfirmed(
  client: ConfirmedAddClient,
  destination: Destination,
  trackIds: readonly TrackId[],
  onCreated: (playlistId: PlaylistId) => void = () => {},
): Promise<ConfirmedAdd> {
  const wanted = [...new Set(trackIds)];
  let playlistId: PlaylistId;
  let before = new Set<TrackId>();
  if (destination.type === "new") {
    playlistId = (await client.createPlaylist(destination.name, { isPublic: destination.isPublic })).id;
    onCreated(playlistId);
  } else {
    playlistId = destination.playlistId;
    before = new Set((await client.getPlaylistTracks(playlistId)).map((track) => track.id));
  }
  const already = wanted.filter((id) => before.has(id));
  const toAdd = wanted.filter((id) => !before.has(id));
  let after = before;
  if (toAdd.length > 0) {
    await client.addTracksToPlaylist(playlistId, toAdd);
    after = new Set((await client.getPlaylistTracks(playlistId)).map((track) => track.id));
  }
  return {
    playlistId,
    name: destination.name,
    created: destination.type === "new",
    added: toAdd.filter((id) => after.has(id)),
    already,
    missing: toAdd.filter((id) => !after.has(id)),
  };
}
