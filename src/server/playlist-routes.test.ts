import { describe, expect, it, vi } from "vitest";

import { FakeAccount, MemoryStore } from "../features/fake-account.test-support.js";
import { Journal, recordingClient } from "../features/journal.js";
import type { Playlist } from "../qobuz/index.js";
import { handleApi, type ApiDeps, type QobuzApiService } from "./router.js";

const PORT = 4321;
const NONCE = "nonce";

/** An account behind the API, with the given jobs. */
function setup(jobs: unknown[] = []) {
  const account = new FakeAccount();
  const owners = new Map<number, number>();
  const read = account.getPlaylist.bind(account);
  account.getPlaylist = async (id: number): Promise<Playlist> => ({ ...(await read(id)), ownerId: owners.get(id) ?? 1 });
  const extra = Object.assign(account, {
    getFavoriteTracks: async () => account.favourites.tracks.map((id) => ({ id, title: `Track ${id}`, duration: 3 })),
    searchArtists: async () => [],
    getArtist: async (id: number) => ({ id, name: "Linked" }),
  });
  const journal = new Journal({ store: new MemoryStore(), source: "web" });
  const lock = { release: vi.fn() };
  const acquireWriteLock = vi.fn(async (): Promise<{ release(): void } | undefined> => lock);
  const deps: ApiDeps = {
    service: recordingClient(extra, journal) as unknown as QobuzApiService,
    session: { displayName: "A", subscriptionLabel: "Studio" },
    nonce: NONCE,
    port: PORT,
    history: { journal },
    ownerId: 1,
    acquireWriteLock,
    jobs: { service: { list: () => ({ jobs, invalid: [], flags: {} }) } } as unknown as NonNullable<ApiDeps["jobs"]>,
  };
  const call = (method: string, path: string, body?: unknown) =>
    handleApi(
      {
        method,
        path: `/api/manager/${path}`,
        headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, nonce: NONCE },
        body,
      },
      deps,
    );
  return { account, owners, journal, lock, acquireWriteLock, call, deps };
}

const job = (name: string, playlistId: number, rest: Record<string, unknown> = {}) => ({
  job: { name, target: { type: "adopted", playlistId }, edits: "respect", tidy: {}, ...rest },
  state: {},
});

describe("reading", () => {
  it("lists playlists with who owns and manages them", async () => {
    const world = setup([]);
    const a = world.account.seedPlaylist("A", [1]);
    const b = world.account.seedPlaylist("B", []);
    world.account.getUserPlaylists = async () => [
      { id: a, name: "A", ownerId: 1 },
      { id: b, name: "B", ownerId: 2 },
    ];
    world.deps.jobs!.service.list = () =>
      ({
        jobs: [
          job("Tidy A", a),
          job("Mix", 999, { source: { type: "follow", playlistId: a }, edits: "mirror" }),
        ],
        invalid: [],
        flags: {},
      }) as never;
    const res = await world.call("GET", "playlists");
    expect(res.body).toEqual({
      playlists: [
        { id: a, name: "A", ownerId: 1, owned: true, managed: { jobName: "Tidy A", mode: "tidy" }, readBy: ["Mix"] },
        { id: b, name: "B", ownerId: 2, owned: false, readBy: [] },
      ],
    });
    expect(world.acquireWriteLock).not.toHaveBeenCalled();
  });

  it("still lists when the jobs file cannot be read", async () => {
    const { call, deps } = setup();
    deps.jobs!.service.list = () => {
      throw new Error("broken");
    };
    expect((await call("GET", "playlists")).status).toBe(200);
  });

  it("opens a playlist with its entries", async () => {
    const { account, call } = setup();
    const id = account.seedPlaylist("A", [5, 5]);
    const res = await call("POST", "open", { playlistId: id });
    expect(res.body).toMatchObject({ playlist: { id, name: "A", owned: true }, entries: [{ id: 5 }, { id: 5 }] });
    expect((await call("POST", "open", { playlistId: "1" })).status).toBe(400);
    expect((await call("POST", "open", { playlistId: 12345 })).status).toBe(502);
  });

  it("compares with the favourites or a playlist, sending only what matching needs", async () => {
    const { account, call } = setup();
    account.favourites.tracks = [3];
    expect((await call("POST", "compare", { favourites: true })).body).toEqual({ tracks: [{ id: 3, title: "Track 3" }] });
    const id = account.seedPlaylist("A", [4]);
    expect((await call("POST", "compare", { playlistId: id })).body).toEqual({ tracks: [{ id: 4, title: "Track 4" }] });
    expect((await call("POST", "compare", {})).status).toBe(400);
  });

  it("looks up artist links", async () => {
    const { call } = setup();
    const line = "https://play.qobuz.com/artist/7";
    expect((await call("POST", "artist-links", { lines: [line, "Tricky"] })).body).toEqual({
      links: [{ line, artist: { id: 7, name: "Linked" } }],
    });
    expect((await call("POST", "artist-links", { lines: [] })).status).toBe(400);
  });

  it("finds artists across playlists", async () => {
    const { account, call } = setup();
    const id = account.seedPlaylist("A", [1]);
    const res = await call("POST", "remove-artists/resolve", { playlistIds: [id, id], lines: ["Nobody"] });
    expect(res.body).toMatchObject({
      artists: [{ name: "Nobody", main: 0 }],
      playlists: [{ playlist: { id, name: "A" }, hits: [] }],
    });
    expect((await call("POST", "remove-artists/resolve", { playlistIds: [], lines: ["x"] })).status).toBe(400);
    expect((await call("POST", "remove-artists/resolve", { playlistIds: [id], lines: [" "] })).status).toBe(400);
  });

  it("answers 404 to anything else", async () => {
    const { call } = setup();
    expect((await call("GET", "save")).status).toBe(404);
    expect((await call("POST", "nope")).status).toBe(404);
  });
});

