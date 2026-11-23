import { describe, expect, it, vi } from "vitest";

import type { Track } from "../services/model.js";
import {
  deduplicateTracks,
  entriesByPlaylist,
  enrichReleaseDates,
  findSongsAcrossPlaylists,
  findOtherVersions,
  formatAcrossPlaylistsReport,
  formatOtherVersions,
  otherVersions,
  findDuplicateGroups,
  formatResolutionReport,
  KEEP_STRATEGIES,
  normalise,
  removePlaylistEntries,
  removedTracks,
  resolveDuplicateGroups,
  scanAllPlaylists,
  selectKeeper,
  strategyNeedsReleaseDates,
  tracksToRemove,
  toDedupTrack,
  trackSignature,
  type DedupTrack,
} from "./deduplicate.js";

describe("normalise", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalise("  So   What!! ")).toBe("so what");
  });

  it("folds accents so accented and plain spellings match", () => {
    expect(normalise("Café del Mar")).toBe(normalise("Cafe del Mar"));
  });

  it("removes edition noise and its trailing year", () => {
    expect(normalise("So What (2015 Remaster)")).toBe("so what");
    expect(normalise("So What - 2011 Remastered Version")).toBe("so what");
    expect(normalise("Kind of Blue (Deluxe Edition)")).toBe("kind of blue");
  });

  it("keeps meaningful qualifiers that distinguish recordings", () => {
    expect(normalise("Teardrop (Live)")).toBe("teardrop live");
    expect(normalise("Song (Acoustic)")).toBe("song acoustic");
    expect(normalise("Song (Extended Version)")).toBe("song extended version");
  });

  it("does not strip numbers that are part of the title", () => {
    expect(normalise("1999")).toBe("1999");
    expect(normalise("Symphony No. 5")).toBe("symphony no 5");
  });
});

describe("trackSignature", () => {
  it("combines normalised artist and title so same title different artist differ", () => {
    const gnarls: DedupTrack = { id: 1, title: "Crazy", artist: "Gnarls Barkley" };
    const patsy: DedupTrack = { id: 2, title: "Crazy", artist: "Patsy Cline" };
    expect(trackSignature(gnarls)).not.toBe(trackSignature(patsy));
  });

  it("matches a remaster to the original", () => {
    const original: DedupTrack = { id: 1, title: "So What", artist: "Miles Davis" };
    const remaster: DedupTrack = {
      id: 2,
      title: "So What (2015 Remaster)",
      artist: "Miles Davis",
    };
    expect(trackSignature(original)).toBe(trackSignature(remaster));
  });
});

describe("findDuplicateGroups", () => {
  it("groups tracks sharing a normalised signature (different ISRCs)", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "So What", artist: "Miles Davis", isrc: "AAA" },
      { id: 2, title: "So What (2015 Remaster)", artist: "Miles Davis", isrc: "BBB" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });

  it("groups tracks sharing an ISRC even if titles differ textually", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Teardrop", artist: "Massive Attack", isrc: "SAME" },
      { id: 2, title: "Teardrop (from Mezzanine)", artist: "Massive Attack", isrc: "SAME" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });

  it("merges transitively across ISRC and signature links", () => {
    // A-B share an ISRC; B-C share a signature -> all one group.
    const tracks: DedupTrack[] = [
      { id: 1, title: "Song", artist: "Band", isrc: "X" },
      { id: 2, title: "Song (Weird Tag)", artist: "Band", isrc: "X" },
      { id: 3, title: "Song", artist: "Band", isrc: "Y" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("keeps distinct songs with the same title but different artists apart", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Crazy", artist: "Gnarls Barkley" },
      { id: 2, title: "Crazy", artist: "Patsy Cline" },
    ];
    expect(findDuplicateGroups(tracks)).toEqual([]);
  });

  it("keeps distinct versions (live, remix) apart", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Song", artist: "Band" },
      { id: 2, title: "Song (Live)", artist: "Band" },
      { id: 3, title: "Song (Tiesto Remix)", artist: "Band" },
    ];
    expect(findDuplicateGroups(tracks)).toEqual([]);
  });

  it("returns only groups with more than one track, in order of first appearance", () => {
    const tracks: DedupTrack[] = [
      { id: 1, title: "Unique One", artist: "A" },
      { id: 2, title: "Dupe", artist: "B" },
      { id: 3, title: "Unique Two", artist: "C" },
      { id: 4, title: "Dupe", artist: "B" },
    ];
    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([2, 4]);
  });
});

