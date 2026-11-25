import { describe, expect, it } from "vitest";

import { ServiceHub } from "../services/hub.js";
import { tagId, type PlaylistId, type TrackId } from "../services/ids.js";
import { qid } from "../services/ids.test-support.js";
import { SpotifyClient } from "../services/spotify/client.js";
import { FakeSpotify } from "../services/spotify/fake-spotify.test-support.js";
import { SpotifyService } from "../services/spotify/service.js";
import { TidalClient } from "../services/tidal/client.js";
import { FakeTidal } from "../services/tidal/fake-tidal.test-support.js";
import { TidalService } from "../services/tidal/service.js";
import { FakeAccount, MemoryStore } from "./fake-account.test-support.js";
import { createPlaylistWithTracks } from "./playlist-from-artists.js";
import { selectEntry } from "./history.js";
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

/** A journal whose entries are a minute apart, so they order by time. */
function newJournal() {
  const store = new MemoryStore();
  let n = 0;
  let minute = 0;
  const journal = new Journal({
    store,
    source: "cli",
    now: () => new Date(Date.UTC(2026, 10, 2, 20, minute++)),
    newId: () => `e${++n}`,
  });
  return { store, journal };
}

/** TIDAL (the fake behind the real service), recorded. */
function tidalSetup() {
  const { store, journal } = newJournal();
  const fake = new FakeTidal();
  for (let n = 1; n <= 9; n += 1) {
    fake.addTrack(String(n));
  }
  const service = new TidalService(new TidalClient({ tokens: fake.tokens(), fetchImpl: fake.fetch, sleep: async () => {} }));
  const client = recordingClient(service, journal);
  const track = (native: number) => tagId<TrackId>("tidal", native);
  const seed = (name: string, natives: readonly number[]) =>
    tagId<PlaylistId>("tidal", fake.seedPlaylist(name, natives.map((n) => ({ type: "tracks", id: String(n) }))));
  return { store, journal, fake, client, track, seed };
}

describe("undo of a created playlist", () => {
  it("deletes the playlist when it holds only what the entry added", async () => {
    const { journal, account, client, undo } = setup();
    let id = 0;
    await journal.run({ tool: "playlist-from-artists" }, async () => {
      id = (await createPlaylistWithTracks(client, { name: "Road Trip", trackIds: [qid(1), qid(2)] })).id;
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
      ops: [{ kind: "delete-playlist", name: "Road Trip", trackIds: [qid(1), qid(2)] }],
    });
    expect(original?.undone?.by).toBe(undoEntry!.id);
  });

  it("keeps the playlist when it has gained other tracks, removing only its own", async () => {
    const { journal, account, client, undo } = setup();
    let id = 0;
    await journal.run({ tool: "word-play" }, async () => {
      id = (await createPlaylistWithTracks(client, { name: "Fox", trackIds: [qid(1), qid(2)] })).id;
    });
    await account.addTracksToPlaylist(id, [qid(9)]); // made elsewhere

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Remove 2 tracks from Fox"]);
    expect(plan.notes).toEqual([
      "Kept the playlist Fox: it now has tracks this change did not add, so only the added ones are removed.",
    ]);
    expect(account.trackIds(id)).toEqual([qid(9)]);
  });

  it("can be redone by undoing the undo, recreating the playlist", async () => {
    const { journal, account, client, undo } = setup();
    await journal.run({ tool: "playlist-from-artists" }, () =>
      createPlaylistWithTracks(client, { name: "Road Trip", trackIds: [qid(5), qid(6)] }),
    );
    await undo();
    const { plan } = await undo(journal.items()[0]!.id);

    expect(plan.steps.map(describeStep)).toEqual(["Recreate the playlist Road Trip with 2 tracks"]);
    expect(journal.items()[0]?.label).toBe("Redid: Created Road Trip with 2 tracks");
    const [recreated] = [...account.playlists.entries()];
    expect(recreated?.[1].name).toBe("Road Trip");
    expect(account.trackIds(recreated![0])).toEqual([qid(5), qid(6)]);
  });

  it("recreates a deleted playlist with its repeated tracks", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [qid(4), qid(4), qid(5), qid(4)]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    await undo();
    const [recreated] = [...account.playlists.keys()];
    expect(account.trackIds(recreated!)).toEqual([qid(4), qid(4), qid(5), qid(4)]);
  });

  it("says which tracks of a deleted playlist did not come back", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [qid(4), qid(5)]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    account.unplayable.add(qid(5));
    const { outcome } = await undo();
    expect(outcome.notes).toEqual(["1 track could not be put back in Old: Qobuz no longer offers it."]);
  });
});

