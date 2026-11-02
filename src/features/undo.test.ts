import { describe, expect, it } from "vitest";

import { FakeAccount, MemoryStore } from "./fake-account.test-support.js";
import { createPlaylistWithTracks } from "./playlist-from-artists.js";
import { Journal, recordingClient } from "./journal.js";
import { commitUpgrades, type UpgradeChange } from "./upgrade.js";
import {
  applyUndo,
  commitUndo,
  describeStep,
  formatUndoPlan,
  formatUndoResult,
  planUndo,
  restoreMoves,
} from "./undo.js";

function setup() {
  const store = new MemoryStore();
  let n = 0;
  let minute = 0;
  const journal = new Journal({
    store,
    source: "cli",
    // Each write a minute later, so entries order by time.
    now: () => new Date(Date.UTC(2026, 10, 2, 20, minute++)),
    newId: () => `e${++n}`,
  });
  const account = new FakeAccount();
  const client = recordingClient(account, journal);
  /** Plan and apply an undo of `id` (default: the newest entry). */
  const undo = async (id?: string) => {
    const items = journal.items();
    const item = id === undefined ? items[0]! : items.find((i) => i.id === id)!;
    const plan = await planUndo(client, item, items);
    const outcome = await applyUndo(journal, client, item, plan);
    return { plan, outcome };
  };
  return { store, journal, account, client, undo };
}

describe("restoreMoves", () => {
  it("moves each restored entry in front of the one now at its old index", () => {
    // Three entries stay; the restored ones were at 1 and 3.
    expect(restoreMoves(3, [1, 3])).toEqual([
      { from: 0, count: 1, insertBefore: 2 },
      { from: 1, count: 1, insertBefore: 4 },
    ]);
  });

  it("moves consecutive positions together and leaves the ones already at the end", () => {
    // Nine entries in the end: 5, 6 and 7 still precede a kept one.
    expect(restoreMoves(4, [0, 1, 5, 6, 7])).toEqual([
      { from: 0, count: 2, insertBefore: 1 },
      { from: 2, count: 3, insertBefore: 6 },
    ]);
    // Here 6, 7 and 8 are the last three: already in place once appended.
    expect(restoreMoves(4, [0, 1, 6, 7, 8])).toEqual([{ from: 0, count: 2, insertBefore: 1 }]);
    expect(restoreMoves(3, [3, 4])).toEqual([]);
  });
});

describe("undo of a created playlist", () => {
  it("deletes the playlist when it holds only what the entry added", async () => {
    const { journal, account, client, undo } = setup();
    let id = 0;
    await journal.run({ tool: "playlist-from-artists" }, async () => {
      id = (await createPlaylistWithTracks(client, { name: "Road Trip", trackIds: [1, 2] })).id;
    });

    const { plan, outcome } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Delete the playlist Road Trip (2 tracks)"]);
    expect(account.playlists.has(id)).toBe(false);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    const [undoEntry, original] = journal.items();
    expect(undoEntry).toMatchObject({
      tool: "undo",
      label: "Undid: Created Road Trip with 2 tracks",
      undoes: original!.id,
      ops: [{ kind: "delete-playlist", name: "Road Trip", trackIds: [1, 2] }],
    });
    expect(original?.undone?.by).toBe(undoEntry!.id);
  });

  it("keeps the playlist when it has gained other tracks, removing only its own", async () => {
    const { journal, account, client, undo } = setup();
    let id = 0;
    await journal.run({ tool: "word-play" }, async () => {
      id = (await createPlaylistWithTracks(client, { name: "Fox", trackIds: [1, 2] })).id;
    });
    await account.addTracksToPlaylist(id, [9]); // made elsewhere

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Remove 2 tracks from Fox"]);
    expect(plan.notes).toEqual([
      "Kept the playlist Fox: it now has tracks this change did not add, so only the added ones are removed.",
    ]);
    expect(account.trackIds(id)).toEqual([9]);
  });

  it("can be redone by undoing the undo, recreating the playlist", async () => {
    const { journal, account, client, undo } = setup();
    await journal.run({ tool: "playlist-from-artists" }, () =>
      createPlaylistWithTracks(client, { name: "Road Trip", trackIds: [5, 6] }),
    );
    await undo();
    const { plan } = await undo(journal.items()[0]!.id);

    expect(plan.steps.map(describeStep)).toEqual(["Recreate the playlist Road Trip with 2 tracks"]);
    expect(journal.items()[0]?.label).toBe("Redid: Created Road Trip with 2 tracks");
    const [recreated] = [...account.playlists.entries()];
    expect(recreated?.[1].name).toBe("Road Trip");
    expect(account.trackIds(recreated![0])).toEqual([5, 6]);
  });

  it("recreates a deleted playlist with its repeated tracks", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [4, 4, 5, 4]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    await undo();
    const [recreated] = [...account.playlists.keys()];
    expect(account.trackIds(recreated!)).toEqual([4, 4, 5, 4]);
  });
});