describe("toDedupTrack", () => {
  it("maps a Qobuz track, defaulting a missing artist to empty", () => {
    expect(
      toDedupTrack({ id: 1, title: "T", isrc: "X", album: "Alb" }),
    ).toEqual({ id: 1, title: "T", artist: "", isrc: "X", album: "Alb" });
  });
});

describe("deduplicateTracks", () => {
  it("groups Qobuz tracks by their dedup signature", () => {
    const groups = deduplicateTracks([
      { id: 1, title: "So What", artist: "Miles Davis" },
      { id: 2, title: "So What (2015 Remaster)", artist: "Miles Davis" },
      { id: 3, title: "Blue in Green", artist: "Miles Davis" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("selectKeeper", () => {
  it("keeps the first-added track (fetch order)", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "So What", artist: "Miles Davis" },
      { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
    ];
    expect(selectKeeper(group, "first-added")).toBe(100);
  });

  it("throws on an empty group", () => {
    expect(() => selectKeeper([], "first-added")).toThrow();
  });

  it("keeps the last-added track", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X" },
      { id: 200, title: "T", artist: "X" },
    ];
    expect(selectKeeper(group, "last-added")).toBe(200);
  });

  it("keeps the highest-quality track (bit depth then sample rate)", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", bitDepth: 16, samplingRate: 44.1 },
      { id: 200, title: "T", artist: "X", bitDepth: 24, samplingRate: 96 },
      { id: 300, title: "T", artist: "X", bitDepth: 24, samplingRate: 192 },
    ];
    expect(selectKeeper(group, "highest-quality")).toBe(300);
  });

  it("keeps the oldest and newest releases, and ignores missing dates", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", releaseDate: "1973-03-01" },
      { id: 200, title: "T", artist: "X", releaseDate: "2011-09-26" },
      { id: 300, title: "T", artist: "X" }, // no date
    ];
    expect(selectKeeper(group, "oldest")).toBe(100);
    expect(selectKeeper(group, "newest")).toBe(200);
  });

  it("breaks ties by keeping the earlier member", () => {
    const group: DedupTrack[] = [
      { id: 100, title: "T", artist: "X", bitDepth: 24 },
      { id: 200, title: "T", artist: "X", bitDepth: 24 },
    ];
    expect(selectKeeper(group, "highest-quality")).toBe(100);
  });
});

describe("strategyNeedsReleaseDates", () => {
  it("is true only for date-based strategies", () => {
    expect(strategyNeedsReleaseDates("oldest")).toBe(true);
    expect(strategyNeedsReleaseDates("newest")).toBe(true);
    expect(strategyNeedsReleaseDates("first-added")).toBe(false);
    expect(strategyNeedsReleaseDates("highest-quality")).toBe(false);
  });
});

describe("enrichReleaseDates", () => {
  it("fills missing dates, fetching each album only once", async () => {
    const groups: DedupTrack[][] = [
      [
        { id: 1, title: "T", artist: "X", albumId: "alb-a" },
        { id: 2, title: "T", artist: "X", albumId: "alb-a", releaseDate: "2000-01-01" },
        { id: 3, title: "T", artist: "X", albumId: "alb-b" },
      ],
    ];
    const calls: string[] = [];
    const fetchDate = async (albumId: string): Promise<string | undefined> => {
      calls.push(albumId);
      return albumId === "alb-a" ? "1990-01-01" : undefined;
    };

    const enriched = await enrichReleaseDates(groups, fetchDate);

    expect(enriched[0]?.map((t) => t.releaseDate)).toEqual([
      "1990-01-01", // fetched
      "2000-01-01", // already present, not refetched
      undefined, // fetch returned nothing
    ]);
    expect(calls).toEqual(["alb-a", "alb-b"]); // alb-a fetched once despite two tracks
  });
});