describe("saving", () => {
  it("saves as one history entry, under the lock", async () => {
    const { account, journal, lock, acquireWriteLock, call } = setup();
    const id = account.seedPlaylist("A", [1, 2, 3]);
    const base = account.entryIds(id);
    const res = await call("POST", "save", { playlistId: id, base, order: [base[2], base[0]], remove: [base[1]] });
    expect(res).toMatchObject({ status: 200, body: { status: "saved", removed: 1, reordered: true } });
    expect(account.trackIds(id)).toEqual([3, 1]);
    expect(journal.items().map((item) => item.tool)).toEqual(["playlist-manager"]);
    expect(acquireWriteLock).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("says when the playlist has changed, and writes nothing", async () => {
    const { account, journal, call } = setup();
    const id = account.seedPlaylist("A", [1, 2]);
    const base = account.entryIds(id);
    await account.addTracksToPlaylist(id, [3]);
    const res = await call("POST", "save", { playlistId: id, base, order: [base[0]], remove: [base[1]] });
    expect(res).toMatchObject({ status: 200, body: { status: "changed", drift: { added: 1 } } });
    expect(journal.items()).toEqual([]);
  });

  it("refuses while a refresh is running", async () => {
    const { account, acquireWriteLock, call } = setup();
    const id = account.seedPlaylist("A", [1]);
    acquireWriteLock.mockResolvedValueOnce(undefined);
    const res = await call("POST", "save", { playlistId: id, base: account.entryIds(id), order: [], remove: account.entryIds(id) });
    expect(res.status).toBe(409);
    expect(account.trackIds(id)).toEqual([1]);
  });

  it("releases the lock when saving fails", async () => {
    const { account, lock, call } = setup();
    const id = account.seedPlaylist("A", [1]);
    account.failAfter("getPlaylistTracks", 0);
    expect((await call("POST", "save", { playlistId: id, base: account.entryIds(id), order: account.entryIds(id) })).status).toBe(502);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a playlist of someone else's, and requests that do not add up", async () => {
    const { account, owners, call } = setup();
    const id = account.seedPlaylist("A", [1]);
    const base = account.entryIds(id);
    for (const body of [
      { playlistId: id, base, order: [] },
      { playlistId: id, base: ["x"], order: base },
      { playlistId: id, base, order: base, moves: {} },
      { playlistId: id, base, order: [], moves: [{ destination: { type: "elsewhere" }, entries: base }] },
      { playlistId: id, base, order: [], moves: [{ destination: { type: "new", name: " " }, entries: base }] },
      null,
    ]) {
      expect((await call("POST", "save", body)).status).toBe(400);
    }
    owners.set(id, 2);
    const res = await call("POST", "save", { playlistId: id, base, order: [], remove: base });
    expect(res.status).toBe(403);
    expect(account.trackIds(id)).toEqual([1]);
  });

  it("moves songs to another playlist of the user's, but not to a mirrored one", async () => {
    const world = setup();
    const { account, call, deps } = world;
    const id = account.seedPlaylist("A", [1, 2]);
    const other = account.seedPlaylist("Other", []);
    const base = account.entryIds(id);
    const body = {
      playlistId: id,
      base,
      order: [base[1]],
      moves: [{ destination: { type: "existing", playlistId: other, name: "lies" }, entries: [base[0]] }],
    };
    deps.jobs!.service.list = () =>
      ({ jobs: [job("M", other, { source: { type: "follow", playlistId: 9 }, edits: "mirror" })], invalid: [], flags: {} }) as never;
    expect((await call("POST", "save", body)).status).toBe(400);
    expect(account.trackIds(id)).toEqual([1, 2]);

    deps.jobs!.service.list = () => ({ jobs: [], invalid: [], flags: {} }) as never;
    expect(await call("POST", "save", body)).toMatchObject({ body: { moved: [{ name: "Other", added: [1] }] } });
    expect(account.trackIds(other)).toEqual([1]);
  });
});

describe("the other writes", () => {
  it("copies songs, skipping those already there", async () => {
    const { account, call } = setup();
    const id = account.seedPlaylist("A", [1]);
    account.unplayable.add(3);
    const res = await call("POST", "copy", { trackIds: [1, 2, 2, 3], destination: { type: "existing", playlistId: id } });
    expect(res.body).toMatchObject({ name: "A", added: [2], already: [1], missing: [3] });
    expect(account.trackIds(id)).toEqual([1, 2]);
    expect((await call("POST", "copy", { trackIds: [], destination: { type: "new", name: "X" } })).status).toBe(400);
  });

  it("copies to a new playlist", async () => {
    const { account, call } = setup();
    const res = await call("POST", "copy", { trackIds: [2], destination: { type: "new", name: " Split ", isPublic: true } });
    const { playlistId } = res.body as { playlistId: number };
    expect(account.playlists.get(playlistId)).toMatchObject({ name: "Split", isPublic: true });
  });

  it("favourites songs that are not favourites yet", async () => {
    const { account, journal, call } = setup();
    account.favourites.tracks = [4];
    expect((await call("POST", "favourite", { trackIds: [4, 4, 5] })).body).toEqual({ added: 1, already: 1 });
    expect(account.favourites.tracks).toEqual([4, 5]);
    // Only what was new is recorded, so undo leaves the older favourite alone.
    expect(journal.items()[0]?.ops).toEqual([{ kind: "add-favourites", type: "tracks", ids: [5] }]);
  });

  it("renames and changes visibility, undoably", async () => {
    const { account, journal, call } = setup();
    const id = account.seedPlaylist("A", []);
    const res = await call("POST", "update", { playlistId: id, name: " B ", isPublic: true });
    expect(res.body).toMatchObject({ playlist: { id, name: "B", owned: true } });
    expect(journal.items()[0]?.label).toBe("Renamed A to B; made B public");
    for (const body of [{ playlistId: id }, { playlistId: id, name: "" }, { playlistId: id, isPublic: 1 }, { playlistId: id, description: 1 }]) {
      expect((await call("POST", "update", body)).status).toBe(400);
    }
  });

  it("duplicates and deletes", async () => {
    const { account, owners, call } = setup();
    const id = account.seedPlaylist("A", [1, 1]);
    const copy = (await call("POST", "duplicate", { playlistId: id, name: "A copy" })).body as { playlist: Playlist };
    expect(account.trackIds(copy.playlist.id)).toEqual([1, 1]);
    owners.set(id, 2);
    expect((await call("POST", "delete", { playlistId: id })).status).toBe(403);
    owners.set(id, 1);
    expect((await call("POST", "delete", { playlistId: id })).body).toEqual({ deleted: id });
    expect(account.playlists.has(id)).toBe(false);
  });

  it("removes artists' songs from several playlists in one entry, reporting failures", async () => {
    const { account, owners, journal, call } = setup();
    const a = account.seedPlaylist("A", [1, 2]);
    const b = account.seedPlaylist("B", [3]);
    const c = account.seedPlaylist("C", [4]);
    owners.set(b, 2);
    const res = await call("POST", "remove-artists/commit", {
      removals: [
        { playlistId: a, entries: [account.entryIds(a)[0]] },
        { playlistId: b, entries: account.entryIds(b) },
        { playlistId: c, entries: account.entryIds(c) },
      ],
    });
    expect(res.body).toMatchObject({ reports: [{ removed: 1 }, { removed: 0, error: expect.stringContaining("someone else") }, { removed: 1 }] });
    expect([account.trackIds(a), account.trackIds(b), account.trackIds(c)]).toEqual([[2], [3], []]);
    expect(journal.items()).toHaveLength(1);
    expect((await call("POST", "remove-artists/commit", { removals: [] })).status).toBe(400);
  });
});
