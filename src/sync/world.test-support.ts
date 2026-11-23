/**
 * Test support (not shipped): accounts on several services holding the same
 * catalogue. Song n is `<service>:n` everywhere, with the ISRC "ISRCn" -- so
 * native ids collide on purpose, and nothing but the tag tells them apart.
 */

import { ServiceError } from "../services/errors.js";
import { tagId, type EntryId, type PlaylistId, type ServiceName, type TrackId } from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import { applyMove } from "../features/playlist-order.js";
import type { SyncClient } from "./run.js";

interface Entry {
  track: TrackId;
  id: EntryId;
}

export class SyncAccount implements SyncClient {
  readonly name: ServiceName;
  readonly #playlists = new Map<PlaylistId, { name: string; entries: Entry[]; owned: boolean }>();
  /** Songs this service does not have. */
  readonly absent = new Set<number>();
  /** Songs it no longer offers (they vanish from playlists by themselves). */
  readonly withdrawn = new Set<number>();
  /** Whether it can say that a song was withdrawn. */
  knowsAvailability = true;
  /** Song -> another song here that is the same recording under another id. */
  readonly alias = new Map<number, number>();
  /** One copy of a repeated song goes only by re-adding the others, as on Spotify. */
  readdsRepeats = false;
  /** Entry ids are places, as on Spotify, rather than lasting. */
  positional = false;
  /** Fail the nth write from now (1 is the next), then work again. */
  failWrite = 0;
  /** Do the write that fails, or not (a lost answer, or a refused request). */
  failAfterWriting = false;
  writes: string[] = [];
  #next = 1;

  constructor(name: ServiceName) {
    this.name = name;
  }

  id(n: number): TrackId {
    return tagId<TrackId>(this.name, n);
  }

  seed(name: string, songs: readonly number[]): PlaylistId {
    // Qobuz names playlists by number.
    const n = this.#next++;
    const id = tagId<PlaylistId>(this.name, this.name === "qobuz" ? 9000 + n : `pl${n}`);
    this.#playlists.set(id, { name, owned: true, entries: songs.map((n) => this.#entry(n)) });
    return id;
  }

  /** What is in a playlist, as song numbers. */
  songs(id: PlaylistId): number[] {
    return this.#get(id).entries.map((entry) => numberOf(entry.track));
  }

  /** An edit made by the user, outside crosstune. */
  edit(id: PlaylistId, change: (songs: number[]) => number[]): void {
    const playlist = this.#get(id);
    const spare = [...playlist.entries];
    playlist.entries = change(this.songs(id)).map((n) => {
      const at = spare.findIndex((entry) => numberOf(entry.track) === n);
      return at === -1 ? this.#entry(n) : spare.splice(at, 1)[0]!;
    });
  }

  rename(id: PlaylistId, name: string): void {
    this.#get(id).name = name;
  }

  remove(id: PlaylistId): void {
    this.#playlists.delete(id);
  }

  disown(id: PlaylistId): void {
    this.#get(id).owned = false;
  }

  /** The service stops offering a song: it goes from every playlist. */
  withdraw(n: number): void {
    this.withdrawn.add(n);
    for (const playlist of this.#playlists.values()) {
      playlist.entries = playlist.entries.filter((entry) => numberOf(entry.track) !== n);
    }
  }

