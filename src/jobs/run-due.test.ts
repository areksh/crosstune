import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { QobuzError } from "../qobuz/index.js";
import { tryAcquireLock } from "../cli/file-lock.js";
import {
  emptyJobState,
  validateJob,
  type InvalidJob,
  type Job,
  type JobState,
  type RunResultSummary,
} from "./model.js";
import { RefreshWriteError, type RefreshClient, type RefreshOutcome } from "./refresh.js";
import { acceptNow, runDue, type RunDueDeps } from "./run-due.js";
import { JobsFileError, JobStateError, type GlobalFlags, type RunRecord } from "./stores.js";

const NOW = new Date("2026-11-02T06:00:00.000Z");

function job(id: string, overrides: Record<string, unknown> = {}): Job {
  return validateJob({
    id,
    name: `Job ${id}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    kind: "managed-playlist",
    schedule: { every: "hour" },
    recipe: { type: "new-releases", artists: { type: "favourites" }, window: { type: "last-days", days: 30 } },
    ...overrides,
  });
}

const ok = (overrides: Partial<RunResultSummary> = {}): RunResultSummary => ({
  at: NOW.toISOString(),
  status: "ok",
  added: 1,
  removed: 0,
  dismissed: 0,
  notes: [],
  ...overrides,
});

function setup(jobs: Job[], options: { invalid?: InvalidJob[]; states?: Record<string, Partial<JobState>> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qh-rundue-"));
  const states = new Map<string, JobState>(
    Object.entries(options.states ?? {}).map(([id, s]) => [id, { ...emptyJobState(), ...s }]),
  );
  const runs: RunRecord[] = [];
  let flags: GlobalFlags = {};
  const client = {} as RefreshClient;
  const lockPath = join(dir, "jobs.lock");
  const order: string[] = [];
  const deps = {
    jobs: {
      load: () => ({ file: { version: 2 as const, jobs }, invalid: options.invalid ?? [] }),
      save: () => {},
    },
    state: {
      load: (id: string) => states.get(id) ?? emptyJobState(),
      save: (id: string, state: JobState) => void states.set(id, state),
      remove: (id: string) => void states.delete(id),
    },
    runs: { append: (r: RunRecord) => void runs.push(r), read: () => [...runs].reverse() },
    global: { load: () => flags, save: (f: GlobalFlags) => void (flags = f) },
    acquireLock: () => tryAcquireLock(lockPath),
    connect: vi.fn(async () => ({ ok: true as const, client })),
    journalRun: vi.fn(<T>(_label: string, fn: () => Promise<T>) => fn()),
    refresh: vi.fn(async (_c: RefreshClient, j: Job, state: JobState): Promise<RefreshOutcome> => {
      order.push(j.id);
      const result = ok();
      return {
        state: { ...state, lastRunAt: NOW.toISOString(), lastResult: result },
        result,
        preview: { createsPlaylist: false, add: [], remove: [], newlyDismissed: [], withheldRemovals: 0, complete: true, notes: [], findings: [] },
      };
    }),
  } satisfies RunDueDeps;
  return { deps, states, runs, order, lockPath, flags: () => flags };
}

describe("runDue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not connect when nothing is due", async () => {
    const { deps } = setup([job("aaaaaaaa")], { states: { aaaaaaaa: { nextRunAt: "2026-11-02T07:00:00.000Z" } } });
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("nothing-due");
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("returns busy while another runner holds the lock", async () => {
    const { deps, lockPath } = setup([job("aaaaaaaa")]);
    const held = tryAcquireLock(lockPath, { isAlive: () => true });
    expect(held).toBeDefined();
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("busy");
    expect(deps.refresh).not.toHaveBeenCalled();
    held?.release();
  });

  it("runs due jobs oldest first and schedules each one's next slot", async () => {
    const { deps, states, runs, order } = setup([job("aaaaaaaa"), job("bbbbbbbb"), job("cccccccc")], {
      states: {
        aaaaaaaa: { nextRunAt: "2026-11-02T05:00:00.000Z" },
        bbbbbbbb: { nextRunAt: "2026-11-02T04:00:00.000Z" },
        // cccccccc has never run: due, first.
      },
    });
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("ran");
    expect(order).toEqual(["cccccccc", "bbbbbbbb", "aaaaaaaa"]);
    expect(states.get("aaaaaaaa")?.nextRunAt).toBe("2026-11-02T07:00:00.000Z");
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ jobId: "cccccccc", jobName: "Job cccccccc", result: { status: "ok" } });
    expect(deps.journalRun).toHaveBeenCalledWith("Managed: Job cccccccc", expect.any(Function));
  });

  it("skips disabled and paused jobs", async () => {
    const { deps, order } = setup([job("aaaaaaaa", { enabled: false }), job("bbbbbbbb")], {
      states: { bbbbbbbb: { paused: { reason: "playlist-deleted", since: "x" } } },
    });
    expect((await runDue(deps, NOW)).status).toBe("nothing-due");
    expect(order).toEqual([]);
  });

  it("backs off after a failure and counts consecutive failures", async () => {
    const { deps, states, runs } = setup([job("aaaaaaaa", { schedule: { every: "day" } })], {
      states: { aaaaaaaa: { consecutiveFailures: 1 } },
    });
    deps.refresh.mockRejectedValueOnce(new Error("Qobuz 500"));
    const summary = await runDue(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "failed", error: "Qobuz 500" });
    expect(states.get("aaaaaaaa")).toMatchObject({
      consecutiveFailures: 2,
      nextRunAt: "2026-11-02T07:00:00.000Z",
      lastRunAt: NOW.toISOString(),
    });
    expect(runs[0]?.result.status).toBe("failed");
  });

  it("resets the failure count after a success", async () => {
    const { deps, states } = setup([job("aaaaaaaa")], { states: { aaaaaaaa: { consecutiveFailures: 3 } } });
    await runDue(deps, NOW);
    expect(states.get("aaaaaaaa")?.consecutiveFailures).toBe(0);
  });

  it("sets needsSignIn and stops when the session is rejected mid-run", async () => {
    const { deps, order, states, flags } = setup([job("aaaaaaaa"), job("bbbbbbbb")]);
    deps.refresh.mockImplementationOnce(async () => {
      throw new QobuzError("authentication", "token expired");
    });
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("needs-sign-in");
    expect(flags().needsSignIn?.message).toMatch(/token expired/);
    expect(order).toEqual([]);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    // Not the job's fault: no failure counted, still due.
    expect(states.get("aaaaaaaa")?.consecutiveFailures ?? 0).toBe(0);
    expect(states.get("aaaaaaaa")?.nextRunAt).toBeUndefined();
  });

  it("sets the flag and runs nothing when connecting fails", async () => {
    const { deps, flags } = setup([job("aaaaaaaa")]);
    deps.connect.mockResolvedValueOnce({ ok: false, reason: "bundle-broken", message: "no secret" } as never);
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("bundle-broken");
    expect(flags().bundleBroken).toEqual({ since: NOW.toISOString(), message: "no secret" });
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("clears the flags once connecting works again", async () => {
    const { deps, flags } = setup([job("aaaaaaaa")]);
    deps.global.save({ needsSignIn: { since: "x", message: "y" } });
    await runDue(deps, NOW);
    expect(flags()).toEqual({});
  });

  it("keeps running other jobs when one pauses", async () => {
    const { deps, order } = setup([job("aaaaaaaa"), job("bbbbbbbb")]);
    deps.refresh.mockImplementationOnce(async (_c, j, state) => {
      order.push(j.id);
      const result = ok({ status: "paused", added: 0 });
      return {
        state: { ...state, paused: { reason: "playlist-deleted", since: NOW.toISOString() } },
        result,
        preview: { createsPlaylist: false, add: [], remove: [], newlyDismissed: [], withheldRemovals: 0, complete: true, notes: [], findings: [] },
      };
    });
    const summary = await runDue(deps, NOW);
    expect(order).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(summary.reports.map((r) => r.result.status)).toEqual(["paused", "ok"]);
  });

  it("reports invalid jobs and runs the valid ones", async () => {
    const invalid = [{ index: 1, id: "zzzzzzzz", error: "bad schedule" }];
    const { deps, order } = setup([job("aaaaaaaa")], { invalid });
    const summary = await runDue(deps, NOW);
    expect(summary.invalid).toEqual(invalid);
    expect(order).toEqual(["aaaaaaaa"]);
  });

  it("reports an unreadable jobs file", async () => {
    const { deps } = setup([]);
    deps.jobs.load = () => {
      throw new JobsFileError("jobs.json cannot be read");
    };
    const summary = await runDue(deps, NOW);
    expect(summary).toMatchObject({ status: "jobs-file-error", message: "jobs.json cannot be read" });
  });

  it("runs one job on request even when it is not due", async () => {
    const { deps, order, states } = setup([job("aaaaaaaa"), job("bbbbbbbb")], {
      states: {
        aaaaaaaa: { nextRunAt: "2026-11-03T00:00:00.000Z" },
        bbbbbbbb: { nextRunAt: "2026-11-01T00:00:00.000Z" },
      },
    });
    await runDue(deps, NOW, { onlyJobId: "aaaaaaaa" });
    expect(order).toEqual(["aaaaaaaa"]);
    expect(states.get("aaaaaaaa")?.nextRunAt).toBe("2026-11-02T07:00:00.000Z");
  });

  it("throws for an unknown job id", async () => {
    const { deps } = setup([job("aaaaaaaa")]);
    await expect(runDue(deps, NOW, { onlyJobId: "ffffffff" })).rejects.toThrow(/No job ffffffff/);
  });

  it("skips a job whose state cannot be read, saving nothing for it", async () => {
    const { deps, order, states, runs } = setup([job("aaaaaaaa"), job("bbbbbbbb")]);
    const load = deps.state.load;
    deps.state.load = (id: string) => {
      if (id === "aaaaaaaa") {
        throw new JobStateError("jobs-state/aaaaaaaa.json cannot be read");
      }
      return load(id);
    };
    const summary = await runDue(deps, NOW);
    expect(order).toEqual(["bbbbbbbb"]);
    expect(summary.invalid).toEqual([{ index: 0, id: "aaaaaaaa", error: expect.stringMatching(/cannot be read/) }]);
    expect(states.has("aaaaaaaa")).toBe(false);
    expect(runs.map((r) => r.jobId)).toEqual(["bbbbbbbb"]);
  });

  it("saves nothing on a dry run", async () => {
    const { deps, states, runs } = setup([job("aaaaaaaa")]);
    const summary = await runDue(deps, NOW, { dryRun: true });
    expect(summary.reports).toHaveLength(1);
    expect(states.size).toBe(0);
    expect(runs).toEqual([]);
    expect(deps.refresh.mock.calls[0]?.[3]).toEqual({ now: NOW, dryRun: true });
  });

  it("saves the partial state a refresh that failed mid-write carries", async () => {
    const { deps, states } = setup([job("aaaaaaaa", { schedule: { every: "day" } })]);
    const partial = { ...emptyJobState(), playlistId: 42, pending: { removed: [], added: [7] } };
    deps.refresh.mockRejectedValueOnce(new RefreshWriteError(new Error("Qobuz 500"), partial));
    const summary = await runDue(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "failed", error: "Qobuz 500" });
    expect(states.get("aaaaaaaa")).toMatchObject({ playlistId: 42, pending: { added: [7] }, consecutiveFailures: 1 });
  });

  it("saves the partial state when the session is rejected mid-write", async () => {
    const { deps, states } = setup([job("aaaaaaaa")]);
    const partial = { ...emptyJobState(), playlistId: 42 };
    deps.refresh.mockRejectedValueOnce(
      new RefreshWriteError(new QobuzError("authentication", "expired"), partial),
    );
    const summary = await runDue(deps, NOW);
    expect(summary.status).toBe("needs-sign-in");
    expect(states.get("aaaaaaaa")?.playlistId).toBe(42);
  });

  it("runs a job after the job managing a playlist it reads, passing the favourites' carried dates", async () => {
    const reader = job("aaaaaaaa", { kind: "playlist", recipe: undefined, target: { type: "created" }, source: { type: "follow", playlistId: 10 } });
    const feed = job("bbbbbbbb");
    const favourites = validateJob({
      id: "cccccccc",
      name: "Favourites",
      createdAt: "2026-11-01T00:00:00.000Z",
      kind: "playlist",
      schedule: { every: "hour" },
      target: { type: "favourites" },
      tidy: { upgrade: {} },
    });
    const { deps, order } = setup([reader, feed, favourites], {
      states: {
        aaaaaaaa: { nextRunAt: "2026-11-02T04:00:00.000Z", playlistId: 20 },
        bbbbbbbb: { nextRunAt: "2026-11-02T05:00:00.000Z", playlistId: 10 },
        cccccccc: { nextRunAt: "2026-11-02T05:30:00.000Z", favouriteDates: [{ trackId: 2, at: "2019-01-01T00:00:00.000Z" }] },
      },
    });
    await runDue(deps, NOW);
    expect(order).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
    const options = deps.refresh.mock.calls.map((call) => call[3]);
    expect(options[0]?.favouriteDates).toEqual(new Map([[2, "2019-01-01T00:00:00.000Z"]]));
    expect(options[2]?.favouriteDates).toBeUndefined();
  });
});

describe("acceptNow", () => {
  it("is busy while another runner holds the lock", async () => {
    const { deps, lockPath } = setup([job("aaaaaaaa")]);
    const held = tryAcquireLock(lockPath, { isAlive: () => true });
    expect(await acceptNow(deps, "aaaaaaaa", "all", NOW)).toMatchObject({ status: "busy" });
    held?.release();
  });

  it("says when the session needs a sign-in", async () => {
    const { deps } = setup([job("aaaaaaaa")]);
    deps.connect.mockResolvedValueOnce({ ok: false, reason: "needs-sign-in", message: "expired" } as never);
    expect(await acceptNow(deps, "aaaaaaaa", "all", NOW)).toEqual({ status: "needs-sign-in", message: "expired" });
  });
});
