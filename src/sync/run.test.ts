import { describe, expect, it } from "vitest";

import { MemoryMatches } from "../features/match.js";
import { ServiceError } from "../services/errors.js";
import type { PlaylistId, ServiceName } from "../services/ids.js";
import { emptyLinkState, type LinkCopies, type LinkState } from "./model.js";
import { linkAsSame, resolveConflict, syncLink, type SyncOutcome } from "./run.js";
import { SyncAccount } from "./world.test-support.js";

const NOW = new Date("2026-11-23T12:00:00Z");

/** A link of one playlist on each service, all holding `songs`, already synced once. */
function world(songs: number[], names: ServiceName[] = ["qobuz", "tidal"]) {
  const accounts = new Map(names.map((name) => [name, new SyncAccount(name)]));
  const copies: LinkCopies = Object.fromEntries(names.map((name) => [name, accounts.get(name)!.seed("Mix", songs)]));
  const matches = new MemoryMatches();
  let state: LinkState = emptyLinkState();
  const saves: LinkState[] = [];
  const at = (name: ServiceName) => ({ account: accounts.get(name)!, id: copies[name]! as PlaylistId });
  const sync = async (): Promise<SyncOutcome> => {
    const outcome = await syncLink({
      clients: accounts,
      copies,
      state,
      matches,
      now: NOW,
      save: (next) => {
        saves.push(structuredClone(next));
        state = next;
      },
    });
    state = outcome.state;
    return outcome;
  };
  return {
    accounts,
    copies,
    matches,
    saves,
    sync,
    at,
    get state() {
      return state;
    },
    set state(next: LinkState) {
      state = next;
    },
    songs: (name: ServiceName) => at(name).account.songs(at(name).id),
    edit: (name: ServiceName, change: (songs: number[]) => number[]) => at(name).account.edit(at(name).id, change),
    writes: () => [...accounts.values()].flatMap((account) => account.writes.map((w) => `${account.name}: ${w}`)),
    clearWrites: () => accounts.forEach((account) => (account.writes = [])),
  };
}

async function linked(songs: number[], names?: ServiceName[]) {
  const w = world(songs, names);
  expect((await w.sync()).status).toBe("synced");
  expect(w.writes()).toEqual([]);
  return w;
}

const without = (...gone: number[]) => (songs: number[]) => songs.filter((n) => !gone.includes(n));

describe("a first sync", () => {
  it("takes equal copies as the same, writing nothing", async () => {
    const w = await linked([1, 2, 3]);
    expect(w.state.base?.songs).toHaveLength(3);
    expect(w.state.base?.songs[0]?.ids).toEqual({ qobuz: "qobuz:1", tidal: "tidal:1" });
  });

  it("is a conflict when the copies differ, and nothing is assumed", async () => {
    const w = world([1, 2, 3]);
    w.edit("tidal", without(2));
    const outcome = await w.sync();
    expect(outcome.status).toBe("conflict");
    expect(w.state.conflicts).toEqual([{ kind: "first-link" }]);
    expect(w.writes()).toEqual([]);
  });

  it("can start from the copies as they are, knowing what differs", async () => {
    const w = world([1, 2, 3]);
    w.edit("tidal", without(2));
    await w.sync();
    w.state = await linkAsSame({ clients: w.accounts, copies: w.copies, state: w.state, matches: w.matches, from: "qobuz", now: NOW });
    expect((await w.sync()).status).toBe("synced");
    expect([w.songs("qobuz"), w.songs("tidal")]).toEqual([[1, 2, 3], [1, 2, 3]]);
  });
});