describe("undo of playlist changes", () => {
  it("puts removed duplicates back exactly where they were", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [1, 2, 3, 2, 4, 1]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "deduplicate" }, () =>
      client.removeTracksFromPlaylist(id, [ids[3]!, ids[5]!, ids[1]!]),
    );
    expect(account.trackIds(id)).toEqual([1, 3, 4]);

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Put 3 tracks back in Late Night, in their old places"]);
    expect(account.trackIds(id)).toEqual([1, 2, 3, 2, 4, 1]);
  });

  it("reverses an upgrade: the old tracks back in place, the replacements gone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [10, 1, 20, 2, 30]);
    const ids = account.entryIds(id);
    const changes: UpgradeChange[] = [
      { action: "replace", location: { type: "playlist", playlistId: id, playlistTrackId: ids[1]! }, trackId: 1, newTrackId: 101 },
      { action: "replace", location: { type: "playlist", playlistId: id, playlistTrackId: ids[3]! }, trackId: 2, newTrackId: 102 },
    ];
    await journal.run({ tool: "upgrade" }, () => commitUpgrades(client, changes));
    expect(account.trackIds(id)).toEqual([10, 101, 20, 102, 30]);
    expect(journal.items()[0]?.label).toBe("Upgraded 2 tracks in Late Night");

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual([
      "Remove 2 tracks from Late Night",
      "Put 2 tracks back in Late Night, in their old places",
    ]);
    expect(plan.notes).toEqual([]);
    expect(account.trackIds(id)).toEqual([10, 1, 20, 2, 30]);
  });

  it("restores removals made in several steps, latest first", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2, 3, 4, 5]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "other" }, async () => {
      await client.removeTracksFromPlaylist(id, [ids[1]!]);
      await client.removeTracksFromPlaylist(id, [ids[3]!]);
    });
    await undo();
    expect(account.trackIds(id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips and reports added tracks that are already gone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [1]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [2, 3]));
    await account.removeTracksFromPlaylist(id, [account.entryIds(id)[1]!]); // removed elsewhere

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Late Night"]);
    expect(plan.notes).toEqual(["1 of the tracks added to Late Night is no longer in it."]);
    expect(account.trackIds(id)).toEqual([1]);
  });

  it("reports a playlist that no longer exists and changes nothing there", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [1]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [2]));
    account.playlists.delete(id);

    const { plan } = await undo();

    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual(["Late Night no longer exists (or cannot be read), so its changes are not undone."]);
  });

  it("says when entries it did not add were reordered", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2]);
    await journal.run({ tool: "other" }, () => client.movePlaylistTracks!(id, [account.entryIds(id)[1]!], 1));
    const { plan } = await undo();
    expect(plan.notes).toEqual(["The order of 1 track in Mix is not restored."]);
  });

  it("leaves restored tracks at the end when moving them back fails", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2, 3]);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    account.failAfter("movePlaylistTracks", 0);

    const { outcome } = await undo();

    expect(account.trackIds(id)).toEqual([2, 3, 1]);
    expect(outcome.notes).toEqual(["1 track was put back at the end of Mix, not in its old place."]);
    expect(outcome.undone).toBe(true);
  });
});

