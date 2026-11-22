import { describe, expect, it, vi } from "vitest";

import type { Track } from "../qobuz/index.js";
import { FakeAccount, MemoryStore } from "./fake-account.test-support.js";
import { Journal, recordingClient } from "./journal.js";
import { draftChanges, moveTo, startDraft, takeOut, type Destination, type Draft } from "./playlist-draft.js";
import {
  commitRemovals,
  duplicatePlaylist,
  formatRemoveArtists,
  openPlaylist,
  removalsOf,
  resolveArtistLinks,
  resolveRemoveArtists,
  savePlaylist,
  saveProblem,
  type SaveOutcome,
} from "./playlist-manager.js";
import { applyUndo, planUndo } from "./undo.js";

function setup(trackIds: number[]) {
  const account = new FakeAccount();
  const journal = new Journal({ store: new MemoryStore(), source: "web" });
  const client = recordingClient(account, journal);
  const id = account.seedPlaylist("Mix", trackIds);
  const save = (draft: Draft): Promise<SaveOutcome> =>
    journal.run({ tool: "playlist-manager" }, () => savePlaylist(client, { playlistId: id, ...draftChanges(draft) }));
  const undo = async () => {
    const items = journal.items();
    await applyUndo(journal, client, items[0]!, await planUndo(client, items[0]!, items));
  };
  const to = (name: string, ids: number[] = []): Extract<Destination, { type: "existing" }> => ({
    type: "existing",
    playlistId: account.seedPlaylist(name, ids),
    name,
  });
  return { account, journal, client, id, save, undo, to, draft: startDraft(account.entryIds(id)) };
}

const saved = (outcome: SaveOutcome) => {
  if (outcome.status !== "saved") {
    throw new Error("not saved");
  }
  return outcome;
};

describe("savePlaylist", () => {
  it("removes and reorders to exactly what the draft says, as one undoable entry", async () => {
    const { account, journal, id, save, undo, draft } = setup([1, 2, 3, 2, 4]);
    const [e1, , e3, e4] = draft.base;
    const next = moveTo(takeOut(draft, [e1!, e3!]), [e4!], 0);

    const outcome = saved(await save(next));

    expect(outcome).toMatchObject({ removed: 2, reordered: true, kept: [] });
    expect(account.entryIds(id)).toEqual(next.order);
    expect(journal.items()).toHaveLength(1);
    expect(journal.items()[0]?.label).toBe("Removed 2 tracks from Mix; reordered Mix");
    await undo();
    expect(account.trackIds(id)).toEqual([1, 2, 3, 2, 4]);
  });

  it("removes one copy of a repeated track and leaves the other", async () => {
    const { account, id, save, draft } = setup([7, 7]);
    await save(takeOut(draft, [draft.base[0]!]));
    expect(account.entryIds(id)).toEqual([draft.base[1]]);
  });

  it("writes nothing when the playlist changed since it was opened", async () => {
    const { account, id, save, draft, journal } = setup([1, 2, 3]);
    await account.addTracksToPlaylist(id, [9]);
    await account.removeTracksFromPlaylist(id, [draft.base[0]!]);
    const before = account.entryIds(id);

    expect(await save(takeOut(draft, [draft.base[1]!]))).toEqual({
      status: "changed",
      drift: { added: 1, gone: 1, reordered: false },
    });
    expect(account.entryIds(id)).toEqual(before);
    expect(journal.items()).toEqual([]);
  });

  it("notices a reorder elsewhere", async () => {
    const { account, id, save, draft } = setup([1, 2, 3]);
    await account.movePlaylistTracks(id, [draft.base[2]!], 1);
    expect(await save(takeOut(draft, [draft.base[1]!]))).toMatchObject({ status: "changed", drift: { reordered: true } });
  });

  it("makes no request beyond reading for a draft without changes", async () => {
    const { account, save, draft } = setup([1, 2]);
    expect(saved(await save(draft))).toMatchObject({ removed: 0, reordered: false });
    expect(account.calls.every((call) => call.startsWith("get"))).toBe(true);
  });

  it("can empty a playlist", async () => {
    const { account, id, save, draft } = setup([1, 2]);
    await save(takeOut(draft, draft.base));
    expect(account.trackIds(id)).toEqual([]);
  });

  it("reports a failed removal and does not reorder", async () => {
    const { account, id, save, draft } = setup([1, 2, 3]);
    account.failAfter("removeTracksFromPlaylist", 0);
    const outcome = saved(await save(moveTo(takeOut(draft, [draft.base[0]!]), [draft.base[2]!], 0)));
    expect(outcome).toMatchObject({ removed: 0, reordered: false, failed: { step: "Remove songs" } });
    expect(account.trackIds(id)).toEqual([1, 2, 3]);
  });

  it("counts what went before a removal failed part-way", async () => {
    const { account, save, draft } = setup(Array.from({ length: 120 }, (_, i) => i + 1));
    account.failAfter("removeTracksFromPlaylist", 1);
    const outcome = saved(await save(takeOut(draft, draft.base)));
    expect(outcome).toMatchObject({ removed: 50, failed: { step: "Remove songs" } });
  });

  it("says when it does not know what went before a failure", async () => {
    const { account, save, draft } = setup([1, 2]);
    account.failAfter("removeTracksFromPlaylist", 0);
    const read = account.getPlaylistTracks.bind(account);
    let reads = 0;
    account.getPlaylistTracks = async (id) => {
      reads += 1;
      if (reads > 2) {
        throw new Error("offline");
      }
      return read(id);
    };
    expect(saved(await save(takeOut(draft, draft.base)))).toMatchObject({ unverified: true });
  });

  it("reports a failed reorder after the removals that were made", async () => {
    const { account, id, save, draft } = setup([1, 2, 3]);
    account.failAfter("movePlaylistTracks", 0);
    const outcome = saved(await save(moveTo(takeOut(draft, [draft.base[0]!]), [draft.base[2]!], 0)));
    expect(outcome).toMatchObject({ removed: 1, reordered: false, failed: { step: "Reorder the playlist" } });
    expect(account.trackIds(id)).toEqual([2, 3]);
  });
});