describe("a sync", () => {
  it("copies an addition, in its place", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", () => [1, 9, 2, 3]);
    const outcome = await w.sync();
    expect(w.songs("tidal")).toEqual([1, 9, 2, 3]);
    expect(outcome).toMatchObject({ status: "synced", changes: [{ service: "tidal", added: 1, removed: 0 }] });
  });

  it("copies a removal", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("tidal", without(2));
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 3]);
  });

  it("copies a reorder", async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("tidal", () => [4, 1, 2, 3]);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([4, 1, 2, 3]);
  });

  it("copies a new name", async () => {
    const w = await linked([1]);
    w.at("qobuz").account.rename(w.copies.qobuz!, "Better");
    await w.sync();
    expect((await w.at("tidal").account.getPlaylist(w.copies.tidal!)).name).toBe("Better");
  });

  it("merges additions and removals made on both sides", async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("qobuz", () => [1, 10, 2, 3, 4]);
    w.edit("tidal", () => [1, 2, 4, 11]);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 10, 2, 4, 11]);
    expect(w.songs("tidal")).toEqual([1, 10, 2, 4, 11]);
  });

  it("takes the same change on both sides as agreement", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", () => [1, 9, 3]);
    w.edit("tidal", () => [1, 9, 3]);
    expect((await w.sync()).status).toBe("synced");
    expect(w.writes()).toEqual([]);
    expect(w.state.base?.songs.map((song) => song.ids.qobuz)).toEqual(["qobuz:1", "qobuz:9", "qobuz:3"]);
  });

  it("writes nothing the second time", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", () => [3, 1, 8, 2]);
    await w.sync();
    w.clearWrites();
    expect((await w.sync()).status).toBe("unchanged");
    expect(w.writes()).toEqual([]);
  });

  it("keeps three services the same", async () => {
    const w = await linked([1, 2, 3], ["qobuz", "tidal", "spotify"]);
    w.edit("qobuz", () => [1, 2, 3, 7]);
    w.edit("spotify", without(1));
    await w.sync();
    for (const name of ["qobuz", "tidal", "spotify"] as const) {
      expect(w.songs(name)).toEqual([2, 3, 7]);
    }
  });

  it("keeps a song that is on the list twice, and removes only the one taken out", async () => {
    const w = await linked([1, 2, 1, 3]);
    w.edit("qobuz", () => [2, 1, 3]);
    await w.sync();
    expect(w.songs("tidal")).toEqual([2, 1, 3]);
    w.edit("tidal", () => [2, 1, 3, 1]);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([2, 1, 3, 1]);
  });

  it("works where entries are places, repeated songs included", async () => {
    const w = world([1, 2, 1, 3, 4], ["qobuz", "spotify"]);
    w.at("spotify").account.positional = true;
    await w.sync();
    w.edit("qobuz", () => [4, 1, 1, 5, 3]);
    await w.sync();
    expect(w.songs("spotify")).toEqual([4, 1, 1, 5, 3]);
  });

  it("saves what it will write before the first write, and clears it after", async () => {
    const w = await linked([1, 2]);
    w.saves.length = 0;
    w.edit("qobuz", () => [1, 2, 3]);
    await w.sync();
    expect(w.saves[0]?.pending?.copies.tidal).toEqual({ before: ["tidal:1", "tidal:2"], after: ["tidal:1", "tidal:2", "tidal:3"] });
    expect(w.state.pending).toBeUndefined();
  });

  it("does nothing when a copy cannot be read", async () => {
    const w = await linked([1, 2]);
    w.edit("qobuz", without(1));
    w.at("tidal").account.getPlaylistTracks = async () => {
      throw new ServiceError("tidal", "network", "offline");
    };
    await expect(w.sync()).rejects.toMatchObject({ kind: "network" });
    expect(w.writes()).toEqual([]);
  });

  it("stops without writing when a copy changes while it works", async () => {
    const w = await linked([1, 2]);
    w.edit("qobuz", () => [1, 2, 3]);
    const { account, id } = w.at("tidal");
    const read = account.getPlaylistTracks.bind(account);
    let reads = 0;
    account.getPlaylistTracks = async (playlist) => {
      const tracks = await read(playlist);
      reads += 1;
      if (reads === 1) {
        account.edit(id, () => [2, 1]);
      }
      return tracks;
    };
    expect((await w.sync()).status).toBe("failed");
    expect(w.writes()).toEqual([]);
    expect(w.state.pending).toBeUndefined();
  });
});

