import { describe, expect, it, vi } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { ServiceHub } from "../services/hub.js";
import { tagId, type PlaylistId, type TrackId } from "../services/ids.js";
import { SpotifyClient } from "../services/spotify/client.js";
import { FakeSpotify } from "../services/spotify/fake-spotify.test-support.js";
import { SpotifyService } from "../services/spotify/service.js";
import { FakeQobuz } from "../services/qobuz/fake-qobuz.test-support.js";
import type { MusicService } from "../services/service.js";
import { addConfirmed } from "./playlist-add.js";
import { createPlaylistWithTracks } from "./playlist-from-artists.js";
import { QobuzService } from "../services/qobuz/service.js";
import { MUSIC_READS, MUSIC_WRITES } from "../services/service.js";
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

const createOp: Operation = { kind: "create-playlist", playlistId: qid(1), name: "Road Trip" };

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

  it("keeps a link id on the entry, and reads it back", async () => {
    const { store, journal } = setup();
    await journal.run({ tool: "link", label: "Synced Mix", link: "aaaaaaaa" }, async () => {
      journal.record(createOp);
    });
    expect(entriesOf(store)[0]?.link).toBe("aaaaaaaa");
    expect(journal.items()[0]?.link).toBe("aaaaaaaa");
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
        journal.record({ kind: "add-favourites", type: "tracks", ids: [qid(1), qid(2)] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(entriesOf(store)).toEqual([
      expect.objectContaining({ tool: "import", error: "boom", ops: [expect.objectContaining({ ids: [qid(1), qid(2)] })] }),
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
        journal.record({ kind: "add-favourites", type: "tracks", ids: [qid(1)] });
        await tick();
        journal.record({ kind: "add-favourites", type: "tracks", ids: [qid(2)] });
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

  it("keeps the lines it cannot read when it compacts, exactly as they were", () => {
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
    // Written by a newer crosstune, or damaged: not ours to throw away.
    const newer = '{"v":2,"type":"entry","id":"n1","at":"2026-11-02T19:00:00.000Z","ops":"something new"}';
    const unknownOp =
      '{"v":1,"type":"entry","id":"n2","at":"2026-11-02T19:30:00.000Z","tool":"x","source":"cli","label":"L","ops":[{"kind":"pin-playlist","playlistId":"qobuz:5"}]}';
    const itsMarker = '{"v":1,"type":"undone","id":"n2","by":"n3","at":"2026-11-02T19:40:00.000Z"}';
    const damaged = '{"v":1,"type":"entry","id":"n4","at":"2026-11-0';
    store.text += `${newer}\n${unknownOp}\n${itsMarker}\n${damaged}\n`;
    journal.record(createOp);
    expect(store.replaces).toBe(0);

    journal.record(createOp);

    expect(store.replaces).toBe(1);
    expect(entriesOf(store).map((e) => e.id)).toEqual(["id2", "id3"]);
    // Where they were: after the entry that went, before the ones that stay.
    expect(store.text.split("\n").slice(0, 4)).toEqual([newer, unknownOp, itsMarker, damaged]);
  });

  it("keeps what it does not know of an entry it can read when it compacts", () => {
    const store = new MemoryStore();
    const journal = new Journal({
      store,
      source: "web",
      now: () => new Date("2026-11-02T20:00:00.000Z"),
      limits: { maxEntries: 2, maxAgeDays: 90 },
    });
    const withMore =
      '{"v":1,"type":"entry","id":"m1","at":"2026-11-02T20:00:00.000Z","tool":"x","source":"cli","label":"L","ops":[],"somethingNewer":[1,2]}';
    const older =
      '{"v":1,"type":"entry","id":"o1","at":"2026-11-02T19:00:00.000Z","tool":"x","source":"cli","label":"L","ops":[]}';
    store.text = `${older}\n${withMore}\n`;
    journal.record(createOp);
    expect(store.replaces).toBe(1);
    expect(store.text).not.toContain(older);
    expect(store.text.split("\n")).toContain(withMore);
  });

  it("drops a line it cannot read once it is older than the history goes back", () => {
    const store = new MemoryStore();
    const journal = new Journal({
      store,
      source: "web",
      now: () => new Date("2026-11-02T20:00:00.000Z"),
      limits: { maxEntries: 5, maxAgeDays: 90 },
    });
    const old = '{"v":2,"type":"entry","id":"n1","at":"2026-06-01T00:00:00.000Z","ops":"something new"}';
    store.text = `${old}\n`;
    journal.record(createOp);
    expect(store.text).not.toContain(old);
    expect(entriesOf(store)).toHaveLength(1);
  });

  it("starts a new line after a last line that was cut off", () => {
    const { store, journal } = setup();
    store.text = '{"v":1,"type":"entry","id":"cut","at":"2026-11-0';
    journal.record(createOp);
    expect(entriesOf(store).map((e) => e.id)).toEqual(["id1"]);
  });

  it("compacts inside the store's exclusive section", () => {
    const store = new MemoryStore();
    let inside = false;
    let replacedInside = false;
    const locked = Object.assign(store, {
      exclusive<T>(fn: () => T): T {
        inside = true;
        try {
          return fn();
        } finally {
          inside = false;
        }
      },
    });
    const original = store.replace.bind(store);
    store.replace = (text: string) => {
      replacedInside = inside;
      original(text);
    };
    const journal = new Journal({
      store: locked,
      source: "web",
      now: () => new Date("2026-11-02T20:00:00.000Z"),
      limits: { maxEntries: 1, maxAgeDays: 90 },
    });
    journal.record(createOp);
    journal.record(createOp);
    expect(store.replaces).toBe(1);
    expect(replacedInside).toBe(true);
  });

  it("appends inside the store's exclusive section too", () => {
    let inside = false;
    let appendedInside = false;
    const store = new MemoryStore();
    const original = store.append.bind(store);
    store.append = (text: string) => {
      appendedInside = inside;
      original(text);
    };
    const locked = Object.assign(store, {
      exclusive<T>(fn: () => T): T {
        inside = true;
        try {
          return fn();
        } finally {
          inside = false;
        }
      },
    });
    const journal = new Journal({ store: locked, source: "web" });
    journal.record(createOp);
    expect(appendedInside).toBe(true);
  });

  it("appends instead of compacting while the store is busy", () => {
    const store = Object.assign(new MemoryStore(), { exclusive: () => undefined });
    const journal = new Journal({
      store,
      source: "web",
      now: () => new Date("2026-11-02T20:00:00.000Z"),
      limits: { maxEntries: 1, maxAgeDays: 90 },
    });
    journal.record(createOp);
    journal.record(createOp);
    expect(store.replaces).toBe(0);
    expect(store.appends).toBe(2);
    expect(entriesOf(store)).toHaveLength(2);
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
  it("records every write of a music service, and nothing it does not know", () => {
    // Every method must be classed as a read or a write (services/service.ts),
    // so a write can never bypass the history by accident.
    expect([...MUTATING_METHODS].sort()).toEqual([...MUSIC_WRITES].sort());
    const classified = new Set<string>([
      ...MUSIC_READS,
      ...MUSIC_WRITES,
      "constructor",
      "account",
      "capabilities",
      "connect",
      "disconnect",
      "connected",
      "service",
      "scoped",
      "all",
    ]);
    const view = new ServiceHub().scoped("qobuz");
    for (const prototype of [QobuzService.prototype, ServiceHub.prototype, Object.getPrototypeOf(view)]) {
      expect(Object.getOwnPropertyNames(prototype).filter((name) => !classified.has(name))).toEqual([]);
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
      await client.addTracksToPlaylist(playlist.id, [qid(11), qid(12)]);
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
            { trackId: qid(11), playlistTrackId: e1, position: 0 },
            { trackId: qid(12), playlistTrackId: e2, position: 1 },
          ],
        },
      ],
    });
    // Known empty after creating it: one read, after the add.
    expect(account.calls.filter((c) => c.startsWith("getPlaylistTracks"))).toHaveLength(1);
  });

  it("records only the new entries of an existing playlist, with its name", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(3), qid(1)]));
    const [, , e3, e4] = account.entryIds(id);
    expect(entriesOf(store)[0]).toMatchObject({
      label: "Added 2 tracks to Late Night",
      ops: [
        {
          kind: "add-tracks",
          playlistId: id,
          playlistName: "Late Night",
          entries: [
            { trackId: qid(3), playlistTrackId: e3, position: 2 },
            { trackId: qid(1), playlistTrackId: e4, position: 3 },
          ],
        },
      ],
    });
  });

  it("records what arrived when an add fails part-way, and rethrows", async () => {
    const { store, journal, account } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
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
    await expect(journal.run({ tool: "x" }, () => client.addTracksToPlaylist(id, [qid(5), qid(6)]))).rejects.toThrow(
      "throttled",
    );
    const entry = entriesOf(store)[0]!;
    expect(entry.error).toBe("throttled");
    expect(entry.ops).toEqual([
      expect.objectContaining({ entries: [{ trackId: qid(5), playlistTrackId: account.entryIds(id)[1], position: 1 }] }),
    ]);
  });

  it("keeps the track ids as unconfirmed when the playlist cannot be read back", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    await journal.run({ tool: "x" }, async () => {
      await client.getPlaylistTracks(id); // not recorded
      account.failAfter("getPlaylistTracks", 1); // the read before the add works, the one after fails
      await client.addTracksToPlaylist(id, [qid(7)]);
    });
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "add-tracks", playlistId: id, playlistName: "Late Night", entries: [], unconfirmed: [qid(7)] },
    ]);
  });

  it("matches the end of the playlist when it could not be read before adding", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    account.failAfter("getPlaylistTracks", 0);
    await journal.run({ tool: "x" }, () => client.addTracksToPlaylist(id, [qid(7), qid(8)]));
    const [, e7, e8] = account.entryIds(id);
    expect(entriesOf(store)[0]?.ops).toEqual([
      expect.objectContaining({
        entries: [
          { trackId: qid(7), playlistTrackId: e7, position: 1 },
          { trackId: qid(8), playlistTrackId: e8, position: 2 },
        ],
      }),
    ]);
  });

  it("records removed entries with their track and old position", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2), qid(3), qid(2)]);
    const [, e2, , e4] = account.entryIds(id);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [e4!, e2!]));
    expect(entriesOf(store)[0]).toMatchObject({
      label: "Removed 2 duplicates from Late Night",
      ops: [
        {
          kind: "remove-tracks",
          playlistId: id,
          entries: [
            { trackId: qid(2), playlistTrackId: e2, position: 1 },
            { trackId: qid(2), playlistTrackId: e4, position: 3 },
          ],
        },
      ],
    });
  });

  it("does not remove what it could not record", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2)]);
    const [e1] = account.entryIds(id);
    account.failAfter("getPlaylistTracks", 0);
    await expect(client.removeTracksFromPlaylist(id, [e1!])).rejects.toThrow();
    expect(account.trackIds(id)).toEqual([qid(1), qid(2)]);
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

  it("records moves with where their entries were, without reading it again", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2)]);
    const [, e2] = account.entryIds(id);
    await journal.run({ tool: "upgrade" }, async () => {
      await client.addTracksToPlaylist(id, [qid(3)]);
      await client.movePlaylistTracks!(id, [e2!], 1);
      await client.addTracksToPlaylist(id, [qid(4)]);
    });
    const ops = entriesOf(store)[0]?.ops ?? [];
    expect(ops.map((op) => op.kind)).toEqual(["add-tracks", "move-tracks", "add-tracks"]);
    expect(ops[1]).toEqual({
      kind: "move-tracks",
      playlistId: id,
      playlistName: "Late Night",
      playlistTrackIds: [e2],
      insertBefore: 1,
      from: [1],
      trackIds: [qid(2)],
    });
    // before add 1, after add 1, after add 2: the move's outcome is known.
    expect(account.calls.filter((c) => c.startsWith("getPlaylistTracks"))).toHaveLength(3);
  });

  it("takes a read of a playlist it has already changed as what is known of it", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2)]);
    await journal.run({ tool: "x" }, async () => {
      await client.addTracksToPlaylist(id, [qid(3)]);
      // Changed elsewhere meanwhile; the action reads the playlist again.
      await account.addTracksToPlaylist(id, [qid(9)]);
      await client.getPlaylistTracks(id);
      await client.addTracksToPlaylist(id, [qid(4)]);
    });
    const added = entriesOf(store)[0]!.ops.flatMap((op) => (op.kind === "add-tracks" ? op.entries : []));
    // Not the 9 that somebody else added.
    expect(added.map((e) => e.trackId)).toEqual([qid(3), qid(4)]);
  });

  describe("where entries have no ids of their own (Spotify)", () => {
    const P = tagId<PlaylistId>("spotify", "p");
    const song = (letter: string) => tagId<TrackId>("spotify", letter);

    function spotify(letters: string) {
      const store = new MemoryStore();
      const journal = new Journal({ store, source: "cli", now: () => new Date("2026-11-24T20:00:00.000Z") });
      const fake = new FakeSpotify();
      for (const letter of "abcxy") {
        fake.addTrack(letter);
      }
      fake.seedPlaylist("p", [...letters].map((letter) => `spotify:track:${letter}`));
      const service = new SpotifyService(
        new SpotifyClient({ tokens: fake.tokens, fetchImpl: fake.fetchImpl, sleep: async () => {} }),
      );
      const client = recordingClient(service, journal);
      const now = () => fake.uris("p").map((uri) => uri!.split(":")[2]).join("");
      const ids = async () => (await client.getPlaylistTracks(P)).map((t) => t.playlistTrackId!);
      return { store, journal, client, now, ids };
    }

    it("records only what an add put in, though a copy that stayed goes by a new id", async () => {
      const { store, journal, client, now, ids } = spotify("aba");
      await journal.run({ tool: "x" }, async () => {
        // Without a read in between: the copy that stays is still "a#2" to us.
        await client.removeTracksFromPlaylist(P, [(await ids())[0]!]);
        await client.addTracksToPlaylist(P, [song("x"), song("a")]);
      });
      expect(now()).toBe("baxa");
      const [removed, added] = entriesOf(store)[0]!.ops;
      expect(removed).toMatchObject({ kind: "remove-tracks", entries: [{ trackId: song("a"), position: 0 }] });
      // Read back, the "a" that stayed is "a#1": new as an id, not as an entry.
      expect(added).toMatchObject({
        kind: "add-tracks",
        entries: [
          { trackId: song("x"), position: 2 },
          { trackId: song("a"), position: 3 },
        ],
      });
      expect((added as Extract<Operation, { kind: "add-tracks" }>).entries).toHaveLength(2);
    });

    it("records a move named by the ids of a read made after its own removal", async () => {
      const { store, journal, client, now, ids } = spotify("abab");
      await journal.run({ tool: "x" }, async () => {
        await client.removeTracksFromPlaylist(P, [(await ids())[0]!]);
        // Read again: the last b is "b#2" still, the a before it "a#1" now.
        await client.movePlaylistTracks(P, [(await ids())[1]!], 1);
      });
      expect(now()).toBe("abb");
      expect(entriesOf(store)[0]!.ops).toMatchObject([
        { kind: "remove-tracks", entries: [{ trackId: song("a"), position: 0 }] },
        { kind: "move-tracks", from: [1], insertBefore: 1, trackIds: [song("a")] },
      ]);
    });
  });

  it("records a move's entries as positioned by the moves before it", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2), qid(3)]);
    const [e1, e2, e3] = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.movePlaylistTracks!(id, [e3!, qid(999)], 1);
      await client.movePlaylistTracks!(id, [e2!, e1!], 1);
    });
    const ops = entriesOf(store)[0]?.ops ?? [];
    expect(ops).toMatchObject([
      { kind: "move-tracks", playlistTrackIds: [e3], from: [2] },
      { kind: "move-tracks", playlistTrackIds: [e2, e1], from: [2, 1] },
    ]);
    expect(account.entryIds(id)).toEqual([e2, e1, e3]);
    expect(entriesOf(store)[0]?.label).toBe("Reordered Late Night");
  });

  it("records changed details as they were", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    await journal.run({ tool: "playlist-manager" }, () =>
      client.updatePlaylist!(id, { name: "Early Morning", isPublic: true, description: "Calm" }),
    );
    expect(entriesOf(store)[0]).toMatchObject({
      label:
        "Renamed Late Night to Early Morning; made Early Morning public; changed the description of Early Morning",
      ops: [
        {
          kind: "update-playlist",
          playlistId: id,
          before: { name: "Late Night", isPublic: false, description: "" },
          after: { name: "Early Morning", isPublic: true, description: "Calm" },
        },
      ],
    });
  });

  it("does not change details it could not record", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    account.failAfter("getPlaylist", 0);
    await expect(client.updatePlaylist!(id, { name: "X" })).rejects.toThrow();
    expect(account.playlists.get(id)?.name).toBe("Late Night");
    expect(journal.items()).toEqual([]);
  });

  it("records favourites added and removed, batch by batch", async () => {
    const { store, journal, account, client } = setup();
    const ids = Array.from({ length: 60 }, (_, i) => qid(i + 1));
    account.failAfter("addFavoriteTracks", 1);
    await expect(
      journal.run({ tool: "import" }, async () => {
        await client.addFavoriteAlbums([qid("a")]);
        await client.removeFavoriteArtists([qid(9)]);
        await client.addFavoriteTracks(ids);
      }),
    ).rejects.toThrow();
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "add-favourites", type: "albums", ids: [qid("a")] },
      { kind: "remove-favourites", type: "artists", ids: [qid(9)] },
      { kind: "add-favourites", type: "tracks", ids: ids.slice(0, 50) },
    ]);
  });

  it("adds and records only the favourites that are new, so undo keeps the old ones", async () => {
    const { store, journal, account, client } = setup();
    account.favourites.tracks.push(qid(1), qid(2));
    await journal.run({ tool: "import" }, () => client.addFavoriteTracks!([qid(2), qid(3)]));
    expect(account.calls).toContain("addFavoriteTracks:3");
    expect(entriesOf(store)[0]?.ops).toEqual([{ kind: "add-favourites", type: "tracks", ids: [qid(3)] }]);
    // Nothing new: nothing sent, nothing recorded.
    await journal.run({ tool: "import" }, () => client.addFavoriteTracks!([qid(1)]));
    expect(account.calls.filter((c) => c.startsWith("addFavoriteTracks"))).toHaveLength(1);
    expect(entriesOf(store)).toHaveLength(1);
  });

  it("records a deleted playlist's name and tracks", async () => {
    const { store, journal, account, client } = setup();
    const id = account.seedPlaylist("Old", [qid(4), qid(5)]);
    await journal.run({ tool: "undo", label: "Undid: x" }, () => client.deletePlaylist!(id));
    expect(entriesOf(store)[0]?.ops).toEqual([
      { kind: "delete-playlist", playlistId: id, name: "Old", trackIds: [qid(4), qid(5)], isPublic: false },
    ]);
  });
});