describe("undo of playlist changes", () => {
  it("puts removed duplicates back exactly where they were", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1), qid(2), qid(3), qid(2), qid(4), qid(1)]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "deduplicate" }, () =>
      client.removeTracksFromPlaylist(id, [ids[3]!, ids[5]!, ids[1]!]),
    );
    expect(account.trackIds(id)).toEqual([qid(1), qid(3), qid(4)]);

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Put 3 tracks back in Late Night, in their old places"]);
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(3), qid(2), qid(4), qid(1)]);
  });

  it("reverses an upgrade: the old tracks back in place, the replacements gone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [qid(10), qid(1), qid(20), qid(2), qid(30)]);
    const ids = account.entryIds(id);
    const changes: UpgradeChange[] = [
      { action: "replace", location: { type: "playlist", playlistId: id, playlistTrackId: ids[1]! }, trackId: qid(1), newTrackId: qid(101) },
      { action: "replace", location: { type: "playlist", playlistId: id, playlistTrackId: ids[3]! }, trackId: qid(2), newTrackId: qid(102) },
    ];
    await journal.run({ tool: "upgrade" }, () => commitUpgrades(client, changes));
    expect(account.trackIds(id)).toEqual([qid(10), qid(101), qid(20), qid(102), qid(30)]);
    expect(journal.items()[0]?.label).toBe("Upgraded 2 tracks in Late Night");

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual([
      "Put 2 tracks back in Late Night, in their old places",
      "Remove 2 tracks from Late Night",
    ]);
    expect(plan.notes).toEqual([]);
    expect(account.trackIds(id)).toEqual([qid(10), qid(1), qid(20), qid(2), qid(30)]);
  });

  it("restores removals made in several steps, latest first", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3), qid(4), qid(5)]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "other" }, async () => {
      await client.removeTracksFromPlaylist(id, [ids[1]!]);
      await client.removeTracksFromPlaylist(id, [ids[3]!]);
    });
    await undo();
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(3), qid(4), qid(5)]);
  });

  it("skips and reports added tracks that are already gone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(2), qid(3)]));
    await account.removeTracksFromPlaylist(id, [account.entryIds(id)[1]!]); // removed elsewhere

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Late Night"]);
    expect(plan.notes).toEqual(["1 of the tracks added to Late Night is no longer in it."]);
    expect(account.trackIds(id)).toEqual([qid(1)]);
  });

  it("reports a playlist that no longer exists and changes nothing there", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Late Night", [qid(1)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(2)]));
    account.playlists.delete(id);

    const { plan } = await undo();

    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual(["Late Night no longer exists, so its changes are not undone."]);
  });

  it("tells a deleted playlist from an unreadable one on TIDAL too", async () => {
    const { journal, fake, client, track, seed } = tidalSetup();
    const kept = seed("Kept", [1]);
    const gone = seed("Gone", [2]);
    await journal.run({ tool: "similar-artists" }, async () => {
      await client.addTracksToPlaylist(kept, [track(3)]);
      await client.addTracksToPlaylist(gone, [track(4)]);
    });
    fake.playlists.delete(String(gone).replace("tidal:", ""));

    const items = journal.items();
    const plan = await planUndo(client, items[0]!, items);

    expect(plan.blocked).toBeUndefined();
    expect(plan.notes).toEqual(["Gone no longer exists, so its changes are not undone."]);
    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Kept"]);
    await applyUndo(journal, client, items[0]!, plan);
    expect(fake.contents(String(kept).replace("tidal:", ""))).toEqual(["tracks:1"]);
  });

  it("puts a reordered playlist back in its old order, and can redo it", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3), qid(4), qid(2)]);
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
    const id = account.seedPlaylist("Mix", [qid(1), qid(2)]);
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
    const trackIds = Array.from({ length: 900 }, (_, i) => qid(i + 1));
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
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3), qid(4), qid(5)]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, () =>
      client.removeTracksFromPlaylist(id, [ids[0]!, ids[1]!, ids[3]!]),
    );
    account.unplayable.add(qid(2));
    const { outcome } = await undo();
    expect(account.trackIds(id)).toEqual([qid(1), qid(3), qid(4), qid(5)]);
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
      const id = account.seedPlaylist("Mix", Array.from({ length: 4 + random(12) }, () => qid(1 + random(6))));
      const start = account.trackIds(id);
      await journal.run({ tool: "playlist-manager" }, async () => {
        for (let step = 0; step < 2 + random(6); step += 1) {
          const ids = account.entryIds(id);
          const picked = ids.filter(() => random(3) === 0);
          if (random(3) === 0) {
            await client.addTracksToPlaylist(id, [qid(1 + random(6)), qid(7 + random(3))]);
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
    const from = account.seedPlaylist("From", [qid(1), qid(2), qid(3)]);
    const to = account.seedPlaylist("To", [qid(9)]);
    const entry = account.entryIds(from)[1]!;
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.addTracksToPlaylist(to, [qid(2)]);
      await client.removeTracksFromPlaylist(from, [entry]);
    });
    if (unplayable) {
      account.unplayable.add(qid(2));
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
    expect(account.trackIds(from)).toEqual([qid(1), qid(2), qid(3)]);
    expect(account.trackIds(to)).toEqual([qid(9)]);
  });

  it("leaves the song where it went when it cannot be put back", async () => {
    const { account, undo, from, to } = await moved(true);
    const { outcome } = await undo();
    expect(account.trackIds(from)).toEqual([qid(1), qid(3)]);
    expect(account.trackIds(to)).toEqual([qid(9), qid(2)]);
    expect(outcome.notes).toEqual([
      "1 track could not be put back in From: Qobuz no longer offers it.",
      "1 track stays in To, as it could not be put back where it was.",
    ]);
  });

  it("leaves the song where it went when putting it back fails", async () => {
    const { account, undo, from, to } = await moved();
    account.failAfter("addTracksToPlaylist", 0);
    const { outcome } = await undo();
    expect(account.trackIds(from)).toEqual([qid(1), qid(3)]);
    expect(account.trackIds(to)).toEqual([qid(9), qid(2)]);
    expect(outcome.failed).toHaveLength(1);
  });

  it("leaves the song where it went when the playlist it came from is gone", async () => {
    const { account, undo, from, to } = await moved();
    account.playlists.delete(from);
    const { outcome } = await undo();
    expect(account.trackIds(to)).toEqual([qid(9), qid(2)]);
    expect(outcome.notes).toContain("1 track stays in To, as it could not be put back where it was.");
  });

  it("keeps a new playlist whose songs' old playlist is gone", async () => {
    const { journal, account, client, undo } = setup();
    const from = account.seedPlaylist("From", [qid(1), qid(2)]);
    let to = 0;
    await journal.run({ tool: "playlist-manager" }, async () => {
      to = (await createPlaylistWithTracks(client, { name: "Split", trackIds: [qid(2)] })).id;
      await client.removeTracksFromPlaylist(from, [account.entryIds(from)[1]!]);
    });
    account.playlists.delete(from);
    await undo();
    expect(account.trackIds(to)).toEqual([qid(2)]);
  });

  it("does nothing when a playlist cannot be read for now", async () => {
    const { account, journal, client, from, to } = await moved();
    account.failAfter("getPlaylistTracks", 0);
    const items = journal.items();
    const plan = await planUndo(client, items[0]!, items);
    expect(plan.blocked).toMatch(/could not be read/);
    await expect(applyUndo(journal, client, items[0]!, plan)).rejects.toThrow();
    expect([account.trackIds(from), account.trackIds(to)]).toEqual([[qid(1), qid(3)], [qid(9), qid(2)]]);
  });

  it("does not delete a new playlist holding a song that could not be put back", async () => {
    const { journal, account, client, undo } = setup();
    const from = account.seedPlaylist("From", [qid(1), qid(2)]);
    let to = 0;
    await journal.run({ tool: "playlist-manager" }, async () => {
      to = (await createPlaylistWithTracks(client, { name: "Split", trackIds: [qid(2)] })).id;
      await client.removeTracksFromPlaylist(from, [account.entryIds(from)[1]!]);
    });
    account.unplayable.add(qid(2));
    const { outcome } = await undo();
    expect(account.trackIds(to)).toEqual([qid(2)]);
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
    const id = account.seedPlaylist("Mix", [qid(1)]);
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
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3)]);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    account.failAfter("movePlaylistTracks", 0);

    const { outcome } = await undo();

    expect(account.trackIds(id)).toEqual([qid(2), qid(3), qid(1)]);
    expect(outcome.notes).toEqual(["1 track was put back at the end of Mix, not in its old place."]);
    expect(outcome.done).toEqual(["Put 1 track back in Mix"]);
    expect(outcome.failed).toEqual([
      { step: "Put Mix back in its old order", reason: "movePlaylistTracks failed with HTTP 500" },
    ]);
    // Not all of it went through: it stays to be finished.
    expect(outcome.undone).toBe(false);

    const again = await undo(journal.items().find((i) => i.tool === "deduplicate")!.id);

    expect(again.plan.steps.map(describeStep)).toEqual(["Put Mix back in its old order"]);
    expect(again.outcome).toMatchObject({ undone: true, failed: [] });
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(3)]);
  });
});