describe("a repeated song a copy cannot remove one of (Spotify)", () => {
  async function repeated() {
    const w = await linked([1, 2, 1, 3], ["qobuz", "spotify"]);
    w.at("spotify").account.readdsRepeats = true;
    w.edit("qobuz", () => [2, 1, 3]);
    expect((await w.sync()).status).toBe("synced");
    return w;
  }

  it("is asked about, and the removal is not put back", async () => {
    const w = await repeated();
    expect(w.state.questions).toMatchObject([{ kind: "repeated", service: "spotify" }]);
    for (let round = 0; round < 3; round += 1) {
      await w.sync();
      expect([w.songs("qobuz"), w.songs("spotify")]).toEqual([[2, 1, 3], [1, 2, 1, 3]]);
      expect(w.state.questions).toMatchObject([{ kind: "repeated" }]);
    }
  });

  it("answered removed, goes from that copy too", async () => {
    const w = await repeated();
    const [question] = w.state.questions;
    w.state = { ...w.state, answers: { [question!.key]: "removed" } };
    await w.sync();
    expect(w.songs("spotify").filter((n) => n === 1)).toHaveLength(1);
    expect(w.state.questions).toEqual([]);
    w.clearWrites();
    expect((await w.sync()).status).toBe("unchanged");
    expect(w.writes()).toEqual([]);
  });

  it("answered keep, stays there and is not asked again", async () => {
    const w = await repeated();
    const [question] = w.state.questions;
    w.state = { ...w.state, answers: { [question!.key]: "keep" } };
    await w.sync();
    await w.sync();
    expect([w.songs("qobuz"), w.songs("spotify")]).toEqual([[2, 1, 3], [1, 2, 1, 3]]);
    expect(w.state.questions).toEqual([]);
  });

  it("removed there later by the user, is simply gone", async () => {
    const w = await repeated();
    w.edit("spotify", () => [2, 1, 3]);
    await w.sync();
    expect([w.songs("qobuz"), w.songs("spotify")]).toEqual([[2, 1, 3], [2, 1, 3]]);
    expect(w.state.questions).toEqual([]);
  });
});

describe("what is not a removal", () => {
  it("a song the service withdrew stays on the others", async () => {
    const w = await linked([1, 2, 3]);
    w.at("tidal").account.withdraw(2);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 3]);
    expect(w.state.base?.songs[1]?.gaps).toEqual({ tidal: "withdrawn" });
    w.clearWrites();
    await w.sync();
    expect(w.writes()).toEqual([]);
  });

  it("a song that may have been withdrawn waits for an answer, and nothing else does", async () => {
    const w = await linked([1, 2, 3]);
    w.at("tidal").account.knowsAvailability = false;
    w.edit("tidal", () => [1, 3, 4]);
    const outcome = await w.sync();
    expect(outcome.status).toBe("synced");
    expect(w.songs("qobuz")).toEqual([1, 2, 3, 4]);
    expect(w.songs("tidal")).toEqual([1, 3, 4]);
    expect(w.state.questions).toMatchObject([{ kind: "removed-or-withdrawn", service: "tidal", song: { id: "tidal:2" } }]);
    // Asked again, not acted on, until answered.
    await w.sync();
    expect(w.songs("qobuz")).toContain(2);

    w.state = { ...w.state, answers: { [w.state.questions[0]!.key]: "removed" } };
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 3, 4]);
    expect([w.state.questions, w.state.answers]).toEqual([[], {}]);
  });

  it("waits where the service finds songs it no longer offers just the same", async () => {
    const w = await linked([1, 2, 3]);
    Object.assign(w.at("tidal").account, { capabilities: { playability: { ok: false, reason: "cannot say" } } });
    w.edit("tidal", without(2));
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 3]);
    expect(w.state.questions).toMatchObject([{ kind: "removed-or-withdrawn" }]);
  });

  it("answered as withdrawn, it stays on the others for good", async () => {
    const w = await linked([1, 2, 3]);
    w.at("tidal").account.knowsAvailability = false;
    w.edit("tidal", without(2));
    await w.sync();
    w.state = { ...w.state, answers: { [w.state.questions[0]!.key]: "withdrawn" } };
    await w.sync();
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 3]);
    expect(w.state.questions).toEqual([]);
  });

  it("a song that could not be checked waits too", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("tidal", without(2));
    w.at("tidal").account.getTrack = async () => {
      throw new ServiceError("tidal", "network", "offline");
    };
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 3]);
    expect(w.state.questions).toHaveLength(1);
  });

  it("a song whose id the service replaced is the same song", async () => {
    const w = await linked([1, 2, 3]);
    w.at("tidal").account.alias.set(92, 2);
    w.edit("tidal", () => [1, 92, 3]);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 3]);
    expect(w.songs("tidal")).toEqual([1, 92, 3]);
    expect(w.state.base?.songs[1]?.ids.tidal).toBe("tidal:92");
  });
});