describe("savePlaylist moving songs", () => {
  it("adds to the other playlist before removing here", async () => {
    const { account, id, save, undo, to, draft } = setup([1, 2, 3]);
    const other = to("Other", [9]);
    const outcome = saved(await save(takeOut(draft, [draft.base[2]!, draft.base[0]!], other)));

    expect(account.trackIds(other.playlistId)).toEqual([9, 1, 3]);
    expect(account.trackIds(id)).toEqual([2]);
    expect(outcome).toMatchObject({ removed: 2, moved: [{ name: "Other", added: [1, 3], already: [], missing: [] }] });
    const writes = account.calls.filter((call) => !call.startsWith("get"));
    expect(writes.map((call) => call.split(":")[0])).toEqual(["addTracksToPlaylist", "removeTracksFromPlaylist"]);

    await undo();
    expect(account.trackIds(id)).toEqual([1, 2, 3]);
    expect(account.trackIds(other.playlistId)).toEqual([9]);
  });

  it("removes a song already in the other playlist without adding it again", async () => {
    const { account, id, save, to, draft } = setup([1, 2]);
    const other = to("Other", [1]);
    const outcome = saved(await save(takeOut(draft, draft.base, other)));
    expect(account.trackIds(other.playlistId)).toEqual([1, 2]);
    expect(account.trackIds(id)).toEqual([]);
    expect(outcome.moved[0]).toMatchObject({ added: [2], already: [1] });
  });

  it("keeps a song that did not arrive, in its place", async () => {
    const { account, id, save, to, draft } = setup([1, 2, 3, 4]);
    account.unplayable.add(2);
    const other = to("Other");
    const [e1, e2, e3, e4] = draft.base;
    const outcome = saved(await save(moveTo(takeOut(draft, [e2!, e3!], other), [e4!], 0)));
    expect(account.trackIds(other.playlistId)).toEqual([3]);
    expect(account.entryIds(id)).toEqual([e4, e1, e2]);
    expect(outcome.kept).toEqual([{ trackId: 2, title: "Track 2" }]);
  });

  it("keeps everything here when the add fails", async () => {
    const { account, id, save, to, draft } = setup([1, 2]);
    const other = to("Other");
    account.failAfter("addTracksToPlaylist", 0);
    const outcome = saved(await save(takeOut(takeOut(draft, [draft.base[0]!], other), [draft.base[1]!])));
    expect(outcome.failed).toMatchObject({ step: "Add to Other" });
    expect(account.trackIds(id)).toEqual([1, 2]);
  });

  it("creates a new playlist, and undo deletes it again", async () => {
    const { account, id, save, undo, draft } = setup([1, 2, 3]);
    const outcome = saved(await save(takeOut(draft, [draft.base[1]!], { type: "new", name: "Split", isPublic: true })));
    const created = outcome.moved[0]!;
    expect(created).toMatchObject({ name: "Split", created: true, added: [2] });
    expect(account.playlists.get(created.playlistId)).toMatchObject({ name: "Split", isPublic: true });
    await undo();
    expect(account.playlists.has(created.playlistId)).toBe(false);
    expect(account.trackIds(id)).toEqual([1, 2, 3]);
  });

  it("says which playlist it made when adding to it, or a later step, fails", async () => {
    for (const method of ["addTracksToPlaylist", "removeTracksFromPlaylist"]) {
      const { account, save, draft } = setup([1, 2]);
      account.failAfter(method, 0);
      const destination: Destination = { type: "new", name: "Split", isPublic: false };
      const outcome = saved(await save(takeOut(draft, [draft.base[0]!], destination)));
      expect(outcome.failed).toBeDefined();
      const [made] = [...account.playlists].filter(([, p]) => p.name === "Split");
      expect(outcome.created).toEqual([{ destination, playlistId: made![0] }]);
    }
  });

  it("makes no new playlist for songs known not to play", async () => {
    const account = new FakeAccount();
    const id = account.seedPlaylist("Mix", [1]);
    const read = account.getPlaylistTracks.bind(account);
    account.getPlaylistTracks = async (p) => (await read(p)).map((track) => ({ ...track, streamable: false }));
    const draft = takeOut(startDraft(account.entryIds(id)), account.entryIds(id), { type: "new", name: "X", isPublic: false });
    const outcome = saved(await savePlaylist(account, { playlistId: id, ...draftChanges(draft) }));
    expect(outcome).toMatchObject({ moved: [], removed: 0, kept: [{ trackId: 1 }] });
    expect(account.playlists.size).toBe(1);
  });
});