describe("an undo that went through only in part", () => {
  /** One entry removes a song from each of two playlists; undoing puts Late back and fails on Early. */
  async function halfUndone() {
    const world = setup();
    const { journal, account, client, undo } = world;
    const early = account.seedPlaylist("Early", [qid(1), qid(2), qid(3)]);
    const late = account.seedPlaylist("Late", [qid(4), qid(5), qid(6)]);
    await journal.run({ tool: "deduplicate" }, async () => {
      await client.removeTracksFromPlaylist(early, [account.entryIds(early)[1]!]);
      await client.removeTracksFromPlaylist(late, [account.entryIds(late)[1]!]);
    });
    const original = journal.items()[0]!.id;
    // Late is put back first; the second add, to Early, fails.
    account.failAfter("addTracksToPlaylist", 1);
    const first = await undo(original);
    return { ...world, early, late, original, first };
  }

  it("is not marked undone, and says what failed", async () => {
    const { journal, account, early, late, original, first } = await halfUndone();
    expect(first.outcome.done).toEqual(["Put 1 track back in Late, in its old place"]);
    expect(first.outcome.failed).toEqual([
      { step: "Put 1 track back in Early, in its old place", reason: "addTracksToPlaylist failed with HTTP 500" },
    ]);
    expect(first.outcome.undone).toBe(false);
    expect(journal.items().find((i) => i.id === original)?.undone).toBeUndefined();
    expect(account.trackIds(early)).toEqual([qid(1), qid(3)]);
    expect(account.trackIds(late)).toEqual([qid(4), qid(5), qid(6)]);
  });

  it("is finished by undoing it again, which does only what is left", async () => {
    const { journal, account, client, undo, early, late, original } = await halfUndone();

    const { plan, outcome } = await undo(original);

    expect(plan.blocked).toBeUndefined();
    expect(plan.steps.map(describeStep)).toEqual(["Put 1 track back in Early, in its old place"]);
    expect(plan.notes).toEqual([]);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    expect(account.trackIds(early)).toEqual([qid(1), qid(2), qid(3)]);
    // Not added a second time.
    expect(account.trackIds(late)).toEqual([qid(4), qid(5), qid(6)]);
    const item = journal.items().find((i) => i.id === original)!;
    expect(item.undone?.by).toBe(outcome.entryId);
    await expect(planUndo(client, item, journal.items())).resolves.toMatchObject({
      blocked: expect.stringMatching(/^Already undone/),
    });
  });

  it("is what the CLI's plain undo picks up again", async () => {
    const { journal, original } = await halfUndone();
    expect(selectEntry(journal.items())?.id).toBe(original);
  });

  it("puts back only the copies that did not arrive the first time", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(1), qid(3)]);
    const ids = account.entryIds(id);
    await journal.run({ tool: "playlist-manager" }, () => client.removeTracksFromPlaylist(id, [ids[0]!, ids[2]!]));
    const original = journal.items()[0]!.id;
    // A repeated song goes in two requests; the second fails.
    account.failAfter("addTracksToPlaylist", 1);

    const first = await undo(original);
    expect(first.outcome.undone).toBe(false);
    expect(account.trackIds(id)).toEqual([qid(2), qid(3), qid(1)]);

    const { plan, outcome } = await undo(original);
    expect(plan.steps.map(describeStep)).toEqual(["Put 1 track back in Mix, in its old place"]);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(1), qid(3)]);
  });

  it("does not take out or un-favourite again what the first try did", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "x" }, async () => {
      await client.addTracksToPlaylist(id, [qid(2)]);
      await client.addFavoriteTracks([qid(5)]);
      await client.addFavoriteAlbums([qid("a")]);
    });
    const original = journal.items()[0]!.id;
    account.failAfter("removeFavoriteTracks", 0);
    const first = await undo(original);
    expect(first.outcome.undone).toBe(false);
    expect(first.outcome.done).toEqual(["Remove 1 album from Favourites", "Remove 1 track from Mix"]);
    account.calls.length = 0;

    const { plan, outcome } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Favourites"]);
    expect(plan.notes).toEqual([]);
    expect(outcome.undone).toBe(true);
    expect(account.calls.filter((call) => /^(remove|add|delete|update|move)/.test(call))).toEqual([
      "removeFavoriteTracks:5",
    ]);
    expect(account.favourites.tracks).toEqual([]);
  });

  it("does not set details back or delete a playlist a second time", async () => {
    const { journal, account, client, undo } = setup();
    const mix = account.seedPlaylist("Mix", [qid(1)]);
    let made = 0;
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.updatePlaylist!(mix, { name: "Mix 2" });
      made = (await createPlaylistWithTracks(client, { name: "Split", trackIds: [qid(7)] })).id;
      await client.addFavoriteTracks([qid(5)]);
    });
    const original = journal.items()[0]!.id;
    account.failAfter("removeFavoriteTracks", 0);
    await undo(original);
    expect(account.playlists.has(made)).toBe(false);
    expect(account.playlists.get(mix)?.name).toBe("Mix");

    const { plan } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Favourites"]);
    expect(plan.notes).toEqual([]);
  });

  it("fills a playlist it had begun to make again, rather than making another", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [qid(4), qid(4), qid(5), qid(4)]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    const original = journal.items()[0]!.id;
    // The repeats go in three requests; the second fails.
    account.failAfter("addTracksToPlaylist", 1);

    const first = await undo(original);
    expect(first.outcome.undone).toBe(false);
    const [[again, begun]] = [...account.playlists.entries()] as [[PlaylistId, { name: string }]];
    expect(begun.name).toBe("Old");
    expect(account.trackIds(again)).toEqual([qid(4)]);
    expect(journal.items()[0]).toMatchObject({ undoes: original, recreated: [{ was: id, now: again }] });

    const { plan, outcome } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Put the 3 tracks still missing back in Old"]);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    expect([...account.playlists.keys()]).toEqual([again]);
    expect(account.trackIds(again)).toEqual([qid(4), qid(4), qid(5), qid(4)]);
  });

  it("makes the playlist again from nothing when the one it had begun is gone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Old", [qid(4), qid(4)]);
    await journal.run({ tool: "other" }, () => client.deletePlaylist(id));
    const original = journal.items()[0]!.id;
    account.failAfter("addTracksToPlaylist", 1);
    await undo(original);
    account.playlists.clear();

    const { plan } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Recreate the playlist Old with 2 tracks"]);
    expect([...account.playlists.values()].map((p) => p.entries.map((e) => e.trackId))).toEqual([[qid(4), qid(4)]]);
  });

  it("starts over after a try that was itself undone", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "x" }, async () => {
      await client.addTracksToPlaylist(id, [qid(2)]);
      await client.addFavoriteTracks([qid(5)]);
    });
    const original = journal.items()[0]!.id;
    account.failAfter("removeFavoriteTracks", 0);
    const first = await undo(original);
    await undo(first.outcome.entryId); // redo the half that went through
    expect(account.trackIds(id)).toEqual([qid(1), qid(2)]);

    const { plan, outcome } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from Favourites", "Remove 1 track from Mix"]);
    expect(plan.notes).toEqual([]);
    expect(outcome.undone).toBe(true);
    expect(account.trackIds(id)).toEqual([qid(1)]);
  });

  it("ends where the change began, whichever request fails, with nothing put back twice", async () => {
    let seed = 29;
    const random = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const writes = ["addTracksToPlaylist", "movePlaylistTracks", "removeTracksFromPlaylist", "getPlaylistTracks"];
    let retried = 0;
    for (let round = 0; round < 150; round += 1) {
      const { journal, account, client, undo } = setup();
      const id = account.seedPlaylist("Mix", Array.from({ length: 4 + random(10) }, () => qid(1 + random(5))));
      const start = account.trackIds(id);
      await journal.run({ tool: "playlist-manager" }, async () => {
        for (let step = 0; step < 2 + random(5); step += 1) {
          const ids = account.entryIds(id);
          const picked = ids.filter(() => random(3) === 0);
          if (random(3) === 0) {
            await client.addTracksToPlaylist(id, [qid(1 + random(5)), qid(7 + random(3))]);
          } else if (random(2) === 0) {
            await client.removeTracksFromPlaylist(id, picked.slice(0, ids.length - 1));
          } else {
            await client.movePlaylistTracks!(id, picked, 1 + random(ids.length + 1));
          }
        }
      });
      const original = journal.items()[0]?.id;
      if (original === undefined) {
        continue;
      }
      // Some request of the undo fails; each further try may fail once more.
      let outcome: Awaited<ReturnType<typeof undo>>["outcome"] | undefined;
      for (let attempt = 0; attempt < 6 && outcome?.undone !== true; attempt += 1) {
        if (attempt < 2) {
          account.failAfter(writes[random(writes.length)]!, random(4));
        }
        const item = journal.items().find((i) => i.id === original)!;
        const plan = await planUndo(client, item, journal.items());
        if (plan.blocked !== undefined) {
          continue; // the read failed: nothing was done
        }
        outcome = await applyUndo(journal, client, item, plan);
        retried += outcome.undone ? 0 : 1;
      }
      for (const method of writes) {
        account.failAfter(method, Number.MAX_SAFE_INTEGER);
      }
      expect(outcome?.undone, `round ${round}`).toBe(true);
      expect(account.trackIds(id), `round ${round}`).toEqual(start);
    }
    // The failures did hit undos in progress.
    expect(retried).toBeGreaterThan(20);
  });

  it("counts as undone when all that is left is what cannot be done", async () => {
    const { journal, account, client, undo } = setup();
    const from = account.seedPlaylist("From", [qid(1), qid(2)]);
    await journal.run({ tool: "playlist-manager" }, async () => {
      await createPlaylistWithTracks(client, { name: "Split", trackIds: [qid(2)] });
      await client.removeTracksFromPlaylist(from, [account.entryIds(from)[1]!]);
    });
    account.unplayable.add(qid(2));

    const { outcome } = await undo();

    // The song is no longer offered: trying again would change nothing.
    expect(outcome.failed.map((f) => f.step)).toEqual(["Delete the playlist Split (1 track)"]);
    expect(outcome.undone).toBe(true);
  });
});

