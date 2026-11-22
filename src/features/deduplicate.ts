/**
 * Duplicate detection for Qobuz tracks.
 *
 * Two tracks are treated as duplicates when they share an ISRC (the same
 * recording) or a normalised artist+title signature (catching remasters and
 * textual variants that ISRC misses -- remasters often get a fresh ISRC).
 * Grouping is transitive: an ISRC link and a signature link chain together.
 *
 * Normalisation deliberately removes only edition *noise* (Remaster, Deluxe,
 * Anniversary, ...) and keeps qualifiers that mark genuinely different
 * recordings (Live, Acoustic, Remix, Extended), so those stay separate.
 *
 * The matching is pure (no network) so it can be tuned against fixtures before
 * spending any live API calls; the few helpers that read or write Qobuz (the
 * all-playlists scan, release-date enrichment, removal across playlists) take
 * an injected client or callback.
 */

import type { Playlist, Track } from "../qobuz/index.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";

/** The fields duplicate detection and keep-strategies need from a track. */
export interface DedupTrack {
  id: number;
  title: string;
  /** Variant label ("Live", "2011 Remaster"), when there is one. */
  version?: string;
  artist: string;
  isrc?: string;
  album?: string;
  albumId?: string;
  playlistTrackId?: number;
  bitDepth?: number;
  samplingRate?: number;
  hires?: boolean;
  releaseDate?: string;
  /** Album cover URL, for the web UI's optional artwork. */
  image?: string;
}

/** Edition markers that do not distinguish a recording; removed during normalisation. */
const NOISE_WORDS = new Set([
  "remaster",
  "remastered",
  "deluxe",
  "anniversary",
  "reissue",
  "bonus",
  "mono",
  "stereo",
  "remasterise",
  "remasterised",
]);

/**
 * Words that are only noise in the presence of a noise marker (e.g. "Remastered
 * Version", "Deluxe Edition"), but meaningful on their own ("Extended Version").
 */
const CONTEXTUAL_WORDS = new Set(["version", "edition"]);

/**
 * Normalise a piece of text (a title or an artist name) for comparison.
 *
 * Lowercases, folds accents, drops bracketing, removes edition noise (and any
 * year or contextual word attached to it), strips remaining punctuation, and
 * collapses whitespace. Letters and digits of every script are kept; text that
 * is all punctuation ("!!!") becomes empty.
 */
export function normalise(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip Latin combining diacritical marks
    .normalize("NFC") // recompose what other scripts need (kana, Hangul)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " "); // punctuation/brackets -> space

  const tokens = folded.split(/\s+/).filter((t) => t.length > 0);
  const noiseFound = tokens.some((t) => NOISE_WORDS.has(t));

  const kept = tokens.filter((token) => {
    if (NOISE_WORDS.has(token)) {
      return false;
    }
    if (noiseFound && CONTEXTUAL_WORDS.has(token)) {
      return false;
    }
    // Drop a year only when it sits alongside removed edition noise.
    if (noiseFound && /^(19|20)\d{2}$/.test(token)) {
      return false;
    }
    return true;
  });

  return kept.join(" ");
}

/** Version labels that name the ordinary recording, so do not set a copy apart. */
const PLAIN_VERSIONS = new Set(["album version", "lp version", "original album version"]);

/** A title with its version label, as the copies of one song share it. */
function titleWithVersion(track: DedupTrack): string {
  return track.version === undefined || PLAIN_VERSIONS.has(normalise(track.version))
    ? track.title
    : `${track.title} (${track.version})`;
}

/** A track's title as shown: with its version label. */
export function displayTitle(track: DedupTrack): string {
  return track.version === undefined ? track.title : `${track.title} (${track.version})`;
}

/**
 * The normalised artist+title signature used to match textual duplicates. The
 * version label counts as part of the title: edition noise in it ("2011
 * Remaster") is ignored as elsewhere, but a live take, a remix or an acoustic
 * version is another song (see {@link findOtherVersions}). A side that is nothing but punctuation ("!!!") or noise ("Remastered") is
 * compared as written, so that such titles are not all the same song.
 */
export function trackSignature(track: DedupTrack): string {
  return `${comparable(track.artist)}\u0000${comparable(titleWithVersion(track))}`;
}

function comparable(text: string): string {
  const normalised = normalise(text);
  return normalised.length > 0 ? normalised : text.trim().toLowerCase();
}

/**
 * Group tracks into sets of duplicates.
 *
 * Returns only groups of two or more tracks, ordered by the first appearance of
 * each group; within a group, tracks keep their input order.
 */
