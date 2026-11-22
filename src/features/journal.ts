/**
 * Recording changes into the history.
 *
 * Two parts. A {@link Journal} groups operations into entries -- one per user
 * action: the CLI command or web commit wraps its work in {@link Journal.run},
 * and every operation recorded while it runs (even across awaits and
 * concurrent requests, via AsyncLocalStorage) lands in that entry, which is
 * written when the action ends, failed or not. An operation recorded outside
 * any run gets an entry of its own.
 *
 * {@link recordingClient} wraps the Qobuz client so that every mutating method
 * (see {@link MUTATING_METHODS}) records what it did -- no tool can forget.
 * It reads what reversing a change needs: a playlist's entries around an add
 * (to learn the new entries' ids and positions), before a removal (to keep each
 * removed track and its position) and before a move (to keep where its entries
 * were). A partial failure records what did
 * happen before the error is rethrown.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Playlist, Track } from "../qobuz/index.js";
import { applyMove } from "./playlist-order.js";
import {
  describeEntry,
  foldHistory,
  HISTORY_LIMITS,
  parseHistory,
  pruneRecords,
  serializeRecords,
  type FavouriteType,
  type HistoryEntry,
  type HistoryItem,
  type HistoryLimits,
  type HistoryRecord,
  type HistorySource,
  type Operation,
  type PlaylistDetails,
  type PlaylistEntryRecord,
} from "./history.js";

/** Where the history lives (a file in the CLI; memory in tests). */
export interface HistoryStore {
  /** The whole history text, or "" when there is none yet. */
  read(): string;
  append(text: string): void;
  /** Replace the whole history (compaction). */
  replace(text: string): void;
  /**
   * Run `fn` holding the history's lock, so a compaction cannot drop a record
   * another process appends meanwhile; undefined (without running `fn`) when
   * another process holds it. Optional: without it, compaction is unlocked.
   */
  exclusive?<T>(fn: () => T): T | undefined;
}

export interface JournalOptions {
  store: HistoryStore;
  source: HistorySource;
  now?: () => Date;
  newId?: () => string;
  limits?: HistoryLimits;
  /**
   * Called when the history cannot be written. The action itself is not
   * failed: its change was made either way.
   */
  onWriteError?: (error: unknown) => void;
}

/** What an action is called in the history. */
export interface EntryMeta {
  tool: string;
  /** Defaults to a label built from the operations. */
  label?: string;
  /** For an undo: the entry it reverses (the entry is written even if empty). */
  undoes?: string;
}

/** Per-action scratch the recorder keeps: playlist names and known contents. */
export interface RecordingScope {
  names: Map<number, string>;
  /** A playlist's entries as they are now, when known (saves a read). */
  snapshots: Map<number, Track[]>;
}

interface Draft extends RecordingScope {
  id: string;
  meta: EntryMeta;
  ops: Operation[];
}

export class Journal {
  readonly #store: HistoryStore;
  readonly #source: HistorySource;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #limits: HistoryLimits;
  readonly #onWriteError: (error: unknown) => void;
  readonly #open = new AsyncLocalStorage<Draft>();

  constructor(options: JournalOptions) {
    this.#store = options.store;
    this.#source = options.source;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID().slice(0, 8));
    this.#limits = options.limits ?? HISTORY_LIMITS;
    this.#onWriteError = options.onWriteError ?? (() => {});
  }