describe("undo of favourites", () => {
  it("removes added favourites and re-adds removed ones", async () => {
    const { journal, account, client, undo } = setup();
    account.favourites.tracks = [qid(1), qid(2)];
    await journal.run({ tool: "upgrade" }, async () => {
      await client.addFavoriteTracks([qid(3)]);
      await client.removeFavoriteTracks([qid(1)]);
      await client.addFavoriteAlbums([qid("a")]);
    });

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual([
      "Remove 1 album from Favourites",
      "Add 1 track back to Favourites",
      "Remove 1 track from Favourites",
    ]);
    expect([...account.favourites.tracks].sort()).toEqual([qid(1), qid(2)]);
    expect(account.favourites.albums).toEqual([]);
  });
});

describe("planUndo checks", () => {
  it("refuses an entry that is already undone", async () => {
    const { journal, client, undo } = setup();
    await journal.run({ tool: "import" }, () => client.addFavoriteArtists([qid(7)]));
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
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(2)]));
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(3)]));
    const items = journal.items();

    const plan = await planUndo(client, items[1]!, items);

    expect(plan.warnings).toEqual(['A later change also touched it: "Added 1 track to Mix".']);
  });
});

describe("commitUndo", () => {
  it("reports a failing step and carries on with the rest", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "x" }, async () => {
      await client.addTracksToPlaylist(id, [qid(2)]);
      await client.addFavoriteTracks([qid(5)]);
    });
    const items = journal.items();
    const plan = await planUndo(client, items[0]!, items);
    account.failAfter("removeFavoriteTracks", 0);

    const result = await commitUndo(client, plan);

    expect(result.done).toEqual(["Remove 1 track from Mix"]);
    expect(result.failed).toEqual([
      { step: "Remove 1 track from Favourites", reason: "removeFavoriteTracks failed with HTTP 500" },
    ]);
    expect(account.trackIds(id)).toEqual([qid(1)]);
  });

  it("does not mark the entry undone when every step failed", async () => {
    const { journal, account, client, undo } = setup();
    await journal.run({ tool: "x" }, () => client.addFavoriteTracks([qid(5)]));
    account.failAfter("removeFavoriteTracks", 0);

    const { outcome } = await undo();

    expect(outcome.undone).toBe(false);
    expect(journal.items().find((i) => i.tool === "x")?.undone).toBeUndefined();
  });

  it("goes on from a failed undo that an earlier version left in the history", async () => {
    const { journal, account, client, store, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2)]);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    const original = journal.items()[0]!.id;
    // As an earlier version wrote an undo of which every step failed: an
    // entry with no operations and nothing else, the original not marked.
    store.text += `${JSON.stringify({
      v: 1,
      type: "entry",
      id: "old1",
      at: "2026-11-02T20:30:00.000Z",
      tool: "undo",
      source: "web",
      label: "Undid: Removed 1 duplicate from Mix",
      ops: [],
      undoes: original,
    })}\n`;

    const { plan, outcome } = await undo(original);

    expect(plan.steps.map(describeStep)).toEqual(["Put 1 track back in Mix, in its old place"]);
    expect(outcome.undone).toBe(true);
    expect(account.trackIds(id)).toEqual([qid(1), qid(2)]);
  });
});