describe("a mixed list", () => {
  it("is refused whole, before the first batch, through what the app uses", async () => {
    const fake = new FakeQobuz();
    const journal = new Journal({ store: new MemoryStore(), source: "cli" });
    const hub = new ServiceHub();
    hub.connect(recordingClient<MusicService>(new QobuzService(fake as never), journal));
    const ids = [...Array.from({ length: 60 }, (_, i) => qid(i + 1)), tagId<never>("tidal", "x")];
    for (const client of [hub, hub.scoped("qobuz"), hub.service("qobuz")]) {
      await expect(client.addFavoriteTracks(ids)).rejects.toThrow();
      await expect(client.removeFavoriteTracks(ids)).rejects.toThrow();
    }
    expect(fake.calls).toEqual([]);
    expect(journal.items()).toEqual([]);
  });

  it("creates no playlist for songs of another service", async () => {
    const fake = new FakeQobuz();
    const hub = new ServiceHub();
    hub.connect(new QobuzService(fake as never));
    const view = hub.scoped("qobuz");
    const trackIds = [qid(1), tagId<never>("tidal", 2)];
    await expect(createPlaylistWithTracks(view, { name: "New", trackIds })).rejects.toMatchObject({ kind: "bad-id" });
    await expect(
      addConfirmed(view, { type: "new", name: "New", isPublic: false }, trackIds),
    ).rejects.toMatchObject({ kind: "bad-id" });
    expect(fake.calls).toEqual([]);
  });
});
