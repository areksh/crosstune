import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import {
  capList,
  emptyJobState,
  newJobId,
  parseJobsFile,
  parseJobState,
  playlistIdOf,
  sourceReads,
  validateJob,
  type JobState,
} from "./model.js";

const FEED = {
  type: "new-releases",
  artists: { type: "list", artists: [{ id: qid(1), name: "Röyksopp" }] },
  window: { type: "last-days", days: 30 },
};

/** A minimal valid job as a user (or the UI) would write it. */
function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2c3d4",
    name: "Fresh",
    createdAt: "2026-11-02T10:00:00.000Z",
    kind: "playlist",
    schedule: { every: "day" },
    target: { type: "created" },
    source: FEED,
    ...overrides,
  };
}

/** A version 1 job, as phase 1 wrote it. */
function v1Job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2c3d4",
    name: "Fresh",
    createdAt: "2026-11-02T10:00:00.000Z",
    kind: "managed-playlist",
    schedule: { every: "day" },
    recipe: FEED,
    ...overrides,
  };
}

function sourceWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return rawJob({ source: { ...FEED, ...overrides } });
}

describe("validateJob", () => {
  it("fills the defaults", () => {
    expect(validateJob(rawJob())).toEqual({
      id: "a1b2c3d4",
      name: "Fresh",
      createdAt: "2026-11-02T10:00:00.000Z",
      enabled: true,
      kind: "playlist",
      target: { type: "created", isPublic: false },
      edits: "respect",
      schedule: { every: "day", at: "06:00" },
      source: {
        type: "new-releases",
        artists: { type: "list", artists: [{ id: qid(1), name: "Röyksopp" }] },
        window: { type: "last-days", days: 30 },
        include: ["album", "ep-single"],
        hideFavourites: false,
      },
      tidy: {},
    });
  });

  it("reads a version 1 job as a created playlist with that source", () => {
    const job = validateJob(v1Job({ isPublic: true, edits: "mirror", shape: { maxTracks: 5 } }));
    expect(job).toMatchObject({
      kind: "playlist",
      target: { type: "created", isPublic: true },
      edits: "mirror",
      shape: { maxTracks: 5 },
      source: { type: "new-releases", window: { type: "last-days", days: 30 } },
      tidy: {},
    });
    expect(job).not.toHaveProperty("recipe");
    expect(job).not.toHaveProperty("isPublic");
  });

  it("fills a weekly schedule's weekday (Monday) and time", () => {
    expect(validateJob(rawJob({ schedule: { every: "week" } })).schedule).toEqual({
      every: "week",
      weekday: 1,
      at: "06:00",
    });
  });

  it("keeps the optional parts of a new releases source", () => {
    const job = validateJob(
      sourceWith({
        artists: { type: "favourites" },
        similar: { perArtist: 3 },
        window: { type: "since", date: "2026-01-01" },
        include: ["album"],
        hideFavourites: true,
        exclude: { excludeTracks: ["live"] },
      }),
    );
    expect(job.source).toMatchObject({
      similar: { perArtist: 3, refreshDays: 30 },
      exclude: { excludeTracks: ["live"] },
      hideFavourites: true,
    });
  });

  it("fills a combined source's defaults", () => {
    const job = validateJob(
      rawJob({
        source: { type: "combined", inputs: [{ type: "playlist", playlistId: qid(5) }, { type: "favourites" }] },
      }),
    );
    expect(job.source).toEqual({
      type: "combined",
      inputs: [{ type: "playlist", playlistId: qid(5) }, { type: "favourites" }],
      mode: "merge",
      keep: "highest-quality",
      order: "sequential",
      matchSongs: true,
    });
  });

  it("fills follow, smart and discovery defaults", () => {
    expect(validateJob(rawJob({ source: { type: "follow", playlistId: qid(9) } })).source).toEqual({
      type: "follow",
      playlistId: qid(9),
      keepRemoved: false,
    });
    expect(
      validateJob(
        rawJob({
          source: {
            type: "smart",
            from: [{ type: "favourites" }],
            rules: [{ type: "quality", quality: "hires" }, { type: "favourited-within", days: 30 }],
          },
        }),
      ).source,
    ).toEqual({
      type: "smart",
      from: [{ type: "favourites" }],
      rules: [{ type: "quality", quality: "hires" }, { type: "favourited-within", days: 30 }],
      order: "as-listed",
    });
    expect(validateJob(rawJob({ source: { type: "discovery", seeds: { type: "favourites" } } })).source).toEqual({
      type: "discovery",
      seeds: { type: "favourites" },
      similar: { perArtist: 10, refreshDays: 30 },
      artistsPerRotation: 10,
      tracksPerArtist: 3,
      rotation: "week",
      avoidRepeatsFor: 8,
      skipFavouriteTracks: true,
    });
  });

  it("fills each tidy-up's defaults", () => {
    const job = validateJob(
      rawJob({ target: { type: "adopted", playlistId: qid(3) }, source: undefined, tidy: { dedupe: {}, upgrade: {}, repair: {} } }),
    );
    expect(job.tidy).toEqual({
      dedupe: { cadence: "every-pass", mode: "apply", keep: ["highest-quality", "first-added"] },
      upgrade: { cadence: "monthly", mode: "apply", allowSignatureMatch: false, maxSearches: 200 },
      repair: { cadence: "weekly", mode: "apply", action: "replace" },
    });
    expect(job.source).toBeUndefined();
  });

  it("accepts the favourites with tidy-ups only", () => {
    const job = validateJob(
      rawJob({ target: { type: "favourites" }, source: undefined, tidy: { dedupe: { mode: "suggest" } } }),
    );
    expect(job.target).toEqual({ type: "favourites" });
    expect(job.tidy.dedupe?.mode).toBe("suggest");
  });

  it.each([
    ["a bad window", sourceWith({ window: { type: "last-days", days: 0 } }), /days/],
    ["a bad date", sourceWith({ window: { type: "since", date: "2026-02-30" } }), /date/],
    ["a bad count", sourceWith({ window: { type: "latest-per-artist", count: 51 } }), /count/],
    ["an unknown window", sourceWith({ window: { type: "forever" } }), /window/],
    ["a bad time", rawJob({ schedule: { every: "day", at: "25:00" } }), /at/],
    ["a bad weekday", rawJob({ schedule: { every: "week", weekday: 7 } }), /weekday/],
    ["an unknown kind of release", sourceWith({ include: ["bootleg"] }), /include/],
    ["no kinds of release", sourceWith({ include: [] }), /include/],
    ["no artists", sourceWith({ artists: { type: "list", artists: [] } }), /artists/],
    ["a bad similar count", sourceWith({ similar: { perArtist: 21 } }), /perArtist/],
    ["a blank name", rawJob({ name: "  " }), /name/],
    ["a bad id", rawJob({ id: "nope" }), /id/],
    ["an unknown job kind", rawJob({ kind: "laundry" }), /kind/],
    ["a bad edit mode", rawJob({ edits: "sometimes" }), /edits/],
    ["a non-integer cap", rawJob({ shape: { maxTracks: 1.5 } }), /maxTracks/],
    ["an unknown source", rawJob({ source: { type: "radio" } }), /source type/],
    ["a combined source of one", rawJob({ source: { type: "combined", inputs: [{ type: "favourites" }] } }), /inputs/],
    [
      "a combined source repeating a playlist",
      rawJob({
        source: { type: "combined", inputs: [{ type: "playlist", playlistId: qid(1) }, { type: "playlist", playlistId: qid(1) }] },
      }),
      /twice/,
    ],
    ["a smart source without rules", rawJob({ source: { type: "smart", from: [{ type: "favourites" }], rules: [] } }), /rules/],
    [
      "a bad decade",
      rawJob({ source: { type: "smart", from: [{ type: "favourites" }], rules: [{ type: "decades", decades: ["90s"] }] } }),
      /decades/,
    ],
    [
      "favourited-within without the favourites",
      rawJob({
        source: { type: "smart", from: [{ type: "playlist", playlistId: qid(2) }], rules: [{ type: "favourited-within", days: 7 }] },
      }),
      /favourites/,
    ],
    [
      "a duration rule backwards",
      rawJob({
        source: { type: "smart", from: [{ type: "favourites" }], rules: [{ type: "duration", minSeconds: 300, maxSeconds: 100 }] },
      }),
      /shortest/,
    ],
    ["a bad cadence", rawJob({ tidy: { dedupe: { cadence: "hourly" } } }), /cadence/],
    ["a bad keep", rawJob({ tidy: { dedupe: { keep: ["loudest"] } } }), /keep/],
    ["neither source nor tidy-up", rawJob({ target: { type: "adopted", playlistId: qid(3) }, source: undefined }), /source, a tidy-up/],
    ["a new playlist without a source", rawJob({ source: undefined, tidy: { dedupe: {} } }), /needs a source/],
    ["a source on the favourites", rawJob({ target: { type: "favourites" }, tidy: { dedupe: {} } }), /favourites/],
    ["mirror on an adopted playlist", rawJob({ target: { type: "adopted", playlistId: qid(3) }, edits: "mirror" }), /mirror/],
    ["maxReleases on another source", rawJob({ source: { type: "follow", playlistId: qid(2) }, shape: { maxReleases: 2 } }), /maxReleases/],
    [
      "a source reading its own playlist",
      rawJob({ target: { type: "adopted", playlistId: qid(3) }, source: { type: "follow", playlistId: qid(3) } }),
      /itself/,
    ],
  ])("rejects %s with a readable message", (_label, raw, message) => {
    expect(() => validateJob(raw)).toThrow(message);
  });
});

