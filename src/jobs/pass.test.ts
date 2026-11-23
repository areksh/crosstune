/**
 * Multi-pass scenarios: a source and tidy-ups on one playlist must agree, in
 * both edit modes, across passes, undo and suggestions.
 */

import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { MemoryStore } from "../features/fake-account.test-support.js";
import { Journal, recordingClient } from "../features/journal.js";
import { applyUndo, planUndo } from "../features/undo.js";
import { emptyJobState, validateJob, type Job, type JobState } from "./model.js";
import { runPass, type RefreshClient } from "./refresh.js";
import { acceptSuggestions, ignoreSuggestions } from "./suggestions.js";
import { richAccount } from "./world.test-support.js";

const DAY = 86_400_000;
const T0 = new Date("2026-11-02T06:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function world() {
  const account = richAccount();
  // The source side of the client: nothing a combined source needs beyond playlists.
  const client = Object.assign(account, {
    getFavoriteArtists: async () => [],
    getFavoriteAlbums: async () => [],
    getSimilarArtists: async () => [],
    getArtistTopTracks: async () => [],
    getArtistReleases: async () => ({ releases: [], truncated: false }),
    getAlbumTracks: async () => [],
  }) as unknown as typeof account & RefreshClient;
  return { account, client };
}

function job(raw: Record<string, unknown>): Job {
  return validateJob({
    id: "a1b2c3d4",
    name: "Mix",
    createdAt: T0.toISOString(),
    kind: "playlist",
    schedule: { every: "day" },
    ...raw,
  });
}

function combinedOf(...playlistIds: number[]) {
  return { type: "combined", inputs: playlistIds.map((playlistId) => ({ type: "playlist", playlistId })) };
}

async function pass(client: RefreshClient, j: Job, state: JobState, now = T0) {
  return (await runPass(client, j, state, { now })).state;
}

describe("a combined playlist with an upgrade tidy-up", () => {
  it.each(["respect", "mirror"] as const)("stays upgraded across passes (%s edits)", async (edits) => {
    const { account, client } = world();
    const a = account.seedPlaylist("A", [qid(1), qid(7)]);
    const b = account.seedPlaylist("B", [qid(8)]);
    const j = job({ target: { type: "created" }, edits, source: combinedOf(a, b), tidy: { upgrade: { cadence: "every-pass" } } });

    let state = await pass(client, j, emptyJobState());
    const mine = state.playlistId!;
    expect(account.trackIds(mine)).toEqual([qid(2), qid(7), qid(8)]); // 1 upgraded in place
    expect(state.substitutions).toEqual([{ from: qid(1), to: qid(2), key: "upgrade:1>2" }]);

    const calls = account.calls.length;
    state = await pass(client, j, state, at(1));
    expect(account.trackIds(mine)).toEqual([qid(2), qid(7), qid(8)]);
    const writes = account.calls
      .slice(calls)
      .filter((call) => /^(addTracksToPlaylist|removeTracksFromPlaylist|movePlaylistTracks):/.test(call));
    expect(writes).toEqual([]);
    expect(state.dismissed).toEqual([]);
  });

  it("follows its inputs: a track added upstream arrives, one removed leaves", async () => {
    const { account, client } = world();
    const a = account.seedPlaylist("A", [qid(7)]);
    const b = account.seedPlaylist("B", [qid(8)]);
    const j = job({ target: { type: "created" }, source: combinedOf(a, b) });
    let state = await pass(client, j, emptyJobState());
    await account.addTracksToPlaylist(a, [qid(5)]);
    await account.removeTracksFromPlaylist(b, account.entryIds(b));
    state = await pass(client, j, state, at(1));
    expect(account.trackIds(state.playlistId!)).toEqual([qid(7), qid(5)]);
  });
});