export function findDuplicateGroups(tracks: readonly DedupTrack[]): DedupTrack[][] {
  const parent = tracks.map((_, i) => i);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    // Path compression.
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node]!;
      parent[node] = root;
      node = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  };

  // Link each track to the first track seen with the same ISRC and the same
  // signature.
  const firstByKey = new Map<string, number>();
  const linkOn = (key: string | undefined, index: number): void => {
    if (key === undefined || key.length === 0) {
      return;
    }
    const seen = firstByKey.get(key);
    if (seen === undefined) {
      firstByKey.set(key, index);
    } else {
      union(seen, index);
    }
  };

  tracks.forEach((track, index) => {
    linkOn(track.isrc === undefined ? undefined : `isrc:${track.isrc}`, index);
    linkOn(`sig:${trackSignature(track)}`, index);
  });

  // Collect members by root, preserving input order.
  const groupsByRoot = new Map<number, DedupTrack[]>();
  tracks.forEach((track, index) => {
    const root = find(index);
    const members = groupsByRoot.get(root);
    if (members === undefined) {
      groupsByRoot.set(root, [track]);
    } else {
      members.push(track);
    }
  });

  return [...groupsByRoot.values()].filter((group) => group.length > 1);
}

/**
 * Songs held in several *versions*: the same artist and title, but a different
 * version label ("Live", "Acoustic", a remix) and not known to be the same
 * recording. These are not duplicates -- nothing removes them unless the user
 * picks them -- but they look alike in a list, so the tools point them out.
 *
 * Each group lists every copy of the song given, duplicates included, in order;
 * groups are ordered by first appearance.
 */
export function findOtherVersions(tracks: readonly DedupTrack[]): DedupTrack[][] {
  // Which duplicate group each track is in: copies of one recording do not
  // make a second version.
  const recording = new Map<DedupTrack, DedupTrack>();
  for (const group of findDuplicateGroups(tracks)) {
    group.forEach((track) => recording.set(track, group[0]!));
  }
  const byTitle = new Map<string, DedupTrack[]>();
  for (const track of tracks) {
    if (track.artist.trim().length === 0) {
      continue;
    }
    const key = `${comparable(track.artist)}\u0000${comparable(track.title)}`;
    const members = byTitle.get(key);
    if (members === undefined) {
      byTitle.set(key, [track]);
    } else {
      members.push(track);
    }
  }
  return [...byTitle.values()].filter(
    (group) => new Set(group.map((track) => recording.get(track) ?? track)).size > 1,
  );
}

/** Map a Qobuz track to the dedup shape (missing artist becomes empty). */
export function toDedupTrack(track: Track): DedupTrack {
  return {
    id: track.id,
    title: track.title,
    ...(track.version !== undefined && { version: track.version }),
    artist: track.artist ?? "",
    ...(track.isrc !== undefined && { isrc: track.isrc }),
    ...(track.album !== undefined && { album: track.album }),
    ...(track.albumId !== undefined && { albumId: track.albumId }),
    ...(track.playlistTrackId !== undefined && {
      playlistTrackId: track.playlistTrackId,
    }),
    ...(track.bitDepth !== undefined && { bitDepth: track.bitDepth }),
    ...(track.samplingRate !== undefined && { samplingRate: track.samplingRate }),
    ...(track.hires !== undefined && { hires: track.hires }),
    ...(track.releaseDate !== undefined && { releaseDate: track.releaseDate }),
    ...(track.image !== undefined && { image: track.image }),
  };
}

/** Find duplicate groups among Qobuz tracks. */
export function deduplicateTracks(tracks: readonly Track[]): DedupTrack[][] {
  return findDuplicateGroups(tracks.map(toDedupTrack));
}

/** A strategy for choosing which track in a duplicate group to keep. */
export type KeepStrategy =
  | "first-added"
  | "last-added"
  | "highest-quality"
  | "oldest"
  | "newest";

/** All keep strategies, for CLI validation and help. */
export const KEEP_STRATEGIES: readonly KeepStrategy[] = [
  "first-added",
  "last-added",
  "highest-quality",
  "oldest",
  "newest",
];

/**
 * Keep strategies applied in order: each later strategy only breaks the ties
 * left by the earlier ones (e.g. highest quality, then the oldest of the
 * equally good copies). A single strategy is a chain of one.
 */
export type KeepChain = readonly KeepStrategy[];