describe("resolveDuplicateGroups / removedTracks", () => {
  it("produces a plan keeping the first track and removing the rest", () => {
    const groups: DedupTrack[][] = [
      [
        { id: 100, title: "So What", artist: "Miles Davis" },
        { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
        { id: 300, title: "So What", artist: "Miles Davis" },
      ],
    ];
    const [resolved] = resolveDuplicateGroups(groups, "first-added");
    expect(resolved?.keepId).toBe(100);
    expect(removedTracks(resolved!).map((t) => t.id)).toEqual([200, 300]);
  });

  it("removes a second entry of the very same track in a playlist", () => {
    // The same track added twice: one entry is kept, the other removed.
    const group: DedupTrack[] = [
      { id: 100, title: "A", artist: "X", playlistTrackId: 1 },
      { id: 200, title: "A", artist: "X", playlistTrackId: 2 },
      { id: 100, title: "A", artist: "X", playlistTrackId: 3 },
    ];
    const [resolved] = resolveDuplicateGroups([group], "first-added");
    expect(resolved?.keepId).toBe(100);
    expect(removedTracks(resolved!).map((t) => t.playlistTrackId)).toEqual([2, 3]);
    expect(formatResolutionReport([resolved!]).match(/drop/g)).toHaveLength(2);
  });

  it("respects a user-overridden keepId when computing removals", () => {
    const resolved = {
      keepId: 200,
      tracks: [
        { id: 100, title: "A", artist: "X" },
        { id: 200, title: "A", artist: "X" },
      ],
    };
    expect(removedTracks(resolved).map((t) => t.id)).toEqual([100]);
  });

  it("collects removals across all groups in a plan", () => {
    const removals = tracksToRemove([
      {
        keepId: 1,
        tracks: [
          { id: 1, title: "A", artist: "X" },
          { id: 2, title: "A", artist: "X" },
        ],
      },
      {
        keepId: 3,
        tracks: [
          { id: 3, title: "B", artist: "Y" },
          { id: 4, title: "B", artist: "Y" },
        ],
      },
    ]);
    expect(removals.map((t) => t.id)).toEqual([2, 4]);
  });
});

describe("formatResolutionReport", () => {
  it("reports a friendly message when there are no duplicates", () => {
    expect(formatResolutionReport([])).toBe("No duplicates found.");
  });

  it("marks the kept and dropped tracks in each group", () => {
    const report = formatResolutionReport([
      {
        keepId: 100,
        tracks: [
          { id: 100, title: "So What", artist: "Miles Davis", album: "Kind of Blue" },
          { id: 200, title: "So What (2015 Remaster)", artist: "Miles Davis" },
        ],
      },
    ]);
    expect(report).toContain("Found 1 duplicate group; keeping 1 each, 1 to remove:");
    expect(report).toContain("Miles Davis - So What");
    expect(report).toContain("keep  id 100: So What  [Kind of Blue]");
    expect(report).toContain("drop  id 200: So What (2015 Remaster)");
  });
});

describe("selectKeeper with a chain of strategies", () => {
  const group: DedupTrack[] = [
    { id: 100, title: "T", artist: "X", bitDepth: 16, samplingRate: 44.1, releaseDate: "1990-01-01" },
    { id: 200, title: "T", artist: "X", bitDepth: 24, samplingRate: 96, releaseDate: "2015-01-01" },
    { id: 300, title: "T", artist: "X", bitDepth: 24, samplingRate: 96, releaseDate: "1999-01-01" },
  ];

  it("breaks ties of the first strategy with the next", () => {
    expect(selectKeeper(group, ["highest-quality"])).toBe(200); // tie kept the earlier
    expect(selectKeeper(group, ["highest-quality", "oldest"])).toBe(300);
    expect(selectKeeper(group, ["highest-quality", "newest"])).toBe(200);
    expect(selectKeeper(group, ["highest-quality", "last-added"])).toBe(300);
  });

  it("ignores later strategies when the first leaves no tie", () => {
    expect(selectKeeper(group, ["oldest", "highest-quality"])).toBe(100);
    expect(selectKeeper(group, ["first-added", "highest-quality"])).toBe(100);
    expect(selectKeeper(group, ["last-added", "oldest"])).toBe(300);
  });

  it("matches the single strategy for a chain of one", () => {
    for (const strategy of KEEP_STRATEGIES) {
      expect(selectKeeper(group, [strategy])).toBe(selectKeeper(group, strategy));
    }
  });

  it("throws on an empty chain", () => {
    expect(() => selectKeeper(group, [])).toThrow(/strategy/);
  });

  it("needs release dates when any strategy in the chain does", () => {
    expect(strategyNeedsReleaseDates(["highest-quality", "oldest"])).toBe(true);
    expect(strategyNeedsReleaseDates(["highest-quality", "last-added"])).toBe(false);
  });

  it("resolves groups with a chain", () => {
    expect(resolveDuplicateGroups([group], ["highest-quality", "oldest"])[0]?.keepId).toBe(300);
  });
});

describe("toDedupTrack artwork", () => {
  it("carries the cover URL through", () => {
    expect(
      toDedupTrack({ id: 1, title: "T", image: "https://static.qobuz.com/x.jpg" }).image,
    ).toBe("https://static.qobuz.com/x.jpg");
  });
});

describe("findSongsAcrossPlaylists", () => {
  const road = { id: 1, name: "Road Trip" };
  const chill = { id: 2, name: "Chill" };
  const gym = { id: 3, name: "Gym" };

  it("lists songs in more than one playlist, with their copies per playlist", () => {
    const songs = findSongsAcrossPlaylists([
      {
        playlist: road,
        tracks: [
          { id: 10, title: "Teardrop", artist: "Massive Attack", isrc: "T1", playlistTrackId: 101 },
          { id: 20, title: "Only Road", artist: "A", playlistTrackId: 102 },
        ],
      },
      {
        playlist: chill,
        tracks: [
          // The remaster matches by signature.
          { id: 11, title: "Teardrop (2019 Remaster)", artist: "Massive Attack", playlistTrackId: 201 },
          { id: 10, title: "Teardrop", artist: "Massive Attack", isrc: "T1", playlistTrackId: 202 },
        ],
      },
      { playlist: gym, tracks: [{ id: 30, title: "Other", artist: "B", playlistTrackId: 301 }] },
    ]);

    expect(songs).toHaveLength(1);
    expect(songs[0]?.track.id).toBe(10);
    expect(
      songs[0]?.playlists.map((p) => [p.playlist.name, p.tracks.map((t) => t.playlistTrackId)]),
    ).toEqual([
      ["Road Trip", [101]],
      ["Chill", [201, 202]],
    ]);
  });

  it("leaves out songs repeated within a single playlist only", () => {
    const songs = findSongsAcrossPlaylists([
      {
        playlist: road,
        tracks: [
          { id: 10, title: "Teardrop", artist: "Massive Attack", playlistTrackId: 101 },
          { id: 10, title: "Teardrop", artist: "Massive Attack", playlistTrackId: 102 },
        ],
      },
      { playlist: chill, tracks: [] },
    ]);
    expect(songs).toEqual([]);
  });
});

describe("scanAllPlaylists", () => {
  it("resolves each playlist's own duplicates and finds songs across playlists", async () => {
    const tracks: Record<number, Track[]> = {
      1: [
        { id: 10, title: "Paranoid", artist: "Black Sabbath", isrc: "P", albumId: "a", playlistTrackId: 11 },
        { id: 12, title: "Paranoid", artist: "Black Sabbath", isrc: "P", albumId: "b", playlistTrackId: 12 },
      ],
      2: [{ id: 10, title: "Paranoid", artist: "Black Sabbath", isrc: "P", playlistTrackId: 21 }],
      3: [{ id: 99, title: "Lonely", artist: "Z", playlistTrackId: 31 }],
    };
    const dates: Record<string, string> = { a: "2010-01-01", b: "1970-01-01" };
    const client = {
      getUserPlaylists: vi.fn(async () => [
        { id: 1, name: "One" },
        { id: 2, name: "Two" },
        { id: 3, name: "Three" },
      ]),
      getPlaylistTracks: vi.fn(async (id: number) => tracks[id] ?? []),
      getAlbumReleaseDate: vi.fn(async (albumId: string) => dates[albumId]),
    };

    const scan = await scanAllPlaylists(client, ["highest-quality", "oldest"]);

    expect(scan.playlistCount).toBe(3);
    expect(scan.within).toHaveLength(1);
    expect(scan.within[0]?.playlist).toEqual({ id: 1, name: "One" });
    expect(scan.within[0]?.groups[0]?.keepId).toBe(12); // equal quality, b is older
    expect(scan.across.map((song) => song.playlists.map((p) => p.playlist.id))).toEqual([[1, 2]]);
    expect(client.getAlbumReleaseDate).toHaveBeenCalledTimes(2);
  });
});

describe("entriesByPlaylist / removePlaylistEntries", () => {
  it("groups entries per playlist, each once", () => {
    expect(
      entriesByPlaylist([
        { playlistId: 1, playlistTrackId: 11 },
        { playlistId: 2, playlistTrackId: 21 },
        { playlistId: 1, playlistTrackId: 12 },
        { playlistId: 1, playlistTrackId: 11 },
      ]),
    ).toEqual(
      new Map([
        [1, [11, 12]],
        [2, [21]],
      ]),
    );
  });

  it("removes with one request per playlist and counts the entries", async () => {
    const client = { removeTracksFromPlaylist: vi.fn(async () => {}) };
    const removed = await removePlaylistEntries(client, [
      { playlistId: 1, playlistTrackId: 11 },
      { playlistId: 2, playlistTrackId: 21 },
      { playlistId: 1, playlistTrackId: 12 },
    ]);
    expect(removed).toBe(3);
    expect(client.removeTracksFromPlaylist).toHaveBeenCalledWith(1, [11, 12]);
    expect(client.removeTracksFromPlaylist).toHaveBeenCalledWith(2, [21]);
  });
});

describe("formatAcrossPlaylistsReport", () => {
  it("lists each song with the playlists it is in", () => {
    const report = formatAcrossPlaylistsReport([
      {
        track: { id: 1, title: "Teardrop", artist: "Massive Attack" },
        playlists: [
          { playlist: { id: 1, name: "Road Trip" }, tracks: [{ id: 1, title: "Teardrop", artist: "Massive Attack" }] },
          {
            playlist: { id: 2, name: "Chill" },
            tracks: [
              { id: 1, title: "Teardrop", artist: "Massive Attack" },
              { id: 2, title: "Teardrop", artist: "Massive Attack" },
            ],
          },
        ],
      },
    ]);
    expect(report).toContain("1 song is in more than one playlist:");
    expect(report).toContain("1. Massive Attack - Teardrop");
    expect(report).toContain('in "Road Trip" (id 1)');
    expect(report).toContain('in "Chill" (id 2) (2 copies)');
  });

  it("says when there are none", () => {
    expect(formatAcrossPlaylistsReport([])).toBe("No song is in more than one playlist.");
  });
});

describe("titles outside the Latin alphabet", () => {
  const song = (id: number, artist: string, title: string, isrc: string) => ({ id, artist, title, isrc });

  it("tells songs in different scripts apart", () => {
    expect(
      findDuplicateGroups([
        song(1, "Кино", "Группа крови", "RU0000000001"),
        song(2, "宇多田ヒカル", "初恋", "JP0000000001"),
        song(3, "宇多田ヒカル", "光", "JP0000000002"),
      ]),
    ).toEqual([]);
  });

  it("tells punctuation-only titles apart", () => {
    expect(findDuplicateGroups([song(1, "A", "?", "X1"), song(2, "A", "!!!", "X2")])).toEqual([]);
  });

  it("still matches the same song, whatever its script", () => {
    const groups = findDuplicateGroups([
      song(1, "Кино", "Группа крови", "RU1"),
      song(2, "КИНО", "Группа крови (Remastered 2019)", "RU2"),
    ]);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([[1, 2]]);
  });

  it("keeps voiced kana and still folds Latin accents", () => {
    expect(normalise("がんばれ")).toBe("がんばれ");
    expect(normalise("Beyoncé")).toBe("beyonce");
  });
});

describe("versions", () => {
  const song = (id: number, version?: string, isrc?: string): DedupTrack => ({
    id,
    title: "Roads",
    artist: "Portishead",
    ...(version !== undefined && { version }),
    ...(isrc !== undefined && { isrc }),
  });

  it("does not take a live, acoustic or remixed version for a duplicate", () => {
    expect(findDuplicateGroups([song(1), song(2, "Live"), song(3, "Acoustic"), song(4, "Remix")])).toEqual([]);
  });

  it("still matches editions, the album version, the same label and the same recording", () => {
    const ids = (tracks: DedupTrack[]) => findDuplicateGroups(tracks).map((g) => g.map((t) => t.id));
    expect(ids([song(1), song(2, "2011 Remaster")])).toEqual([[1, 2]]);
    expect(ids([song(1), song(2, "Album Version")])).toEqual([[1, 2]]);
    expect(ids([song(1, "Live"), song(2, "live")])).toEqual([[1, 2]]);
    expect(ids([song(1, undefined, "X"), song(2, "Live", "X")])).toEqual([[1, 2]]);
    expect(ids([song(1, "Live"), { id: 2, title: "Roads (Live)", artist: "Portishead" }])).toEqual([[1, 2]]);
  });

  it("points out songs held in several versions, with all their copies", () => {
    const groups = findOtherVersions([song(1), song(2, "Live"), song(3, "Remastered"), { ...song(4), title: "Glory Box" }]);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([[1, 2, 3]]);
  });

  it("does not call duplicates other versions", () => {
    expect(findOtherVersions([song(1), song(2, "2011 Remaster")])).toEqual([]);
    expect(findOtherVersions([song(1, undefined, "X"), song(2, "Live", "X")])).toEqual([]);
    expect(findOtherVersions([{ id: 1, title: "T", artist: "" }, { id: 2, title: "T", artist: "", version: "Live" }])).toEqual([]);
  });

  it("counts versions as the same song when asked, and then has none to point out", () => {
    const tracks = [song(1), song(2, "Live"), song(3, "Acoustic"), { ...song(4, "Live"), title: "Glory Box" }];
    expect(findDuplicateGroups(tracks, { includeVersions: true }).map((g) => g.map((t) => t.id))).toEqual([[1, 2, 3]]);
    expect(otherVersions(tracks, { includeVersions: true })).toEqual([]);
    expect(otherVersions(tracks)).toHaveLength(1);
  });

  it("does not join songs without an artist when counting versions", () => {
    const tracks = [{ id: 1, title: "T", artist: "" }, { id: 2, title: "T", artist: "", version: "Live" }];
    expect(findDuplicateGroups(tracks, { includeVersions: true })).toEqual([]);
  });

  it("leaves out copies the plan removes, so nothing is listed as both kept and removed", () => {
    const tracks: Track[] = [song(1), song(2, "2011 Remaster"), song(3, "Live")];
    const resolved = resolveDuplicateGroups(deduplicateTracks(tracks), "last-added");
    expect(otherVersions(tracks, {}, resolved).map((g) => g.map((t) => t.id))).toEqual([[2, 3]]);
  });

  it("reports them for the CLI", () => {
    expect(formatOtherVersions([])).toBe("");
    expect(formatOtherVersions([[song(1), song(2, "Live")]])).toBe(
      "1 song is here in different versions (live, acoustic, remix...). These are kept (--include-versions counts them as duplicates):\n   Portishead - Roads: no label, Live",
    );
  });
});

describe("scanAllPlaylists with versions", () => {
  it("lists a playlist that only has other versions, with nothing to remove", async () => {
    const scan = await scanAllPlaylists(
      {
        getUserPlaylists: async () => [{ id: 1, name: "Mix" }, { id: 2, name: "Plain" }],
        getPlaylistTracks: async (id) =>
          id === 1
            ? [
                { id: 1, title: "Roads", artist: "Portishead" },
                { id: 2, title: "Roads", artist: "Portishead", version: "Live" },
              ]
            : [],
        getAlbumReleaseDate: async () => undefined,
      },
      "first-added",
    );
    expect(scan.within).toHaveLength(1);
    expect(scan.within[0]).toMatchObject({ playlist: { name: "Mix" }, groups: [] });
    expect(scan.within[0]!.versions.map((g) => g.map((t) => t.id))).toEqual([[1, 2]]);
  });
});
