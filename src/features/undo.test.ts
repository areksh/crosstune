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

  it("says which tracks of a deleted playlist did not come back", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [4, 5]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    account.unplayable.add(5);
    const { outcome } = await undo();
    expect(outcome.notes).toEqual(["1 track could not be put back in Old: Qobuz no longer offers it."]);
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
      "Put 2 tracks back in Late Night, in their old places",
      "Remove 2 tracks from Late Night",
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
    expect(plan.notes).toEqual(["Late Night no longer exists, so its changes are not undone."]);
  });

  it("puts a reordered playlist back in its old order, and can redo it", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2, 3, 4, 2]);
    const start = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.movePlaylistTracks!(id, [start[4]!, start[0]!], 3);
      await client.movePlaylistTracks!(id, [start[3]!], 1);
    });
    const after = account.entryIds(id);

    const { plan } = await undo();
    expect(plan.steps.map(describeStep)).toEqual(["Put Mix back in its old order"]);
    expect(plan.notes).toEqual([]);
    expect(account.entryIds(id)).toEqual(start);

    await undo(journal.items()[0]!.id);
    expect(account.entryIds(id)).toEqual(after);
  });

  it("says when moves were recorded without where their entries were", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [1, 2]);
    await journal.run({ tool: "other" }, () => client.movePlaylistTracks!(id, [account.entryIds(id)[1]!], 1));
    const item = structuredClone(journal.items()[0]!);
    for (const op of item.ops) {
      if (op.kind === "move-tracks") {
        delete op.from;
      }
    }
    const plan = await planUndo(client, item, [item]);
    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual(["The order of 1 track in Mix is not restored."]);
  });

  it("puts everything back after removals and moves, scattered through a long playlist, in few requests", async () => {
    const { journal, account, client, undo } = setup();
    const trackIds = Array.from({ length: 900 }, (_, i) => i + 1);
    const id = account.seedPlaylist("Long", trackIds);
    const ids = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.removeTracksFromPlaylist(id, ids.filter((_, i) => i % 3 === 0));
      await client.movePlaylistTracks!(id, [ids[898]!, ids[1]!], 5);
    });
    account.calls.length = 0;
    const { outcome } = await undo();
    expect(outcome.notes).toEqual([]);
    expect(account.trackIds(id)).toEqual(trackIds);
    expect(account.calls.filter((c) => c.startsWith("movePlaylistTracks")).length).toBeLessThanOrEqual(5);
  });

  it("reports tracks Qobuz no longer offers and still puts the others in their places", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2, 3, 4, 5]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, () =>
      client.removeTracksFromPlaylist(id, [ids[0]!, ids[1]!, ids[3]!]),
    );
    account.unplayable.add(2);
    const { outcome } = await undo();
    expect(account.trackIds(id)).toEqual([1, 3, 4, 5]);
    expect(outcome.notes).toEqual(["1 track could not be put back in Mix: Qobuz no longer offers it."]);
  });

  it("reverses any mix of adding, removing and moving, and redoes it", async () => {
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    for (let round = 0; round < 60; round += 1) {
      const { journal, account, client, undo } = setup();
      const id = account.seedPlaylist("Mix", Array.from({ length: 4 + random(12) }, () => 1 + random(6)));
      const start = account.trackIds(id);
      await journal.run({ tool: "playlist-manager" }, async () => {
        for (let step = 0; step < 2 + random(6); step += 1) {
          const ids = account.entryIds(id);
          const picked = ids.filter(() => random(3) === 0);
          if (random(3) === 0) {
            await client.addTracksToPlaylist(id, [1 + random(6), 7 + random(3)]);
          } else if (random(2) === 0) {
            await client.removeTracksFromPlaylist(id, picked.slice(0, ids.length - 1));
          } else {
            await client.movePlaylistTracks!(id, picked, 1 + random(ids.length + 1));
          }
        }
      });
      if (journal.items().length === 0) {
        continue;
      }
      const after = account.trackIds(id);
      const { outcome } = await undo();
      expect(outcome.failed).toEqual([]);
      expect(account.trackIds(id)).toEqual(start);
      await undo(journal.items()[0]!.id);
      expect(account.trackIds(id)).toEqual(after);
    }
  });
});

