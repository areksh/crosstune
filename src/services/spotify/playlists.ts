/**
 * Reading and changing the items of a playlist, by positional entry ids.
 *
 * Every change reads the playlist first, finds the entries in it (./entries.ts)
 * and names the snapshot they were found in, so that Spotify works the change
 * out against that one and merges it with whatever others do meanwhile. Changes
 * to one playlist are made one after another. What the playlist was left as is
 * remembered, so that the ids of one read stay good through our own changes.
 *
 * **Removing one copy of a song.** Spotify's DELETE removes every copy, so the
 * ones that stay are added again: their added dates are lost. It is checked
 * first that Spotify still offers the song. This is done last, one song at a
 * time, with no other request of the change between the two:
 *
 *   1. DELETE the song        -- interrupted before: nothing happened to it
 *   2. POST the kept copies   -- interrupted before: THIS SONG IS MISSING
 *   3. PUT, to spread several -- interrupted before: all there, side by side at
 *      kept copies out           the first one's place
 *
 * So at most one song is missing after an interruption, whenever it happens,
 * and those not yet dealt with are untouched. An error in between raises
 * {@link RemovalInterrupted}, which names the song, after looking whether the
 * request went through and trying once more. Only a killed process leaves the
 * song out without saying so; a read of the playlist then shows it missing
 * against the read made before. Adding cannot name a snapshot, so a change
 * somebody else makes between 1 and 2 can put the song a little off its place.
 */

import { isNotFound } from "../errors.js";
import { nativeOf, tagId } from "../ids.js";
import type { EntryId, PlaylistId, Track, TrackId } from "../model.js";
import { mayHaveHappened, SpotifyError, type SpotifyClient } from "./client.js";
import {
  appendEntries,
  applyRange,
  findEntries,
  identify,
  numberEntries,
  orderAfterMove,
  planRemoval,
  rangeMoves,
  spreadMoves,
  trackNativeOf,
  type Removal,
  type Uris,
  type View,
} from "./entries.js";
import { isRecord, number, parsePlaylistItem, text } from "./models.js";
import { isLocal, isSong, nativeOfUri, plainId, uriOf } from "./uris.js";

/** Spotify's limit on adding and on removing. */
const ITEMS_PER_REQUEST = 100;
const ITEMS_PER_PAGE = 50;
/** How often a playlist that changes while it is read is read again. */
const READS = 3;

/** Without this, Spotify gives episodes as nothing. */
const EVERY_TYPE = { additional_types: "track,episode" };

/** Removing one copy of a song was interrupted, and its other copies may be missing. */
export class RemovalInterrupted extends SpotifyError {
  /** The copies that may be missing. */
  readonly missing: TrackId[];

  constructor(title: string, missing: TrackId[], cause?: unknown) {
    const why = cause instanceof Error ? ` (${cause.message})` : "";
    super(
      "interrupted",
      `removing a copy of ${title} was interrupted${why}, and ${missing.length === 1 ? "the other copy" : `${missing.length} other copies`} may be missing from the playlist; if so, add it again`,
      { cause },
    );
    this.name = "RemovalInterrupted";
    this.missing = missing;
  }
}

/** A playlist as just read. */
interface Read {
  snapshot: string;
  uris: Uris;
  /** The song at each place; undefined where it cannot be read. */
  tracks: readonly (Track | undefined)[];
}

/** A playlist being changed. */
interface Open {
  readonly native: string;
  readonly tracks: Read["tracks"];
  view: View;
  snapshot: string;
  /** Somebody else changed it since it was last read. */
  readonly changed: boolean;
  /** As last read or left by us. */
  readonly known: View | undefined;
}

export class PlaylistEditor {
  readonly #client: SpotifyClient;
  /** Why another user's playlist cannot be read. */
  readonly #notReadable: string;
  readonly #views = new Map<string, View>();
  readonly #busy = new Map<string, Promise<unknown>>();

  constructor(client: SpotifyClient, notReadable: string) {
    this.#client = client;
    this.#notReadable = notReadable;
  }

