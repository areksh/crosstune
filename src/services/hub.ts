/**
 * The connected services, behind one set of methods.
 *
 * A method that takes an id goes to that id's service; a list of favourites is
 * split by service. A method that takes none (search, create, the user's own
 * lists) needs a service named: {@link ServiceHub.scoped} gives a view that
 * uses one service for those and still routes ids anywhere. Putting one
 * service's track into another's playlist is refused here: crossing services
 * is always an explicit step.
 */

import { labelOf, ServiceError } from "./errors.js";
import { nativeOf, serviceOf, SERVICES, type AnyId, type ServiceName } from "./ids.js";
import type { AlbumId, ArtistId, EntryId, PlaylistId, TrackId } from "./model.js";
import type { Account, Capabilities, MusicReads, MusicService, MusicWrites, PlaylistChanges, PlaylistOptions } from "./service.js";

/** The methods that name no id, so cannot be routed by one. */
type Unrouted =
  | "searchArtists"
  | "searchAlbums"
  | "searchTracks"
  | "findByIsrc"
  | "getUserPlaylists"
  | "getFavoriteTracks"
  | "getFavoriteAlbums"
  | "getFavoriteArtists"
  | "createPlaylist";

type Routed = Omit<MusicReads & MusicWrites, Unrouted>;

export class ServiceHub implements Routed {
  readonly #services = new Map<ServiceName, MusicService>();

  /** Add a service, or replace it (signing in again). */
  connect(service: MusicService): void {
    this.#services.set(service.name, service);
  }

  disconnect(name: ServiceName): void {
    this.#services.delete(name);
  }

  connected(): ServiceName[] {
    return SERVICES.filter((name) => this.#services.has(name));
  }

  /** @throws {ServiceError} kind `not-connected`. */
  service(name: ServiceName): MusicService {
    const service = this.#services.get(name);
    if (service === undefined) {
      throw new ServiceError(name, "not-connected", `${labelOf(name)} is not connected`);
    }
    return service;
  }

  /** The hub as one service: ids go to their own, everything else to `name`. */
  scoped(name: ServiceName): MusicService {
    return new ScopedService(this, name);
  }

  /**
   * The hub as every connected service at once: the user's own lists are all of
   * theirs; a search or a new playlist goes to `name`. Listing the playlists
   * leaves out a service that fails (see {@link unavailableIn}); the favourites
   * are whole or an error, as what is missing from them would count as absent.
   */
  all(name: ServiceName): MusicService {
    return new AllServices(this, name);
  }

  #of(id: AnyId): MusicService {
    return this.service(serviceOf(id));
  }

  /** The playlist's service, once every other id is known to be its too. */
  #owning(playlistId: PlaylistId, ids: readonly AnyId[]): MusicService {
    const name = serviceOf(playlistId);
    for (const id of ids) {
      nativeOf(name, id);
    }
    return this.service(name);
  }

  /** Each service's share of `ids`; every service is found before any is used. */
  async #split<T extends AnyId>(
    ids: readonly T[],
    use: (service: MusicService, ids: T[]) => Promise<void>,
  ): Promise<void> {
    const shares = new Map<ServiceName, T[]>();
    for (const id of ids) {
      const name = serviceOf(id);
      shares.set(name, [...(shares.get(name) ?? []), id]);
    }
    const calls = [...shares].map(([name, share]) => ({ service: this.service(name), share }));
    for (const { service, share } of calls) {
      await use(service, share);
    }
  }

  async getTrack(trackId: TrackId) {
    return this.#of(trackId).getTrack(trackId);
  }

  async getArtist(artistId: ArtistId) {
    return this.#of(artistId).getArtist(artistId);
  }

  async getArtistTopTracks(artistId: ArtistId, limit?: number) {
    return this.#of(artistId).getArtistTopTracks(artistId, ...optional(limit));
  }

  async getSimilarArtists(artistId: ArtistId, limit: number) {
    return this.#of(artistId).getSimilarArtists(artistId, limit);
  }

  async getArtistReleases(artistId: ArtistId, maxReleases?: number) {
    return this.#of(artistId).getArtistReleases(artistId, ...optional(maxReleases));
  }

  async getAlbum(albumId: AlbumId) {
    return this.#of(albumId).getAlbum(albumId);
  }

  async getAlbumTracks(albumId: AlbumId) {
    return this.#of(albumId).getAlbumTracks(albumId);
  }

  async getAlbumReleaseDate(albumId: AlbumId) {
    return this.#of(albumId).getAlbumReleaseDate(albumId);
  }

  async getPlaylist(playlistId: PlaylistId) {
    return this.#of(playlistId).getPlaylist(playlistId);
  }

  async getPlaylistTracks(playlistId: PlaylistId) {
    return this.#of(playlistId).getPlaylistTracks(playlistId);
  }

  async updatePlaylist(playlistId: PlaylistId, changes: PlaylistChanges) {
    return this.#of(playlistId).updatePlaylist(playlistId, changes);
  }

  async deletePlaylist(playlistId: PlaylistId) {
    return this.#of(playlistId).deletePlaylist(playlistId);
  }

  async addTracksToPlaylist(playlistId: PlaylistId, trackIds: readonly TrackId[]) {
    return this.#owning(playlistId, trackIds).addTracksToPlaylist(playlistId, trackIds);
  }

  async removeTracksFromPlaylist(playlistId: PlaylistId, entryIds: readonly EntryId[]) {
    return this.#owning(playlistId, entryIds).removeTracksFromPlaylist(playlistId, entryIds);
  }

  async movePlaylistTracks(playlistId: PlaylistId, entryIds: readonly EntryId[], insertBefore: number) {
    return this.#owning(playlistId, entryIds).movePlaylistTracks(playlistId, entryIds, insertBefore);
  }

  async addFavoriteTracks(ids: readonly TrackId[]) {
    return this.#split(ids, (service, share) => service.addFavoriteTracks(share));
  }

  async addFavoriteAlbums(ids: readonly AlbumId[]) {
    return this.#split(ids, (service, share) => service.addFavoriteAlbums(share));
  }

  async addFavoriteArtists(ids: readonly ArtistId[]) {
    return this.#split(ids, (service, share) => service.addFavoriteArtists(share));
  }

  async removeFavoriteTracks(ids: readonly TrackId[]) {
    return this.#split(ids, (service, share) => service.removeFavoriteTracks(share));
  }

  async removeFavoriteAlbums(ids: readonly AlbumId[]) {
    return this.#split(ids, (service, share) => service.removeFavoriteAlbums(share));
  }

  async removeFavoriteArtists(ids: readonly ArtistId[]) {
    return this.#split(ids, (service, share) => service.removeFavoriteArtists(share));
  }
}