describe("songs a service does not have", () => {
  it("are gaps: on the other copies, and not a removal here", async () => {
    const w = await linked([1, 2]);
    w.at("tidal").account.absent.add(9);
    w.edit("qobuz", () => [1, 9, 2]);
    const outcome = await w.sync();
    expect(w.songs("tidal")).toEqual([1, 2]);
    expect(outcome.gaps).toMatchObject([{ service: "tidal", gap: "not-found" }]);
    w.clearWrites();
    await w.sync();
    expect([w.songs("qobuz"), w.writes()]).toEqual([[1, 9, 2], []]);
  });

  it("are gaps when the service takes the add but drops it", async () => {
    const w = await linked([1, 2]);
    const { account } = w.at("tidal");
    const find = account.findByIsrc.bind(account);
    account.findByIsrc = async (isrcs) => {
      account.withdrawn.delete(9);
      const found = await find(isrcs);
      account.withdrawn.add(9);
      return found;
    };
    w.edit("qobuz", () => [1, 2, 9]);
    await w.sync();
    expect([w.songs("qobuz"), w.songs("tidal")]).toEqual([[1, 2, 9], [1, 2]]);
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 2, 9]);
  });

  it("are filled when the user adds the song there by hand", async () => {
    const w = await linked([1, 2]);
    w.at("tidal").account.absent.add(9);
    w.edit("qobuz", () => [1, 9, 2]);
    await w.sync();
    w.at("tidal").account.absent.delete(9);
    w.edit("tidal", () => [1, 9, 2]);
    w.clearWrites();
    await w.sync();
    expect([w.songs("qobuz"), w.songs("tidal"), w.writes()]).toEqual([[1, 9, 2], [1, 9, 2], []]);
  });

  it("are looked for again after a week", async () => {
    const w = await linked([1, 2]);
    w.at("tidal").account.absent.add(9);
    w.edit("qobuz", () => [1, 9, 2]);
    await w.sync();
    w.at("tidal").account.absent.delete(9);
    await w.sync();
    expect(w.songs("tidal")).toEqual([1, 2]);
    w.state = { ...w.state, gapsCheckedAt: "2026-11-01T00:00:00.000Z" };
    await w.sync();
    expect(w.songs("tidal")).toEqual([1, 9, 2]);
  });

  it("are removed everywhere when removed from a copy that has them", async () => {
    const w = await linked([1, 2]);
    w.at("tidal").account.absent.add(9);
    w.edit("qobuz", () => [1, 9, 2]);
    await w.sync();
    w.edit("qobuz", without(9));
    await w.sync();
    expect(w.state.base?.songs).toHaveLength(2);
  });
});

