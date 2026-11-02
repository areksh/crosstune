import { describe, expect, it } from "vitest";

import {
  describeResult,
  describeSchedule,
  describeSource,
  describeWindow,
  formatJobList,
  formatPreview,
  formatRunSummary,
} from "./format.js";
import { emptyJobState, validateJob } from "./model.js";

const job = validateJob({
  id: "a1b2c3d4",
  name: "Fresh",
  createdAt: "2026-11-01T00:00:00.000Z",
  kind: "playlist",
  schedule: { every: "week", weekday: 5, at: "07:30" },
  target: { type: "created" },
  tidy: { dedupe: {}, upgrade: { mode: "suggest" } },
  source: {
    type: "new-releases",
    artists: { type: "list", artists: [{ id: 1, name: "Air" }, { id: 2, name: "Bonobo" }] },
    similar: { perArtist: 3, refreshDays: 30 },
    window: { type: "last-days", days: 30 },
  },
});

describe("describe*", () => {
  it("words schedules", () => {
    expect(describeSchedule({ every: "hour" })).toBe("Every hour");
    expect(describeSchedule({ every: "day", at: "06:00" })).toBe("Daily at 06:00");
    expect(describeSchedule({ every: "week", weekday: 5, at: "07:30" })).toBe("Fridays at 07:30");
  });

  it("words windows", () => {
    expect(describeWindow({ type: "last-days", days: 1 })).toBe("released in the last day");
    expect(describeWindow({ type: "last-days", days: 30 })).toBe("released in the last 30 days");
    expect(describeWindow({ type: "since", date: "2026-01-01" })).toBe("released since 2026-01-01");
    expect(describeWindow({ type: "latest-per-artist", count: 1 })).toBe("each artist's newest release");
    expect(describeWindow({ type: "latest-per-artist", count: 3 })).toBe("each artist's 3 newest releases");
  });

  it("words results", () => {
    expect(describeResult({ at: "", status: "ok", added: 2, removed: 1, dismissed: 0, notes: [] })).toBe(
      "ok: +2 tracks, -1 track",
    );
    expect(describeResult({ at: "", status: "ok", added: 0, removed: 0, dismissed: 0, notes: [] })).toBe(
      "ok: no changes",
    );
    expect(describeResult({ at: "", status: "ok", added: 0, removed: 0, dismissed: 0, replaced: 2, suggested: 1, notes: [] })).toBe(
      "ok: 2 replaced, 1 suggestion",
    );
    expect(
      describeResult({ at: "", status: "failed", added: 0, removed: 0, dismissed: 0, notes: [], error: "HTTP 500" }),
    ).toBe("failed: HTTP 500");
    expect(describeResult({ at: "", status: "partial", added: 1, removed: 0, dismissed: 2, notes: [] })).toBe(
      "partial: +1 track, 2 dismissed",
    );
  });
});

describe("formatJobList", () => {
  it("says when there are no jobs", () => {
    expect(formatJobList({ jobs: [], invalid: [], flags: {} })).toMatch(/No jobs yet/);
  });

  it("lists each job with its schedule, recipe and last run", () => {
    const text = formatJobList({
      jobs: [
        {
          job,
          state: {
            ...emptyJobState(),
            playlistId: 77,
            nextRunAt: "2026-11-06T07:30:00.000Z",
            lastResult: { at: "2026-10-30T07:30:00.000Z", status: "ok", added: 3, removed: 0, dismissed: 0, notes: [] },
          },
          recentRuns: [],
        },
      ],
      invalid: [{ index: 1, id: "ffffffff", error: "schedule.every must be one of hour, day, week" }],
      flags: { needsSignIn: { since: "x", message: "expired" } },
    });
    expect(text).toContain("a1b2c3d4  Fresh");
    expect(text).toContain("Fridays at 07:30");
    expect(text).toContain("2 artists + 3 similar each");
    expect(text).toContain("released in the last 30 days");
    expect(text).toContain("playlist (77), created by qobuz-helper");
    expect(text).toContain("Upgrade monthly (suggest) · Dedupe every pass");
    expect(text).toContain("ok: +3 tracks");
    expect(text).toContain("next 2026-11-06T07:30:00.000Z");
    expect(text).toMatch(/ffffffff.*schedule\.every/);
    expect(text).toMatch(/sign in again/i);
  });

  it("says when a job's state cannot be read", () => {
    const text = formatJobList({
      jobs: [{ job, state: emptyJobState(), recentRuns: [], stateError: "jobs-state/a1b2c3d4.json cannot be read" }],
      invalid: [],
      flags: {},
    });
    expect(text).toMatch(/skipped: jobs-state\/a1b2c3d4\.json cannot be read/);
  });

  it("shows paused and disabled jobs", () => {
    const text = formatJobList({
      jobs: [
        { job: { ...job, enabled: false }, state: emptyJobState(), recentRuns: [] },
        { job, state: { ...emptyJobState(), paused: { reason: "playlist-deleted", since: "x" } }, recentRuns: [] },
      ],
      invalid: [],
      flags: {},
    });
    expect(text).toMatch(/paused by you/);
    expect(text).toMatch(/playlist was deleted/);
  });
});

