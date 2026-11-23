/**
 * Links: playlists on several services kept the same (ADR-0013).
 *
 * A link remembers how its copies last matched -- ids only, besides the name --
 * and a sync works out from that what each copy's changes were. Two-way means
 * that a song removed from one copy is removed from the others, so everything
 * that could be mistaken for a removal is told apart first.
 */

import type { PlaylistId, ServiceName, TrackId } from "../services/ids.js";

/** Why a song is not on a copy. Only `not-found` is looked for again. */
export type Gap =
  /** The service does not have it. */
  | "not-found"
  /** The service no longer offers it. */
  | "withdrawn"
  /** Its match there is another song of the list already. */
  | "same-as";

export interface SyncSong {
  /** Its track on each copy that has it. */
  ids: Partial<Record<ServiceName, TrackId>>;
  gaps?: Partial<Record<ServiceName, Gap>>;
  /** For a `same-as` gap: the track it is the same as there. */
  sameAs?: Partial<Record<ServiceName, TrackId>>;
  isrc?: string;
}

/** How the copies last matched. */
export interface SyncBase {
  name: string;
  songs: SyncSong[];
}

/** What a sync was about to write to one copy. */
export interface PendingCopy {
  before: TrackId[];
  after: TrackId[];
}

/** Written before the first write, removed after the last. */
export interface PendingSync {
  base: SyncBase;
  copies: Partial<Record<ServiceName, PendingCopy>>;
}

export type Conflict =
  | { kind: "removed-and-changed"; song: SongRef; removedOn: ServiceName; changedOn: ServiceName; change: "moved" | "duplicated" }
  | { kind: "reordered"; services: ServiceName[] }
  | { kind: "renamed"; names: { service: ServiceName; name: string }[] }
  | { kind: "gone"; service: ServiceName }
  | { kind: "not-editable"; service: ServiceName }
  | { kind: "many-removed"; service: ServiceName; removed: number; of: number }
  | { kind: "interrupted"; service: ServiceName }
  /** The first sync of a link whose copies differ. */
  | { kind: "first-link" };

/** A song a sync needs an answer about; the rest is synced. */
export type Question =
  | { kind: "removed-or-withdrawn"; key: string; song: SongRef; service: ServiceName }
  | { kind: "which-was-removed"; key: string; songs: SongRef[]; service: ServiceName }
  | { kind: "match"; key: string; song: SongRef; on: ServiceName; options: SongRef[]; reason?: string }
  /** Taking out one copy of a repeated song would re-add the others (Spotify). */
  | { kind: "repeated"; key: string; song: SongRef; service: ServiceName };

export interface SongRef {
  title: string;
  artist?: string;
  id: TrackId;
}

/** Answers to {@link Question}s, by key. */
export type Answers = Readonly<Record<string, "removed" | "withdrawn" | "keep">>;

export interface LinkState {
  base?: SyncBase;
  pending?: PendingSync;
  conflicts: Conflict[];
  questions: Question[];
  answers: Record<string, "removed" | "withdrawn" | "keep">;
  lastSyncAt?: string;
  /** When songs a service did not have were last looked for again. */
  gapsCheckedAt?: string;
  paused?: { since: string; reason: "undone" | "account-forgotten" };
}

export type LinkCopies = Partial<Record<ServiceName, PlaylistId>>;

export function emptyLinkState(): LinkState {
  return { conflicts: [], questions: [], answers: {} };
}

/** A copy that lost this much at once is a conflict. */
export const MANY_REMOVED = { songs: 10, share: 0.25 } as const;