describe("an adopted playlist", () => {
  it("keeps the user's tracks, adds the source's, and tidies both", async () => {
    const { account, client } = world();
    const mine = account.seedPlaylist("Mine", [qid(3), qid(5)]);
    const feed = account.seedPlaylist("Feed", [qid(8), qid(6)]);
    const j = job({
      target: { type: "adopted", playlistId: mine },
      source: { type: "follow", playlistId: feed },
      tidy: { repair: { cadence: "every-pass" }, dedupe: {} },
    });
    let state = await pass(client, j, emptyJobState());
    // 3 repaired to 4 (the user's own track), 8 added, 6 added then de-duplicated against 5.
    expect(account.trackIds(mine)).toEqual([qid(4), qid(5), qid(8)]);
    expect(state.owned.map((entry) => entry.trackId)).toEqual([qid(8)]);

    state = await pass(client, j, state, at(1));
    expect(account.trackIds(mine)).toEqual([qid(4), qid(5), qid(8)]);
    expect(state.dismissed).toEqual([]);
  });

  it("is never strict mirror", () => {
    expect(() => job({ target: { type: "adopted", playlistId: qid(1) }, edits: "mirror", source: { type: "follow", playlistId: qid(2) } })).toThrow(/mirror/);
  });

  it("pauses when the playlist is deleted", async () => {
    const { account, client } = world();
    const mine = account.seedPlaylist("Mine", [qid(1)]);
    const j = job({ target: { type: "adopted", playlistId: mine }, tidy: { dedupe: {} } });
    await account.deletePlaylist(mine);
    const outcome = await runPass(client, j, emptyJobState(), { now: T0 });
    expect(outcome.state.paused?.reason).toBe("playlist-deleted");
    expect(outcome.result.status).toBe("paused");
  });
});

describe("putting back what a tidy-up replaced", () => {
  it.each(["respect", "mirror"] as const)("is respected by the next pass (%s edits)", async (edits) => {
    const { account, client } = world();
    const a = account.seedPlaylist("A", [qid(1)]);
    const b = account.seedPlaylist("B", [qid(7)]);
    const j = job({ target: { type: "created" }, edits, source: combinedOf(a, b), tidy: { upgrade: { cadence: "every-pass" } } });
    let state = await pass(client, j, emptyJobState());
    const mine = state.playlistId!;
    expect(account.trackIds(mine)).toEqual([qid(2), qid(7)]);
    // As an undo from History would: the original back, the replacement gone.
    await account.addTracksToPlaylist(mine, [qid(1)]);
    await account.removeTracksFromPlaylist(mine, [account.entryIds(mine)[0]!]);

    state = await pass(client, j, state, at(1));
    expect(account.trackIds(mine)).toContain(qid(1));
    expect(account.trackIds(mine)).not.toContain(qid(2));
    expect(state.ignored).toContain("upgrade:1>2");
    expect(state.substitutions).toEqual([]);

    state = await pass(client, j, state, at(2));
    expect(account.trackIds(mine)).toContain(qid(1));
    expect(account.trackIds(mine)).not.toContain(qid(2));
  });

  it("an undo from History is respected the same way", async () => {
    const { account, client } = world();
    const a = account.seedPlaylist("A", [qid(1)]);
    const b = account.seedPlaylist("B", [qid(7)]);
    const j = job({ target: { type: "created" }, source: combinedOf(a, b), tidy: { upgrade: { cadence: "every-pass" } } });
    let state = await pass(client, j, emptyJobState());
    const mine = state.playlistId!;
    await account.addTracksToPlaylist(a, [qid(8)]); // so the next pass has something to add
    const journal = new Journal({ store: new MemoryStore(), source: "cli" });
    const recorded = recordingClient(client, journal) as unknown as RefreshClient;
    state = (await journal.run({ tool: "managed" }, () => runPass(recorded, j, state, { now: at(1) }))).state;
    expect(account.trackIds(mine)).toEqual([qid(2), qid(8), qid(7)]);
    const items = journal.items();
    const latest = items[items.length - 1]!;
    await applyUndo(journal, recorded, latest, await planUndo(recorded, latest, items));
    expect(account.trackIds(mine)).toEqual([qid(2), qid(7)]);

    state = await pass(client, j, state, at(2));
    // The undone addition is dismissed, the earlier upgrade stands.
    expect(account.trackIds(mine)).toEqual([qid(2), qid(7)]);
    expect(state.dismissed).toEqual([qid(8)]);
  });
});