  #entry(n: number): Entry {
    return { track: this.id(n), id: tagId<EntryId>(this.name, `e${this.#next++}`) };
  }

  #get(id: PlaylistId) {
    const playlist = this.#playlists.get(id);
    if (playlist === undefined) {
      throw new ServiceError(this.name, "not-found", "no such playlist");
    }
    return playlist;
  }

  #write(what: string, apply: () => void): void {
    this.writes.push(what);
    if (this.failWrite > 0) {
      this.failWrite -= 1;
      if (this.failWrite === 0) {
        if (this.failAfterWriting) {
          apply();
        }
        throw new ServiceError(this.name, "api-response", "HTTP 500");
      }
    }
    apply();
  }

  #track(n: number): Track {
    return {
      id: this.id(n),
      title: `Song ${n}`,
      artist: "Artist",
      isrc: `ISRC${this.alias.get(n) ?? n}`,
      duration: 200,
    };
  }

  /** Entries as read: on a positional service their ids are their places. */
  #read(id: PlaylistId): Entry[] {
    const { entries } = this.#get(id);
    if (!this.positional) {
      return entries;
    }
    const seen = new Map<TrackId, number>();
    return entries.map((entry) => {
      const nth = (seen.get(entry.track) ?? 0) + 1;
      seen.set(entry.track, nth);
      return { track: entry.track, id: tagId<EntryId>(this.name, `${numberOf(entry.track)}#${nth}`) };
    });
  }

  async getPlaylist(id: PlaylistId): Promise<Playlist> {
    const playlist = this.#get(id);
    return {
      id,
      name: playlist.name,
      ...(playlist.owned ? {} : { ownerId: tagId(this.name, "someone") }),
    };
  }

  async getPlaylistTracks(id: PlaylistId): Promise<Track[]> {
    return this.#read(id).map((entry) => ({ ...this.#track(numberOf(entry.track)), playlistTrackId: entry.id }));
  }

  async addTracksToPlaylist(id: PlaylistId, tracks: readonly TrackId[]): Promise<void> {
    this.#write(`add ${tracks.map(numberOf).join(",")}`, () => {
      for (const track of new Set(tracks)) {
        if (!this.withdrawn.has(numberOf(track)) && !this.absent.has(numberOf(track))) {
          this.#get(id).entries.push(this.#entry(numberOf(track)));
        }
      }
    });
  }

  async removeTracksFromPlaylist(id: PlaylistId, ids: readonly EntryId[]): Promise<void> {
    const read = this.#read(id);
    const gone = new Set(ids.map((one) => read.findIndex((entry) => entry.id === one)));
    this.#write(`remove ${ids.length}`, () => {
      const playlist = this.#get(id);
      playlist.entries = playlist.entries.filter((_, index) => !gone.has(index));
    });
  }

  async removesByReAdding(id: PlaylistId, ids: readonly EntryId[]): Promise<TrackId[]> {
    if (!this.readdsRepeats) {
      return [];
    }
    const read = this.#read(id);
    const going = read.filter((entry) => ids.includes(entry.id));
    return [...new Set(going.map((entry) => entry.track))].filter(
      (track) => read.filter((entry) => entry.track === track).length > going.filter((entry) => entry.track === track).length,
    );
  }

  async movePlaylistTracks(id: PlaylistId, ids: readonly EntryId[], insertBefore: number): Promise<void> {
    const read = this.#read(id);
    this.#write(`move ${ids.length}`, () => {
      const playlist = this.#get(id);
      const order = applyMove(read.map((entry) => entry.id), ids, insertBefore);
      const byId = new Map(read.map((entry, index) => [entry.id, playlist.entries[index]!]));
      playlist.entries = order.map((one) => byId.get(one)!);
    });
  }

  async updatePlaylist(id: PlaylistId, changes: { name?: string }): Promise<Playlist> {
    this.#write("rename", () => Object.assign(this.#get(id), changes));
    return this.getPlaylist(id);
  }

  async getTrack(id: TrackId): Promise<Track> {
    const n = numberOf(id);
    if (!this.knowsAvailability) {
      throw new ServiceError(this.name, "unsupported", "cannot say");
    }
    if (this.withdrawn.has(n) || this.absent.has(n)) {
      throw new ServiceError(this.name, "not-found", "gone");
    }
    return this.#track(n);
  }

  #offers(n: number): boolean {
    return !this.absent.has(n) && !this.withdrawn.has(n);
  }

  async findByIsrc(isrcs: readonly string[]): Promise<Map<string, Track[]>> {
    const out = new Map<string, Track[]>();
    for (const isrc of isrcs) {
      const n = Number(isrc.replace("ISRC", ""));
      if (this.#offers(n)) {
        out.set(isrc, [this.#track(n)]);
      }
    }
    return out;
  }

  async searchTracks(query: string): Promise<Track[]> {
    const n = Number(/Song (\d+)/.exec(query)?.[1]);
    return this.#offers(n) ? [{ ...this.#track(n), isrc: "OTHER" }] : [];
  }
}

export function numberOf(id: TrackId): number {
  return Number(id.slice(id.indexOf(":") + 1));
}