describe("an uncertain match", () => {
  it("waits for the user while the rest is synced", async () => {
    const w = await linked([1, 2]);
    const { account } = w.at("tidal");
    account.findByIsrc = async () => new Map();
    w.edit("qobuz", () => [1, 9, 2]);
    w.edit("tidal", () => [1, 2, 3]);
    await w.sync();
    expect(w.songs("tidal")).toEqual([1, 2, 3]);
    expect(w.songs("qobuz")).toEqual([1, 9, 2, 3]);
    expect(w.state.questions).toMatchObject([{ kind: "match", on: "tidal", song: { id: "qobuz:9" } }]);
    w.matches.remember(w.at("qobuz").account.id(9), "tidal", account.id(9));
    await w.sync();
    expect(w.songs("tidal")).toEqual([1, 9, 2, 3]);
    expect(w.state.questions).toEqual([]);
  });

  it("the user leaves out is a gap", async () => {
    const w = await linked([1, 2]);
    w.matches.remember(w.at("qobuz").account.id(9), "tidal", null);
    w.edit("qobuz", () => [1, 9, 2]);
    await w.sync();
    expect([w.songs("tidal"), w.state.questions]).toEqual([[1, 2], []]);
  });

  it("two songs that are one song there are written once, and removing it asks which", async () => {
    const w = await linked([1, 2]);
    w.matches.remember(w.at("qobuz").account.id(7), "tidal", w.at("tidal").account.id(1));
    w.edit("qobuz", () => [1, 7, 2]);
    await w.sync();
    expect(w.songs("tidal")).toEqual([1, 2]);
    expect(w.state.base?.songs[1]?.gaps).toEqual({ tidal: "same-as" });
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 7, 2]);
    w.edit("tidal", without(1));
    await w.sync();
    expect(w.songs("qobuz")).toEqual([1, 7, 2]);
    expect(w.state.questions).toMatchObject([{ kind: "which-was-removed", service: "tidal" }]);
  });
});

describe("conflicts write nothing, anywhere", () => {
  const conflict = async (w: Awaited<ReturnType<typeof linked>>) => {
    const before = [...w.accounts.keys()].map((name) => {
      try {
        return w.songs(name);
      } catch {
        return undefined;
      }
    });
    const outcome = await w.sync();
    expect(outcome.status).toBe("conflict");
    expect(w.writes()).toEqual([]);
    const after = [...w.accounts.keys()].map((name) => {
      try {
        return w.songs(name);
      } catch {
        return undefined;
      }
    });
    expect(after).toEqual(before);
    return w.state.conflicts;
  };

  it("removed on one copy and moved on another", async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("qobuz", without(2));
    w.edit("tidal", () => [2, 1, 3, 4]);
    expect(await conflict(w)).toMatchObject([
      { kind: "removed-and-changed", removedOn: "qobuz", changedOn: "tidal", change: "moved" },
    ]);
  });

  it("removed on one copy and duplicated on another", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", without(2));
    w.edit("tidal", () => [1, 2, 3, 2]);
    expect(await conflict(w)).toMatchObject([{ kind: "removed-and-changed", change: "duplicated" }]);
  });

  it("reordered differently", async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("qobuz", () => [4, 1, 2, 3]);
    w.edit("tidal", () => [2, 1, 3, 4]);
    expect(await conflict(w)).toMatchObject([{ kind: "reordered", services: ["qobuz", "tidal"] }]);
  });

  it("renamed differently", async () => {
    const w = await linked([1]);
    w.at("qobuz").account.rename(w.copies.qobuz!, "A");
    w.at("tidal").account.rename(w.copies.tidal!, "B");
    expect(await conflict(w)).toMatchObject([{ kind: "renamed", names: [{ name: "A" }, { name: "B" }] }]);
  });

  it("a copy deleted", async () => {
    const w = await linked([1]);
    w.at("tidal").account.remove(w.copies.tidal!);
    expect(await conflict(w)).toEqual([{ kind: "gone", service: "tidal" }]);
  });

  it("a copy that is no longer the user's", async () => {
    const w = await linked([1]);
    w.at("tidal").account.disown(w.copies.tidal!);
    expect(await conflict(w)).toEqual([{ kind: "not-editable", service: "tidal" }]);
  });

  it("a copy emptied, however short", async () => {
    const w = await linked([1, 2]);
    w.edit("qobuz", () => []);
    expect(await conflict(w)).toEqual([{ kind: "many-removed", service: "qobuz", removed: 2, of: 2 }]);
  });

  it("a copy that lost ten songs and a quarter", async () => {
    const all = Array.from({ length: 40 }, (_, i) => i + 1);
    const w = await linked(all);
    w.edit("tidal", (songs) => songs.slice(10));
    expect(await conflict(w)).toEqual([{ kind: "many-removed", service: "tidal", removed: 10, of: 40 }]);
    const ok = await linked(all);
    ok.edit("tidal", (songs) => songs.slice(9));
    expect((await ok.sync()).status).toBe("synced");
    const long = await linked(Array.from({ length: 60 }, (_, i) => i + 1));
    long.edit("tidal", (songs) => songs.slice(14));
    expect((await long.sync()).status).toBe("synced");
  });

  it("stays until the copies agree again", async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("qobuz", () => [4, 1, 2, 3]);
    w.edit("tidal", () => [2, 1, 3, 4]);
    await conflict(w);
    await conflict(w);
    w.edit("tidal", () => [4, 1, 2, 3]);
    expect((await w.sync()).status).toBe("synced");
    expect(w.state.conflicts).toEqual([]);
  });
});