describe("parseJobsFile", () => {
  it("keeps valid jobs and reports invalid ones by index", () => {
    const { file, invalid } = parseJobsFile({
      version: 2,
      jobs: [rawJob(), rawJob({ id: "bbbbbbbb", schedule: { every: "fortnight" } })],
    });
    expect(file.jobs.map((job) => job.id)).toEqual(["a1b2c3d4"]);
    expect(invalid).toEqual([{ index: 1, id: "bbbbbbbb", error: expect.stringMatching(/every/) }]);
  });

  it("reads a version 1 file as version 3", () => {
    const { file, invalid } = parseJobsFile({ version: 1, jobs: [v1Job()] });
    expect(invalid).toEqual([]);
    expect(file.version).toBe(3);
    expect(file.jobs[0]?.target).toEqual({ type: "created", isPublic: false });
  });

  it("treats a repeated id as invalid after the first", () => {
    const { file, invalid } = parseJobsFile({ version: 2, jobs: [rawJob(), rawJob({ name: "Twin" })] });
    expect(file.jobs).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ index: 1, error: expect.stringMatching(/repeated/) });
  });

  it("rejects another version", () => {
    expect(() => parseJobsFile({ version: 4, jobs: [] })).toThrow(/version/);
  });

  it("rejects something that is not a jobs file", () => {
    expect(() => parseJobsFile([])).toThrow();
  });
});