describe("formatting", () => {
  it("formats a plan and a result for the CLI", async () => {
    const { journal, account, client } = setup();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(2)]));
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(3)]));
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

describe("entries from before ids named their service", () => {
  it("undoes them beside newer ones", async () => {
    const { journal, account, client, store } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2)]);
    const [first] = account.entryIds(id);
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [first!]));
    // As an earlier version wrote it: the same line with Qobuz's bare ids.
    store.text = store.text.replace(/"qobuz:(\d+)"/g, "$1");
    expect(store.text).not.toContain("qobuz:");
    await journal.run({ tool: "word-play" }, () => client.addTracksToPlaylist(id, [qid(9)]));

    const items = journal.items();
    expect(items).toHaveLength(2);
    await applyUndo(journal, client, items[1]!, await planUndo(client, items[1]!, items));
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(9)]);
  });
});

describe("stepping back through the history", () => {
  /** A moves song 3 to the top; B then removes it. */
  async function movedThenRemoved() {
    const world = setup();
    const { journal, account, client } = world;
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3)]);
    await journal.run({ tool: "playlist-manager" }, () => client.movePlaylistTracks!(id, [account.entryIds(id)[2]!], 1));
    await journal.run({ tool: "playlist-manager" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    expect(account.trackIds(id)).toEqual([qid(1), qid(2)]);
    return { ...world, id };
  }

  it("undoes an earlier move of a song that a later undo put back under a new id", async () => {
    const { journal, account, undo, id } = await movedThenRemoved();
    const [b, a] = journal.items();

    await undo(b!.id);
    expect(account.trackIds(id)).toEqual([qid(3), qid(1), qid(2)]);

    const { plan, outcome } = await undo(a!.id);
    expect(plan.steps.map(describeStep)).toEqual(["Put Mix back in its old order"]);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(3)]);
  });

  it("keeps the new ids on the undo's own entry", async () => {
    const { journal, account, undo, id } = await movedThenRemoved();
    const before = journal.items()[0]!;
    const removed = before.ops.flatMap((op) => (op.kind === "remove-tracks" ? op.entries : []))[0]!;

    await undo(before.id);

    expect(journal.items()[0]).toMatchObject({
      undoes: before.id,
      renamed: [{ playlistId: id, entries: [[removed.playlistTrackId, account.entryIds(id)[0]]] }],
    });
  });

  it("follows a song through several undos", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1), qid(2), qid(3)]);
    // A moves 3 to the top; B removes it; undo B; C removes it again; undo C.
    await journal.run({ tool: "playlist-manager" }, () => client.movePlaylistTracks!(id, [account.entryIds(id)[2]!], 1));
    const a = journal.items()[0]!;
    await journal.run({ tool: "playlist-manager" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    await undo();
    await journal.run({ tool: "playlist-manager" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[0]!]));
    await undo();
    expect(account.trackIds(id)).toEqual([qid(3), qid(1), qid(2)]);

    await undo(a.id);

    expect(account.trackIds(id)).toEqual([qid(1), qid(2), qid(3)]);
  });

  it("takes out what an earlier entry added, after a later undo put it back", async () => {
    const { journal, account, client, undo } = setup();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(id, [qid(2)]));
    const a = journal.items()[0]!;
    await journal.run({ tool: "deduplicate" }, () => client.removeTracksFromPlaylist(id, [account.entryIds(id)[1]!]));
    await undo();
    expect(account.trackIds(id)).toEqual([qid(1), qid(2)]);

    const { plan } = await undo(a.id);

    expect(plan.notes).toEqual([]);
    expect(account.trackIds(id)).toEqual([qid(1)]);
  });

  it("does the same where ids are stable on another service (TIDAL)", async () => {
    const { journal, fake, client, seed } = tidalSetup();
    const id = seed("Mix", [1, 2, 3]);
    const native = String(id).replace("tidal:", "");
    const entries = async () => (await client.getPlaylistTracks(id)).map((t) => t.playlistTrackId!);
    await journal.run({ tool: "playlist-manager" }, async () => client.movePlaylistTracks(id, [(await entries())[2]!], 1));
    await journal.run({ tool: "playlist-manager" }, async () => client.removeTracksFromPlaylist(id, [(await entries())[0]!]));
    expect(fake.contents(native)).toEqual(["tracks:1", "tracks:2"]);
    const undo = async (entryId: string) => {
      const items = journal.items();
      const item = items.find((i) => i.id === entryId)!;
      return applyUndo(journal, client, item, await planUndo(client, item, items));
    };
    const [b, a] = journal.items();

    await undo(b!.id);
    expect(fake.contents(native)).toEqual(["tracks:3", "tracks:1", "tracks:2"]);
    await undo(a!.id);

    expect(fake.contents(native)).toEqual(["tracks:1", "tracks:2", "tracks:3"]);
  });

  it("still reads an undo written before new ids were kept, and plans as it did then", async () => {
    const { journal, account, client, store, undo, id } = await movedThenRemoved();
    const [b, a] = journal.items();
    await undo(b!.id);
    // As an earlier version wrote the undo's entry: without the new ids.
    store.text = store.text.replace(/,"renamed":\[.*?\]\]\}\]/, "");
    expect(store.text).not.toContain("renamed");

    const items = journal.items();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ undoes: b!.id, tool: "undo" });
    const plan = await planUndo(client, items.find((i) => i.id === a!.id)!, items);

    expect(plan.blocked).toBeUndefined();
    expect(plan.steps).toEqual([]);
    expect(account.trackIds(id)).toEqual([qid(3), qid(1), qid(2)]);
  });
});

