import { describe, expect, it } from "vitest";

import type { Artist, Release, Track } from "../qobuz/index.js";
import { FakeAccount, MemoryStore } from "../features/fake-account.test-support.js";
import { Journal, recordingClient } from "../features/journal.js";
import { applyUndo, planUndo } from "../features/undo.js";
import { emptyJobState, validateJob, type JobState, type ManagedPlaylistJob } from "./model.js";
import { RefreshWriteError, refreshManagedPlaylist, type RefreshClient } from "./refresh.js";

const A: Artist = { id: 1, name: "Air" };
const DAY1 = new Date("2026-11-01T12:00:00Z");

function release(id: string, date: string): Release {
  return { id, artistId: A.id, artist: A.name, title: id, releaseDate: date, releaseType: "album" };
}

/** A fake account that also answers the new-releases reads. */
function world() {
  const account = new FakeAccount();
  const releases: Release[] = [release("r1", "2026-10-20"), release("r2", "2026-10-25")];
  const albumTracks: Record<string, number[]> = { r1: [11, 12], r2: [21, 22], r3: [31] };
  let failReleases = false;
  const feed = {
    getFavoriteArtists: async (): Promise<Artist[]> => [A],
    getFavoriteAlbums: async () => [],
    getSimilarArtists: async (): Promise<Artist[]> => [],
    getArtistReleases: async () => {
      if (failReleases) {
        throw new Error("Qobuz is down");
      }
      return { releases, truncated: false };
    },
    getAlbumTracks: async (albumId: string): Promise<Track[]> =>
      (albumTracks[albumId] ?? []).map((id) => ({ id, title: `Track ${id}`, duration: 180 })),
  };
  const client = Object.assign(account, feed) as FakeAccount & RefreshClient;
  return {
    account,
    client,
    releases,
    failReleases: (fail: boolean) => {
      failReleases = fail;
    },
  };
}

function job(overrides: Record<string, unknown> = {}): ManagedPlaylistJob {
  return validateJob({
    id: "a1b2c3d4",
    name: "Air feed",
    createdAt: "2026-11-01T00:00:00.000Z",
    kind: "managed-playlist",
    schedule: { every: "day" },
    recipe: {
      type: "new-releases",
      artists: { type: "list", artists: [A] },
      window: { type: "last-days", days: 30 },
    },
    ...overrides,
  });
}

async function run(
  client: RefreshClient,
  state: JobState,
  options: { now?: Date; dryRun?: boolean; job?: ManagedPlaylistJob } = {},
) {
  return refreshManagedPlaylist(client, options.job ?? job(), state, {
    now: options.now ?? DAY1,
    ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
  });
}

const writes = (account: FakeAccount) =>
  account.calls.filter((call) =>
    /^(createPlaylist|addTracksToPlaylist|removeTracksFromPlaylist|movePlaylistTracks|deletePlaylist):/.test(call),
  );

