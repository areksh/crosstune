/**
 * Test support (not shipped): an in-memory TIDAL, answering {@link FakeTidal.fetch}
 * as the OpenAPI document (1.10.258) says the API does -- JSON:API documents,
 * includes on request only, cursor paging, batch limits, skipped items on an
 * add, moves before an item, idempotency keys, 401 for a stale token.
 *
 * Stricter than the document where that catches a mistake: a parameter an
 * endpoint does not list is refused (the document promises that of filters and
 * sorts only), and every mutation must carry a key. Where the document says
 * nothing there is a switch (see {@link FakeTidal.ignoresGoneEntries}).
 */

import type { TokenSource } from "../tokens.js";

interface Ref {
  type: string;
  id: string;
  meta?: Record<string, unknown>;
}

interface Resource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  related: Record<string, Ref[]>;
}

interface FakePlaylist {
  name: string;
  description?: string;
  accessType: string;
  owner: string;
  items: Array<Ref & { meta: { itemId: string; addedAt: string } }>;
}

export interface FakeRequest {
  method: string;
  /** Without the base path, as sent (still encoded). */
  path: string;
  query: URLSearchParams;
  body: any;
  key: string | undefined;
}

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (request: FakeRequest, ids: string[]) => Answer;

const BASE = "https://openapi.tidal.com/v2";

/** The relationships that can be included, per type (those the app uses). */
const RELATIONSHIPS: Record<string, readonly string[]> = {
  tracks: ["albums", "artists"],
  videos: ["albums", "artists"],
  albums: ["artists", "coverArt", "items"],
  artists: ["albums", "tracks", "similarArtists"],
  playlists: ["items", "owners", "coverArt"],
  searchResults: ["albums", "artists", "tracks"],
};

const TARGETS: Record<string, readonly string[]> = {
  items: ["tracks", "videos"],
  albums: ["albums"],
  artists: ["artists"],
  tracks: ["tracks"],
  similarArtists: ["artists"],
  coverArt: ["artworks"],
  owners: ["users"],
};

const COLLECTIONS: Record<string, string> = {
  userCollectionTracks: "tracks",
  userCollectionAlbums: "albums",
  userCollectionArtists: "artists",
};

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`HTTP ${status}`);
  }
}

export class FakeTidal {
  readonly user = { id: "77", attributes: { username: "jr", country: "NO", firstName: "John", lastName: "Rambo" } };
  readonly playlists = new Map<string, FakePlaylist>();
  readonly collections: Record<string, Array<Ref & { meta: { addedAt: string } }>> = {
    tracks: [],
    albums: [],
    artists: [],
  };
  readonly requests: FakeRequest[] = [];
  /** "tracks:66": known, but cannot be added to anything. */
  readonly unavailable = new Set<string>();
  /** "tracks:67": still named in lists, but nothing more is said of it. */
  readonly hidden = new Set<string>();
  /** Whether removing an entry that is gone is taken in silence (undocumented). */
  ignoresGoneEntries = false;
  pageSize = 20;
  maxPlaylistItems = 10_000;
  /** The only access token accepted now. */
  token = "T1";
  /** How often a token was asked to be renewed. */
  renewals = 0;
  /** Answers to give instead, in turn, without doing anything. */
  readonly instead: Answer[] = [];
  /** How many of the next writes are made but answered with 503. */
  loseAnswers = 0;

  readonly #catalogue = new Map<string, Resource>();
  readonly #replays = new Map<string, { signature: string; answer: Answer }>();
  #next = 1;

  // ---- Setting up ----

  add(type: string, id: string, attributes: Record<string, unknown>, related: Record<string, Ref[]> = {}): void {
    this.#catalogue.set(`${type}:${id}`, { type, id, attributes, related });
  }

