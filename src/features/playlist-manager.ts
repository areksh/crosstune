/**
 * The playlist manager's dealings with Qobuz: saving a draft
 * (./playlist-draft.ts), copying and duplicating, and removing artists' songs
 * from several playlists.
 *
 * {@link savePlaylist} writes in an order that cannot lose a song -- to other
 * playlists first, then removing here, then reordering -- and stops at the
 * first failure. Before that it reads the playlist again: one that changed
 * since the draft was opened is not written to. A song moved elsewhere is
 * removed here only once it was seen there, because Qobuz drops tracks it
 * cannot play without an error.
 */

import { shortId, type EntryId, type PlaylistId, type TrackId } from "../services/ids.js";
import type { Artist, Playlist, Track } from "../services/model.js";
import {
  linkLines,
  matchArtists,
  parseArtistTerms,
  type ParsedArtistTerms,
} from "./artist-match.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { lookUpArtist, type ArtistLookupClient } from "./playlist-from-artists.js";
import { addConfirmed, addInOrder, missingFrom, type ConfirmedAdd, type ConfirmedAddClient } from "./playlist-add.js";
import { driftOf, type Destination, type DraftChanges, type Drift, type Entry } from "./playlist-draft.js";
import { mergeOrder, planOrder } from "./playlist-order.js";

