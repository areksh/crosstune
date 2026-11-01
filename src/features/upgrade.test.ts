import { describe, expect, it, vi } from "vitest";

import type { Playlist, Track } from "../qobuz/index.js";
import {
  commitUpgrades,
  formatUpgradeReport,
  isBelowBestQuality,
  planChanges,
  resolveUpgrades,
  type UpgradeChange,
  type UpgradeCommitClient,
  type UpgradeItem,
  type UpgradeResolverClient,
} from "./upgrade.js";

function resolver(
  overrides: Partial<UpgradeResolverClient> & { searchIndex?: Record<string, Track[]> } = {},
): UpgradeResolverClient & { searchTracks: ReturnType<typeof vi.fn> } {
  const index = overrides.searchIndex ?? {};
  return {
    getFavoriteTracks: vi.fn(async () => [] as Track[]),
    getPlaylistTracks: vi.fn(async () => [] as Track[]),
    getUserPlaylists: vi.fn(async () => [] as Playlist[]),
    searchTracks: vi.fn(async (query: string) => index[query] ?? []),
    ...overrides,
  } as UpgradeResolverClient & { searchTracks: ReturnType<typeof vi.fn> };
}

const cd = { bitDepth: 16, samplingRate: 44.1 };
const hires96 = { bitDepth: 24, samplingRate: 96 };
const hires192 = { bitDepth: 24, samplingRate: 192 };

const sympathy: Track = {
  id: 1,
  title: "Unfinished Sympathy",
  artist: "Massive Attack",
  isrc: "GBAAA9100001",
  album: "Blue Lines",
  streamable: true,
  ...cd,
};

describe("isBelowBestQuality", () => {
  it("is true below 24/192 and false at it", () => {
    expect(isBelowBestQuality(cd)).toBe(true);
    expect(isBelowBestQuality(hires96)).toBe(true);
    expect(isBelowBestQuality(hires192)).toBe(false);
  });
});