  /** A track by artists on an album, with the attributes every track has. */
  addTrack(id: string, options: { title?: string; isrc?: string; artists?: string[]; album?: string } = {}): void {
    this.add(
      "tracks",
      id,
      {
        title: options.title ?? `Track ${id}`,
        isrc: options.isrc ?? null,
        duration: "PT3M",
        explicit: false,
        popularity: 0.5,
        mediaTags: ["LOSSLESS"],
        availability: ["STREAM"],
      },
      {
        artists: (options.artists ?? ["7"]).map((artist) => ({ type: "artists", id: artist })),
        albums: options.album === undefined ? [] : [{ type: "albums", id: options.album }],
      },
    );
  }

  seedPlaylist(name: string, items: Ref[], options: { id?: string; owner?: string } = {}): string {
    const id = options.id ?? `pl-${this.#next++}`;
    this.playlists.set(id, {
      name,
      accessType: "UNLISTED",
      owner: options.owner ?? this.user.id,
      items: items.map((item) => this.#entry(item)),
    });
    return id;
  }

  /** What a playlist holds, as "type:id", in order. */
  contents(id: string): string[] {
    return this.playlists.get(id)!.items.map((item) => `${item.type}:${item.id}`);
  }

  itemIds(id: string): string[] {
    return this.playlists.get(id)!.items.map((item) => item.meta.itemId);
  }

  /** The requests made, as "METHOD /path". */
  log(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }

  /** Tokens as a keeper gives them: one refresh however many ask. */
  tokens(start = this.token): TokenSource {
    let held = start;
    return {
      accessToken: async () => held,
      renewedToken: async (rejected) => {
        if (rejected === held) {
          this.renewals += 1;
          held = this.token;
        }
        return held;
      },
    };
  }

  // ---- Answering ----

  readonly fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(`${BASE}/`)) {
      throw new Error(`not TIDAL's API: ${url.href}`);
    }
    const headers = new Headers(init.headers);
    const request: FakeRequest = {
      method: init.method ?? "GET",
      path: url.pathname.slice(new URL(BASE).pathname.length),
      query: url.searchParams,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      key: headers.get("Idempotency-Key") ?? undefined,
    };
    this.requests.push(request);
    // As the network does: other requests get in between.
    await Promise.resolve();
    const answer = this.#answer(request, headers);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers,
    });
  }) as typeof fetch;

  #answer(request: FakeRequest, headers: Headers): Answer {
    if (headers.get("Authorization") !== `Bearer ${this.token}`) {
      return refusal(401);
    }
    const instead = this.instead.shift();
    if (instead !== undefined) {
      return instead;
    }
    if (request.method === "GET") {
      return this.#handle(request);
    }
    if (request.key === undefined || request.key.length > 128) {
      return refusal(400, "NO_KEY");
    }
    const signature = JSON.stringify([request.method, request.path, request.query.toString(), request.body]);
    const before = this.#replays.get(request.key);
    if (before !== undefined) {
      return before.signature === signature ? before.answer : refusal(422, "IDEMPOTENCY_KEY_REUSED");
    }
    const answer = this.#handle(request);
    this.#replays.set(request.key, { signature, answer });
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1;
      return refusal(503);
    }
    return answer;
  }

  #handle(request: FakeRequest): Answer {
    for (const [method, pattern, params, handler] of this.#routes) {
      const match = method === request.method ? pattern.exec(request.path) : null;
      if (match !== null) {
        for (const name of request.query.keys()) {
          if (!params.includes(name)) {
            return refusal(400, "UNKNOWN_PARAMETER");
          }
        }
        try {
          return handler(request, match.slice(1).map(decodeURIComponent));
        } catch (error) {
          if (error instanceof Refused) {
            return refusal(error.status, error.code);
          }
          throw error;
        }
      }
    }
    return refusal(404);
  }

  readonly #routes: Array<[string, RegExp, readonly string[], Handler]> = [
    ["GET", /^\/users\/me$/, ["include"], () => document({ type: "users", ...this.user })],
    ["GET", /^\/playlists$/, ["countryCode", "filter[owners.id]", "include", "page[cursor]", "sort"], (r) => this.#myPlaylists(r)],
    ["POST", /^\/playlists$/, [], (r) => this.#createPlaylist(r)],
    ["GET", /^\/playlists\/([^/]+)$/, ["countryCode", "include"], (r, [id]) => this.#single(r, this.#playlist(id!))],
    ["PATCH", /^\/playlists\/([^/]+)$/, [], (r, [id]) => this.#updatePlaylist(r, id!)],
    ["DELETE", /^\/playlists\/([^/]+)$/, [], (_, [id]) => this.#deletePlaylist(id!)],
    [
      "GET",
      /^\/playlists\/([^/]+)\/relationships\/items$/,
      ["countryCode", "include", "page[cursor]", "sort"],
      (r, [id]) => this.#list(r, this.#playlist(id!), "items"),
    ],
    ["POST", /^\/playlists\/([^/]+)\/relationships\/items$/, [], (r, [id]) => this.#addItems(r, id!)],
    ["DELETE", /^\/playlists\/([^/]+)\/relationships\/items$/, [], (r, [id]) => this.#removeItems(r, id!)],
    ["PATCH", /^\/playlists\/([^/]+)\/relationships\/items$/, [], (r, [id]) => this.#moveItems(r, id!)],
    ["GET", /^\/tracks$/, ["countryCode", "filter[isrc]", "include", "page[cursor]"], (r) => this.#tracksByIsrc(r)],
    [
      "GET",
      /^\/(tracks|videos|albums|artists)\/([^/]+)$/,
      ["countryCode", "include"],
      (r, [type, id]) => this.#single(r, this.#known(type!, id!)),
    ],
    [
      "GET",
      /^\/artists\/([^/]+)\/relationships\/tracks$/,
      ["countryCode", "include", "page[cursor]", "collapseBy"],
      (r, [id]) => {
        if (!["FINGERPRINT", "NONE"].includes(r.query.get("collapseBy") ?? "")) {
          throw new Refused(400, "NO_COLLAPSE");
        }
        return this.#list(r, this.#known("artists", id!), "tracks");
      },
    ],
    [
      "GET",
      /^\/(artists|albums)\/([^/]+)\/relationships\/(albums|similarArtists|items)$/,
      ["countryCode", "include", "page[cursor]"],
      (r, [type, id, name]) => this.#list(r, this.#known(type!, id!), name!),
    ],
    [
      "GET",
      /^\/searchResults$/,
      ["countryCode", "filter[query]", "include"],
      (r) => {
        const query = r.query.get("filter[query]") ?? "";
        if (query.length < 1 || query.length > 256) {
          throw new Refused(400, "BAD_QUERY");
        }
        return this.#several(r, [this.#found(query)]);
      },
    ],
    [
      "GET",
      /^\/searchResults\/([^/]+)\/relationships\/(tracks|albums|artists)$/,
      ["countryCode", "include", "page[cursor]"],
      (r, [id, name]) => this.#list(r, this.#found(Buffer.from(id!, "base64").toString()), name!),
    ],
    [
      "GET",
      /^\/(userCollection\w+)\/me\/relationships\/items$/,
      ["include", "locale", "page[cursor]", "sort"],
      (r, [name]) => {
        const type = COLLECTIONS[name!]!;
        const newestFirst = [...this.collections[type]!].reverse();
        const me = { type: name!, id: "me", attributes: {}, related: { items: newestFirst } };
        return this.#list(r, me, "items", [type]);
      },
    ],
    ["POST", /^\/(userCollection\w+)\/me\/relationships\/items$/, [], (r, [name]) => this.#collect(r, COLLECTIONS[name!]!)],
    ["DELETE", /^\/(userCollection\w+)\/me\/relationships\/items$/, [], (r, [name]) => this.#uncollect(r, COLLECTIONS[name!]!)],
  ];

  // ---- Reading ----

  #known(type: string, id: string): Resource {
    const resource = this.#catalogue.get(`${type}:${id}`);
    if (resource === undefined || this.hidden.has(`${type}:${id}`)) {
      throw new Refused(404);
    }
    return resource;
  }

  #playlist(id: string): Resource {
    const playlist = this.playlists.get(id);
    if (playlist === undefined) {
      throw new Refused(404);
    }
    const { items, owner, ...attributes } = playlist;
    return {
      type: "playlists",
      id,
      attributes: {
        ...attributes,
        bounded: true,
        playlistType: "USER",
        numberOfItems: items.length,
        numberOfTrackItems: items.filter((item) => item.type === "tracks").length,
        externalLinks: [{ href: `https://tidal.com/playlist/${id}`, meta: { type: "TIDAL_SHARING" } }],
      },
      related: { items, owners: [{ type: "users", id: owner }] },
    };
  }

  /** Everything whose title or name holds the query. */
  #found(query: string): Resource {
    const of = (type: string, field: string): Ref[] =>
      [...this.#catalogue.values()]
        .filter((r) => r.type === type && String(r.attributes[field]).toLowerCase().includes(query.toLowerCase()))
        .map(({ id }) => ({ type, id }));
    return {
      type: "searchResults",
      id: Buffer.from(query).toString("base64"),
      attributes: { query, trackingId: "t" },
      related: { tracks: of("tracks", "title"), albums: of("albums", "title"), artists: of("artists", "name") },
    };
  }

  #single(request: FakeRequest, resource: Resource): Answer {
    const { data, included } = this.#resources(request, [resource]);
    return { status: 200, body: { data: data[0], included, links: { self: request.path } } };
  }

  #several(request: FakeRequest, resources: Resource[]): Answer {
    const { slice, links } = this.#page(request, resources);
    return { status: 200, body: { ...this.#resources(request, slice), links } };
  }

  #myPlaylists(request: FakeRequest): Answer {
    if (request.query.get("filter[owners.id]") !== "me") {
      throw new Refused(400, "NO_FILTER");
    }
    const mine = [...this.playlists].filter(([, playlist]) => playlist.owner === this.user.id);
    return this.#several(request, mine.reverse().map(([id]) => this.#playlist(id)));
  }

  #tracksByIsrc(request: FakeRequest): Answer {
    const wanted = (request.query.get("filter[isrc]") ?? "").split(",").filter((isrc) => isrc.length > 0);
    if (wanted.length < 1 || wanted.length > 20) {
      throw new Refused(400, "BAD_FILTER");
    }
    const of = (isrc: string) =>
      [...this.#catalogue.values()].filter((r) => r.type === "tracks" && r.attributes["isrc"] === isrc);
    if (wanted.length === 1) {
      return this.#several(request, of(wanted[0]!));
    }
    const one = wanted.flatMap((isrc) => of(isrc).slice(0, 1));
    return { status: 200, body: { ...this.#resources(request, one), links: { self: request.path } } };
  }

  /** A to-many relationship's own endpoint. */
  #list(request: FakeRequest, resource: Resource, name: string, targets = TARGETS[name]!): Answer {
    const { slice, links } = this.#page(request, resource.related[name] ?? []);
    const body: Record<string, unknown> = { data: slice, links };
    const include = includesOf(request);
    if (include.length > 0) {
      const world = new Map<string, Resource & { asked: Set<string> }>();
      for (const [first, ...rest] of include) {
        if (first !== name) {
          throw new Refused(400, "BAD_INCLUDE");
        }
        this.#include(slice, rest, targets, world);
      }
      body["included"] = [...world.values()].map((r) => this.#render(r, r.asked));
    }
    return { status: 200, body };
  }

  /** Resource objects, with the relationships that were asked for. */
  #resources(request: FakeRequest, resources: Resource[]): { data: unknown[]; included: unknown[] } {
    const world = new Map<string, Resource & { asked: Set<string> }>();
    const asked = new Set<string>();
    for (const [first, ...rest] of includesOf(request)) {
      for (const resource of resources) {
        if (!RELATIONSHIPS[resource.type]?.includes(first!)) {
          throw new Refused(400, "BAD_INCLUDE");
        }
        const shown = (resource.related[first!] ?? []).slice(0, this.pageSize);
        this.#include(shown, rest, TARGETS[first!]!, world);
      }
      asked.add(first!);
    }
    return {
      data: resources.map((resource) => this.#render(resource, asked)),
      included: [...world.values()].map((r) => this.#render(r, r.asked)),
    };
  }

  /** Follow an include path from what it has reached. */
  #include(refs: Ref[], path: string[], types: readonly string[], world: Map<string, Resource & { asked: Set<string> }>): void {
    const [segment, ...rest] = path;
    const [qualifier, name] = segment?.includes(":") ? segment.split(":") : [undefined, segment];
    const scope = qualifier === undefined ? types : types.filter((type) => type === qualifier);
    if (name !== undefined && (scope.length === 0 || scope.some((type) => !RELATIONSHIPS[type]?.includes(name)))) {
      throw new Refused(400, "BAD_INCLUDE");
    }
    for (const ref of refs) {
      const key = `${ref.type}:${ref.id}`;
      const resource = this.#catalogue.get(key);
      if (resource === undefined || this.hidden.has(key)) {
        continue;
      }
      const shown = world.get(key) ?? { ...resource, asked: new Set<string>() };
      world.set(key, shown);
      if (name !== undefined && scope.includes(ref.type)) {
        shown.asked.add(name);
        this.#include(resource.related[name] ?? [], rest, TARGETS[name]!, world);
      }
    }
    if (refs.length === 0 && name !== undefined) {
      // A bad path is refused even where there is nothing to follow it from.
      this.#checkPath(rest, TARGETS[name]!);
    }
  }

  #checkPath(path: string[], types: readonly string[]): void {
    const [name, ...rest] = path;
    if (name !== undefined) {
      if (types.some((type) => !RELATIONSHIPS[type]?.includes(name))) {
        throw new Refused(400, "BAD_INCLUDE");
      }
      this.#checkPath(rest, TARGETS[name]!);
    }
  }

  #render(resource: Resource, asked: ReadonlySet<string>): unknown {
    const relationships: Record<string, unknown> = {};
    for (const name of asked) {
      const self = `/${resource.type}/${encodeURIComponent(resource.id)}/relationships/${name}`;
      const all = resource.related[name] ?? [];
      relationships[name] = {
        data: all.slice(0, this.pageSize),
        links: { self, ...this.#nextLinks(self, all.length, 0) },
      };
    }
    return {
      type: resource.type,
      id: resource.id,
      attributes: resource.attributes,
      ...(asked.size > 0 && { relationships }),
    };
  }

  #page<T>(request: FakeRequest, all: readonly T[]): { slice: T[]; links: unknown } {
    const cursor = request.query.get("page[cursor]");
    const at = cursor === null ? 0 : Number(/^\+(\d+)\/=$/.exec(cursor)?.[1] ?? NaN);
    if (Number.isNaN(at)) {
      throw new Refused(400, "BAD_CURSOR");
    }
    const others = new URLSearchParams(request.query);
    others.delete("page[cursor]");
    const self = `${request.path}?${others.toString()}`;
    return {
      slice: all.slice(at, at + this.pageSize),
      links: { self, ...this.#nextLinks(self, all.length, at) },
    };
  }

  #nextLinks(self: string, total: number, at: number): Record<string, unknown> {
    const next = at + this.pageSize;
    if (next >= total) {
      return {};
    }
    // Opaque, and in need of encoding.
    const nextCursor = `+${next}/=`;
    const join = self.includes("?") ? "&" : "?";
    return { next: `${self}${join}page[cursor]=${encodeURIComponent(nextCursor)}`, meta: { nextCursor } };
  }

  // ---- Writing ----

  #own(id: string): FakePlaylist {
    const playlist = this.playlists.get(id);
    // What cannot be accessed behaves as if it did not exist.
    if (playlist === undefined || playlist.owner !== this.user.id) {
      throw new Refused(404);
    }
    return playlist;
  }

  #entry(item: Ref): FakePlaylist["items"][number] {
    const n = this.#next++;
    const addedAt = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
    return { type: item.type, id: item.id, meta: { itemId: `item-${n}`, addedAt } };
  }

  #createPlaylist(request: FakeRequest): Answer {
    const { type, attributes } = request.body.data;
    if (type !== "playlists") {
      throw new Refused(400);
    }
    checkAttributes(attributes, true);
    const id = this.seedPlaylist(attributes.name, []);
    Object.assign(this.playlists.get(id)!, { accessType: "PUBLIC" }, attributes);
    return { status: 201, body: { data: this.#render(this.#playlist(id), new Set()), links: { self: "/playlists" } } };
  }

  #updatePlaylist(request: FakeRequest, id: string): Answer {
    const { data } = request.body;
    if (data.type !== "playlists" || data.id !== id) {
      throw new Refused(400);
    }
    checkAttributes(data.attributes, false);
    Object.assign(this.#own(id), data.attributes);
    return { status: 200, body: { data: this.#render(this.#playlist(id), new Set()), links: { self: "/" } } };
  }

  #deletePlaylist(id: string): Answer {
    this.#own(id);
    this.playlists.delete(id);
    return done();
  }

  #addItems(request: FakeRequest, id: string): Answer {
    const playlist = this.#own(id);
    const data = batch(request, 50, ["tracks", "videos"]);
    const { onDuplicates = "ADD", positionBefore } = request.body.meta ?? {};
    const present = new Set(this.contents(id));
    const there = (ref: Ref) => present.has(`${ref.type}:${ref.id}`);
    if (onDuplicates === "FAIL" && data.some(there)) {
      throw new Refused(409, "DUPLICATE_ITEMS_IN_PLAYLIST");
    }
    const skipped: unknown[] = [];
    const added: FakePlaylist["items"] = [];
    for (const ref of data) {
      const key = `${ref.type}:${ref.id}`;
      if (!this.#catalogue.has(key) || this.unavailable.has(key)) {
        skipped.push({ type: ref.type, id: ref.id, reason: "NOT_FOUND" });
      } else if (onDuplicates === "SKIP" && there(ref)) {
        skipped.push({ type: ref.type, id: ref.id, reason: "ALREADY_PRESENT" });
      } else {
        added.push(this.#entry(ref));
      }
    }
    if (playlist.items.length + added.length > this.maxPlaylistItems) {
      throw new Refused(409, "TOO_MANY_ITEMS_IN_PLAYLIST");
    }
    playlist.items.splice(this.#placeOf(playlist, positionBefore), 0, ...added);
    return { status: 200, body: { data: added, links: { self: request.path }, meta: { skipped } } };
  }

  #placeOf(playlist: FakePlaylist, before: string | undefined): number {
    if (before === undefined) {
      return playlist.items.length;
    }
    const place = playlist.items.findIndex((item) => item.meta.itemId === before);
    if (place < 0) {
      throw new Refused(400, "BAD_POSITION");
    }
    return place;
  }

  /** The entries a request names: by item id, which must be that resource's. */
  #named(playlist: FakePlaylist, data: Ref[]): FakePlaylist["items"] {
    return data.flatMap((ref) => {
      const entry = playlist.items.find((item) => item.meta.itemId === ref.meta?.["itemId"]);
      if (entry === undefined) {
        if (this.ignoresGoneEntries) {
          return [];
        }
        throw new Refused(404);
      }
      if (entry.type !== ref.type || entry.id !== ref.id) {
        throw new Refused(400, "ITEM_MISMATCH");
      }
      return entry;
    });
  }

  #removeItems(request: FakeRequest, id: string): Answer {
    const playlist = this.#own(id);
    const gone = this.#named(playlist, batch(request, 50, ["tracks", "videos"], true));
    playlist.items = playlist.items.filter((item) => !gone.includes(item));
    return done();
  }

  #moveItems(request: FakeRequest, id: string): Answer {
    const playlist = this.#own(id);
    const moving = this.#named(playlist, batch(request, 20, ["tracks", "videos"], true));
    const { meta } = request.body;
    if (meta !== undefined && meta.positionBefore === undefined && meta.mode === undefined) {
      throw new Refused(400, "BAD_META");
    }
    if (moving.some((item) => item.meta.itemId === meta?.positionBefore)) {
      throw new Refused(400, "BAD_POSITION");
    }
    const place = this.#placeOf(playlist, meta?.positionBefore);
    const before = playlist.items.slice(0, place).filter((item) => !moving.includes(item));
    const after = playlist.items.slice(place).filter((item) => !moving.includes(item));
    playlist.items = [...before, ...moving, ...after];
    return done();
  }

  #collect(request: FakeRequest, type: string): Answer {
    const list = this.collections[type]!;
    const skipped: unknown[] = [];
    const data = batch(request, 50, [type]);
    const added = data.filter((ref) => {
      const known = this.#catalogue.has(`${type}:${ref.id}`);
      const present = list.some((item) => item.id === ref.id);
      if (!known || present) {
        skipped.push({ type, id: ref.id, reason: known ? "ALREADY_PRESENT" : "NOT_FOUND" });
      }
      return known && !present;
    });
    for (const ref of added) {
      list.push({ type, id: ref.id, meta: { addedAt: this.#entry(ref).meta.addedAt } });
    }
    return { status: 200, body: { data: added, links: { self: request.path }, meta: { skipped } } };
  }

  #uncollect(request: FakeRequest, type: string): Answer {
    const gone = new Set(batch(request, 50, [type]).map((ref) => ref.id));
    this.collections[type] = this.collections[type]!.filter((item) => !gone.has(item.id));
    return done();
  }
}

function document(resource: { type: string; id: string; attributes: unknown }): Answer {
  return { status: 200, body: { data: resource, links: { self: "/" } } };
}

const done = (): Answer => ({ status: 200, body: { links: { self: "/" } } });

function refusal(status: number, code?: string): Answer {
  return { status, body: { errors: [{ status: String(status), ...(code !== undefined && { code }) }] } };
}

function includesOf(request: FakeRequest): string[][] {
  const paths = (request.query.get("include") ?? "").split(",").filter((path) => path.length > 0);
  const split = paths.map((path) => path.split("."));
  if (split.some((path) => path.length > 3)) {
    throw new Refused(400, "INCLUDE_TOO_DEEP");
  }
  return split;
}

/** A mutation's identifiers, within the limits the document sets. */
function batch(request: FakeRequest, max: number, types: string[], withItemId = false): Ref[] {
  const data: Ref[] = request.body?.data ?? [];
  const bad = (ref: Ref) =>
    !types.includes(ref.type) ||
    typeof ref.id !== "string" ||
    ref.id.length === 0 ||
    (withItemId && typeof ref.meta?.["itemId"] !== "string");
  if (data.length < 1 || data.length > max || data.some(bad)) {
    throw new Refused(400, "BAD_DATA");
  }
  return data;
}

function checkAttributes(attributes: Record<string, unknown>, creating: boolean): void {
  const { name, description, accessType, ...others } = attributes;
  const bad =
    (name === undefined ? creating : typeof name !== "string" || name.length < 1 || name.length > 250) ||
    (description !== undefined && (typeof description !== "string" || description.length > 500)) ||
    (accessType !== undefined && accessType !== "PUBLIC" && accessType !== "UNLISTED") ||
    Object.keys(others).length > 0;
  if (bad) {
    throw new Refused(400, "BAD_ATTRIBUTES");
  }
}