describe("undo of favourites", () => {
  it("removes added favourites and re-adds removed ones", async () => {
    const { journal, account, client, undo } = setup();
    account.favourites.tracks = [1, 2];
    await journal.run({ tool: "upgrade" }, async () => {
      await client.addFavoriteTracks([3]);
      await client.removeFavoriteTracks([1]);
      await client.addFavoriteAlbums(["a"]);
    });

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual([
      "Remove 1 album from Favourites",
      "Add 1 track back to Favourites",
      "Remove 1 track from Favourites",
    ]);
    expect([...account.favourites.tracks].sort()).toEqual([1, 2]);
    expect(account.favourites.albums).toEqual([]);
  });
});

describe("planUndo checks", () => {
  it("refuses an entry that is already undone", async () => {
    const { journal, client, undo } = setup();
    await journal.run({ tool: "import" }, () => client.addFavoriteArtists([7]));
    const firstId = journal.items()[0]!.id;
    await undo();

    const items = journal.items();
    const plan = await planUndo(client, items.find((i) => i.id === firstId)!, items);
    expect(plan.blocked).toMatch(/^Already undone/);
    await expect(applyUndo(journal, client, items.find((i) => i.id === firstId)!, plan)).rejects.toThrow(
      /Already undone/,
    );
  });

  it("warns about later changes to the same playlist or favourites", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [1]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [2]));
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [3]));
    const items = journal.items();

    const plan = await planUndo(client, items[1]!, items);

    expect(plan.warnings).toEqual(['A later change also touched it: "Added 1 track to Mix".']);
  });
});

describe("commitUndo", () => {
  it("reports a failing step and carries on with the rest", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [1]);
    await journal.run({ tool: "x" }, async () => {
      await client.addTracksToPlaylist(id, [2]);
      await client.addFavoriteTracks([5]);
    });
    const items = journal.items();
    const plan = await planUndo(client, items[0]!, items);
    account.failAfter("removeFavoriteTracks", 0);

    const result = await commitUndo(client, plan);

    expect(result.done).toEqual(["Remove 1 track from Mix"]);
    expect(result.failed).toEqual([
      { step: "Remove 1 track from Favourites", reason: "removeFavoriteTracks failed with HTTP 500" },
    ]);
    expect(account.trackIds(id)).toEqual([1]);
  });

  it("does not mark the entry undone when every step failed", async () => {
    const { journal, account, client, undo } = setup();
    await journal.run({ tool: "x" }, () => client.addFavoriteTracks([5]));
    account.failAfter("removeFavoriteTracks", 0);

    const { outcome } = await undo();

    expect(outcome.undone).toBe(false);
    expect(journal.items().find((i) => i.tool === "x")?.undone).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats a plan and a result for the CLI", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [1]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [2]));
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [3]));
    const items = journal.items();
    const plan = await planUndo(client, items[1]!, items);

    expect(formatUndoPlan(plan)).toBe(
      [
        "Undo e1: Added 1 track to Mix",
        "  - Remove 1 track from Mix",
        'Warning: A later change also touched it: "Added 1 track to Mix".',
      ].join("\n"),
    );
    expect(
      formatUndoResult({
        done: ["Remove 1 track from Mix"],
        failed: [{ step: "Add 1 track back to Favourites", reason: "HTTP 500" }],
        notes: ["A note."],
      }),
    ).toBe(
      [
        "Done: Remove 1 track from Mix",
        "Failed: Add 1 track back to Favourites (HTTP 500)",
        "Note: A note.",
      ].join("\n"),
    );
  });
});