describe("saveProblem", () => {
  const ok = { playlistId: 1, base: [1, 2, 3], order: [3, 1], remove: [2], moves: [] };

  it("accepts what a draft produces and refuses anything else", async () => {
    expect(saveProblem(ok)).toBeUndefined();
    expect(saveProblem({ ...ok, remove: [] })).toBeDefined();
    expect(saveProblem({ ...ok, order: [3, 1, 2] })).toBeDefined();
    expect(saveProblem({ ...ok, remove: [9] })).toBeDefined();
    expect(saveProblem({ ...ok, base: [1, 2, 3, 3] })).toBeDefined();
    const self = { destination: { type: "existing", playlistId: 1, name: "Mix" } as const, entries: [2] };
    expect(saveProblem({ ...ok, remove: [], moves: [self] })).toMatch(/playlist they are in/);
    const { client } = setup([1]);
    await expect(savePlaylist(client, { ...ok, remove: [] })).rejects.toThrow();
  });
});

describe("openPlaylist and duplicatePlaylist", () => {
  it("opens with details and entries", async () => {
    const { client, id } = setup([1, 2]);
    expect(await openPlaylist(client, id)).toMatchObject({
      playlist: { id, name: "Mix" },
      entries: [{ id: 1 }, { id: 2 }],
    });
  });

  it("copies repeated songs, and counts those that did not come along", async () => {
    const { account, client, id } = setup([1, 2, 1, 3, 1]);
    account.unplayable.add(3);
    const { playlist, added, missing } = await duplicatePlaylist(client, id, { name: "Copy" });
    expect(account.trackIds(playlist.id)).toEqual([1, 2, 1, 1]);
    expect([added, missing]).toEqual([4, 1]);
  });

  it("copies an empty playlist", async () => {
    const { account, client, id } = setup([]);
    const { playlist } = await duplicatePlaylist(client, id, { name: "Copy" });
    expect(account.trackIds(playlist.id)).toEqual([]);
  });
});