/** Reads playlists; QobuzClient satisfies it. */
export interface PlaylistReadClient {
  getPlaylist(playlistId: PlaylistId): Promise<Playlist>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

/** What saving needs; QobuzClient satisfies it. */
export interface SaveClient extends ConfirmedAddClient {
  removeTracksFromPlaylist(playlistId: PlaylistId, playlistTrackIds: readonly EntryId[]): Promise<void>;
  movePlaylistTracks?(
    playlistId: PlaylistId,
    playlistTrackIds: readonly EntryId[],
    insertBefore: number,
  ): Promise<void>;
}

/** A playlist's entries: its tracks that carry an entry id (all of them, in practice). */
export function toEntries(tracks: readonly Track[]): Entry[] {
  return tracks.filter((track): track is Entry => track.playlistTrackId !== undefined);
}

/** A playlist's details and entries, for the editor. */
export async function openPlaylist(
  client: PlaylistReadClient,
  playlistId: PlaylistId,
): Promise<{ playlist: Playlist; entries: Entry[] }> {
  const [playlist, tracks] = await Promise.all([
    client.getPlaylist(playlistId),
    client.getPlaylistTracks(playlistId),
  ]);
  return { playlist, entries: toEntries(tracks) };
}

/** The managed playlist job behind a playlist. */
export interface ManagedInfo {
  jobName: string;
  /** How it treats edits made by hand; `tidy`: it only tidies up. */
  mode: "respect" | "mirror" | "tidy";
}

/** A playlist as the manager lists it. */
export interface ManagerPlaylist extends Playlist {
  /** Whether it is the user's own (others can only be read). */
  owned: boolean;
  managed?: ManagedInfo;
  /** Names of the managed playlists whose source reads it. */
  readBy: string[];
}

// ---- Saving -----------------------------------------------------------------

export interface SaveRequest extends DraftChanges {
  playlistId: PlaylistId;
}

/** Why a save cannot be what a draft produced, or undefined. */
export function saveProblem(request: SaveRequest): string | undefined {
  const base = new Set(request.base);
  if (base.size !== request.base.length) {
    return "the playlist's entries must each be listed once";
  }
  const parts = [...request.order, ...request.remove, ...request.moves.flatMap((move) => move.entries)];
  if (parts.length !== base.size || new Set(parts).size !== parts.length || parts.some((id) => !base.has(id))) {
    return "every entry must be kept, removed or moved, exactly once";
  }
  if (
    request.moves.some(
      ({ destination }) => destination.type === "existing" && destination.playlistId === request.playlistId,
    )
  ) {
    return "songs cannot be moved to the playlist they are in";
  }
  return undefined;
}

/** A track a report names. */
export interface TrackRef {
  trackId: TrackId;
  title: string;
  artist?: string;
}

export type SaveOutcome =
  | { status: "changed"; drift: Drift }
  | {
      status: "saved";
      /** Entries taken out of the playlist, moved ones included. */
      removed: number;
      reordered: boolean;
      moved: ConfirmedAdd[];
      /** Playlists made for moves, even when a later step failed. */
      created: Array<{ destination: Destination; playlistId: PlaylistId }>;
      /** Songs to be moved that stay, as they did not arrive. */
      kept: TrackRef[];
      /** The step that failed (those after it were not done), and why. */
      failed?: { step: string; reason: string };
      /** After a failure: the playlist could not be read to see what was done. */
      unverified?: true;
    };

/**
 * Save a draft, unless the playlist changed since it was opened.
 *
 * @throws {Error} if {@link saveProblem} rejects the request, or the playlist
 *   cannot be read (nothing has been written then).
 */
export async function savePlaylist(client: SaveClient, request: SaveRequest): Promise<SaveOutcome> {
  const problem = saveProblem(request);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const { playlistId } = request;
  const tracks = new Map(
    toEntries(await client.getPlaylistTracks(playlistId)).map((entry) => [entry.playlistTrackId, entry]),
  );
  const fresh = [...tracks.keys()];
  if (fresh.length !== request.base.length || fresh.some((id, i) => id !== request.base[i])) {
    return { status: "changed", drift: driftOf(request.base, fresh) };
  }

  const outcome: Extract<SaveOutcome, { status: "saved" }> = {
    status: "saved",
    removed: 0,
    reordered: false,
    moved: [],
    created: [],
    kept: [],
  };
  const going = [...request.remove];
  let step = "";
  try {
    for (const { destination, entries } of request.moves) {
      step = `Add to ${destination.name}`;
      const { add, arrived } = await moveOut(client, destination, entries.map((id) => tracks.get(id)!), outcome.created);
      if (add !== undefined) {
        outcome.moved.push(add);
      }
      for (const id of entries) {
        const entry = tracks.get(id)!;
        if (arrived.has(entry.id)) {
          going.push(id);
        } else {
          outcome.kept.push({
            trackId: entry.id,
            title: entry.title,
            ...(entry.artist !== undefined && { artist: entry.artist }),
          });
        }
      }
    }

    step = "Remove songs";
    if (going.length > 0) {
      await client.removeTracksFromPlaylist(playlistId, going);
      outcome.removed = going.length;
    }

    step = "Reorder the playlist";
    const gone = new Set(going);
    const current = fresh.filter((id) => !gone.has(id));
    // Songs that stay after all keep their places.
    for (const move of planOrder(current, mergeOrder(current, request.order))) {
      if (client.movePlaylistTracks === undefined) {
        throw new Error("playlists cannot be reordered here");
      }
      await client.movePlaylistTracks(playlistId, move.playlistTrackIds, move.insertBefore);
      outcome.reordered = true;
    }
  } catch (error) {
    outcome.failed = { step, reason: messageOf(error) };
    // A bulk change may have gone through in part: look.
    try {
      const after = toEntries(await client.getPlaylistTracks(playlistId)).map((entry) => entry.playlistTrackId);
      const here = new Set(after);
      const left = fresh.filter((id) => here.has(id));
      const leftNow = after.filter((id) => tracks.has(id));
      outcome.removed = fresh.length - left.length;
      outcome.reordered = left.some((id, i) => id !== leftNow[i]);
    } catch {
      outcome.unverified = true;
    }
  }
  return outcome;
}

/** Add songs to where they are moved; those that can be taken out here have `arrived`. */
async function moveOut(
  client: SaveClient,
  destination: Destination,
  entries: readonly Entry[],
  created: Array<{ destination: Destination; playlistId: PlaylistId }>,
): Promise<{ add?: ConfirmedAdd; arrived: Set<TrackId> }> {
  // No playlist is made for songs that will not arrive.
  if (destination.type === "new" && entries.every((entry) => entry.streamable === false)) {
    return { arrived: new Set() };
  }
  const add = await addConfirmed(
    client,
    destination,
    entries.map((entry) => entry.id),
    (playlistId) => created.push({ destination, playlistId }),
  );
  return { add, arrived: new Set([...add.added, ...add.already]) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create a copy of a playlist, its repeated songs included.
 *
 * @throws if it cannot be read, or the copy not made or filled.
 */
export async function duplicatePlaylist(
  client: ConfirmedAddClient,
  playlistId: PlaylistId,
  options: { name: string; isPublic?: boolean; description?: string },
): Promise<{ playlist: Playlist; added: number; missing: number }> {
  const trackIds = (await client.getPlaylistTracks(playlistId)).map((track) => track.id);
  const playlist = await client.createPlaylist(options.name, {
    isPublic: options.isPublic ?? false,
    ...(options.description !== undefined && { description: options.description }),
  });
  if (trackIds.length === 0) {
    return { playlist, added: 0, missing: 0 };
  }
  await addInOrder(client, playlist.id, trackIds);
  const got = (await client.getPlaylistTracks(playlist.id)).map((track) => track.id);
  const missing = missingFrom(trackIds, got).length;
  return { playlist, added: trackIds.length - missing, missing };
}

// ---- Removing artists -------------------------------------------------------

/** Look up the lines that are Qobuz links (each once). */
export async function resolveArtistLinks(
  client: ArtistLookupClient,
  lines: readonly string[],
): Promise<Map<string, Artist | { problem: string }>> {
  const links = linkLines(lines);
  const found = await mapWithConcurrency(links, DEFAULT_CONCURRENCY, async (line) => {
    const match = await lookUpArtist(client, line);
    return "problem" in match ? { problem: match.problem } : match.artist;
  });
  return new Map(links.map((line, i) => [line, found[i]!]));
}

/** A playlist the removal looks in. */
export interface PlaylistRef {
  id: PlaylistId;
  name: string;
}

/** A song an artist in the list is on. */
export interface ArtistHit {
  entry: Entry;
  /** Whether they are its main artist, or only a guest. */
  as: "main" | "guest";
  /** The listed artists it matched. */
  names: string[];
}

export interface RemoveArtistsPlan {
  /** What each line matched, across the playlists. */
  artists: Array<{
    line: string;
    name: string;
    main: number;
    guest: number;
    suggestion?: { name: string; count: number };
  }>;
  problems: ParsedArtistTerms["problems"];
  /** Every playlist asked for, with its hits in order, or why it could not be read. */
  playlists: Array<{ playlist: PlaylistRef; trackCount: number; hits: ArtistHit[]; error?: string }>;
}

/** Find the listed artists' songs in playlists (nothing is written). */
export async function resolveRemoveArtists(
  client: ArtistLookupClient & { getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]> },
  playlists: readonly PlaylistRef[],
  lines: readonly string[],
): Promise<RemoveArtistsPlan> {
  const { terms, problems } = parseArtistTerms(lines, await resolveArtistLinks(client, lines));
  const read = await mapWithConcurrency(playlists, DEFAULT_CONCURRENCY, async (playlist) => {
    try {
      return { playlist, entries: toEntries(await client.getPlaylistTracks(playlist.id)) };
    } catch (error) {
      return { playlist, entries: [] as Entry[], error: messageOf(error) };
    }
  });
  const overall = matchArtists(
    read.flatMap((list) => list.entries),
    terms,
  );
  return {
    artists: overall.map(({ line, name, main, guest, suggestion }) => ({
      line,
      name,
      main: main.length,
      guest: guest.length,
      ...(suggestion !== undefined && { suggestion }),
    })),
    problems,
    playlists: read.map(({ playlist, entries, error }) => ({
      playlist,
      trackCount: entries.length,
      hits: hitsIn(entries, terms),
      ...(error !== undefined && { error }),
    })),
  };
}

function hitsIn(entries: readonly Entry[], terms: ParsedArtistTerms["terms"]): ArtistHit[] {
  const hits = new Map<number, ArtistHit>();
  for (const result of matchArtists(entries, terms)) {
    for (const as of ["main", "guest"] as const) {
      for (const index of result[as]) {
        const hit = hits.get(index) ?? { entry: entries[index]!, as, names: [] };
        hit.as = hit.as === "main" ? "main" : as;
        hit.names.push(result.name);
        hits.set(index, hit);
      }
    }
  }
  return [...hits.entries()].sort(([a], [b]) => a - b).map(([, hit]) => hit);
}

/** Entries to take out of one playlist. */
export interface PlaylistRemoval {
  playlistId: PlaylistId;
  entries: readonly EntryId[];
}

export interface RemovalReport {
  playlistId: PlaylistId;
  removed: number;
  error?: string;
}

/**
 * Remove entries from several playlists, those still there. A playlist that
 * fails is reported and the others carry on.
 */
export async function commitRemovals(
  client: {
    getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
    removeTracksFromPlaylist(playlistId: PlaylistId, playlistTrackIds: readonly EntryId[]): Promise<void>;
  },
  removals: readonly PlaylistRemoval[],
): Promise<RemovalReport[]> {
  const reports: RemovalReport[] = [];
  for (const { playlistId, entries } of removals) {
    const present = async (): Promise<EntryId[]> => {
      const here = new Set(toEntries(await client.getPlaylistTracks(playlistId)).map((e) => e.playlistTrackId));
      return entries.filter((id) => here.has(id));
    };
    let going: EntryId[] = [];
    try {
      going = await present();
      await client.removeTracksFromPlaylist(playlistId, going);
      reports.push({ playlistId, removed: going.length });
    } catch (error) {
      // Some of it may have gone through: look.
      const left = going.length === 0 ? [] : await present().catch(() => going);
      reports.push({ playlistId, removed: going.length - left.length, error: messageOf(error) });
    }
  }
  return reports;
}

/** The entries a plan would remove, per playlist that has some. */
export function removalsOf(plan: RemoveArtistsPlan, includeGuests: boolean): PlaylistRemoval[] {
  return plan.playlists
    .map(({ playlist, hits }) => ({
      playlistId: playlist.id,
      entries: hits.filter((hit) => includeGuests || hit.as === "main").map((hit) => hit.entry.playlistTrackId),
    }))
    .filter((removal) => removal.entries.length > 0);
}

/** A plan as text, for the CLI. */
export function formatRemoveArtists(plan: RemoveArtistsPlan, includeGuests: boolean): string {
  const lines: string[] = [];
  for (const { name, main, guest, suggestion } of plan.artists) {
    if (main + guest === 0) {
      const hint = suggestion === undefined ? "" : ` (did you mean ${suggestion.name}?)`;
      lines.push(`${name}: not in ${plan.playlists.length === 1 ? "this playlist" : "these playlists"}${hint}`);
    } else {
      const parts = [main > 0 ? songs(main) : "", guest > 0 ? `${guest} as a guest` : ""];
      lines.push(`${name}: ${parts.filter((part) => part !== "").join(", and ")}`);
    }
  }
  plan.problems.forEach(({ line, reason }) => lines.push(`${line}: ${reason}`));
  for (const { playlist, hits, error } of plan.playlists) {
    if (error !== undefined) {
      lines.push("", `"${playlist.name}" (id ${shortId(playlist.id)}): could not be read (${error})`);
      continue;
    }
    if (hits.length === 0) {
      continue;
    }
    lines.push("", `"${playlist.name}" (id ${shortId(playlist.id)}):`);
    for (const { entry, as } of hits) {
      const marker = as === "main" || includeGuests ? "drop" : "keep";
      const title = entry.version === undefined ? entry.title : `${entry.title} (${entry.version})`;
      lines.push(`   ${marker}  ${entry.artist ?? "?"} - ${title}${as === "guest" ? "  [guest]" : ""}`);
    }
  }
  return lines.join("\n");
}

function songs(count: number): string {
  return `${count} song${count === 1 ? "" : "s"}`;
}