describe("formatRunSummary", () => {
  it("words each status", () => {
    expect(formatRunSummary({ status: "nothing-due", reports: [], invalid: [] })).toBe("Nothing is due.");
    expect(formatRunSummary({ status: "busy", reports: [], invalid: [], message: "Another one" })).toBe("Another one");
    expect(formatRunSummary({ status: "needs-sign-in", reports: [], invalid: [], message: "expired" })).toMatch(
      /qobuz-helper login/,
    );
    expect(
      formatRunSummary({
        status: "ran",
        reports: [{ jobId: "a1b2c3d4", name: "Fresh", result: { at: "", status: "ok", added: 1, removed: 0, dismissed: 0, notes: ["note"] } }],
        invalid: [],
      }),
    ).toBe("Fresh: ok: +1 track\n  note");
  });
});

describe("formatPreview", () => {
  it("says what a refresh would do", () => {
    const text = formatPreview("Fresh", {
      createsPlaylist: true,
      add: [
        { trackId: 1, source: "album:x" },
        { trackId: 2, source: "album:x" },
        { trackId: 3, source: "album:y" },
      ],
      remove: [],
      newlyDismissed: [],
      withheldRemovals: 0,
      complete: true,
      notes: [],
      findings: [],
    });
    expect(text).toBe('Would create the playlist "Fresh" and add 3 tracks from 2 releases.');
  });

  it("says when nothing would change", () => {
    expect(
      formatPreview("Fresh", { createsPlaylist: false, add: [], remove: [], newlyDismissed: [], withheldRemovals: 0, complete: true, notes: ["n"], findings: [] }),
    ).toBe('"Fresh" is up to date.\n  n');
  });

  it("lists what the tidy-ups would do", () => {
    expect(
      formatPreview("Fresh", {
        createsPlaylist: false,
        add: [{ trackId: 1, source: "playlist:4" }],
        remove: [],
        newlyDismissed: [],
        withheldRemovals: 0,
        complete: true,
        notes: [],
        findings: [{ key: "upgrade:1>2", tidy: "upgrade", summary: "Song: better", mode: "suggest" }],
      }),
    ).toBe('Would add 1 track in "Fresh".\nWould suggest: Song: better');
  });
});

describe("describeSource", () => {
  it("words each kind of source", () => {
    const names = new Map([[4, "Road trip"]]);
    expect(describeSource(undefined)).toBe("No source: only tidied");
    expect(
      describeSource(
        { type: "combined", inputs: [{ type: "playlist", playlistId: 4 }, { type: "favourites" }], mode: "merge", keep: "first", order: "shuffle", matchSongs: true },
        names,
      ),
    ).toBe("Combined: Road trip + Favourites (merged, shuffled)");
    expect(describeSource({ type: "follow", playlistId: 4, keepRemoved: true }, names)).toBe("Archive of Road trip");
    expect(
      describeSource({
        type: "smart",
        from: [{ type: "favourites" }],
        rules: [{ type: "quality", quality: "hires" }, { type: "duration", maxSeconds: 300 }],
        order: "as-listed",
      }),
    ).toBe("Smart: Favourites, hi-res, at most 5:00");
  });
});