function chainOf(strategy: KeepStrategy | KeepChain): KeepChain {
  return typeof strategy === "string" ? [strategy] : strategy;
}

/** Whether a strategy (or any in a chain) needs release dates, so callers can enrich beforehand. */
export function strategyNeedsReleaseDates(strategy: KeepStrategy | KeepChain): boolean {
  return chainOf(strategy).some((s) => s === "oldest" || s === "newest");
}

/**
 * A resolved duplicate group: its members plus which one is kept.
 *
 * This is the plan the deduplicator produces and a removal step (later) will
 * consume. A UI can edit `keepId` between the two -- letting the user override
 * the automatic choice -- without re-running detection.
 */
export interface ResolvedGroup {
  tracks: DedupTrack[];
  keepId: number;
}

/**
 * Choose the id of the track to keep from a group, per the given strategy or
 * chain of strategies (later ones break the earlier ones' ties). Ties left at
 * the end keep the earlier member, so the result is stable and predictable.
 *
 * @throws {Error} if the group or the chain is empty.
 */
export function selectKeeper(
  group: readonly DedupTrack[],
  strategy: KeepStrategy | KeepChain,
): number {
  if (group.length === 0) {
    throw new Error("Cannot select a keeper from an empty group");
  }
  const chain = chainOf(strategy);
  if (chain.length === 0) {
    throw new Error("At least one keep strategy is required");
  }
  // Groups preserve fetch order, so a member's index is when it was added.
  const members = group.map((track, index) => ({ track, index }));
  const compare = (a: Member, b: Member): number => {
    for (const step of chain) {
      const result = compareBy(step, a, b);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  };
  let best = members[0]!;
  for (const member of members.slice(1)) {
    if (compare(member, best) > 0) {
      best = member;
    }
  }
  return best.track.id;
}

interface Member {
  track: DedupTrack;
  index: number;
}

/** Positive when `a` is preferred over `b` under one strategy; 0 on a tie. */
function compareBy(strategy: KeepStrategy, a: Member, b: Member): number {
  switch (strategy) {
    case "first-added":
      return b.index - a.index;
    case "last-added":
      return a.index - b.index;
    case "highest-quality":
      return compareQuality(a.track, b.track);
    case "oldest":
      return compareByDate(a.track, b.track, true);
    case "newest":
      return compareByDate(a.track, b.track, false);
  }
}

/** Higher bit depth wins, then higher sampling rate. */
function compareQuality(a: DedupTrack, b: DedupTrack): number {
  return (
    (a.bitDepth ?? 0) - (b.bitDepth ?? 0) ||
    (a.samplingRate ?? 0) - (b.samplingRate ?? 0)
  );
}

/**
 * Compare two tracks by release date. A track with a known date is always
 * preferred over one without; `wantOldest` selects the earlier or later date.
 */
function compareByDate(a: DedupTrack, b: DedupTrack, wantOldest: boolean): number {
  const da = a.releaseDate;
  const db = b.releaseDate;
  if (da === undefined && db === undefined) return 0;
  if (da === undefined) return -1;
  if (db === undefined) return 1;
  if (da === db) return 0;
  const aIsEarlier = da < db;
  return wantOldest ? (aIsEarlier ? 1 : -1) : aIsEarlier ? -1 : 1;
}

/**
 * Fill in missing release dates by fetching each album once via `fetchDate`.
 * Used before an oldest/newest selection when the track list did not carry
 * dates inline. Returns new groups; inputs are not mutated.
 */
export async function enrichReleaseDates(
  groups: readonly DedupTrack[][],
  fetchDate: (albumId: string) => Promise<string | undefined>,
): Promise<DedupTrack[][]> {
  const cache = new Map<string, string | undefined>();
  const result: DedupTrack[][] = [];
  for (const group of groups) {
    const enrichedGroup: DedupTrack[] = [];
    for (const track of group) {
      if (track.releaseDate !== undefined || track.albumId === undefined) {
        enrichedGroup.push(track);
        continue;
      }
      if (!cache.has(track.albumId)) {
        cache.set(track.albumId, await fetchDate(track.albumId));
      }
      const date = cache.get(track.albumId);
      enrichedGroup.push(date === undefined ? track : { ...track, releaseDate: date });
    }
    result.push(enrichedGroup);
  }
  return result;
}

/** Resolve duplicate groups into a keep/remove plan using the given strategy (or chain). */
export function resolveDuplicateGroups(
  groups: readonly DedupTrack[][],
  strategy: KeepStrategy | KeepChain,
): ResolvedGroup[] {
  return groups.map((tracks) => ({
    tracks: [...tracks],
    keepId: selectKeeper(tracks, strategy),
  }));
}

/**
 * The index of the kept entry in a resolved group: the first one carrying
 * `keepId`. A playlist can hold the very same track more than once, so later
 * entries with that id are duplicates to remove, not further keepers.
 */
export function keptIndex(group: ResolvedGroup): number {
  return group.tracks.findIndex((track) => track.id === group.keepId);
}

/** The tracks in a resolved group that would be removed (all but the kept entry). */
export function removedTracks(group: ResolvedGroup): DedupTrack[] {
  const kept = keptIndex(group);
  return group.tracks.filter((_, index) => index !== kept);
}

/** All tracks across a plan that would be removed. */
export function tracksToRemove(
  resolved: readonly ResolvedGroup[],
): DedupTrack[] {
  return resolved.flatMap(removedTracks);
}

/** Render a keep/remove plan as a human-readable report. */
export function formatResolutionReport(
  resolved: readonly ResolvedGroup[],
): string {
  if (resolved.length === 0) {
    return "No duplicates found.";
  }
  const removeTotal = resolved.reduce(
    (sum, group) => sum + group.tracks.length - 1,
    0,
  );
  const lines: string[] = [
    `Found ${resolved.length} duplicate group${resolved.length === 1 ? "" : "s"}; keeping 1 each, ${removeTotal} to remove:`,
    "",
  ];
  resolved.forEach((group, index) => {
    const keep = keptIndex(group);
    const kept = group.tracks[keep];
    const heading = kept === undefined ? "" : `${kept.artist} - ${displayTitle(kept)}`;
    lines.push(`${index + 1}. ${heading}`);
    for (const [position, track] of group.tracks.entries()) {
      const marker = position === keep ? "keep" : "drop";
      const album = track.album === undefined ? "" : `  [${track.album}]`;
      lines.push(`   ${marker}  id ${track.id}: ${displayTitle(track)}${album}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/** The songs held in several versions, for the CLI; empty text when there are none. */
export function formatOtherVersions(groups: readonly DedupTrack[][]): string {
  if (groups.length === 0) {
    return "";
  }
  const lines = [
    `${groups.length} song${groups.length === 1 ? " is" : "s are"} here in different versions (live, acoustic, remix...). These are kept:`,
  ];
  for (const group of groups) {
    lines.push(`   ${group[0]!.artist} - ${group[0]!.title}: ${group.map((t) => t.version ?? "no label").join(", ")}`);
  }
  return lines.join("\n");
}

/** A playlist as the across-playlists scan reports it. */
export interface PlaylistRef {
  id: number;
  name: string;
}

/** A playlist with its tracks (in playlist order). */
export interface PlaylistTracks {
  playlist: PlaylistRef;
  tracks: readonly Track[];
}

/** A song (same matching as duplicates) saved in more than one playlist. */
export interface SongAcrossPlaylists {
  /** A representative copy: the first found. */
  track: DedupTrack;
  /** Each playlist holding the song, in scan order, with its copies there. */
  playlists: Array<{ playlist: PlaylistRef; tracks: DedupTrack[] }>;
}

/**
 * Find songs that appear in more than one of the given playlists, matching as
 * {@link findDuplicateGroups} does (ISRC or normalised artist+title, chained).
 * Songs repeated only within one playlist are not listed here; they are that
 * playlist's own duplicates.
 */
export function findSongsAcrossPlaylists(
  lists: readonly PlaylistTracks[],
): SongAcrossPlaylists[] {
  const all: DedupTrack[] = [];
  const owner = new Map<DedupTrack, number>();
  lists.forEach((list, listIndex) => {
    for (const track of list.tracks) {
      const entry = toDedupTrack(track);
      all.push(entry);
      owner.set(entry, listIndex);
    }
  });

  const songs: SongAcrossPlaylists[] = [];
  for (const group of findDuplicateGroups(all)) {
    const byList = new Map<number, DedupTrack[]>();
    for (const track of group) {
      const listIndex = owner.get(track)!;
      const copies = byList.get(listIndex);
      if (copies === undefined) {
        byList.set(listIndex, [track]);
      } else {
        copies.push(track);
      }
    }
    if (byList.size < 2) {
      continue;
    }
    songs.push({
      track: group[0]!,
      playlists: [...byList.entries()]
        .sort(([a], [b]) => a - b)
        .map(([listIndex, tracks]) => ({ playlist: lists[listIndex]!.playlist, tracks })),
    });
  }
  return songs;
}

/** The client surface the all-playlists scan needs; QobuzClient satisfies it. */
export interface AllPlaylistsClient {
  getUserPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  getAlbumReleaseDate(albumId: string): Promise<string | undefined>;
}

/** The result of scanning every playlist. */
export interface AllPlaylistsScan {
  /** Duplicates, and songs in several versions, within each playlist that has some. */
  within: Array<{ playlist: PlaylistRef; groups: ResolvedGroup[]; versions: DedupTrack[][] }>;
  /** Songs saved in more than one playlist; nothing is removed by default. */
  across: SongAcrossPlaylists[];
  /** How many playlists were scanned. */
  playlistCount: number;
}

/**
 * Scan all the user's playlists: each playlist's own duplicates, resolved by
 * `keep` exactly as a single-playlist scan is, plus the songs saved in more
 * than one playlist. Playlists are read through a small pool.
 */
export async function scanAllPlaylists(
  client: AllPlaylistsClient,
  keep: KeepStrategy | KeepChain,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<AllPlaylistsScan> {
  const playlists = await client.getUserPlaylists();
  const lists: PlaylistTracks[] = await mapWithConcurrency(
    playlists,
    concurrency,
    async (playlist) => ({
      playlist: { id: playlist.id, name: playlist.name },
      tracks: await client.getPlaylistTracks(playlist.id),
    }),
  );

  const found = lists
    .map((list) => ({
      playlist: list.playlist,
      groups: deduplicateTracks(list.tracks),
      versions: findOtherVersions(list.tracks.map(toDedupTrack)),
    }))
    .filter((entry) => entry.groups.length > 0 || entry.versions.length > 0);
  // Enrich every playlist's groups in one pass, so each album is looked up once.
  let allGroups = found.flatMap((entry) => entry.groups);
  if (strategyNeedsReleaseDates(keep) && allGroups.length > 0) {
    allGroups = await enrichReleaseDates(allGroups, (albumId) =>
      client.getAlbumReleaseDate(albumId),
    );
  }
  let offset = 0;
  const within = found.map((entry) => {
    const groups = allGroups.slice(offset, offset + entry.groups.length);
    offset += entry.groups.length;
    return { playlist: entry.playlist, groups: resolveDuplicateGroups(groups, keep), versions: entry.versions };
  });

  return { within, across: findSongsAcrossPlaylists(lists), playlistCount: lists.length };
}

/** An entry to remove from a playlist. */
export interface PlaylistEntry {
  playlistId: number;
  playlistTrackId: number;
}

/**
 * Group playlist entries by playlist (in first-seen order), each entry once,
 * for removal with one request per playlist.
 */
export function entriesByPlaylist(entries: readonly PlaylistEntry[]): Map<number, number[]> {
  const byPlaylist = new Map<number, number[]>();
  for (const { playlistId, playlistTrackId } of entries) {
    const ids = byPlaylist.get(playlistId) ?? [];
    if (!ids.includes(playlistTrackId)) {
      ids.push(playlistTrackId);
    }
    byPlaylist.set(playlistId, ids);
  }
  return byPlaylist;
}

/**
 * Remove entries from several playlists, one playlist at a time. Returns how
 * many entries were removed.
 */
export async function removePlaylistEntries(
  client: {
    removeTracksFromPlaylist(playlistId: number, playlistTrackIds: readonly number[]): Promise<void>;
  },
  entries: readonly PlaylistEntry[],
): Promise<number> {
  let removed = 0;
  for (const [playlistId, ids] of entriesByPlaylist(entries)) {
    await client.removeTracksFromPlaylist(playlistId, ids);
    removed += ids.length;
  }
  return removed;
}

/** Render the songs found in more than one playlist (for the CLI). */
export function formatAcrossPlaylistsReport(songs: readonly SongAcrossPlaylists[]): string {
  if (songs.length === 0) {
    return "No song is in more than one playlist.";
  }
  const lines = [
    `${songs.length} song${songs.length === 1 ? " is" : "s are"} in more than one playlist:`,
    "",
  ];
  songs.forEach((song, index) => {
    lines.push(`${index + 1}. ${song.track.artist} - ${displayTitle(song.track)}`);
    for (const { playlist, tracks } of song.playlists) {
      const copies = tracks.length > 1 ? ` (${tracks.length} copies)` : "";
      lines.push(`   in "${playlist.name}" (id ${playlist.id})${copies}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
