import { describe, expect, it, vi } from "vitest";

import { QobuzClient } from "../qobuz/index.js";
import { FakeAccount, MemoryStore } from "./fake-account.test-support.js";
import { parseHistory, type HistoryEntry, type Operation } from "./history.js";
import { Journal, MUTATING_METHODS, recordingClient } from "./journal.js";

function setup(options: { now?: () => Date } = {}) {
  const store = new MemoryStore();
  let n = 0;
  const journal = new Journal({
    store,
    source: "cli",
    now: options.now ?? (() => new Date("2026-11-02T20:00:00.000Z")),
    newId: () => `id${++n}`,
  });
  const account = new FakeAccount();
  const client = recordingClient(account, journal);
  return { store, journal, account, client };
}

function entriesOf(store: MemoryStore): HistoryEntry[] {
  return parseHistory(store.text).flatMap((r) => (r.type === "entry" ? [r] : []));
}

const createOp: Operation = { kind: "create-playlist", playlistId: 1, name: "Road Trip" };

describe("Journal", () => {
  it("writes one entry per run, labelled from its operations", async () => {
    const { store, journal } = setup();
    const result = await journal.run({ tool: "playlist-from-artists" }, async () => {
      journal.record(createOp);
      return 42;
    });
    expect(result).toBe(42);
    expect(entriesOf(store)).toEqual([
      {
        type: "entry",
        id: "id1",
        at: "2026-11-02T20:00:00.000Z",
        tool: "playlist-from-artists",
        source: "cli",
        label: "Created Road Trip",
        ops: [createOp],
      },
    ]);
  });

  it("uses an explicit label and hands the run its entry id", async () => {
    const { store, journal } = setup();
    let seen = "";
    await journal.run({ tool: "undo", label: "Undid: something", undoes: "x9" }, async (entry) => {
      seen = entry.id;
    });
    // An undo is written even when it had nothing left to change.
    expect(entriesOf(store)).toEqual([
      expect.objectContaining({ id: seen, label: "Undid: something", undoes: "x9", ops: [] }),
    ]);
  });

  it("writes nothing for a run that changed nothing", async () => {
    const { store, journal } = setup();
    await journal.run({ tool: "deduplicate" }, async () => {});
    expect(store.text).toBe("");
  });

  it("records what happened before a run failed, and rethrows", async () => {
    const { store, journal } = setup();
    await expect(
      journal.run({ tool: "import" }, async () => {
        journal.record({ kind: "add-favourites", type: "tracks", ids: [1, 2] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(entriesOf(store)).toEqual([
      expect.objectContaining({ tool: "import", error: "boom", ops: [expect.objectContaining({ ids: [1, 2] })] }),
    ]);
  });

  it("gives an operation made outside any run an entry of its own", () => {
    const { store, journal } = setup();
    journal.record(createOp);
    expect(entriesOf(store)).toEqual([expect.objectContaining({ tool: "other", ops: [createOp] })]);
  });

  it("keeps concurrent runs apart", async () => {
    const { store, journal } = setup();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      journal.run({ tool: "a" }, async () => {
        await tick();
        journal.record({ kind: "add-favourites", type: "tracks", ids: [1] });
        await tick();
        journal.record({ kind: "add-favourites", type: "tracks", ids: [2] });
      }),
      journal.run({ tool: "b" }, async () => {
        journal.record({ kind: "add-favourites", type: "albums", ids: ["x"] });
        await tick();
      }),
    ]);
    const byTool = Object.fromEntries(entriesOf(store).map((e) => [e.tool, e.ops.length]));
    expect(byTool).toEqual({ a: 2, b: 1 });
  });

  it("marks entries undone and folds them into items", async () => {
    const { journal } = setup();
    journal.record(createOp);
    journal.markUndone("id1", "id2");
    expect(journal.items()).toEqual([
      expect.objectContaining({ id: "id1", undone: { at: "2026-11-02T20:00:00.000Z", by: "id2" } }),
    ]);
  });

  it("compacts the file when a write takes it past the limits", () => {
    const store = new MemoryStore();
    let n = 0;
    const journal = new Journal({
      store,
      source: "web",
      now: () => new Date("2026-11-02T20:00:00.000Z"),
      newId: () => `id${++n}`,
      limits: { maxEntries: 2, maxAgeDays: 90 },
    });
    journal.record(createOp);
    journal.record(createOp);
    expect(store.replaces).toBe(0);
    journal.record(createOp);
    expect(store.replaces).toBe(1);
    expect(entriesOf(store).map((e) => e.id)).toEqual(["id2", "id3"]);
  });

  it("reports a failed write without failing the action", async () => {
    const onWriteError = vi.fn();
    const journal = new Journal({
      store: {
        read: () => "",
        append: () => {
          throw new Error("disk full");
        },
        replace: () => {},
      },
      source: "cli",
      onWriteError,
    });
    await expect(
      journal.run({ tool: "x" }, async () => {
        journal.record(createOp);
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(onWriteError).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }));
  });
});

describe("recordingClient", () => {
  it("classifies every QobuzClient method as recorded or not", () => {
    // A new client method must be added to one list or the other, so a write
    // can never bypass the history by accident.
    const notWrites = [
      "constructor",
      "init",
      "initFromCache",
      "loginWithOAuthCode",
      "loginWithToken",
      "getUserFavorites",
      "searchArtists",
      "searchAlbums",
      "searchTracks",
      "getSimilarArtists",
      "getArtistTopTracks",
      "getArtistReleases",
      "getFavoriteTracks",
      "getFavoriteAlbums",
      "getFavoriteArtists",
      "getUserPlaylists",
      "getPlaylistTracks",
      "getPlaylist",
      "getArtist",
      "getAlbum",
      "getAlbumReleaseDate",
      "getAlbumTracks",
      "appId",
      "isLoggedIn",
      "credentials",
    ];
    const methods = Object.getOwnPropertyNames(QobuzClient.prototype);
    const unclassified = methods.filter(
      (name) => !notWrites.includes(name) && !(MUTATING_METHODS as readonly string[]).includes(name),
    );
    expect(unclassified).toEqual([]);
    for (const name of MUTATING_METHODS) {
      expect(methods).toContain(name);
    }
  });

  it("passes reads and getters through, bound to the real client", async () => {
    class WithPrivate {
      #secret = 7;
      get value(): number {
        return this.#secret;
      }
      async getPlaylistTracks(): Promise<[]> {
        return this.#secret === 7 ? [] : [];
      }
    }
    const wrapped = recordingClient(new WithPrivate(), setup().journal);
    expect(wrapped.value).toBe(7);
    const read = wrapped.getPlaylistTracks;
    await expect(read()).resolves.toEqual([]);
  });

  it("records a created playlist and the entries added to it, without reading it first", async () => {
    const { store, journal, account, client } = setup();
    await journal.run({ tool: "playlist-from-artists" }, async () => {
      const playlist = await client.createPlaylist("Road Trip", { isPublic: false });
      await client.addTracksToPlaylist(playlist.id, [11, 12]);
    });
    const [id] = [...account.playlists.keys()];
    const [e1, e2] = account.entryIds(id!);
    expect(entriesOf(store)[0]).toMatchObject({
      label: "Created Road Trip with 2 tracks",
      ops: [
        { kind: "create-playlist", playlistId: id, name: "Road Trip", isPublic: false },
        {
          kind: "add-tracks",
          playlistId: id,
          entries: [
            { trackId: 11, playlistTrackId: e1, position: 0 },
            { trackId: 12, playlistTrackId: e2, position: 1 },
          ],
        },
      ],
    });
    // Known empty after creating it: one read, after the add.
    expect(account.calls.filter((c) => c.startsWith("getPlaylistTracks"))).toHaveLength(1);
  });

  it("records only the new entries of an existing playlist, with its name", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1, 2]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [3, 1]));
    const [, , e3, e4] = account.entryIds(id);
    expect(entriesOf(store)[0]).toMatchObject({
      label: "Added 2 tracks to Late Night",
      ops: [
        {
          kind: "add-tracks",
          playlistId: id,
          playlistName: "Late Night",
          entries: [
            { trackId: 3, playlistTrackId: e3, position: 2 },
            { trackId: 1, playlistTrackId: e4, position: 3 },
          ],
        },
      ],
    });
  });

  it("records what arrived when an add fails part-way, and rethrows", async () => {
    const { store, journal, account } = setup();
    const id = account.seedPlaylist("Late Night", [1]);
    // A client whose add lands the first track, then fails.
    const flaky = Object.assign(Object.create(account) as FakeAccount, {
      addTracksToPlaylist: async (playlistId: number, trackIds: readonly number[]) => {
        await account.addTracksToPlaylist(playlistId, trackIds.slice(0, 1));
        throw new Error("throttled");
      },
      getPlaylistTracks: (playlistId: number) => account.getPlaylistTracks(playlistId),
      getPlaylist: (playlistId: number) => account.getPlaylist(playlistId),
    });
    const client = recordingClient(flaky, journal);
    await expect(journal.run({ tool: "x" }, () => client.addTracksToPlaylist(id, [5, 6]))).rejects.toThrow(
      "throttled",
    );
    const entry = entriesOf(store)[0]!;
    expect(entry.error).toBe("throttled");
    expect(entry.ops).toEqual([
      expect.objectContaining({ entries: [{ trackId: 5, playlistTrackId: account.entryIds(id)[1], position: 1 }] }),
    ]);
  });

  it("keeps the track ids as unconfirmed when the playlist cannot be read back", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1]);
    await journal.run({ tool: "x" }, async () => {
      await client.getPlaylistTracks(id); // not recorded
      account.failAfter("getPlaylistTracks", 1); // the read before the add works, the one after fails
      await client.addTracksToPlaylist(id, [7]);
    });
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "add-tracks", playlistId: id, playlistName: "Late Night", entries: [], unconfirmed: [7] },
    ]);
  });

  it("matches the end of the playlist when it could not be read before adding", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1]);
    account.failAfter("getPlaylistTracks", 0);
    await journal.run({ tool: "x" }, () => client.addTracksToPlaylist(id, [7, 8]));
    const [, e7, e8] = account.entryIds(id);
    expect(entriesOf(store)[0]?.ops).toEqual([
      expect.objectContaining({
        entries: [
          { trackId: 7, playlistTrackId: e7, position: 1 },
          { trackId: 8, playlistTrackId: e8, position: 2 },
        ],
      }),
    ]);
  });

  it("records removed entries with their track and old position", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1, 2, 3, 2]);
    const [, e2, , e4] = account.entryIds(id);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [e4!, e2!]));
    expect(entriesOf(store)[0]).toMatchObject({
      label: "Removed 2 duplicates from Late Night",
      ops: [
        {
          kind: "remove-tracks",
          playlistId: id,
          entries: [
            { trackId: 2, playlistTrackId: e2, position: 1 },
            { trackId: 2, playlistTrackId: e4, position: 3 },
          ],
        },
      ],
    });
  });

  it("does not remove what it could not record", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1, 2]);
    const [e1] = account.entryIds(id);
    account.failAfter("getPlaylistTracks", 0);
    await expect(client.removeTracksFromPlaylist(id, [e1!])).rejects.toThrow();
    expect(account.trackIds(id)).toEqual([1, 2]);
    expect(store.text).toBe("");
  });

  it("records the batches of a removal that went through before one failed", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Big", Array.from({ length: 60 }, (_, i) => i + 1));
    const ids = account.entryIds(id);
    account.failAfter("removeTracksFromPlaylist", 1);
    await expect(journal.run({ tool: "x" }, () => client.removeTracksFromPlaylist(id, ids))).rejects.toThrow();
    const op = entriesOf(store)[0]?.ops[0];
    expect(op).toMatchObject({ kind: "remove-tracks" });
    expect(op?.kind === "remove-tracks" && op.entries.length).toBe(50);
    expect(account.trackIds(id)).toHaveLength(10);
  });

  it("records moves and reads the playlist afresh after one", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [1, 2]);
    const [, e2] = account.entryIds(id);
    await journal.run({ tool: "upgrade" }, async () => {
      await client.addTracksToPlaylist(id, [3]);
      await client.movePlaylistTracks!(id, [e2!], 1);
      await client.addTracksToPlaylist(id, [4]);
    });
    const ops = entriesOf(store)[0]?.ops ?? [];
    expect(ops.map((op) => op.kind)).toEqual(["add-tracks", "move-tracks", "add-tracks"]);
    expect(ops[1]).toEqual({
      kind: "move-tracks",
      playlistId: id,
      playlistName: "Late Night",
      playlistTrackIds: [e2],
      insertBefore: 1,
    });
    // before add 1, after add 1, before add 2 (the move invalidated it), after add 2.
    expect(account.calls.filter((c) => c.startsWith("getPlaylistTracks"))).toHaveLength(4);
  });

  it("records favourites added and removed, batch by batch", async () => {
    const { store, journal, account, client } = setup();
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    account.failAfter("addFavoriteTracks", 1);
    await expect(
      journal.run({ tool: "import" }, async () => {
        await client.addFavoriteAlbums(["a"]);
        await client.removeFavoriteArtists([9]);
        await client.addFavoriteTracks(ids);
      }),
    ).rejects.toThrow();
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "add-favourites", type: "albums", ids: ["a"] },
      { kind: "remove-favourites", type: "artists", ids: [9] },
      { kind: "add-favourites", type: "tracks", ids: ids.slice(0, 50) },
    ]);
  });

  it("records a deleted playlist's name and tracks", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Old", [4, 5]);
    await journal.run({ tool: "undo", label: "Undid: x" }, () => client.deletePlaylist!(id));
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "delete-playlist", playlistId: id, name: "Old", trackIds: [4, 5] },
    ]);
  });
});
