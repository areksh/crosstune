/**
 * Test support (not shipped; excluded from the build): an in-memory Spotify
 * behind a `fetch`, with the Web API's documented development-mode behaviour as
 * of November 2026:
 *
 * - a playlist's items are given only to its owner and collaborators;
 * - every change makes a new snapshot; a range move is worked out against the
 *   snapshot it names and merged into the newest;
 * - DELETE names songs, and removes every copy there is;
 * - adding names a position but no snapshot, and keeps repeats;
 * - local files can be neither added nor removed, only moved;
 * - search and an artist's albums give 10 at most, the library takes 40 URIs;
 * - removed endpoints answer 404.
 *
 * Where the documentation is silent it is strict (an error), so that the
 * service does not come to rely on what is unknown.
 */

import { normaliseIsrc } from "../isrc.js";
import type { TokenSource } from "../tokens.js";

export interface FakeTrack {
  name: string;
  artists?: string[];
  isrc?: string;
  album?: string;
  seconds?: number;
}

export interface FakeAlbum {
  name: string;
  artists?: string[];
  type?: string;
  date?: string;
  upc?: string;
}

interface Entry {
  key: number;
  /** Undefined: an item Spotify gives as null. */
  uri: string | undefined;
  addedAt: string;
}

interface FakePlaylist {
  name: string;
  description: string;
  isPublic: boolean;
  collaborative: boolean;
  owner: string;
  collaborators: string[];
  /** Every snapshot by id, oldest first; the last is the current one. */
  snapshots: Map<string, Entry[]>;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  status: number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bad = (message: string): never => {
  throw new Refusal(400, message);
};
const missing = (): never => {
  throw new Refusal(404, "Resource not found");
};

const LOCAL = /^spotify:local:/;

export class FakeSpotify {
  readonly me = "me";
  readonly tracks = new Map<string, FakeTrack>();
  readonly episodes = new Map<string, { name: string; show: string }>();
  readonly albums = new Map<string, FakeAlbum>();
  readonly artists = new Map<string, string>();
  readonly playlists = new Map<string, FakePlaylist>();
  /** Playlists in the user's library. */
  shown: string[] = [];
  /** Newest first. */
  saved: { uri: string; at: string }[] = [];
  readonly seen: SeenRequest[] = [];
  /** Songs that are taken, and answered normally, but not added. */
  readonly droppedOnAdd = new Set<string>();
  /** Songs still shown in playlists that are otherwise gone. */
  readonly withdrawn = new Set<string>();
  /** Answer this many requests from now on with a 429. */
  throttled: { times: number; retryAfter: number } | undefined;
  quotaUsedUp = false;
  /** Called with each request before it is answered, to change things in between. */
  before: ((request: { method: string; path: string }) => void) | undefined;

  #valid = "token-1";
  #held = "token-1";
  #clock = Date.parse("2026-11-01T00:00:00Z");
  #next = 1;
  #failure: { at: number; applied: boolean; once: boolean } | undefined;

  /** What the client gets its tokens from. */
  readonly tokens: TokenSource = {
    accessToken: async () => this.#held,
    renewedToken: async (rejected) => {
      if (rejected === this.#held) {
        this.#held = this.#valid;
      }
      return this.#held;
    },
  };

  /** Make the token in use no longer good. */
  expire(): void {
    this.#valid = `renewed-${this.#next++}`;
  }

  /** From the `nth` request from now (0: the next), the network fails: for that one, or for good. */
  failAt(nth: number, options: { applied?: boolean; once?: boolean } = {}): void {
    this.#failure = { at: this.seen.length + nth, applied: options.applied ?? false, once: options.once ?? false };
  }

  recover(): void {
    this.#failure = undefined;
  }

  addTrack(id: string, track: FakeTrack = { name: `Track ${id}` }): string {
    this.tracks.set(id, track);
    return `spotify:track:${id}`;
  }

  seedPlaylist(
    id: string,
    uris: readonly (string | undefined)[],
    options: { owner?: string; collaborators?: string[]; name?: string } = {},
  ): string {
    this.playlists.set(id, {
      name: options.name ?? id,
      description: "",
      isPublic: false,
      collaborative: options.collaborators !== undefined,
      owner: options.owner ?? this.me,
      collaborators: options.collaborators ?? [],
      snapshots: new Map(),
    });
    this.shown.push(id);
    this.#commit(id, uris.map((uri) => this.#entry(uri)));
    return id;
  }