  /** The playlist's items, with the entry ids that changes take. */
  async read(playlistId: PlaylistId): Promise<Track[]> {
    const native = plainId(playlistId);
    return this.#inTurn(native, async () => {
      const { uris, tracks } = await this.#load(native);
      const ids = numberEntries(uris);
      this.#views.set(native, { uris, ids });
      return tracks.flatMap((track, i) => (track === undefined ? [] : [{ ...track, playlistTrackId: ids[i]! }]));
    });
  }

  async add(playlistId: PlaylistId, trackIds: readonly TrackId[]): Promise<void> {
    const native = plainId(playlistId);
    const uris = trackIds.map(uriOf);
    if (trackIds.some(isLocal)) {
      throw new SpotifyError("unsupported", "Spotify's API cannot add local files to a playlist");
    }
    if (uris.length === 0) {
      return;
    }
    await this.#inTurn(native, async () => {
      for (const batch of batches(uris)) {
        await this.#client.send("POST", `/playlists/${native}/items`, { body: { uris: batch } });
        const view = this.#views.get(native);
        if (view !== undefined) {
          this.#views.set(native, appendEntries(view, batch));
        }
      }
    });
  }

  /** The songs of which a removal would take out, and add again, the copies that stay. */
  async readdedBy(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<TrackId[]> {
    const native = plainId(playlistId);
    checkRemovable(entryIds);
    if (entryIds.length === 0) {
      return [];
    }
    return this.#inTurn(native, async () => {
      const open = await this.#open(native);
      return planRemoval(open.view.uris, new Set(this.#find(open, entryIds))).repeated.map(({ uri }) => trackOf(uri));
    });
  }

  async remove(playlistId: PlaylistId, entryIds: readonly EntryId[]): Promise<void> {
    const native = plainId(playlistId);
    checkRemovable(entryIds);
    if (entryIds.length === 0) {
      return;
    }
    await this.#inTurn(native, async () => {
      const open = await this.#open(native);
      const places = this.#find(open, entryIds);
      const going = new Set(places.map((place) => open.view.ids[place]!));
      const plan = planRemoval(open.view.uris, new Set(places));
      await this.#checkReturnable(open, plan);
      for (const batch of batches(plan.whole)) {
        await this.#deleteSongs(open, batch);
      }
      for (const song of plan.repeated) {
        await this.#removeCopies(open, song, going);
      }
      if (plan.repeated.length > 0) {
        await this.#checkReturned(open, plan);
      }
    });
  }

  /** See `MusicWrites.movePlaylistTracks`. */
  async move(playlistId: PlaylistId, entryIds: readonly EntryId[], insertBefore: number): Promise<void> {
    const native = plainId(playlistId);
    entryIds.forEach((id) => nativeOf("spotify", id));
    if (entryIds.length === 0) {
      return;
    }
    await this.#inTurn(native, async () => {
      const open = await this.#open(native);
      const places = this.#find(open, entryIds);
      // Places are counted as they were read: without what cannot be read.
      const shown = open.view.ids.filter((_, place) => open.view.uris[place] !== undefined);
      if (open.changed || insertBefore > shown.length + 1) {
        throw changedMeanwhile();
      }
      const { ids } = open.view;
      const moved = places.map((place) => ids[place]!);
      const anchor = shown[Math.max(insertBefore, 1) - 1];
      for (const move of rangeMoves(ids, orderAfterMove(ids, moved, anchor))) {
        await this.#moveRange(open, move);
      }
    });
  }

  /** Run `work` once everything begun earlier on this playlist has ended. */
  async #inTurn<T>(native: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#busy.get(native) ?? Promise.resolve()).then(work);
    const ended = run.then(
      () => {},
      () => {},
    );
    this.#busy.set(native, ended);
    try {
      return await run;
    } finally {
      if (this.#busy.get(native) === ended) {
        this.#busy.delete(native);
      }
    }
  }

  // -- Reading ------------------------------------------------------------

  /** Read every item, as of one snapshot. */
  async #load(native: string): Promise<Read> {
    const path = `/playlists/${native}`;
    for (let attempt = 0; attempt < READS; attempt += 1) {
      // One answer holds the snapshot and the first items, so they agree.
      const playlist = await this.#client.get(path, EVERY_TYPE);
      const snapshot = isRecord(playlist) ? text(playlist["snapshot_id"]) : undefined;
      const items = isRecord(playlist) ? playlist["items"] : undefined;
      if (!isRecord(items)) {
        throw new SpotifyError("unsupported", this.#notReadable);
      }
      if (snapshot === undefined) {
        throw new SpotifyError("api-response", "Spotify did not say which version of the playlist this is");
      }
      const raw: unknown[] = Array.isArray(items["items"]) ? items["items"] : [];
      const total = number(items["total"]) ?? Infinity;
      let same = true;
      if (raw.length < total) {
        const rest = await this.#client.pages(`${path}/items`, EVERY_TYPE, { size: ITEMS_PER_PAGE, from: raw.length });
        raw.push(...rest.items);
        const after = await this.#client.get(path, { fields: "snapshot_id" });
        same = isRecord(after) && after["snapshot_id"] === snapshot && (rest.total ?? raw.length) === raw.length;
      }
      if (same) {
        const tracks = raw.map(parsePlaylistItem);
        return { snapshot, tracks, uris: tracks.map((track) => (track === undefined ? undefined : uriOf(track.id))) };
      }
    }
    throw new SpotifyError("conflict", "the playlist kept changing on Spotify while it was read; try again");
  }

  async #open(native: string): Promise<Open> {
    const { uris, tracks, snapshot } = await this.#load(native);
    const known = this.#views.get(native);
    const { ids, changed } = identify(uris, known);
    return { native, tracks, view: { uris, ids }, snapshot, changed, known };
  }

  /** @throws {SpotifyError} kind `conflict` if an entry cannot be found for certain. */
  #find(open: Open, entryIds: readonly EntryId[]): number[] {
    const places = findEntries({ ...open.view, changed: open.changed }, open.known, entryIds);
    if (places === undefined) {
      throw changedMeanwhile();
    }
    return places;
  }

  // -- Writing ------------------------------------------------------------

  /** What the playlist is after a request of ours. */
  #left(open: Open, view: View, answer: unknown): void {
    open.view = view;
    open.snapshot = (isRecord(answer) ? text(answer["snapshot_id"]) : undefined) ?? open.snapshot;
    this.#views.set(open.native, view);
  }

  async #deleteSongs(open: Open, uris: readonly string[]): Promise<void> {
    const answer = await this.#client.send("DELETE", `/playlists/${open.native}/items`, {
      body: { items: uris.map((uri) => ({ uri })), snapshot_id: open.snapshot },
      repeatable: true,
    });
    this.#left(open, without(open.view, new Set(uris)), answer);
  }

  async #moveRange(open: Open, move: { start: number; length: number; before: number }): Promise<void> {
    const answer = await this.#client.send("PUT", `/playlists/${open.native}/items`, {
      body: {
        range_start: move.start,
        range_length: move.length,
        insert_before: move.before,
        snapshot_id: open.snapshot,
      },
    });
    const { uris, ids } = open.view;
    this.#left(open, { uris: applyRange(uris, move), ids: applyRange(ids, move) }, answer);
  }

  /** Refuse, while nothing is done, what could not be put back. */
  async #checkReturnable(open: Open, plan: Removal): Promise<void> {
    for (const { uri, keptAt } of plan.repeated) {
      const id = trackOf(uri);
      const title = titleOf(open, uri);
      if (keptAt.length > ITEMS_PER_REQUEST) {
        throw new SpotifyError("unsupported", `${title} is in the playlist too often to remove single copies`);
      }
      if (isSong(id)) {
        await this.#client.get(`/tracks/${nativeOf("spotify", id)}`).catch((error: unknown) => {
          throw isNotFound(error)
            ? new SpotifyError(
                "unsupported",
                `Spotify removes every copy of a song at once, and no longer offers ${title}, so the copies that stay could not be added again`,
                { cause: error },
              )
            : error;
        });
      }
    }
  }

  /** Take every copy of a song out and put those that stay back (see the top of this file). */
  async #removeCopies(open: Open, song: Removal["repeated"][number], going: ReadonlySet<EntryId>): Promise<void> {
    const { uri, keptAt } = song;
    const kept = open.view.ids.filter((id, place) => open.view.uris[place] === uri && !going.has(id));
    try {
      await this.#deleteSongs(open, [uri]);
    } catch (error) {
      if (!mayHaveHappened(error)) {
        throw error;
      }
      const now = await this.#look(open.native);
      if (now === undefined || now.uris.includes(uri)) {
        throw interrupted(open, uri, keptAt.length, error);
      }
      this.#left(open, without(open.view, new Set([uri])), { snapshot_id: now.snapshot });
    }
    const answer = await this.#putBack(open, uri, keptAt);
    const first = keptAt[0]!;
    const { uris, ids } = open.view;
    this.#left(
      open,
      {
        uris: [...uris.slice(0, first), ...kept.map(() => uri), ...uris.slice(first)],
        ids: [...ids.slice(0, first), ...kept, ...ids.slice(first)],
      },
      answer,
    );
    for (const move of spreadMoves(keptAt)) {
      await this.#moveRange(open, move);
    }
  }

  /** Add the copies together; they are spread out afterwards. */
  async #putBack(open: Open, uri: string, keptAt: readonly number[]): Promise<unknown> {
    let left = keptAt.length;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#client.send("POST", `/playlists/${open.native}/items`, {
          body: { uris: Array.from({ length: left }, () => uri), position: keptAt[0] },
        });
      } catch (error) {
        const now = mayHaveHappened(error) ? await this.#look(open.native) : undefined;
        if (now !== undefined) {
          left = keptAt.length - now.uris.filter((other) => other === uri).length;
          if (left <= 0) {
            return { snapshot_id: now.snapshot };
          }
        }
        if (now === undefined || attempt > 0) {
          throw interrupted(open, uri, left, error);
        }
      }
    }
  }

  /** Check that everything put back is there: Spotify can take a song and not add it. */
  async #checkReturned(open: Open, plan: Removal): Promise<void> {
    const now = await this.#look(open.native);
    for (const { uri, keptAt } of now === undefined ? [] : plan.repeated) {
      const short = keptAt.length - now!.uris.filter((other) => other === uri).length;
      if (short > 0) {
        throw interrupted(open, uri, short, undefined);
      }
    }
  }

  /** The playlist as it is, or undefined if it cannot be read. */
  async #look(native: string): Promise<Read | undefined> {
    return this.#load(native).catch(() => undefined);
  }
}