describe("resolveUpgrades: better quality", () => {
  it("proposes the best streamable release with the same ISRC", async () => {
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [sympathy]),
      searchIndex: {
        GBAAA9100001: [
          { id: 2, title: "Unfinished Sympathy", isrc: "GBAAA9100001", streamable: true, ...hires96 },
          { id: 3, title: "Unfinished Sympathy", isrc: "gbaaa-9100001", streamable: true, ...hires192 },
          // Better, but not streamable.
          { id: 4, title: "Unfinished Sympathy", isrc: "GBAAA9100001", streamable: false, bitDepth: 24, samplingRate: 352.8 },
          // Same quality: not an upgrade.
          { id: 5, title: "Unfinished Sympathy", isrc: "GBAAA9100001", streamable: true, ...cd },
          // A different recording the search ranked highly.
          { id: 6, title: "Unfinished Sympathy", isrc: "GBZZZ0000001", streamable: true, ...hires192 },
        ],
      },
    });

    const plan = await resolveUpgrades(client, { type: "favourites" });

    expect(client.searchTracks).toHaveBeenCalledWith("GBAAA9100001", 20);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.kind).toBe("upgrade");
    expect(item.location).toEqual({ type: "favourites" });
    expect(item.candidates.map((c) => c.track.id)).toEqual([3, 2]);
    expect(item.candidates.every((c) => c.match === "isrc")).toBe(true);
    expect(item.action).toBe("replace");
    expect(item.replacementId).toBe(3);
  });

  it("lists nothing when no better release exists", async () => {
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [sympathy]),
      searchIndex: { GBAAA9100001: [{ ...sympathy }] },
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.items).toEqual([]);
    expect(plan.scanned).toBe(1);
  });

  it("skips tracks already at the best quality, without searching", async () => {
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [{ ...sympathy, ...hires192 }]),
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(client.searchTracks).not.toHaveBeenCalled();
    expect(plan.items).toEqual([]);
  });

  it("counts tracks without an ISRC or of unknown quality as skipped", async () => {
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [
        { id: 1, title: "No ISRC", artist: "A", ...cd },
        { id: 2, title: "No quality", artist: "A", isrc: "X" },
      ]),
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.skippedNoIsrc).toBe(1);
    expect(plan.skippedUnknownQuality).toBe(1);
    expect(client.searchTracks).not.toHaveBeenCalled();
  });

  it("ignores signature matches unless allowed, then flags them", async () => {
    const remaster: Track = {
      id: 9,
      title: "Unfinished Sympathy",
      version: "2012 Remaster",
      artist: "Massive Attack",
      isrc: "GBAAA1200009",
      streamable: true,
      ...hires96,
    };
    const live: Track = { ...remaster, id: 10, version: "Live" };
    const index = {
      GBAAA9100001: [],
      "Massive Attack Unfinished Sympathy": [live, remaster],
    };

    const strict = await resolveUpgrades(
      resolver({ getFavoriteTracks: vi.fn(async () => [sympathy]), searchIndex: index }),
      { type: "favourites" },
    );
    expect(strict.items).toEqual([]);

    const loose = await resolveUpgrades(
      resolver({ getFavoriteTracks: vi.fn(async () => [sympathy]), searchIndex: index }),
      { type: "favourites" },
      { allowSignatureMatch: true },
    );
    expect(loose.items[0]?.candidates).toEqual([{ track: remaster, match: "signature" }]);
  });

  it("ranks same-recording matches before signature matches", async () => {
    const isrcMatch: Track = { ...sympathy, id: 2, ...hires96 };
    const sigMatch: Track = { ...sympathy, id: 3, isrc: "OTHER", ...hires192 };
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [sympathy]),
      searchIndex: {
        GBAAA9100001: [isrcMatch],
        "Massive Attack Unfinished Sympathy": [sigMatch, isrcMatch],
      },
    });
    const plan = await resolveUpgrades(client, { type: "favourites" }, { allowSignatureMatch: true });
    expect(plan.items[0]?.candidates.map((c) => [c.track.id, c.match])).toEqual([
      [2, "isrc"],
      [3, "signature"],
    ]);
    expect(plan.items[0]?.replacementId).toBe(2);
  });

  it("searches each ISRC once across playlists and labels entries with their playlist", async () => {
    const better: Track = { ...sympathy, id: 2, ...hires96 };
    const client = resolver({
      getUserPlaylists: vi.fn(async () => [
        { id: 10, name: "Road Trip" },
        { id: 20, name: "Chill" },
      ]),
      getPlaylistTracks: vi.fn(async (id: number) => [
        { ...sympathy, playlistTrackId: id * 100 },
        // An entry without an entry id cannot be changed: left out.
        { ...sympathy, id: 77 },
      ]),
      searchIndex: { GBAAA9100001: [better] },
    });

    const plan = await resolveUpgrades(client, { type: "all-playlists" });

    expect(client.searchTracks).toHaveBeenCalledTimes(1);
    expect(plan.scanned).toBe(2);
    expect(plan.items.map((item) => item.location)).toEqual([
      { type: "playlist", playlistId: 10, playlistName: "Road Trip", playlistTrackId: 1000 },
      { type: "playlist", playlistId: 20, playlistName: "Chill", playlistTrackId: 2000 },
    ]);
  });

  it("reads one playlist for a playlist source", async () => {
    const client = resolver({
      getPlaylistTracks: vi.fn(async () => [{ ...sympathy, playlistTrackId: 5 }]),
    });
    await resolveUpgrades(client, { type: "playlist", playlistId: 42 });
    expect(client.getPlaylistTracks).toHaveBeenCalledWith(42);
    expect(client.getUserPlaylists).not.toHaveBeenCalled();
  });

  it("stops searching at the cap, checking unplayable tracks first", async () => {
    const broken: Track = { id: 50, title: "Gone", artist: "A", isrc: "GONE", streamable: false };
    const tracks: Track[] = [
      { ...sympathy, id: 1, isrc: "I1" },
      { ...sympathy, id: 2, isrc: "I2" },
      broken,
    ];
    const client = resolver({ getFavoriteTracks: vi.fn(async () => tracks) });

    const plan = await resolveUpgrades(
      client,
      { type: "favourites" },
      { maxSearches: 2, concurrency: 1 },
    );

    // GONE (ISRC), then the signature fallback for it, and nothing else.
    expect(client.searchTracks.mock.calls.map((call) => call[0])).toEqual(["GONE", "A Gone"]);
    expect(plan.unchecked).toBe(2);
    expect(plan.items.map((item) => item.track.id)).toEqual([50]);
  });

  it("counts a failed search without failing the run", async () => {
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [sympathy]),
      searchTracks: vi.fn(async () => {
        throw new Error("HTTP 503");
      }),
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.failed).toBe(1);
    expect(plan.items).toEqual([]);
  });
});