  /**
   * Run one user action as one history entry. The entry is written when `fn`
   * settles if it recorded anything (or is an undo), with the error noted when
   * `fn` failed; the result or error is passed through.
   */
  async run<T>(meta: EntryMeta, fn: (entry: { readonly id: string }) => Promise<T>): Promise<T> {
    const draft: Draft = { id: this.#newId(), meta, ops: [], names: new Map(), snapshots: new Map() };
    let failure: { error: unknown } | undefined;
    try {
      return await this.#open.run(draft, () => fn({ id: draft.id }));
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      if (draft.ops.length > 0 || meta.undoes !== undefined) {
        this.#write(draft, failure);
      }
    }
  }

  /** Record an operation into the open entry, or as an entry of its own. */
  record(op: Operation): void {
    const draft = this.#open.getStore();
    if (draft !== undefined) {
      draft.ops.push(op);
      return;
    }
    this.#write({ id: this.#newId(), meta: { tool: "other" }, ops: [op], names: new Map(), snapshots: new Map() });
  }

  /** The open action's scratch, or a throwaway one outside any action. */
  scope(): RecordingScope {
    return this.#open.getStore() ?? { names: new Map(), snapshots: new Map() };
  }

  /** Every entry, newest first, with undone ones marked. */
  items(): HistoryItem[] {
    return foldHistory(parseHistory(this.#store.read()));
  }

  /** Mark an entry undone (by the undo entry `by`). */
  markUndone(id: string, by: string): void {
    const now = this.#now();
    this.#append([{ type: "undone", id, by, at: now.toISOString() }], now);
  }

  #write(draft: Draft, failure?: { error: unknown }): void {
    const now = this.#now();
    const entry: HistoryEntry = {
      id: draft.id,
      at: now.toISOString(),
      tool: draft.meta.tool,
      source: this.#source,
      label: draft.meta.label ?? describeEntry(draft.meta.tool, draft.ops),
      ops: draft.ops,
    };
    if (draft.meta.undoes !== undefined) {
      entry.undoes = draft.meta.undoes;
    }
    if (failure !== undefined) {
      entry.error = failure.error instanceof Error ? failure.error.message : String(failure.error);
    }
    this.#append([{ type: "entry", ...entry }], now);
  }

  /** Append records, compacting the file instead when that drops old ones. */
  #append(records: HistoryRecord[], now: Date): void {
    try {
      const write = (): true => {
        const all = [...parseHistory(this.#store.read()), ...records];
        const kept = pruneRecords(all, now, this.#limits);
        if (kept.length < all.length) {
          this.#store.replace(serializeRecords(kept));
        } else {
          this.#store.append(serializeRecords(records));
        }
        return true;
      };
      // Under the lock, so a compaction elsewhere cannot drop this record;
      // if the lock stays busy, append anyway (and compact on a later write).
      const written = this.#store.exclusive === undefined ? write() : this.#store.exclusive(write);
      if (written !== true) {
        this.#store.append(serializeRecords(records));
      }
    } catch (error) {
      this.#onWriteError(error);
    }
  }
}

/**
 * The client methods that change the account; {@link recordingClient} records
 * each of them. Every QobuzClient method is classified in the tests, so a new
 * one cannot slip past the history.
 */
export const MUTATING_METHODS = [
  "createPlaylist",
  "deletePlaylist",
  "updatePlaylist",
  "addTracksToPlaylist",
  "removeTracksFromPlaylist",
  "movePlaylistTracks",
  "addFavoriteTracks",
  "addFavoriteAlbums",
  "addFavoriteArtists",
  "removeFavoriteTracks",
  "removeFavoriteAlbums",
  "removeFavoriteArtists",
] as const;

/** The reads the recorder needs from the client it wraps. */
export interface RecordableClient {
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
  /** Used to name playlists in labels; optional. */
  getPlaylist?(playlistId: number): Promise<Playlist>;
}

/** Ids per request when the recorder splits a bulk change (as the client does). */
const BATCH = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

type AnyMethod = (...args: never[]) => Promise<unknown>;

/**
 * Wrap a client so that every mutating method records what it changed into
 * `journal`. Everything else passes straight through to the client.
 */
export function recordingClient<T extends RecordableClient>(client: T, journal: Journal): T {
  const raw = client as unknown as Record<string, AnyMethod | undefined>;
  const call = <R>(name: string, ...args: unknown[]): Promise<R> =>
    (raw[name] as unknown as (...a: unknown[]) => Promise<R>).apply(client, args);

  const tryRead = async (playlistId: number): Promise<Track[] | undefined> => {
    try {
      return await client.getPlaylistTracks(playlistId);
    } catch {
      return undefined;
    }
  };

  const nameOf = async (scope: RecordingScope, playlistId: number): Promise<string | undefined> => {
    const known = scope.names.get(playlistId);
    if (known !== undefined || client.getPlaylist === undefined) {
      return known;
    }
    try {
      const { name } = await client.getPlaylist.call(client, playlistId);
      scope.names.set(playlistId, name);
      return name;
    } catch {
      return undefined;
    }
  };

  const named = async (scope: RecordingScope, playlistId: number): Promise<{ playlistName?: string }> => {
    const name = await nameOf(scope, playlistId);
    return name === undefined ? {} : { playlistName: name };
  };

  const favourites = (method: string, kind: Operation["kind"], type: FavouriteType) =>
    async (ids: ReadonlyArray<number | string>): Promise<void> => {
      // Batch by batch, so a failure records the batches that went through.
      for (const batch of chunk(ids, BATCH)) {
        await call(method, batch);
        journal.record({ kind, type, ids: [...batch] } as Operation);
      }
    };

  const wrappers: Record<string, AnyMethod> = {
    async createPlaylist(name: string, options?: { description?: string; isPublic?: boolean }) {
      const playlist = await call<Playlist>("createPlaylist", name, options);
      const scope = journal.scope();
      const actual = playlist.name.length > 0 ? playlist.name : name;
      scope.names.set(playlist.id, actual);
      scope.snapshots.set(playlist.id, []);
      journal.record({
        kind: "create-playlist",
        playlistId: playlist.id,
        name: actual,
        isPublic: options?.isPublic ?? false,
        ...(options?.description !== undefined && { description: options.description }),
      });
      return playlist;
    },

    async deletePlaylist(playlistId: number) {
      const scope = journal.scope();
      // Read first: a deletion that cannot be recorded is not made.
      const tracks = await client.getPlaylistTracks(playlistId);
      let details: Playlist | undefined;
      try {
        details = await client.getPlaylist?.call(client, playlistId);
      } catch {
        // Deleted all the same; undo then recreates it private.
      }
      const name = details?.name ?? scope.names.get(playlistId) ?? `playlist ${playlistId}`;
      await call("deletePlaylist", playlistId);
      scope.snapshots.delete(playlistId);
      journal.record({
        kind: "delete-playlist",
        playlistId,
        name,
        trackIds: tracks.map((t) => t.id),
        ...(details?.isPublic !== undefined && { isPublic: details.isPublic }),
        ...(details?.description !== undefined && { description: details.description }),
      });
    },

    async updatePlaylist(playlistId: number, changes: PlaylistDetails) {
      const scope = journal.scope();
      // Read first: a change that cannot be recorded is not made.
      const was = await client.getPlaylist?.call(client, playlistId);
      const updated = await call<Playlist>("updatePlaylist", playlistId, changes);
      const before: PlaylistDetails = {};
      if (was !== undefined) {
        if (changes.name !== undefined) {
          before.name = was.name;
        }
        if (changes.description !== undefined) {
          before.description = was.description ?? "";
        }
        if (changes.isPublic !== undefined && was.isPublic !== undefined) {
          before.isPublic = was.isPublic;
        }
      }
      if (changes.name !== undefined) {
        scope.names.set(playlistId, changes.name);
      }
      journal.record({
        kind: "update-playlist",
        playlistId,
        ...(was !== undefined && { playlistName: was.name }),
        before,
        after: { ...changes },
      });
      return updated;
    },

    async addTracksToPlaylist(playlistId: number, trackIds: readonly number[]) {
      if (trackIds.length === 0) {
        return call("addTracksToPlaylist", playlistId, trackIds);
      }
      const scope = journal.scope();
      const before = scope.snapshots.get(playlistId) ?? (await tryRead(playlistId));
      let failure: { error: unknown } | undefined;
      try {
        await call("addTracksToPlaylist", playlistId, trackIds);
      } catch (error) {
        failure = { error };
      }
      const after = await tryRead(playlistId);
      let entries: PlaylistEntryRecord[] = [];
      let unconfirmed: number[] | undefined;
      if (after === undefined) {
        scope.snapshots.delete(playlistId);
        unconfirmed = [...trackIds];
      } else {
        scope.snapshots.set(playlistId, after);
        if (before !== undefined) {
          const known = new Set(before.map((t) => t.playlistTrackId));
          entries = toEntries(after).filter((e) => !known.has(e.playlistTrackId));
        } else {
          // Not read before: the new entries are the playlist's last ones, if
          // they are exactly the tracks sent.
          const tail = toEntries(after).slice(-trackIds.length);
          if (failure === undefined && tail.length === trackIds.length && tail.every((e, i) => e.trackId === trackIds[i])) {
            entries = tail;
          } else {
            unconfirmed = [...trackIds];
          }
        }
      }
      if (entries.length > 0 || unconfirmed !== undefined) {
        journal.record({
          kind: "add-tracks",
          playlistId,
          ...(await named(scope, playlistId)),
          entries,
          ...(unconfirmed !== undefined && { unconfirmed }),
        });
      }
      if (failure !== undefined) {
        throw failure.error;
      }
    },

    async removeTracksFromPlaylist(playlistId: number, playlistTrackIds: readonly number[]) {
      if (playlistTrackIds.length === 0) {
        return call("removeTracksFromPlaylist", playlistId, playlistTrackIds);
      }
      const scope = journal.scope();
      let before = scope.snapshots.get(playlistId);
      if (before === undefined || playlistTrackIds.some((id) => !before!.some((t) => t.playlistTrackId === id))) {
        // Read first: a removal that cannot be recorded is not made.
        before = await client.getPlaylistTracks(playlistId);
      }
      let gone = new Set<number>();
      let failure: { error: unknown } | undefined;
      for (const batch of chunk(playlistTrackIds, BATCH)) {
        try {
          await call("removeTracksFromPlaylist", playlistId, batch);
          batch.forEach((id) => gone.add(id));
        } catch (error) {
          failure = { error };
          break;
        }
      }
      if (failure !== undefined) {
        // The failed batch may have gone through in part: look.
        const after = await tryRead(playlistId);
        if (after !== undefined) {
          const left = new Set(after.map((t) => t.playlistTrackId));
          gone = new Set(playlistTrackIds.filter((id) => !left.has(id)));
        }
      }
      const entries = toEntries(before).filter((e) => gone.has(e.playlistTrackId));
      scope.snapshots.set(
        playlistId,
        before.filter((t) => t.playlistTrackId === undefined || !gone.has(t.playlistTrackId)),
      );
      if (entries.length > 0) {
        journal.record({ kind: "remove-tracks", playlistId, ...(await named(scope, playlistId)), entries });
      }
      if (failure !== undefined) {
        throw failure.error;
      }
    },

    async movePlaylistTracks(playlistId: number, playlistTrackIds: readonly number[], insertBefore: number) {
      if (playlistTrackIds.length === 0) {
        return call("movePlaylistTracks", playlistId, playlistTrackIds, insertBefore);
      }
      const scope = journal.scope();
      const before = scope.snapshots.get(playlistId) ?? (await tryRead(playlistId));
      scope.snapshots.delete(playlistId);
      await call("movePlaylistTracks", playlistId, playlistTrackIds, insertBefore);
      let moved = [...playlistTrackIds];
      let from: number[] | undefined;
      if (before !== undefined && before.every((t) => t.playlistTrackId !== undefined)) {
        const places = new Map(before.map((t, index) => [t.playlistTrackId!, index]));
        // Qobuz ignores ids that are not in the playlist.
        moved = moved.filter((id) => places.has(id));
        from = moved.map((id) => places.get(id)!);
        const byId = new Map(before.map((t) => [t.playlistTrackId!, t]));
        scope.snapshots.set(
          playlistId,
          applyMove([...byId.keys()], moved, insertBefore).map((id) => byId.get(id)!),
        );
      }
      if (moved.length > 0) {
        journal.record({
          kind: "move-tracks",
          playlistId,
          ...(await named(scope, playlistId)),
          playlistTrackIds: moved,
          insertBefore,
          ...(from !== undefined && { from }),
        });
      }
    },

    addFavoriteTracks: favourites("addFavoriteTracks", "add-favourites", "tracks"),
    addFavoriteAlbums: favourites("addFavoriteAlbums", "add-favourites", "albums"),
    addFavoriteArtists: favourites("addFavoriteArtists", "add-favourites", "artists"),
    removeFavoriteTracks: favourites("removeFavoriteTracks", "remove-favourites", "tracks"),
    removeFavoriteAlbums: favourites("removeFavoriteAlbums", "remove-favourites", "albums"),
    removeFavoriteArtists: favourites("removeFavoriteArtists", "remove-favourites", "artists"),
  };

  return new Proxy(client, {
    get(target, property) {
      if (typeof property === "string" && property in wrappers && typeof raw[property] === "function") {
        return wrappers[property];
      }
      // Getters and methods run against the real client (its private fields).
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as AnyMethod).bind(target) : value;
    },
  });
}

/** A playlist's entries (those with an entry id) with their positions. */
function toEntries(tracks: readonly Track[]): PlaylistEntryRecord[] {
  return tracks.flatMap((track, position) =>
    track.playlistTrackId === undefined
      ? []
      : [{ trackId: track.id, playlistTrackId: track.playlistTrackId, position }],
  );
}