/** An optional argument, left out altogether when absent. */
function optional<T extends unknown[]>(...values: T): T {
  let length = values.length;
  while (length > 0 && values[length - 1] === undefined) {
    length -= 1;
  }
  return values.slice(0, length) as T;
}

/** See {@link ServiceHub.scoped}. */
class ScopedService extends ServiceHub implements MusicService {
  readonly name: ServiceName;
  readonly #hub: ServiceHub;

  constructor(hub: ServiceHub, name: ServiceName) {
    super();
    this.#hub = hub;
    this.name = name;
  }

  override connect(service: MusicService): void {
    this.#hub.connect(service);
  }

  override disconnect(name: ServiceName): void {
    this.#hub.disconnect(name);
  }

  override connected(): ServiceName[] {
    return this.#hub.connected();
  }

  override service(name: ServiceName): MusicService {
    return this.#hub.service(name);
  }

  override scoped(name: ServiceName): MusicService {
    return this.#hub.scoped(name);
  }

  override all(name: ServiceName): MusicService {
    return this.#hub.all(name);
  }

  get capabilities(): Capabilities {
    return this.service(this.name).capabilities;
  }

  account(): Account | undefined {
    return this.connected().includes(this.name) ? this.service(this.name).account() : undefined;
  }

  async searchArtists(query: string, limit?: number, offset?: number) {
    return this.service(this.name).searchArtists(query, ...optional(limit, offset));
  }

  async searchAlbums(query: string, limit?: number, offset?: number) {
    return this.service(this.name).searchAlbums(query, ...optional(limit, offset));
  }

  async searchTracks(query: string, limit?: number, offset?: number) {
    return this.service(this.name).searchTracks(query, ...optional(limit, offset));
  }

  async findByIsrc(isrcs: readonly string[]) {
    return this.service(this.name).findByIsrc(isrcs);
  }

  async getUserPlaylists() {
    return this.service(this.name).getUserPlaylists();
  }

  async getFavoriteTracks() {
    return this.service(this.name).getFavoriteTracks();
  }

  async getFavoriteAlbums() {
    return this.service(this.name).getFavoriteAlbums();
  }

  async getFavoriteArtists() {
    return this.service(this.name).getFavoriteArtists();
  }

  async createPlaylist(name: string, options?: PlaylistOptions) {
    return this.service(this.name).createPlaylist(name, ...optional(options));
  }
}

/** A service left out of a list, and why. */
export interface Unavailable {
  service: ServiceName;
  error: string;
}

/** See {@link ServiceHub.all}. */
class AllServices extends ScopedService {
  #unavailable: Unavailable[] = [];

  get unavailable(): readonly Unavailable[] {
    return this.#unavailable;
  }

  override async getUserPlaylists() {
    const names = this.connected();
    const lists = await Promise.allSettled(names.map((name) => this.service(name).getUserPlaylists()));
    this.#unavailable = lists.flatMap((list, index) =>
      list.status === "fulfilled"
        ? []
        : [{ service: names[index]!, error: list.reason instanceof Error ? list.reason.message : String(list.reason) }],
    );
    if (names.length > 0 && this.#unavailable.length === names.length) {
      throw (lists[0] as PromiseRejectedResult).reason;
    }
    return lists.flatMap((list) => (list.status === "fulfilled" ? list.value : []));
  }

  override async getFavoriteTracks() {
    return this.#every((service) => service.getFavoriteTracks());
  }

  override async getFavoriteAlbums() {
    return this.#every((service) => service.getFavoriteAlbums());
  }

  override async getFavoriteArtists() {
    return this.#every((service) => service.getFavoriteArtists());
  }

  async #every<T>(read: (service: MusicService) => Promise<T[]>): Promise<T[]> {
    return (await Promise.all(this.connected().map((name) => read(this.service(name))))).flat();
  }
}

/** The services the last playlist list of {@link ServiceHub.all} left out. */
export function unavailableIn(service: unknown): readonly Unavailable[] {
  return service instanceof AllServices ? service.unavailable : [];
}