/**
 * Spotify (the fake behind the real service), recorded. Its entries have no
 * ids of their own: one is named `<song>#<copy>`, counted afresh at each read.
 * A playlist is written as its songs' letters, "abac".
 */
function spotifySetup(playlists: Record<string, string>) {
  const { store, journal } = newJournal();
  const fake = new FakeSpotify();
  for (const name of "abcdefghxyz") {
    fake.addTrack(name, { name: `Song ${name}` });
  }
  const songs = (letters: string) => [...letters].map((letter) => `spotify:track:${letter}`);
  for (const [name, letters] of Object.entries(playlists)) {
    fake.seedPlaylist(name, songs(letters));
  }
  const service = new SpotifyService(
    new SpotifyClient({ tokens: fake.tokens, fetchImpl: fake.fetchImpl, sleep: async () => {} }),
  );
  /** Requests that fail: a method's name to how many more calls go through first. */
  const failing = new Map<string, number>();
  for (const method of ["addTracksToPlaylist", "movePlaylistTracks", "removeTracksFromPlaylist"] as const) {
    const real = service[method].bind(service) as (...args: unknown[]) => Promise<void>;
    (service as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const left = failing.get(method);
      if (left !== undefined) {
        failing.set(method, left - 1);
        if (left <= 0) {
          failing.delete(method);
          throw new Error(`${method} failed with HTTP 500`);
        }
      }
      return real(...args);
    };
  }
  const client = recordingClient(service, journal);
  const playlist = (name: string) => tagId<PlaylistId>("spotify", name);
  const track = (letter: string) => tagId<TrackId>("spotify", letter);
  const now = (name: string) => fake.uris(name).map((uri) => uri!.split(":")[2]).join("");
  /** The ids of the entries holding these places (0-based), as a fresh read names them. */
  const entriesAt = async (name: string, places: readonly number[]) => {
    const tracks = await client.getPlaylistTracks(playlist(name));
    return places.map((place) => tracks[place]!.playlistTrackId!);
  };
  /** Change a playlist as the user would, in Spotify's own app. */
  const elsewhere = (name: string, letters: string) => fake.edit(name, () => songs(letters));
  const undo = async (id?: string, through: Parameters<typeof planUndo>[0] & Parameters<typeof applyUndo>[1] = client) => {
    const items = journal.items();
    const item = id === undefined ? items[0]! : items.find((i) => i.id === id)!;
    const plan = await planUndo(through, item, items);
    const outcome = await applyUndo(journal, through, item, plan);
    return { plan, outcome };
  };
  return { store, journal, fake, service, client, playlist, track, now, entriesAt, elsewhere, undo, failing };
}