describe("removing artists", () => {
  const track = (id: number, artist: string, rest: Partial<Track> = {}): Track => ({
    id,
    title: `T${id}`,
    artist,
    playlistTrackId: id + 100,
    ...rest,
  });

  function client(lists: Record<number, Track[]>) {
    return {
      searchArtists: vi.fn(async () => []),
      getArtist: vi.fn(async (id: number) => ({ id, name: "Portishead" })),
      getPlaylistTracks: vi.fn(async (id: number) => {
        const list = lists[id];
        if (list === undefined) {
          throw new Error("HTTP 404");
        }
        return list;
      }),
      removeTracksFromPlaylist: vi.fn(async (_id: number, _entries: readonly number[]) => {}),
    };
  }

  it("finds the artists' songs in each playlist, guests apart", async () => {
    const c = client({
      1: [track(1, "Portishead"), track(2, "Other", { guestArtists: ["Portishead"] }), track(3, "Other")],
      2: [track(4, "Tricky"), track(5, "Portishead", { guestArtists: ["Tricky"] })],
    });
    const plan = await resolveRemoveArtists(
      c,
      [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "Gone" }],
      ["Portishead", "Tricky", "Trickyy", "/[/"],
    );
    expect(plan.artists).toEqual([
      { line: "Portishead", name: "Portishead", main: 2, guest: 1 },
      { line: "Tricky", name: "Tricky", main: 1, guest: 1 },
      { line: "Trickyy", name: "Trickyy", main: 0, guest: 0, suggestion: { name: "Tricky", count: 1 } },
    ]);
    expect(plan.problems.map((p) => p.line)).toEqual(["/[/"]);
    expect(plan.playlists.map((p) => p.hits.map((h) => [h.entry.id, h.as, h.names]))).toEqual([
      [[1, "main", ["Portishead"]], [2, "guest", ["Portishead"]]],
      [[4, "main", ["Tricky"]], [5, "main", ["Portishead", "Tricky"]]],
      [],
    ]);
    expect(plan.playlists[2]?.error).toBe("HTTP 404");
    expect(removalsOf(plan, false)).toEqual([
      { playlistId: 1, entries: [101] },
      { playlistId: 2, entries: [104, 105] },
    ]);
    expect(removalsOf(plan, true)[0]).toEqual({ playlistId: 1, entries: [101, 102] });
    const report = formatRemoveArtists(plan, false);
    expect(report).toContain("Portishead: 2 songs, and 1 as a guest");
    expect(report).toContain("Trickyy: not in these playlists (did you mean Tricky?)");
    expect(report).toContain("   keep  Other - T2  [guest]");
    expect(report).toContain('"Gone" (id 3): could not be read (HTTP 404)');
  });

  it("looks up artist links once each", async () => {
    const c = client({});
    const link = "https://play.qobuz.com/artist/7";
    const found = await resolveArtistLinks(c, [link, "Tricky", link, "https://play.qobuz.com/album/abc"]);
    expect(found.get(link)).toEqual({ id: 7, name: "Portishead" });
    expect(found.get("https://play.qobuz.com/album/abc")).toHaveProperty("problem");
    expect(found.size).toBe(2);
    expect(c.getArtist).toHaveBeenCalledTimes(1);
  });

  it("counts what went from a playlist whose removal failed part-way", async () => {
    const account = new FakeAccount();
    const id = account.seedPlaylist("Mix", [1, 2, 3]);
    const entries = account.entryIds(id);
    const remove = account.removeTracksFromPlaylist.bind(account);
    account.removeTracksFromPlaylist = async (p, ids) => {
      await remove(p, ids.slice(0, 2));
      throw new Error("HTTP 500");
    };
    expect(await commitRemovals(account, [{ playlistId: id, entries }])).toEqual([
      { playlistId: id, removed: 2, error: "HTTP 500" },
    ]);
  });

  it("removes what is still there, and carries on past a playlist that fails", async () => {
    const c = client({ 1: [track(1, "A")], 2: [track(2, "A")] });
    c.removeTracksFromPlaylist.mockImplementationOnce(async () => {
      throw new Error("HTTP 500");
    });
    expect(
      await commitRemovals(c, [
        { playlistId: 1, entries: [101] },
        { playlistId: 2, entries: [102, 999] },
        { playlistId: 3, entries: [5] },
      ]),
    ).toEqual([
      { playlistId: 1, removed: 0, error: "HTTP 500" },
      { playlistId: 2, removed: 1 },
      { playlistId: 3, removed: 0, error: "HTTP 404" },
    ]);
    expect(c.removeTracksFromPlaylist).toHaveBeenLastCalledWith(2, [102]);
  });
});