describe("suggest mode", () => {
  it("writes nothing, keeps suggestions, and applies them when accepted", async () => {
    const { account, client } = world();
    const mine = account.seedPlaylist("Mine", [qid(1), qid(5), qid(6)]);
    const j = job({
      target: { type: "adopted", playlistId: mine },
      tidy: { upgrade: { cadence: "every-pass", mode: "suggest" }, dedupe: { mode: "suggest" } },
    });
    let outcome = await runPass(client, j, emptyJobState(), { now: T0 });
    let state = outcome.state;
    expect(account.trackIds(mine)).toEqual([qid(1), qid(5), qid(6)]);
    expect(state.suggestions.map((s) => s.key)).toEqual(["upgrade:1>2", "dedupe:5,6"]);
    expect(outcome.result.suggested).toBe(2);

    state = ignoreSuggestions(state, ["dedupe:5,6"]);
    outcome = await runPass(client, j, state, { now: at(1) });
    state = outcome.state;
    expect(state.suggestions.map((s) => s.key)).toEqual(["upgrade:1>2"]);
    expect(state.suggestions[0]?.foundAt).toBe(T0.toISOString());

    const accepted = await acceptSuggestions(client, j, state, "all", at(1));
    expect(accepted.applied).toBe(1);
    expect(account.trackIds(mine)).toEqual([qid(2), qid(5), qid(6)]);
    expect(accepted.state.suggestions).toEqual([]);
    expect(accepted.state.substitutions).toEqual([{ from: qid(1), to: qid(2), key: "upgrade:1>2" }]);
  });

  it("drops a suggestion that no longer applies", async () => {
    const { account, client } = world();
    const mine = account.seedPlaylist("Mine", [qid(1)]);
    const j = job({ target: { type: "adopted", playlistId: mine }, tidy: { upgrade: { cadence: "every-pass", mode: "suggest" } } });
    const state = (await runPass(client, j, emptyJobState(), { now: T0 })).state;
    await account.removeTracksFromPlaylist(mine, account.entryIds(mine));
    const accepted = await acceptSuggestions(client, j, state, ["upgrade:1>2"], T0);
    expect(accepted).toMatchObject({ applied: 0, stale: 1 });
    expect(accepted.state.suggestions).toEqual([]);
  });
});

describe("the favourites", () => {
  it("are de-duplicated on their cadence", async () => {
    const { account, client } = world();
    account.favourites.tracks = [qid(5), qid(6)];
    const j = job({ target: { type: "favourites" }, tidy: { dedupe: { cadence: "weekly" } } });
    let state = await pass(client, j, emptyJobState());
    expect(account.favourites.tracks).toEqual([qid(5)]);
    account.favourites.tracks = [qid(5), qid(6)]; // the user favourites the remaster again
    const reads = account.calls.filter((call) => call.startsWith("getFavoriteTracks")).length;
    state = await pass(client, j, state, at(3));
    expect(account.calls.filter((call) => call.startsWith("getFavoriteTracks")).length).toBe(reads); // not due
    state = await pass(client, j, state, at(7));
    // Put back by the user: left alone from now on.
    expect(account.favourites.tracks).toEqual([qid(5), qid(6)]);
    expect(state.ignored).toContain("dedupe:5,6");
  });
});

describe("a dry run", () => {
  it("previews the tidy-ups' findings without writing", async () => {
    const { account, client } = world();
    const mine = account.seedPlaylist("Mine", [qid(1), qid(3)]);
    const j = job({ target: { type: "adopted", playlistId: mine }, tidy: { upgrade: { cadence: "every-pass" }, repair: { mode: "suggest" } } });
    const outcome = await runPass(client, j, emptyJobState(), { now: T0, dryRun: true });
    expect(outcome.preview.findings.map((f) => [f.key, f.mode])).toEqual([
      ["repair:3", "suggest"],
      ["upgrade:1>2", "apply"],
    ]);
    expect(account.trackIds(mine)).toEqual([qid(1), qid(3)]);
    expect(outcome.state).toEqual(emptyJobState());
  });
});