describe("resolveUpgrades: no longer playable", () => {
  const gone: Track = {
    id: 30,
    title: "Karmacoma",
    artist: "Massive Attack",
    isrc: "GBKAR9400001",
    streamable: false,
    ...cd,
  };

  it("proposes a streamable release of the same recording, of any quality", async () => {
    const other: Track = { ...gone, id: 31, album: "Protection", streamable: true };
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [gone]),
      searchIndex: { GBKAR9400001: [gone, other] },
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.items).toEqual([
      {
        kind: "unplayable",
        track: gone,
        location: { type: "favourites" },
        candidates: [{ track: other, match: "isrc" }],
        action: "replace",
        replacementId: 31,
      },
    ]);
    // No signature search once the same recording was found.
    expect(client.searchTracks).toHaveBeenCalledTimes(1);
  });

  it("falls back to a signature match, flagged", async () => {
    const sameSong: Track = { ...gone, id: 32, isrc: "OTHER", streamable: true };
    const client = resolver({
      getFavoriteTracks: vi.fn(async () => [gone]),
      searchIndex: { "Massive Attack Karmacoma": [sameSong] },
    });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.items[0]?.candidates).toEqual([{ track: sameSong, match: "signature" }]);
  });

  it("leaves or removes a track with no replacement, as chosen", async () => {
    const client = resolver({ getFavoriteTracks: vi.fn(async () => [gone]) });
    const left = await resolveUpgrades(client, { type: "favourites" });
    expect(left.items[0]).toMatchObject({ kind: "unplayable", candidates: [], action: "leave" });
    expect(left.items[0]?.replacementId).toBeUndefined();

    const removed = await resolveUpgrades(client, { type: "favourites" }, { removeUnplayable: true });
    expect(removed.items[0]?.action).toBe("remove");
  });

  it("lists an unplayable track with nothing to search by as having no replacement", async () => {
    const bare: Track = { id: 33, title: "Untitled", streamable: false };
    const client = resolver({ getFavoriteTracks: vi.fn(async () => [bare]) });
    const plan = await resolveUpgrades(client, { type: "favourites" });
    expect(plan.unchecked).toBe(0);
    expect(plan.items[0]).toMatchObject({ kind: "unplayable", candidates: [], action: "leave" });
  });
});

describe("planChanges", () => {
  const base = { track: sympathy, location: { type: "favourites" as const } };
  it("keeps replaces and removes, drops leaves, defaulting to the best candidate", () => {
    const items: UpgradeItem[] = [
      { ...base, kind: "upgrade", candidates: [{ track: { ...sympathy, id: 2 }, match: "isrc" }], action: "replace", replacementId: 2 },
      { ...base, kind: "upgrade", candidates: [{ track: { ...sympathy, id: 3 }, match: "isrc" }], action: "replace" },
      { ...base, kind: "unplayable", candidates: [], action: "remove" },
      { ...base, kind: "unplayable", candidates: [], action: "leave" },
      { ...base, kind: "unplayable", candidates: [], action: "replace" }, // nothing to replace with
    ];
    expect(planChanges(items)).toEqual([
      { action: "replace", location: { type: "favourites" }, trackId: 1, newTrackId: 2 },
      { action: "replace", location: { type: "favourites" }, trackId: 1, newTrackId: 3 },
      { action: "remove", location: { type: "favourites" }, trackId: 1 },
    ]);
  });
});