describe("refreshManagedPlaylist", () => {
  it("creates the playlist on the first run, newest release first", async () => {
    const { account, client } = world();
    const { state, result } = await run(client, emptyJobState());
    expect(state.playlistId).toBeDefined();
    const id = state.playlistId ?? 0;
    expect(account.playlists.get(id)?.name).toBe("Air feed");
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
    expect(state.owned.map((e) => e.trackId)).toEqual([21, 22, 11, 12]);
    expect(result).toMatchObject({ status: "ok", added: 4, removed: 0, dismissed: 0 });
    expect(state.lastRunAt).toBe(DAY1.toISOString());
    expect(state.lastResult).toEqual(result);
  });

  it("changes nothing when nothing is new", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    const before = writes(account).length;
    const second = await run(client, first.state);
    expect(writes(account).length).toBe(before);
    expect(second.result).toMatchObject({ added: 0, removed: 0 });
  });

  it("puts a new release at the top", async () => {
    const { account, client, releases } = world();
    const first = await run(client, emptyJobState());
    releases.push(release("r3", "2026-10-30"));
    const second = await run(client, first.state);
    expect(account.trackIds(second.state.playlistId ?? 0)).toEqual([31, 21, 22, 11, 12]);
    expect(second.result.added).toBe(1);
  });

  it("dismisses tracks the user removed, even all of them, and does not add them back", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    const id = first.state.playlistId ?? 0;
    await account.removeTracksFromPlaylist(id, account.entryIds(id));
    const second = await run(client, first.state);
    expect(account.trackIds(id)).toEqual([]);
    expect(second.state.dismissed.sort()).toEqual([11, 12, 21, 22]);
    expect(second.result.dismissed).toBe(4);
    const third = await run(client, second.state);
    expect(account.trackIds(id)).toEqual([]);
    expect(third.result).toMatchObject({ added: 0, dismissed: 0 });
  });

  it("keeps a hand-added track in respect mode", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    const id = first.state.playlistId ?? 0;
    await account.addTracksToPlaylist(id, [999]);
    await run(client, first.state, { now: new Date("2026-12-31T00:00:00Z") });
    expect(account.trackIds(id)).toEqual([999]);
  });

  it("removes a hand-added track in mirror mode", async () => {
    const { account, client } = world();
    const mirror = job({ edits: "mirror" });
    const first = await run(client, emptyJobState(), { job: mirror });
    const id = first.state.playlistId ?? 0;
    await account.addTracksToPlaylist(id, [999]);
    await run(client, first.state, { job: mirror });
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
  });

  it("removes releases that age out of the window", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    // On 2026-11-22 the window starts 2026-10-23: r1 (10-20) ages out.
    const second = await run(client, first.state, { now: new Date("2026-11-22T12:00:00Z") });
    expect(account.trackIds(second.state.playlistId ?? 0)).toEqual([21, 22]);
    expect(second.result.removed).toBe(2);
    expect(second.state.owned.map((e) => e.trackId)).toEqual([21, 22]);
    expect(second.state.dismissed).toEqual([]);
  });

  it("withholds removals when an artist cannot be read", async () => {
    const { account, client, failReleases } = world();
    const first = await run(client, emptyJobState());
    failReleases(true);
    const second = await run(client, first.state, { now: new Date("2026-12-31T00:00:00Z") });
    expect(account.trackIds(second.state.playlistId ?? 0)).toEqual([21, 22, 11, 12]);
    expect(second.result.status).toBe("partial");
    expect(second.result.notes.join(" ")).toMatch(/Air/);
  });

  it("pauses when the playlist was deleted, without creating another", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    await account.deletePlaylist(first.state.playlistId ?? 0);
    const creates = account.calls.filter((c) => c.startsWith("createPlaylist")).length;
    const second = await run(client, first.state);
    expect(second.result.status).toBe("paused");
    expect(second.state.paused).toEqual({ reason: "playlist-deleted", since: DAY1.toISOString() });
    expect(account.calls.filter((c) => c.startsWith("createPlaylist")).length).toBe(creates);
    // A paused job stays paused.
    const third = await run(client, second.state);
    expect(third.result.status).toBe("paused");
  });

  it("writes nothing on a dry run", async () => {
    const { account, client } = world();
    const state = emptyJobState();
    const { preview, state: after } = await run(client, state, { dryRun: true });
    expect(writes(account)).toEqual([]);
    expect(after).toEqual(state);
    expect(preview.createsPlaylist).toBe(true);
    expect(preview.add.map((t) => t.trackId)).toEqual([21, 22, 11, 12]);
    expect(preview.add[0]?.source).toBe("album:r2");
  });

  it("treats undoing a refresh like the user removing its tracks", async () => {
    const { account, client, releases } = world();
    const journal = new Journal({ store: new MemoryStore(), source: "cli" });
    const recorded = recordingClient(client, journal);
    const first = await journal.run({ tool: "managed" }, () => run(recorded, emptyJobState()));
    releases.push(release("r3", "2026-10-30"));
    const second = await journal.run({ tool: "managed" }, () => run(recorded, first.state));
    const items = journal.items();
    const latest = items[0];
    expect(latest).toBeDefined();
    if (latest === undefined) {
      return;
    }
    const plan = await planUndo(recorded, latest, items);
    await applyUndo(journal, recorded, latest, plan);
    const id = second.state.playlistId ?? 0;
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
    const third = await run(recorded, second.state);
    expect(third.state.dismissed).toEqual([31]);
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
  });

  it("keeps the new playlist when adding to it fails, and fills it next run", async () => {
    const { account, client } = world();
    account.failAfter("addTracksToPlaylist", 0);
    const error = await run(client, emptyJobState()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshWriteError);
    const saved = (error as RefreshWriteError).state;
    expect(saved.playlistId).toBeDefined();
    const second = await run(client, saved);
    expect(second.state.playlistId).toBe(saved.playlistId);
    expect(account.calls.filter((c) => c.startsWith("createPlaylist"))).toHaveLength(1);
    expect(account.trackIds(saved.playlistId ?? 0)).toEqual([21, 22, 11, 12]);
    expect(second.state.pending).toBeUndefined();
  });

  it("owns tracks it added before a failed read-back, so they still age out", async () => {
    const { account, client } = world();
    account.failAfter("getPlaylistTracks", 0); // the read-back after adding
    const error = await run(client, emptyJobState()).catch((e: unknown) => e);
    const saved = (error as RefreshWriteError).state;
    expect(saved.pending?.added).toEqual([21, 22, 11, 12]);
    const id = saved.playlistId ?? 0;
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
    const second = await run(client, saved);
    expect(second.state.owned.map((e) => e.trackId).sort()).toEqual([11, 12, 21, 22]);
    expect(second.result.added).toBe(0);
    const third = await run(client, second.state, { now: new Date("2026-11-22T12:00:00Z") });
    expect(account.trackIds(id)).toEqual([21, 22]);
    expect(third.state.dismissed).toEqual([]);
  });

  it("does not dismiss what a removal that failed part-way did remove", async () => {
    const { account, client } = world();
    const first = await run(client, emptyJobState());
    const id = first.state.playlistId ?? 0;
    // Removing r1's two tracks: the first goes, then the request fails.
    const remove = account.removeTracksFromPlaylist.bind(account);
    client.removeTracksFromPlaylist = async (playlistId, ptids) => {
      await remove(playlistId, ptids.slice(0, 1));
      throw new Error("Qobuz 500");
    };
    const later = new Date("2026-11-22T12:00:00Z");
    const error = await run(client, first.state, { now: later }).catch((e: unknown) => e);
    const saved = (error as RefreshWriteError).state;
    client.removeTracksFromPlaylist = remove;
    const second = await run(client, saved, { now: later });
    expect(second.state.dismissed).toEqual([]);
    expect(account.trackIds(id)).toEqual([21, 22]);
  });

  it("reorders a mirrored playlist even when nothing is added", async () => {
    const { account, client } = world();
    const mirror = job({ edits: "mirror" });
    const first = await run(client, emptyJobState(), { job: mirror });
    const id = first.state.playlistId ?? 0;
    const entries = account.entryIds(id);
    // The user drags the last track to the top.
    await account.movePlaylistTracks(id, [entries[3] ?? 0], 1);
    expect(account.trackIds(id)).toEqual([12, 21, 22, 11]);
    await run(client, first.state, { job: mirror });
    expect(account.trackIds(id)).toEqual([21, 22, 11, 12]);
  });
});