describe("undo of a move between playlists", () => {
  async function moved(unplayable = false) {
    const world = setup();
    const { journal, account, client } = world;
    const from = account.seedPlaylist("From", [1, 2, 3]);
    const to = account.seedPlaylist("To", [9]);
    const entry = account.entryIds(from)[1]!;
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.addTracksToPlaylist(to, [2]);
      await client.removeTracksFromPlaylist(from, [entry]);
    });
    if (unplayable) {
      account.unplayable.add(2);
    }
    return { ...world, from, to };
  }

  it("puts the song back first, then takes it out of where it went", async () => {
    const { account, undo, from, to } = await moved();
    const { plan } = await undo();
    expect(plan.steps.map(describeStep)).toEqual([
      "Put 1 track back in From, in its old place",
      "Remove 1 track from To",
    ]);
    expect(account.trackIds(from)).toEqual([1, 2, 3]);
    expect(account.trackIds(to)).toEqual([9]);
  });

  it("leaves the song where it went when it cannot be put back", async () => {
    const { account, undo, from, to } = await moved(true);
    const { outcome } = await undo();
    expect(account.trackIds(from)).toEqual([1, 3]);
    expect(account.trackIds(to)).toEqual([9, 2]);
    expect(outcome.notes).toEqual([
      "1 track could not be put back in From: Qobuz no longer offers it.",
      "1 track stays in To, as it could not be put back where it was.",
    ]);
  });

  it("leaves the song where it went when putting it back fails", async () => {
    const { account, undo, from, to } = await moved();
    account.failAfter("addTracksToPlaylist", 0);
    const { outcome } = await undo();
    expect(account.trackIds(from)).toEqual([1, 3]);
    expect(account.trackIds(to)).toEqual([9, 2]);
    expect(outcome.failed).toHaveLength(1);
  });

  it("leaves the song where it went when the playlist it came from is gone", async () => {
    const { account, undo, from, to } = await moved();
    account.playlists.delete(from);
    const { outcome } = await undo();
    expect(account.trackIds(to)).toEqual([9, 2]);
    expect(outcome.notes).toContain("1 track stays in To, as it could not be put back where it was.");
  });

  it("keeps a new playlist whose songs' old playlist is gone", async () => {
    const { journal, account, client, undo } = setup();
    const from = account.seedPlaylist("From", [1, 2]);
    let to = 0;
    await journal.run({ tool: "playlist-manager" }, async () => {
      to = (await createPlaylistWithTracks(client, { name: "Split", trackIds: [2] })).id;
      await client.removeTracksFromPlaylist(from, [account.entryIds(from)[1]!]);
    });
    account.playlists.delete(from);
    await undo();
    expect(account.trackIds(to)).toEqual([2]);
  });

  it("does nothing when a playlist cannot be read for now", async () => {
    const { account, journal, client, from, to } = await moved();
    account.failAfter("getPlaylistTracks", 0);
    const items = journal.items();
    const plan = await planUndo(client, items[0]!, items);
    expect(plan.blocked).toMatch(/could not be read/);
    await expect(applyUndo(journal, client, items[0]!, plan)).rejects.toThrow();
    expect([account.trackIds(from), account.trackIds(to)]).toEqual([[1, 3], [9, 2]]);
  });

  it("does not delete a new playlist holding a song that could not be put back", async () => {
    const { journal, account, client, undo } = setup();
    const from = account.seedPlaylist("From", [1, 2]);
    let to = 0;
    await journal.run({ tool: "playlist-manager" }, async () => {
      to = (await createPlaylistWithTracks(client, { name: "Split", trackIds: [2] })).id;
      await client.removeTracksFromPlaylist(from, [account.entryIds(from)[1]!]);
    });
    account.unplayable.add(2);
    const { outcome } = await undo();
    expect(account.trackIds(to)).toEqual([2]);
    expect(outcome.failed).toEqual([
      {
        step: "Delete the playlist Split (1 track)",
        reason: "kept, as it holds tracks that could not be put back where they were",
      },
    ]);
  });
});

describe("undo of changed details", () => {
  it("sets them back to what they were", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1]);
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.updatePlaylist!(id, { name: "Mix 2" });
      await client.updatePlaylist!(id, { name: "Mix 3", isPublic: true });
    });
    const { plan } = await undo();
    expect(plan.steps.map(describeStep)).toEqual(["Set Mix: name back to Mix, visibility back to private"]);
    expect(account.playlists.get(id)).toMatchObject({ name: "Mix", isPublic: false });
  });
});

describe("undo when moving back fails", () => {
  it("leaves restored tracks at the end when moving them back fails", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [1, 2, 3]);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    account.failAfter("movePlaylistTracks", 0);

    const { outcome } = await undo();

    expect(account.trackIds(id)).toEqual([2, 3, 1]);
    expect(outcome.notes).toEqual(["1 track was put back at the end of Mix, not in its old place."]);
    expect(outcome.done).toEqual(["Put 1 track back in Mix"]);
    expect(outcome.failed).toEqual([
      { step: "Put Mix back in its old order", reason: "movePlaylistTracks failed with HTTP 500" },
    ]);
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