function batches<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / ITEMS_PER_REQUEST) }, (_, i) =>
    items.slice(i * ITEMS_PER_REQUEST, (i + 1) * ITEMS_PER_REQUEST),
  );
}

function checkRemovable(entryIds: readonly EntryId[]): void {
  for (const id of entryIds) {
    if (trackNativeOf(nativeOf("spotify", id)).startsWith("local:")) {
      throw new SpotifyError("unsupported", "Spotify's API cannot remove local files from a playlist; remove them in Spotify");
    }
  }
}

function without({ uris, ids }: View, gone: ReadonlySet<string>): View {
  const stays = uris.map((uri) => uri === undefined || !gone.has(uri));
  return { uris: uris.filter((_, place) => stays[place]), ids: ids.filter((_, place) => stays[place]) };
}

function trackOf(uri: string): TrackId {
  return tagId<TrackId>("spotify", nativeOfUri(uri) ?? uri);
}

function titleOf(open: Open, uri: string): string {
  const id = trackOf(uri);
  const track = open.tracks.find((candidate) => candidate?.id === id);
  return track === undefined || track.title === "" ? String(id) : `"${track.title}"`;
}

function interrupted(open: Open, uri: string, copies: number, cause: unknown): RemovalInterrupted {
  return new RemovalInterrupted(
    titleOf(open, uri),
    Array.from({ length: copies }, () => trackOf(uri)),
    cause,
  );
}

function changedMeanwhile(): SpotifyError {
  return new SpotifyError("conflict", "the playlist was changed meanwhile on Spotify; reload it and try again");
}