function committer(overrides: Partial<UpgradeCommitClient> = {}): UpgradeCommitClient {
  return {
    addFavoriteTracks: vi.fn(async () => {}),
    removeFavoriteTracks: vi.fn(async () => {}),
    getPlaylistTracks: vi.fn(async () => [] as Track[]),
    addTracksToPlaylist: vi.fn(async () => {}),
    removeTracksFromPlaylist: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("commitUpgrades: favourites", () => {
  const fav = { type: "favourites" as const };

  it("adds the replacements, then removes the old tracks and the removals", async () => {
    const client = committer();
    const result = await commitUpgrades(client, [
      { action: "replace", location: fav, trackId: 1, newTrackId: 11 },
      { action: "replace", location: fav, trackId: 2, newTrackId: 11 },
      { action: "remove", location: fav, trackId: 3 },
    ]);
    expect(client.addFavoriteTracks).toHaveBeenCalledWith([11]);
    expect(client.removeFavoriteTracks).toHaveBeenCalledWith([1, 2, 3]);
    expect(result).toEqual({ replaced: 2, removed: 1, failed: [], movedToEnd: 0 });
  });

  it("never removes an old track whose replacement could not be added", async () => {
    const client = committer({
      addFavoriteTracks: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
    });
    const change: UpgradeChange = { action: "replace", location: fav, trackId: 1, newTrackId: 11 };
    const result = await commitUpgrades(client, [change]);
    expect(client.removeFavoriteTracks).not.toHaveBeenCalled();
    expect(result.replaced).toBe(0);
    expect(result.failed).toEqual([
      { change, reason: "could not add the replacement: HTTP 500" },
    ]);
  });

  it("reports an old track that could not be removed", async () => {
    const client = committer({
      removeFavoriteTracks: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
    });
    const result = await commitUpgrades(client, [
      { action: "replace", location: fav, trackId: 1, newTrackId: 11 },
    ]);
    expect(result.replaced).toBe(0);
    expect(result.failed[0]?.reason).toMatch(/replacement was added, but the old track/);
  });
});

/**
 * A fake playlist that applies adds (appending fresh entry ids), deletes and
 * moves, so a commit's effect on the order can be checked end to end.
 */
/**
 * Qobuz's playlist/updateTracksPosition as observed on the live API (Nov
 * 2026): `insert_before` is the 1-based position, in the current playlist, of
 * the entry the moved entries go in front of; 0 or 1 means the top, and past
 * the end means the end.
 */
function qobuzMove<T>(list: readonly T[], moving: (item: T) => boolean, before: number): T[] {
  const anchor = before >= 1 ? list[before - 1] : list[0];
  const moved = list.filter(moving);
  const rest = list.filter((item) => !moving(item));
  if (anchor === undefined) {
    return [...rest, ...moved];
  }
  // An anchor that is itself moving: the entries land where it was.
  const at = moving(anchor) ? list.slice(0, list.indexOf(anchor)).filter((i) => !moving(i)).length
    : rest.indexOf(anchor);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

describe("qobuzMove (the live API's reorder semantics)", () => {
  // Observed on a scratch playlist G S R M I (one entry moved per call).
  it.each([
    [0, 1, "GSRMI"],
    [0, 2, "GSRMI"],
    [0, 3, "SGRMI"],
    [0, 5, "SRMGI"],
    [1, 3, "GSRMI"],
    [4, 2, "GISRM"],
    [4, 1, "IGSRM"],
    [2, 0, "RGSMI"],
  ])("moves entry %i with insert_before %i to give %s", (from, before, expected) => {
    const list = [..."GSRMI"];
    const item = list[from];
    expect(qobuzMove(list, (x) => x === item, before).join("")).toBe(expected);
  });
});

function fakePlaylist(initial: Array<[trackId: number, entryId: number]>) {
  let entries = initial.map(([id, playlistTrackId]) => ({ id, playlistTrackId }));
  let nextEntry = 1000;
  const client = committer({
    getPlaylistTracks: vi.fn(async () =>
      entries.map((e) => ({ id: e.id, title: `t${e.id}`, playlistTrackId: e.playlistTrackId })),
    ),
    addTracksToPlaylist: vi.fn(async (_pid: number, ids: readonly number[]) => {
      for (const id of ids) {
        entries.push({ id, playlistTrackId: nextEntry++ });
      }
    }),
    removeTracksFromPlaylist: vi.fn(async (_pid: number, entryIds: readonly number[]) => {
      entries = entries.filter((e) => !entryIds.includes(e.playlistTrackId));
    }),
    movePlaylistTracks: vi.fn(async (_pid: number, entryIds: readonly number[], before: number) => {
      entries = qobuzMove(entries, (e) => entryIds.includes(e.playlistTrackId), before);
    }),
  });
  return { client, order: () => entries.map((e) => e.id) };
}

function at(playlistTrackId: number) {
  return { type: "playlist" as const, playlistId: 7, playlistTrackId };
}

describe("commitUpgrades: playlists", () => {
  it("replaces entries in place and removes the removals", async () => {
    // Tracks 1..6 at entries 101..106.
    const { client, order } = fakePlaylist([1, 2, 3, 4, 5, 6].map((id) => [id, 100 + id]));
    const result = await commitUpgrades(client, [
      { action: "replace", location: at(105), trackId: 5, newTrackId: 50 },
      { action: "remove", location: at(101), trackId: 1 },
      { action: "replace", location: at(102), trackId: 2, newTrackId: 20 },
      { action: "replace", location: at(103), trackId: 3, newTrackId: 30 },
    ]);
    expect(order()).toEqual([20, 30, 4, 50, 6]);
    expect(result).toEqual({ replaced: 3, removed: 1, failed: [], movedToEnd: 0 });
    // Added in playlist order; the consecutive pair moved in one call.
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(7, [20, 30, 50]);
    expect(client.movePlaylistTracks).toHaveBeenCalledTimes(2);
  });

  it("leaves replacements at the end when it cannot move entries", async () => {
    const { client, order } = fakePlaylist([[1, 101], [2, 102], [3, 103]]);
    delete client.movePlaylistTracks;
    const result = await commitUpgrades(client, [
      { action: "replace", location: at(101), trackId: 1, newTrackId: 10 },
    ]);
    expect(order()).toEqual([2, 3, 10]);
    expect(result.replaced).toBe(1);
    expect(result.movedToEnd).toBe(1);
  });

  it("counts replacements left at the end when a move fails", async () => {
    const { client, order } = fakePlaylist([[1, 101], [2, 102], [3, 103]]);
    client.movePlaylistTracks = vi.fn(async () => {
      throw new Error("HTTP 400");
    });
    const result = await commitUpgrades(client, [
      { action: "replace", location: at(101), trackId: 1, newTrackId: 10 },
      { action: "replace", location: at(103), trackId: 3, newTrackId: 30 },
    ]);
    expect(order()).toEqual([2, 10, 30]);
    expect(result.replaced).toBe(2);
    expect(result.movedToEnd).toBe(2);
  });

  it("keeps an old entry whose replacement did not arrive", async () => {
    const { client, order } = fakePlaylist([[1, 101], [2, 102]]);
    client.addTracksToPlaylist = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    const change: UpgradeChange = { action: "replace", location: at(101), trackId: 1, newTrackId: 10 };
    const result = await commitUpgrades(client, [
      change,
      { action: "remove", location: at(102), trackId: 2 },
    ]);
    expect(order()).toEqual([1]);
    expect(result.failed).toEqual([{ change, reason: "could not add the replacement" }]);
    expect(result.removed).toBe(1);
  });

  it("does not delete old entries when the playlist cannot be re-read after adding", async () => {
    const { client } = fakePlaylist([[1, 101]]);
    const read = client.getPlaylistTracks;
    let calls = 0;
    client.getPlaylistTracks = vi.fn(async (id: number) => {
      calls += 1;
      if (calls > 1) {
        throw new Error("HTTP 503");
      }
      return read(id);
    });
    const result = await commitUpgrades(client, [
      { action: "replace", location: at(101), trackId: 1, newTrackId: 10 },
    ]);
    expect(client.removeTracksFromPlaylist).not.toHaveBeenCalled();
    expect(result.failed[0]?.reason).toMatch(/could not confirm/);
  });

  it("reports entries that are no longer in the playlist", async () => {
    const { client } = fakePlaylist([[1, 101]]);
    const change: UpgradeChange = { action: "remove", location: at(999), trackId: 9 };
    const result = await commitUpgrades(client, [change]);
    expect(result.failed).toEqual([{ change, reason: "no longer in the playlist" }]);
    expect(client.removeTracksFromPlaylist).not.toHaveBeenCalled();
  });

  it("writes each playlist separately", async () => {
    const client = committer({
      getPlaylistTracks: vi.fn(async (id: number) => [
        { id: 1, title: "t", playlistTrackId: id },
      ]),
    });
    await commitUpgrades(client, [
      { action: "remove", location: { type: "playlist", playlistId: 1, playlistTrackId: 1 }, trackId: 1 },
      { action: "remove", location: { type: "playlist", playlistId: 2, playlistTrackId: 2 }, trackId: 1 },
    ]);
    expect(client.removeTracksFromPlaylist).toHaveBeenCalledWith(1, [1]);
    expect(client.removeTracksFromPlaylist).toHaveBeenCalledWith(2, [2]);
  });
});

describe("formatUpgradeReport", () => {
  it("lists upgrades and unplayable tracks with what happens to each", () => {
    const report = formatUpgradeReport({
      items: [
        {
          kind: "upgrade",
          track: sympathy,
          location: { type: "playlist", playlistId: 1, playlistName: "Road Trip", playlistTrackId: 5 },
          candidates: [{ track: { ...sympathy, id: 2, album: "Blue Lines (2012)", ...hires96 }, match: "isrc" }],
          action: "replace",
          replacementId: 2,
        },
        {
          kind: "unplayable",
          track: { id: 3, title: "Black Steel", artist: "Tricky", streamable: false },
          location: { type: "favourites" },
          candidates: [],
          action: "remove",
        },
        {
          kind: "unplayable",
          track: { id: 4, title: "Karmacoma", artist: "Massive Attack", streamable: false },
          location: { type: "favourites" },
          candidates: [{ track: { id: 5, title: "Karmacoma", album: "Protection" }, match: "signature" }],
          action: "replace",
          replacementId: 5,
        },
      ],
      scanned: 40,
      skippedNoIsrc: 2,
      skippedUnknownQuality: 0,
      unchecked: 1,
      failed: 0,
    });
    expect(report).toContain("Better quality available (1):");
    expect(report).toContain('Massive Attack - Unfinished Sympathy  [Blue Lines]  (in "Road Trip")');
    expect(report).toContain("16/44.1 -> 24/96  id 2 [Blue Lines (2012)]");
    expect(report).toContain("No longer playable (2):");
    expect(report).toContain("no replacement found -- remove");
    expect(report).toContain("replace with id 5 [Protection] (same song, maybe a different recording)");
    expect(report).toContain("Scanned 40 tracks.");
    expect(report).toContain("Skipped: 2 without an ISRC to search by; 1 not checked (search limit reached).");
  });

  it("says when there is nothing to do", () => {
    const report = formatUpgradeReport({
      items: [],
      scanned: 0,
      skippedNoIsrc: 0,
      skippedUnknownQuality: 0,
      unchecked: 0,
      failed: 0,
    });
    expect(report).toContain("No better-quality versions found.");
    expect(report).toContain("No unplayable tracks found.");
  });
});