describe("resolving a conflict", () => {
  const clash = async () => {
    const w = await linked([1, 2, 3, 4]);
    w.edit("qobuz", () => [4, 1, 3]);
    w.edit("tidal", () => [2, 1, 3, 4, 5]);
    expect((await w.sync()).status).toBe("conflict");
    return w;
  };
  const resolve = async (w: Awaited<ReturnType<typeof clash>>, choice: Parameters<typeof resolveConflict>[0]["choice"]) => {
    const input = { clients: w.accounts, copies: w.copies, state: w.state, matches: w.matches, now: NOW, choice, save: (s: LinkState) => void (w.state = s) };
    const preview = await resolveConflict({ ...input, dryRun: true });
    expect(w.writes()).toEqual([]);
    const outcome = await resolveConflict(input);
    w.state = outcome.state;
    expect(preview.changes).toEqual(outcome.changes);
    return outcome;
  };

  it("by one copy makes the others like it", async () => {
    const w = await clash();
    expect((await resolve(w, { use: "qobuz" })).status).toBe("synced");
    expect([w.songs("qobuz"), w.songs("tidal")]).toEqual([[4, 1, 3], [4, 1, 3]]);
    w.clearWrites();
    expect((await w.sync()).status).toBe("unchanged");
  });

  it("by merging keeps every addition, and removes only what nobody else touched", async () => {
    const w = await clash();
    await resolve(w, { merge: "qobuz" });
    // 2 was removed on Qobuz but moved on TIDAL: kept. 5 was added on TIDAL: kept.
    expect([...w.songs("qobuz")].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(w.songs("tidal")).toEqual(w.songs("qobuz"));
  });
});

describe("an interrupted sync", () => {
  it.each([false, true])("is finished by the next one, whichever write failed (written anyway: %s)", async (written) => {
    for (let nth = 1; nth <= 12; nth += 1) {
      const w = await linked([1, 2, 3, 4, 5, 6], ["qobuz", "tidal", "spotify"]);
      w.at("spotify").account.positional = true;
      w.edit("qobuz", () => [6, 1, 9, 3, 4]);
      const target = w.at(nth % 2 === 0 ? "tidal" : "spotify").account;
      target.failWrite = Math.ceil(nth / 2);
      target.failAfterWriting = written;
      const first = await w.sync();
      target.failWrite = 0;
      if (first.status === "failed") {
        const next = await w.sync();
        expect(["synced", "unchanged"], JSON.stringify(w.state.conflicts)).toContain(next.status);
      }
      for (const name of ["qobuz", "tidal", "spotify"] as const) {
        expect(w.songs(name), `write ${nth} on ${name}`).toEqual([6, 1, 9, 3, 4]);
      }
      expect(w.state.pending).toBeUndefined();
    }
  });

  it("is a conflict when the user changed the half-written copy", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", () => [1, 2, 3, 8, 9]);
    w.at("tidal").account.failWrite = 1;
    expect((await w.sync()).status).toBe("failed");
    w.edit("tidal", () => [1, 3, 20]);
    expect((await w.sync()).status).toBe("conflict");
    expect(w.state.conflicts).toEqual([{ kind: "interrupted", service: "tidal" }]);
    expect(w.songs("qobuz")).toEqual([1, 2, 3, 8, 9]);
  });

  it("does not undo, on a copy it had finished, what the user did after", async () => {
    const w = await linked([1, 2, 3], ["qobuz", "tidal", "spotify"]);
    w.edit("qobuz", (songs) => [...songs, 8]);
    w.at("spotify").account.failWrite = 1;
    expect((await w.sync()).status).toBe("failed");
    expect(w.songs("tidal")).toEqual([1, 2, 3, 8]);
    w.edit("tidal", without(8));
    expect(Object.keys(w.state.pending!.copies)).toEqual(["spotify"]);
    await w.sync();
    await w.sync();
    for (const name of ["qobuz", "tidal", "spotify"] as const) {
      expect(w.songs(name), name).toEqual([1, 2, 3]);
    }
  });

  it("keeps what it learnt on a finished copy: a song the service dropped is a gap", async () => {
    const w = await linked([1, 2, 3], ["qobuz", "tidal", "spotify"]);
    w.at("tidal").account.absent.add(8);
    w.edit("qobuz", (songs) => [...songs, 8]);
    w.at("spotify").account.failWrite = 1;
    expect((await w.sync()).status).toBe("failed");
    await w.sync();
    await w.sync();
    expect([w.songs("qobuz"), w.songs("tidal"), w.songs("spotify")]).toEqual([[1, 2, 3, 8], [1, 2, 3], [1, 2, 3, 8]]);
  });

  it("takes in what the user changed meanwhile on a copy that was not being written", async () => {
    const w = await linked([1, 2, 3]);
    w.edit("qobuz", () => [1, 2, 3, 8]);
    w.at("tidal").account.failWrite = 1;
    await w.sync();
    w.edit("qobuz", () => [1, 2, 3, 8, 30]);
    await w.sync();
    await w.sync();
    expect([w.songs("qobuz"), w.songs("tidal")]).toEqual([[1, 2, 3, 8, 30], [1, 2, 3, 8, 30]]);
  });
});

