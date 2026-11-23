/**
 * The "follow / archive" source: another playlist's tracks, in its order --
 * or, archiving, every track it ever had (first seen first), so tracks that
 * leave it upstream stay here.
 */

import type { PlaylistId } from "../../services/ids.js";
import type { Track } from "../../services/model.js";
import { capList, CHECKED_CAP, type FollowSource, type SourceState } from "../model.js";
import type { DesiredTrack } from "../reconcile.js";
import { message, type SourceResult } from "./common.js";

/** The most tracks an archive remembers. */
export const ARCHIVE_CAP = CHECKED_CAP * 2;

export async function resolveFollow(
  client: { getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> },
  def: FollowSource,
  ctx: { state: SourceState },
): Promise<SourceResult> {
  const source = `playlist:${def.playlistId}`;
  const previous = ctx.state.seen ?? [];
  let tracks: Track[];
  try {
    tracks = await client.getPlaylistTracks(def.playlistId);
  } catch (error) {
    const note = `Could not read playlist ${def.playlistId} (${message(error)}).`;
    return {
      tracks: def.keepRemoved ? previous.map((trackId) => ({ trackId, source })) : [],
      complete: false,
      notes: [note],
      state: def.keepRemoved ? { seen: previous } : {},
    };
  }
  const durations = new Map(tracks.map((track) => [track.id, track.duration]));
  const order = [...new Set(tracks.map((track) => track.id))];
  const ids = def.keepRemoved ? capList([...new Set([...previous, ...order])], ARCHIVE_CAP) : order;
  const desired: DesiredTrack[] = ids.map((trackId) => {
    const duration = durations.get(trackId);
    return { trackId, source, ...(duration !== undefined && { durationSeconds: duration }) };
  });
  return { tracks: desired, complete: true, notes: [], state: def.keepRemoved ? { seen: ids } : {} };
}