describe("undo where entries have no ids of their own (Spotify)", () => {
  it("puts back the removed copy of a song that is in the playlist more than once", async () => {
    const { journal, client, playlist, now, entriesAt, undo } = spotifySetup({ p: "abac" });
    await journal.run({ tool: "deduplicate" }, async () =>
      client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [0])),
    );
    expect(now("p")).toBe("bac");

    // The copy that stayed is "a#1" now, as the removed one was then.
    const { plan, outcome } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Put 1 track back in p, in its old place"]);
    expect(outcome).toMatchObject({ undone: true, failed: [] });
    expect(now("p")).toBe("abac");
  });

  it("puts back the later copy too, and can redo both", async () => {
    const { journal, client, playlist, now, entriesAt, undo } = spotifySetup({ p: "abacad" });
    await journal.run({ tool: "deduplicate" }, async () =>
      client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [2, 4])),
    );
    expect(now("p")).toBe("abcd");

    await undo();
    expect(now("p")).toBe("abacad");

    await undo(journal.items()[0]!.id);
    expect(now("p")).toBe("abcd");
  });

  it("takes out the copy it added, not one the user added later", async () => {
    const { journal, client, playlist, track, now, elsewhere, undo } = spotifySetup({ p: "ab" });
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(playlist("p"), [track("a")]));
    expect(now("p")).toBe("aba");
    // The user takes their first copy out, and later adds c and the song again.
    elsewhere("p", "baca");

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Remove 1 track from p"]);
    expect(now("p")).toBe("bca");
  });

  it("leaves the user's own copy alone when the one it added is gone", async () => {
    const { journal, client, playlist, track, now, elsewhere, undo } = spotifySetup({ p: "abc" });
    await journal.run({ tool: "similar-artists" }, () => client.addTracksToPlaylist(playlist("p"), [track("a")]));
    expect(now("p")).toBe("abca");
    elsewhere("p", "abc"); // the user took the added copy out again

    const { plan } = await undo();

    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual(["1 of the tracks added to p is no longer in it."]);
    expect(now("p")).toBe("abc");
  });

  it("moves a song back when another copy of it changed which copy it counts as", async () => {
    const { journal, client, playlist, now, entriesAt, undo } = spotifySetup({ p: "axay" });
    await journal.run({ tool: "playlist-manager" }, async () =>
      client.movePlaylistTracks(playlist("p"), await entriesAt("p", [0]), 5),
    );
    expect(now("p")).toBe("xaya");

    const { plan } = await undo();

    expect(plan.steps.map(describeStep)).toEqual(["Put p back in its old order"]);
    expect(now("p")).toBe("axay");
  });

  it("reverses a change that removed, added and moved in one go", async () => {
    const { journal, client, playlist, track, now, entriesAt, undo } = spotifySetup({ p: "abab" });
    await journal.run({ tool: "playlist-manager" }, async () => {
      await client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [0]));
      await client.addTracksToPlaylist(playlist("p"), [track("c"), track("a")]);
      await client.movePlaylistTracks(playlist("p"), await entriesAt("p", [4]), 1);
    });
    expect(now("p")).toBe("ababc");

    await undo();
    expect(now("p")).toBe("abab");

    await undo(journal.items()[0]!.id);
    expect(now("p")).toBe("ababc");
  });

  it("steps back through the history", async () => {
    const { journal, client, playlist, now, entriesAt, undo } = spotifySetup({ p: "abcb" });
    // A moves the last b to the top; B then removes it.
    await journal.run({ tool: "playlist-manager" }, async () =>
      client.movePlaylistTracks(playlist("p"), await entriesAt("p", [3]), 1),
    );
    await journal.run({ tool: "playlist-manager" }, async () =>
      client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [0])),
    );
    expect(now("p")).toBe("abc");
    const [b, a] = journal.items();

    await undo(b!.id);
    expect(now("p")).toBe("babc");
    await undo(a!.id);

    expect(now("p")).toBe("abcb");
  });

  it("deletes a playlist it created, and only its own songs from one that gained others", async () => {
    const { journal, fake, client, track, now, elsewhere, undo } = spotifySetup({});
    let made = "";
    await journal.run({ tool: "playlist-from-artists" }, async () => {
      const playlist = await client.createPlaylist("Road Trip");
      made = String(playlist.id).replace("spotify:", "");
      await client.addTracksToPlaylist(playlist.id, [track("a"), track("b")]);
      await client.addTracksToPlaylist(playlist.id, [track("a")]);
    });
    const original = journal.items()[0]!.id;
    expect(now(made)).toBe("aba");

    const first = await undo(original);
    expect(first.plan.steps.map(describeStep)).toEqual(["Delete the playlist Road Trip (3 tracks)"]);
    expect(fake.shown).not.toContain(made);

    await undo(first.outcome.entryId); // made again, under a new id
    const again = fake.shown.at(-1)!;
    expect(now(again)).toBe("aba");
    elsewhere(again, "xabay");
    const redone = journal.items()[0]!;
    const { plan } = await undo(redone.id);
    expect(plan.steps.map(describeStep)).toEqual(["Remove 3 tracks from Road Trip"]);
    expect(now(again)).toBe("xy");
  });

  it("finishes an undo that failed part-way without putting anything back twice", async () => {
    const { journal, client, playlist, now, entriesAt, undo, failing } = spotifySetup({ early: "abac", late: "xyxz" });
    await journal.run({ tool: "deduplicate" }, async () => {
      await client.removeTracksFromPlaylist(playlist("early"), await entriesAt("early", [0]));
      await client.removeTracksFromPlaylist(playlist("late"), await entriesAt("late", [0]));
    });
    const original = journal.items()[0]!.id;
    expect([now("early"), now("late")]).toEqual(["bac", "yxz"]);
    failing.set("addTracksToPlaylist", 1); // late is put back; early fails

    const first = await undo(original);
    expect(first.outcome.undone).toBe(false);
    expect([now("early"), now("late")]).toEqual(["bac", "xyxz"]);

    const { plan, outcome } = await undo(original);
    expect(plan.steps.map(describeStep)).toEqual(["Put 1 track back in early, in its old place"]);
    expect(outcome.undone).toBe(true);
    expect([now("early"), now("late")]).toEqual(["abac", "xyxz"]);
  });

  it("moves into place what an earlier try could only put back at the end", async () => {
    const { journal, client, playlist, now, entriesAt, undo, failing } = spotifySetup({ p: "abac" });
    await journal.run({ tool: "deduplicate" }, async () =>
      client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [0])),
    );
    const original = journal.items()[0]!.id;
    failing.set("movePlaylistTracks", 0);

    const first = await undo(original);
    expect(first.outcome.undone).toBe(false);
    expect(now("p")).toBe("baca");

    const { plan, outcome } = await undo(original);
    expect(plan.steps.map(describeStep)).toEqual(["Put p back in its old order"]);
    expect(outcome.undone).toBe(true);
    expect(now("p")).toBe("abac");
  });

  it("goes by the playlist's own service when the app is on another", async () => {
    const { journal, client, playlist, now, entriesAt, undo } = spotifySetup({ p: "abac" });
    const tidal = tidalSetup();
    const hub = new ServiceHub();
    hub.connect(client);
    hub.connect(tidal.client);
    await journal.run({ tool: "deduplicate" }, async () =>
      client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", [0])),
    );

    await undo(undefined, hub.scoped("tidal"));

    expect(now("p")).toBe("abac");
  });

  it("reverses any mix of adding, removing and moving, and redoes it", async () => {
    let seed = 5;
    const random = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const letters = "abcd";
    for (let round = 0; round < 60; round += 1) {
      const start = Array.from({ length: 3 + random(8) }, () => letters[random(letters.length)]).join("");
      const { journal, client, playlist, track, now, entriesAt, undo } = spotifySetup({ p: start });
      await journal.run({ tool: "playlist-manager" }, async () => {
        for (let step = 0; step < 2 + random(5); step += 1) {
          const size = now("p").length;
          const picked = Array.from({ length: size }, (_, place) => place).filter(() => random(3) === 0);
          if (random(3) === 0) {
            await client.addTracksToPlaylist(playlist("p"), [track(letters[random(letters.length)]!), track("xyz"[random(3)]!)]);
          } else if (random(2) === 0) {
            await client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", picked.slice(0, size - 1)));
          } else {
            await client.movePlaylistTracks(playlist("p"), await entriesAt("p", picked), 1 + random(size + 1));
          }
        }
      });
      if (journal.items().length === 0) {
        continue;
      }
      const after = now("p");
      const { outcome } = await undo();
      expect(outcome.failed, `round ${round}`).toEqual([]);
      expect(now("p"), `round ${round}: ${start} -> ${after}`).toBe(start);
      await undo(journal.items()[0]!.id);
      expect(now("p"), `round ${round}: redo`).toBe(after);
    }
  });

  it("ends where the change began, whichever request fails, with nothing put back twice", async () => {
    let seed = 17;
    const random = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const letters = "abcd";
    const writes = ["addTracksToPlaylist", "movePlaylistTracks", "removeTracksFromPlaylist"];
    let retried = 0;
    for (let round = 0; round < 80; round += 1) {
      const start = Array.from({ length: 3 + random(8) }, () => letters[random(letters.length)]).join("");
      const { journal, client, playlist, track, now, entriesAt, undo, failing } = spotifySetup({ p: start });
      await journal.run({ tool: "playlist-manager" }, async () => {
        for (let step = 0; step < 2 + random(5); step += 1) {
          const size = now("p").length;
          const picked = Array.from({ length: size }, (_, place) => place).filter(() => random(3) === 0);
          if (random(3) === 0) {
            await client.addTracksToPlaylist(playlist("p"), [track(letters[random(letters.length)]!), track("xyz"[random(3)]!)]);
          } else if (random(2) === 0) {
            await client.removeTracksFromPlaylist(playlist("p"), await entriesAt("p", picked.slice(0, size - 1)));
          } else {
            await client.movePlaylistTracks(playlist("p"), await entriesAt("p", picked), 1 + random(size + 1));
          }
        }
      });
      const original = journal.items()[0]?.id;
      if (original === undefined) {
        continue;
      }
      let undone = false;
      for (let attempt = 0; attempt < 6 && !undone; attempt += 1) {
        if (attempt < 2) {
          failing.set(writes[random(writes.length)]!, random(3));
        }
        undone = (await undo(original)).outcome.undone;
        retried += undone ? 0 : 1;
      }
      expect(undone, `round ${round}`).toBe(true);
      expect(now("p"), `round ${round}`).toBe(start);
    }
    expect(retried).toBeGreaterThan(10);
  });

  it("still undoes a move recorded before the songs moved were kept, by its ids as before", async () => {
    const { journal, client, playlist, now, entriesAt } = spotifySetup({ p: "abc" });
    await journal.run({ tool: "playlist-manager" }, async () =>
      client.movePlaylistTracks(playlist("p"), await entriesAt("p", [2]), 1),
    );
    const item = structuredClone(journal.items()[0]!);
    for (const op of item.ops) {
      if (op.kind === "move-tracks") {
        delete op.trackIds;
      }
    }
    const plan = await planUndo(client, item, [item]);
    await commitUndo(client, plan);
    expect(now("p")).toBe("abc");
  });
});