  /** The URIs of a playlist, in order. */
  uris(id: string): (string | undefined)[] {
    return this.current(id).map((e) => e.uri);
  }

  /** URI and added date of a playlist's entries. */
  dates(id: string): [string | undefined, string][] {
    return this.current(id).map((e) => [e.uri, e.addedAt]);
  }

  current(id: string): Entry[] {
    return [...(this.playlists.get(id)?.snapshots.values() ?? [])].at(-1) ?? [];
  }

  /** Change a playlist as somebody else would. */
  edit(id: string, change: (uris: (string | undefined)[]) => (string | undefined)[]): void {
    this.#commit(id, change(this.uris(id)).map((uri) => this.#entry(uri)));
  }

  get requests(): number {
    return this.seen.length;
  }

  /** The requests since the `from`th, as "METHOD path". */
  calls(from = 0): string[] {
    return this.seen.slice(from).map((r) => `${r.method} ${r.path}`);
  }

  readonly fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname, searchParams, origin } = new URL(url);
    if (origin !== "https://api.spotify.com" || !pathname.startsWith("/v1/")) {
      throw new Error(`not Spotify's API: ${url}`);
    }
    const method = init.method ?? "GET";
    const path = pathname.slice("/v1".length);
    this.before?.({ method, path });
    const failure = this.#failure;
    const failing = failure !== undefined && this.seen.length >= failure.at;
    if (failing && failure.once) {
      this.#failure = undefined;
    }
    const request: SeenRequest = {
      method,
      path,
      query: Object.fromEntries(searchParams),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      status: 0,
    };
    this.seen.push(request);
    if (failing && !failure.applied) {
      throw new TypeError("fetch failed");
    }
    const headers = init.headers as Record<string, string>;
    const response = this.#respond(request, headers["Authorization"]);
    request.status = response.status;
    if (failing) {
      throw new TypeError("fetch failed");
    }
    return response;
  }) as unknown as typeof fetch;

  #respond(request: SeenRequest, authorization: string | undefined): Response {
    const error = (status: number, message: string, extra: object = {}, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ error: { status, message, ...extra } }), { status, headers });
    if (authorization !== `Bearer ${this.#valid}`) {
      return error(401, "The access token expired");
    }
    if (this.quotaUsedUp) {
      return error(429, "Too many requests", { reason: "QUOTA_EXCEEDED" });
    }
    if (this.throttled !== undefined && this.throttled.times > 0) {
      this.throttled.times -= 1;
      return error(429, "API rate limit exceeded", {}, { "Retry-After": String(this.throttled.retryAfter) });
    }
    try {
      const answer = this.#route(request);
      return answer === undefined
        ? new Response(null, { status: 200 })
        : new Response(JSON.stringify(answer), { status: request.method === "POST" ? 201 : 200 });
    } catch (refusal) {
      if (refusal instanceof Refusal) {
        return error(refusal.status, refusal.message);
      }
      throw refusal;
    }
  }

  #route({ method, path, query, body }: SeenRequest): unknown {
    const [first, second, third] = path.slice(1).split("/").map(decodeURIComponent);
    switch (`${method} ${first}${second === undefined ? "" : first === "me" ? `/${second}` : "/*"}${third === undefined ? "" : `/${third}`}`) {
      case "GET me":
        return { id: this.me, display_name: "Me", type: "user" };
      case "GET me/playlists":
        return this.#page(this.shown.map((id) => this.#playlistJson(id, false)), query, 50);
      case "POST me/playlists":
        return this.#create(body);
      case "GET me/tracks":
        return this.#page(
          this.#savedOf("track").map(({ id, at }) => ({ added_at: at, track: this.#trackJson(id) })),
          query,
          50,
        );
      case "GET me/albums":
        return this.#page(
          this.#savedOf("album").map(({ id, at }) => ({ added_at: at, album: this.#albumJson(id, true) })),
          query,
          50,
        );
      case "GET me/following":
        return query["type"] === "artist" ? { artists: this.#following(query) } : bad("type");
      case "PUT me/library":
        return this.#library(query, (uri) => this.#save(uri));
      case "DELETE me/library":
        return this.#library(query, (uri) => this.#unsave(uri));
      case "GET me/library/contains":
        return this.#libraryUris(query).map((uri) => this.saved.some((s) => s.uri === uri));
      case "GET playlists/*":
        return this.#fields(this.#playlistJson(second!, true, query), query["fields"]);
      case "PUT playlists/*":
        return this.#details(second!, body);
      case "GET playlists/*/items":
        this.#readable(second!);
        return this.#page(this.current(second!).map((e) => this.#itemJson(e, query)), query, 50);
      case "POST playlists/*/items":
        return this.#add(second!, body);
      case "PUT playlists/*/items":
        return this.#move(second!, body);
      case "DELETE playlists/*/items":
        return this.#remove(second!, body);
      case "GET tracks/*":
        return this.tracks.has(second!) && !this.withdrawn.has(second!) ? this.#trackJson(second!) : missing();
      case "GET albums/*":
        return this.albums.has(second!) ? this.#albumJson(second!, true) : missing();
      case "GET albums/*/tracks":
        return this.albums.has(second!)
          ? this.#page(this.#tracksOf(second!).map((id) => this.#trackJson(id, true)), query, 50)
          : missing();
      case "GET artists/*":
        return this.artists.has(second!) ? this.#artistJson(second!) : missing();
      case "GET artists/*/albums":
        return this.#page(
          [...this.albums.keys()]
            .filter((id) => this.albums.get(id)!.artists?.[0] === second)
            .map((id) => this.#albumJson(id, false)),
          query,
          10,
        );
      case "GET search":
        return this.#search(query);
      default:
        return missing();
    }
  }

  // -- Playlists ----------------------------------------------------------

  #entry(uri: string | undefined): Entry {
    this.#clock += 1000;
    return { key: this.#next++, uri, addedAt: new Date(this.#clock).toISOString() };
  }

  #commit(id: string, entries: Entry[]): { snapshot_id: string } {
    const snapshot_id = `snapshot-${this.#next++}`;
    this.playlists.get(id)!.snapshots.set(snapshot_id, entries);
    return { snapshot_id };
  }

  #playlist(id: string): FakePlaylist {
    return this.playlists.get(id) ?? missing();
  }

  #readable(id: string): void {
    const { owner, collaborators } = this.#playlist(id);
    if (owner !== this.me && !collaborators.includes(this.me)) {
      throw new Refusal(403, "Forbidden");
    }
  }

  #playlistJson(id: string, whole: boolean, query: Record<string, string> = {}): Record<string, unknown> {
    const playlist = this.#playlist(id);
    const entries = this.current(id);
    const mine = playlist.owner === this.me || playlist.collaborators.includes(this.me);
    const items = entries.slice(0, 100).map((e) => this.#itemJson(e, query));
    return {
      type: "playlist",
      id,
      name: playlist.name,
      description: playlist.description,
      public: playlist.isPublic,
      collaborative: playlist.collaborative,
      owner: { id: playlist.owner },
      snapshot_id: [...playlist.snapshots.keys()].at(-1),
      external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
      ...(mine && {
        items: {
          total: entries.length,
          ...(whole && { items, limit: 100, offset: 0, next: entries.length > 100 ? "more" : null }),
        },
      }),
    };
  }

  /** Only the top-level fields asked for. */
  #fields(json: Record<string, unknown>, fields: string | undefined): Record<string, unknown> {
    if (fields === undefined) {
      return json;
    }
    const names = fields.replace(/\([^)]*\)/g, "").split(",");
    return Object.fromEntries(Object.entries(json).filter(([name]) => names.includes(name)));
  }

  #itemJson({ uri, addedAt }: Entry, query: Record<string, string>): unknown {
    const kinds = (query["additional_types"] ?? "track").split(",");
    const id = uri?.split(":")[2] ?? "";
    const local = uri !== undefined && LOCAL.test(uri);
    const episode = this.episodes.get(id);
    const item =
      uri === undefined
        ? null
        : local
          ? this.#localJson(uri)
          : uri.startsWith("spotify:episode:")
            ? kinds.includes("episode")
              ? { type: "episode", id, uri, name: episode!.name, show: { name: episode!.show }, duration_ms: 60_000 }
              : null
            : this.#trackJson(id);
    return { added_at: addedAt, added_by: { id: this.me }, is_local: local, item };
  }

  #localJson(uri: string): unknown {
    const [artist, album, title, seconds] = uri
      .split(":")
      .slice(2)
      .map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
    return {
      type: "track",
      id: null,
      uri,
      is_local: true,
      name: title,
      artists: [{ id: null, name: artist }],
      album: { id: null, name: album, images: [] },
      duration_ms: Number(seconds) * 1000,
      external_ids: {},
      external_urls: {},
    };
  }

  #create(body: Record<string, unknown>): unknown {
    if (typeof body["name"] !== "string" || body["name"].length === 0) {
      return bad("Missing required field: name");
    }
    const id = this.seedPlaylist(`playlist${this.#next++}`, [], { name: body["name"] });
    this.#details(id, { public: true, ...body });
    return this.#playlistJson(id, true);
  }

  #details(id: string, body: Record<string, unknown>): undefined {
    const playlist = this.#playlist(id);
    if (playlist.owner !== this.me) {
      throw new Refusal(403, "You cannot change this playlist");
    }
    if (typeof body["name"] === "string") {
      playlist.name = body["name"];
    }
    if (typeof body["description"] === "string") {
      playlist.description = body["description"];
    }
    if (typeof body["public"] === "boolean") {
      playlist.isPublic = body["public"];
    }
    return undefined;
  }

  #known(uri: unknown): string {
    const [, kind, id] = String(uri).split(":");
    const exists = kind === "track" ? this.tracks.has(id!) : kind === "episode" && this.episodes.has(id!);
    return exists ? String(uri) : bad("Payload contains a non-existing ID");
  }

  #add(id: string, body: Record<string, unknown>): unknown {
    this.#readable(id);
    const { uris, position } = body;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 100) {
      return bad("uris");
    }
    const entries = [...this.current(id)];
    const added = uris.map((uri) => this.#known(uri)).filter((uri) => !this.droppedOnAdd.has(uri));
    const at = typeof position === "number" ? position : entries.length;
    if (at < 0 || at > entries.length) {
      return bad("Index out of bounds");
    }
    entries.splice(at, 0, ...added.map((uri) => this.#entry(uri)));
    return this.#commit(id, entries);
  }

  #move(id: string, body: Record<string, unknown>): unknown {
    this.#readable(id);
    if ("uris" in body) {
      return bad("replacing a playlist loses its added dates");
    }
    const { range_start: start, range_length: length = 1, insert_before: before, snapshot_id: named } = body;
    if (typeof start !== "number" || typeof length !== "number" || typeof before !== "number") {
      return bad("range");
    }
    const { snapshots } = this.#playlist(id);
    const base = named === undefined ? this.current(id) : (snapshots.get(String(named)) ?? bad("Invalid snapshot"));
    if (start < 0 || length < 1 || start + length > base.length || before < 0 || before > base.length) {
      return bad("Index out of bounds");
    }
    const keys = new Set(base.slice(start, start + length).map((e) => e.key));
    const anchor = base.slice(before).find((e) => !keys.has(e.key));
    const latest = this.current(id);
    const moving = latest.filter((e) => keys.has(e.key));
    const rest = latest.filter((e) => !keys.has(e.key));
    const at = anchor === undefined ? -1 : rest.findIndex((e) => e.key === anchor.key);
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    return this.#commit(id, rest);
  }

  #remove(id: string, body: Record<string, unknown>): unknown {
    this.#readable(id);
    const { items, snapshot_id: named } = body;
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return bad("items");
    }
    if (named !== undefined && !this.#playlist(id).snapshots.has(String(named))) {
      return bad("Invalid snapshot");
    }
    const uris = new Set(
      items.map((item: unknown) => {
        const keys = Object.keys(item as object);
        const { uri } = item as { uri: string };
        return keys.length !== 1 || LOCAL.test(uri) ? bad("uri") : uri;
      }),
    );
    return this.#commit(
      id,
      this.current(id).filter((e) => e.uri === undefined || !uris.has(e.uri)),
    );
  }

  // -- Library ------------------------------------------------------------

  #libraryUris(query: Record<string, string>): string[] {
    const uris = (query["uris"] ?? "").split(",");
    return uris.length > 40 || uris[0] === "" ? bad("uris") : uris;
  }

  #library(query: Record<string, string>, use: (uri: string) => void): undefined {
    this.#libraryUris(query).forEach(use);
    return undefined;
  }

  #save(uri: string): void {
    const [, kind, id] = uri.split(":");
    if (kind === "playlist") {
      this.#playlist(id!);
      this.shown = [...this.shown.filter((other) => other !== id), id!];
      return;
    }
    const where = { track: this.tracks, album: this.albums, artist: this.artists, episode: this.episodes }[kind!];
    if (where === undefined || !where.has(id!)) {
      bad("Invalid URI");
    }
    this.#clock += 1000;
    this.saved = [{ uri, at: new Date(this.#clock).toISOString() }, ...this.saved.filter((s) => s.uri !== uri)];
  }

  #unsave(uri: string): void {
    const [, kind, id] = uri.split(":");
    if (kind === "playlist") {
      this.shown = this.shown.filter((other) => other !== id);
    } else {
      this.saved = this.saved.filter((s) => s.uri !== uri);
    }
  }

  #savedOf(kind: string): { id: string; at: string }[] {
    return this.saved.flatMap(({ uri, at }) => (uri.startsWith(`spotify:${kind}:`) ? [{ id: uri.split(":")[2]!, at }] : []));
  }

  #following(query: Record<string, string>): unknown {
    const ids = this.#savedOf("artist").map(({ id }) => id);
    const limit = Number(query["limit"] ?? 20);
    if (limit > 50) {
      bad("Invalid limit");
    }
    const from = query["after"] === undefined ? 0 : ids.indexOf(query["after"]) + 1;
    const page = ids.slice(from, from + limit);
    const more = from + limit < ids.length;
    return {
      items: page.map((id) => this.#artistJson(id)),
      total: ids.length,
      next: more ? "more" : null,
      cursors: { after: more ? page.at(-1) : null },
    };
  }

  // -- Catalogue ----------------------------------------------------------

  #page(all: readonly unknown[], query: Record<string, string>, most: number): unknown {
    const limit = Number(query["limit"] ?? Math.min(20, most));
    const offset = Number(query["offset"] ?? 0);
    if (limit < 1 || limit > most) {
      return bad("Invalid limit");
    }
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
      next: offset + limit < all.length ? "more" : null,
    };
  }

  #artistJson(id: string): unknown {
    return { type: "artist", id, name: this.artists.get(id) ?? id, external_urls: {} };
  }

  #trackJson(id: string, simplified = false): unknown {
    const track = this.tracks.get(id);
    if (track === undefined) {
      return null;
    }
    return {
      type: "track",
      id,
      uri: `spotify:track:${id}`,
      is_local: false,
      name: track.name,
      artists: (track.artists ?? []).map((artist) => this.#artistJson(artist)),
      duration_ms: (track.seconds ?? 200) * 1000,
      disc_number: 1,
      track_number: 1,
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
      ...(!simplified && {
        external_ids: track.isrc === undefined ? {} : { isrc: track.isrc },
        ...(track.album !== undefined && { album: this.#albumJson(track.album, false) }),
      }),
    };
  }

  #tracksOf(album: string): string[] {
    return [...this.tracks].flatMap(([id, track]) => (track.album === album ? [id] : []));
  }

  #albumJson(id: string, whole: boolean): unknown {
    const album = this.albums.get(id)!;
    const tracks = this.#tracksOf(id);
    return {
      type: "album",
      id,
      name: album.name,
      album_type: album.type ?? "album",
      artists: (album.artists ?? []).map((artist) => this.#artistJson(artist)),
      release_date: album.date ?? "2000-01-01",
      release_date_precision: album.date === undefined ? "day" : { 4: "year", 7: "month" }[album.date.length] ?? "day",
      total_tracks: tracks.length,
      images: [{ url: `https://i.scdn.co/${id}`, width: 300, height: 300 }],
      external_urls: { spotify: `https://open.spotify.com/album/${id}` },
      ...(whole && {
        external_ids: album.upc === undefined ? {} : { upc: album.upc },
        tracks: {
          items: tracks.slice(0, 50).map((track) => this.#trackJson(track, true)),
          total: tracks.length,
          limit: 50,
          offset: 0,
          next: tracks.length > 50 ? "more" : null,
        },
      }),
    };
  }

  #search(query: Record<string, string>): unknown {
    const q = query["q"] ?? "";
    const isrc = /^isrc:(.+)$/.exec(q)?.[1];
    const has = (name: string): boolean => name.toLowerCase().includes(q.toLowerCase());
    switch (query["type"]) {
      case "track":
        return {
          tracks: this.#page(
            [...this.tracks]
              // Spotify also gives near misses for an ISRC.
              .filter(([, t]) => (isrc === undefined ? has(t.name) : normaliseIsrc(t.isrc ?? "").startsWith(isrc.slice(0, 11))))
              .map(([id]) => this.#trackJson(id)),
            query,
            10,
          ),
        };
      case "album":
        return {
          albums: this.#page(
            [...this.albums].filter(([, a]) => has(a.name)).map(([id]) => this.#albumJson(id, false)),
            query,
            10,
          ),
        };
      case "artist":
        return {
          artists: this.#page(
            [...this.artists].filter(([, name]) => has(name)).map(([id]) => this.#artistJson(id)),
            query,
            10,
          ),
        };
      default:
        return bad("type");
    }
  }
}
