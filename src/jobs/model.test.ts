import { describe, expect, it } from "vitest";

import {
  emptyJobState,
  newJobId,
  parseJobsFile,
  parseJobState,
  validateJob,
} from "./model.js";

/** A minimal valid job as a user (or the UI) would write it. */
function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2c3d4",
    name: "Fresh",
    createdAt: "2026-11-02T10:00:00.000Z",
    kind: "managed-playlist",
    schedule: { every: "day" },
    recipe: {
      type: "new-releases",
      artists: { type: "list", artists: [{ id: 1, name: "Röyksopp" }] },
      window: { type: "last-days", days: 30 },
    },
    ...overrides,
  };
}

function recipeWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return rawJob({ recipe: { ...(rawJob()["recipe"] as object), ...overrides } });
}

describe("validateJob", () => {
  it("fills the defaults", () => {
    const job = validateJob(rawJob());
    expect(job).toEqual({
      id: "a1b2c3d4",
      name: "Fresh",
      createdAt: "2026-11-02T10:00:00.000Z",
      enabled: true,
      kind: "managed-playlist",
      isPublic: false,
      edits: "respect",
      schedule: { every: "day", at: "06:00" },
      recipe: {
        type: "new-releases",
        artists: { type: "list", artists: [{ id: 1, name: "Röyksopp" }] },
        window: { type: "last-days", days: 30 },
        include: ["album", "ep-single"],
        hideFavourites: false,
      },
    });
  });

  it("fills a weekly schedule's weekday (Monday) and time", () => {
    expect(validateJob(rawJob({ schedule: { every: "week" } })).schedule).toEqual({
      every: "week",
      weekday: 1,
      at: "06:00",
    });
  });

  it("keeps the optional parts it is given", () => {
    const job = validateJob(
      rawJob({
        enabled: false,
        isPublic: true,
        edits: "mirror",
        shape: { maxReleases: 10, maxMinutes: 90 },
        recipe: {
          type: "new-releases",
          artists: { type: "favourites" },
          similar: { perArtist: 3, refreshDays: 30 },
          window: { type: "since", date: "2026-01-01" },
          include: ["album"],
          hideFavourites: true,
          exclude: { excludeTracks: ["live"] },
        },
      }),
    );
    expect(job.enabled).toBe(false);
    expect(job.edits).toBe("mirror");
    expect(job.shape).toEqual({ maxReleases: 10, maxMinutes: 90 });
    expect(job.recipe.similar).toEqual({ perArtist: 3, refreshDays: 30 });
    expect(job.recipe.exclude).toEqual({ excludeTracks: ["live"] });
  });

  it.each([
    ["a bad window", recipeWith({ window: { type: "last-days", days: 0 } }), /days/],
    ["a bad date", recipeWith({ window: { type: "since", date: "2026-02-30" } }), /date/],
    ["a bad count", recipeWith({ window: { type: "latest-per-artist", count: 51 } }), /count/],
    ["an unknown window", recipeWith({ window: { type: "forever" } }), /window/],
    ["a bad time", rawJob({ schedule: { every: "day", at: "25:00" } }), /at/],
    ["a bad weekday", rawJob({ schedule: { every: "week", weekday: 7 } }), /weekday/],
    ["an unknown kind of release", recipeWith({ include: ["bootleg"] }), /include/],
    ["no kinds of release", recipeWith({ include: [] }), /include/],
    ["no artists", recipeWith({ artists: { type: "list", artists: [] } }), /artists/],
    ["a bad similar count", recipeWith({ similar: { perArtist: 21, refreshDays: 30 } }), /perArtist/],
    ["a blank name", rawJob({ name: "  " }), /name/],
    ["a bad id", rawJob({ id: "nope" }), /id/],
    ["an unknown job kind", rawJob({ kind: "laundry" }), /kind/],
    ["a bad edit mode", rawJob({ edits: "sometimes" }), /edits/],
    ["a non-integer cap", rawJob({ shape: { maxTracks: 1.5 } }), /maxTracks/],
  ])("rejects %s with a readable message", (_label, raw, message) => {
    expect(() => validateJob(raw)).toThrow(message);
  });
});

describe("parseJobsFile", () => {
  it("keeps valid jobs and reports invalid ones by index", () => {
    const { file, invalid } = parseJobsFile({
      version: 1,
      jobs: [rawJob(), rawJob({ id: "bbbbbbbb", schedule: { every: "fortnight" } })],
    });
    expect(file.jobs.map((job) => job.id)).toEqual(["a1b2c3d4"]);
    expect(invalid).toEqual([{ index: 1, id: "bbbbbbbb", error: expect.stringMatching(/every/) }]);
  });

  it("treats a repeated id as invalid after the first", () => {
    const { file, invalid } = parseJobsFile({ version: 1, jobs: [rawJob(), rawJob({ name: "Twin" })] });
    expect(file.jobs).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ index: 1, error: expect.stringMatching(/repeated/) });
  });

  it("rejects another version", () => {
    expect(() => parseJobsFile({ version: 2, jobs: [] })).toThrow(/version/);
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
    const state = {
      ...emptyJobState(),
      playlistId: 7,
      lastRunAt: "2026-11-02T06:00:00.000Z",
      nextRunAt: "2026-11-03T06:00:00.000Z",
      consecutiveFailures: 2,
      paused: { reason: "playlist-deleted" as const, since: "2026-11-02T06:00:00.000Z" },
      owned: [{ playlistTrackId: 10, trackId: 1 }],
      dismissed: [5],
      pending: { removed: [11], added: [3, 4] },
      similar: { takenAt: "2026-11-01T00:00:00.000Z", artists: [{ id: 2, name: "Air" }] },
      lastResult: {
        at: "2026-11-02T06:00:00.000Z",
        status: "ok" as const,
        added: 1,
        removed: 0,
        dismissed: 0,
        notes: [],
      },
    };
    expect(parseJobState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects a state of another version", () => {
    expect(() => parseJobState({ version: 9 })).toThrow(/version/);
  });
});

describe("newJobId", () => {
  it("is 8 hex characters", () => {
    expect(newJobId()).toMatch(/^[0-9a-f]{8}$/);
  });
});