describe("any mix of edits", () => {
  function random(seed: number) {
    let state = seed;
    return (n: number): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return Math.floor((state / 4294967296) * n);
    };
  }

  it("never loses a song nobody removed, ends with equal copies, and settles", async () => {
    let synced = 0;
    for (let round = 1; round <= 300; round += 1) {
      const pick = random(round * 7919);
      const names: ServiceName[] = round % 3 === 0 ? ["qobuz", "tidal", "spotify"] : ["qobuz", "tidal"];
      const start = Array.from({ length: 5 + pick(12) }, (_, i) => i + 1);
      const w = await linked(start, names);
      if (names.includes("spotify")) {
        w.at("spotify").account.positional = true;
      }
      const removed = new Set<number>();
      const added = new Set<number>();
      for (const name of names) {
        for (let step = pick(3); step > 0; step -= 1) {
          const kind = pick(4);
          if (kind === 0) {
            const fresh = 100 + pick(40);
            added.add(fresh);
            w.edit(name, (songs) => [...songs.slice(0, 2), fresh, ...songs.slice(2)]);
          } else if (kind === 1) {
            const gone = w.songs(name)[pick(w.songs(name).length)];
            if (gone !== undefined && w.songs(name).length > 2) {
              removed.add(gone);
              w.edit(name, without(gone));
            }
          } else if (kind === 2) {
            w.edit(name, (songs) => (songs.length < 2 ? songs : [songs[songs.length - 1]!, ...songs.slice(0, -1)]));
          } else {
            const account = w.at(name).account;
            account.failWrite = 1 + pick(4);
            account.failAfterWriting = pick(2) === 0;
          }
        }
      }
      let outcome = await w.sync();
      for (let again = 0; again < 6 && outcome.status === "failed"; again += 1) {
        outcome = await w.sync();
      }
      const everywhere = names.map((name) => new Set(w.songs(name)));
      for (const n of [...start, ...added]) {
        if (!removed.has(n)) {
          expect(everywhere.some((songs) => songs.has(n)), `round ${round}: song ${n} lost`).toBe(true);
        }
      }
      if (outcome.status === "conflict") {
        continue;
      }
      synced += 1;
      for (const name of names) {
        expect(w.songs(name), `round ${round}: ${name}`).toEqual(w.songs(names[0]!));
      }
      w.accounts.forEach((account) => (account.failWrite = 0));
      w.clearWrites();
      expect((await w.sync()).status, `round ${round}`).toBe("unchanged");
      expect(w.writes(), `round ${round}`).toEqual([]);
    }
    expect(synced).toBeGreaterThan(150);
  });
});