describe("job state", () => {
  it("round-trips the empty state", () => {
    expect(parseJobState(JSON.parse(JSON.stringify(emptyJobState())))).toEqual(emptyJobState());
  });

  it("round-trips a full state", () => {
    const state: JobState = {
      ...emptyJobState(),
      playlistId: qid(7),
      lastRunAt: "2026-11-02T06:00:00.000Z",
      nextRunAt: "2026-11-03T06:00:00.000Z",
      consecutiveFailures: 2,
      paused: { reason: "playlist-deleted", since: "2026-11-02T06:00:00.000Z" },
      owned: [{ playlistTrackId: qid(10), trackId: qid(1) }],
      dismissed: [qid(5)],
      pending: { removed: [qid(11)], added: [qid(3), qid(4)] },
      substitutions: [{ from: qid(1), to: qid(2), key: "upgrade:1>2" }, { from: qid(3), key: "repair:3" }],
      tidy: {
        dedupe: { lastRunAt: "2026-11-02T06:00:00.000Z" },
        upgrade: { lastRunAt: "2026-11-01T06:00:00.000Z", checked: [{ trackId: qid(4), at: "2026-11-01T06:00:00.000Z" }] },
      },
      applied: ["dedupe:4,4"],
      suggestions: [
        {
          key: "upgrade:5>6",
          tidy: "upgrade",
          summary: "Song: 16/44.1 -> 24/96",
          change: { type: "replace", trackId: qid(5), newTrackId: qid(6), playlistTrackId: qid(12) },
          foundAt: "2026-11-02T06:00:00.000Z",
        },
        {
          key: "dedupe:7,8",
          tidy: "dedupe",
          summary: "Two copies",
          change: { type: "dedupe", keepTrackId: qid(7), remove: [{ trackId: qid(8), playlistTrackId: qid(13) }] },
          foundAt: "2026-11-02T06:00:00.000Z",
        },
      ],
      ignored: ["repair:9"],
      favouriteDates: [{ trackId: qid(6), at: "2020-01-01T00:00:00.000Z" }],
      source: {
        similar: { takenAt: "2026-11-01T00:00:00.000Z", artists: [{ id: qid(2), name: "Air" }] },
        seen: [qid(1), qid(2)],
        rotation: { number: 3, artistIds: [qid(2)], tracks: [{ trackId: qid(1), source: "artist:2", durationSeconds: 200 }] },
        served: [{ rotation: 2, trackIds: [qid(9)] }],
      },
      lastResult: {
        at: "2026-11-02T06:00:00.000Z",
        status: "ok",
        added: 1,
        removed: 0,
        dismissed: 0,
        replaced: 1,
        tidyRemoved: 2,
        suggested: 3,
        notes: [],
      },
    };
    expect(parseJobState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("reads a version 1 state, moving the similar snapshot into the source state", () => {
    const state = parseJobState({
      version: 1,
      consecutiveFailures: 0,
      playlistId: qid(4),
      owned: [],
      dismissed: [qid(2)],
      similar: { takenAt: "x", artists: [{ id: qid(1), name: "" }, { id: qid(2), name: "Air" }, "junk"] },
    });
    expect(state.version).toBe(3);
    expect(state.dismissed).toEqual([qid(2)]);
    expect(state.source?.similar).toEqual({ takenAt: "x", artists: [{ id: qid(2), name: "Air" }] });
    expect(state.substitutions).toEqual([]);
  });

  it("skips unusable suggestions rather than rejecting the state", () => {
    const state = parseJobState({ ...emptyJobState(), suggestions: [{ key: "x", tidy: "laundry" }, "junk"] });
    expect(state.suggestions).toEqual([]);
  });

  it("rejects a state of another version", () => {
    expect(() => parseJobState({ version: 9 })).toThrow(/version/);
  });
});

describe("helpers", () => {
  it("newJobId is 8 hex characters", () => {
    expect(newJobId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("playlistIdOf reads the target, then the state", () => {
    const created = validateJob(rawJob());
    const adopted = validateJob(rawJob({ target: { type: "adopted", playlistId: qid(3) } }));
    expect(playlistIdOf(created, {})).toBeUndefined();
    expect(playlistIdOf(created, { playlistId: qid(8) })).toBe(qid(8));
    expect(playlistIdOf(adopted, { playlistId: qid(8) })).toBe(qid(3));
  });

  it("sourceReads lists the playlists and favourites a source reads", () => {
    const combined = validateJob(
      rawJob({ source: { type: "combined", inputs: [{ type: "playlist", playlistId: qid(5) }, { type: "favourites" }] } }),
    );
    expect(sourceReads(combined.source)).toEqual({ playlists: [qid(5)], favourites: true });
    expect(sourceReads(validateJob(rawJob()).source)).toEqual({ playlists: [], favourites: false });
  });

  it("capList keeps the newest", () => {
    expect(capList([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(capList([1], 2)).toEqual([1]);
  });
});

describe("ids in job files", () => {
  it("reads a version 2 file's bare ids as Qobuz's, and writes version 3", () => {
    const { file, invalid } = parseJobsFile({
      version: 2,
      jobs: [
        rawJob({
          target: { type: "adopted", playlistId: 3 },
          source: {
            type: "combined",
            inputs: [{ type: "playlist", playlistId: 5 }, { type: "favourites" }],
            mode: "merge",
            keep: "first",
            order: "sequential",
          },
        }),
        rawJob({ id: "b1b2c3d4" }),
      ],
    });
    expect(invalid).toEqual([]);
    expect(file.version).toBe(3);
    expect(file.jobs[0]).toMatchObject({
      target: { type: "adopted", playlistId: "qobuz:3" },
      source: { inputs: [{ type: "playlist", playlistId: "qobuz:5" }, { type: "favourites" }] },
    });
    expect(file.jobs[1]?.source).toMatchObject({ artists: { artists: [{ id: "qobuz:1", name: "Röyksopp" }] } });
    expect(parseJobsFile(JSON.parse(JSON.stringify(file))).file).toEqual(file);
  });

  it("takes another service's ids", () => {
    const job = validateJob(rawJob({ target: { type: "adopted", playlistId: "tidal:a-b" } }));
    expect(job.target).toEqual({ type: "adopted", playlistId: "tidal:a-b" });
  });

  it.each([0, -1, 1.5, "", "qobuz:", "nope:1", null])("rejects the playlist id %j", (playlistId) => {
    expect(() => validateJob(rawJob({ target: { type: "adopted", playlistId } }))).toThrow(/target\.playlistId/);
  });

  it("reads a version 2 state's bare ids as Qobuz's, keeping its keys", () => {
    const state = parseJobState({
      ...JSON.parse(JSON.stringify(emptyJobState())),
      version: 2,
      playlistId: 4,
      owned: [{ playlistTrackId: 90, trackId: 1 }],
      dismissed: [2],
      pending: { removed: [91], added: [3] },
      substitutions: [{ from: 5, to: 6, key: "upgrade:5>6" }],
      tidy: { upgrade: { lastRunAt: "x", checked: [{ trackId: 5, at: "y" }] } },
      suggestions: [
        {
          key: "dedupe:7,8",
          tidy: "dedupe",
          summary: "Two copies",
          change: { type: "dedupe", keepTrackId: 7, remove: [{ trackId: 8, playlistTrackId: 13 }] },
          foundAt: "",
        },
      ],
      ignored: ["repair:9"],
      favouriteDates: [{ trackId: 6, at: "2020-01-01T00:00:00.000Z" }],
      source: {
        seen: [1],
        rotation: { number: 3, artistIds: [2], tracks: [{ trackId: 1, source: "artist:2" }] },
        served: [{ rotation: 2, trackIds: [9] }],
      },
    });
    expect(state).toMatchObject({
      version: 3,
      playlistId: "qobuz:4",
      owned: [{ playlistTrackId: "qobuz:90", trackId: "qobuz:1" }],
      dismissed: ["qobuz:2"],
      pending: { removed: ["qobuz:91"], added: ["qobuz:3"] },
      substitutions: [{ from: "qobuz:5", to: "qobuz:6", key: "upgrade:5>6" }],
      tidy: { upgrade: { checked: [{ trackId: "qobuz:5", at: "y" }] } },
      ignored: ["repair:9"],
      favouriteDates: [{ trackId: "qobuz:6" }],
      source: {
        seen: ["qobuz:1"],
        rotation: { artistIds: ["qobuz:2"], tracks: [{ trackId: "qobuz:1", source: "artist:2" }] },
        served: [{ trackIds: ["qobuz:9"] }],
      },
    });
    expect(state.suggestions[0]).toMatchObject({
      key: "dedupe:7,8",
      change: { keepTrackId: "qobuz:7", remove: [{ trackId: "qobuz:8", playlistTrackId: "qobuz:13" }] },
    });
  });
});
