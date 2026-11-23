import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { emptyJobState, validateJob, type RunResultSummary } from "../jobs/model.js";
import { configDir } from "./config-dir.js";
import {
  fileGlobalStore,
  fileJobStateStore,
  fileJobStore,
  fileRunLog,
  JobsFileError,
  JobStateError,
  type RunRecord,
} from "./job-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qh-jobs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const job = validateJob({
  id: "a1b2c3d4",
  name: "Fresh",
  createdAt: "2026-11-02T10:00:00.000Z",
  kind: "managed-playlist",
  schedule: { every: "day" },
  recipe: {
    type: "new-releases",
    artists: { type: "favourites" },
    window: { type: "last-days", days: 30 },
  },
});

describe("configDir", () => {
  it("honours XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/crosstune");
  });
});

describe("fileJobStore", () => {
  it("round-trips jobs.json, owner-only", () => {
    const store = fileJobStore(dir);
    store.save({ version: 3, jobs: [job] });
    expect(store.load()).toEqual({ file: { version: 3, jobs: [job] }, invalid: [] });
    expect(statSync(join(dir, "jobs.json")).mode & 0o777).toBe(0o600);
  });

  it("loads an empty list when there is no file", () => {
    expect(fileJobStore(dir).load()).toEqual({ file: { version: 3, jobs: [] }, invalid: [] });
  });

  it("throws on an unparsable file and refuses to overwrite it", () => {
    writeFileSync(join(dir, "jobs.json"), "{ not json");
    const store = fileJobStore(dir);
    expect(() => store.load()).toThrow(JobsFileError);
    expect(() => store.save({ version: 3, jobs: [job] })).toThrow(JobsFileError);
    expect(readFileSync(join(dir, "jobs.json"), "utf8")).toBe("{ not json");
  });

  it("keeps invalid jobs, as they were, when saving the valid ones", () => {
    const broken = { ...job, id: "bbbbbbbb", schedule: { every: "never" } };
    writeFileSync(join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: [job, broken] }));
    const store = fileJobStore(dir);
    store.save({ version: 3, jobs: [{ ...job, name: "Renamed" }] });
    const raw = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
    expect(raw.jobs).toEqual([{ ...job, name: "Renamed" }, broken]);
    expect(store.load().invalid).toHaveLength(1);
  });

  it("reports an invalid job and keeps the others", () => {
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({ version: 1, jobs: [job, { ...job, id: "bbbbbbbb", schedule: { every: "never" } }] }),
    );
    const { file, invalid } = fileJobStore(dir).load();
    expect(file.jobs).toEqual([job]);
    expect(invalid).toHaveLength(1);
  });
});

describe("fileJobStateStore", () => {
  it("round-trips a state and loads the empty state when missing", () => {
    const store = fileJobStateStore(dir);
    expect(store.load("a1b2c3d4")).toEqual(emptyJobState());
    const state = { ...emptyJobState(), playlistId: qid(9), dismissed: [qid(3)] };
    store.save("a1b2c3d4", state);
    expect(store.load("a1b2c3d4")).toEqual(state);
    expect(statSync(join(dir, "jobs-state", "a1b2c3d4.json")).mode & 0o777).toBe(0o600);
    store.remove("a1b2c3d4");
    expect(store.load("a1b2c3d4")).toEqual(emptyJobState());
  });

  it("refuses a corrupt state file rather than starting over", () => {
    const store = fileJobStateStore(dir);
    store.save("a1b2c3d4", emptyJobState());
    writeFileSync(join(dir, "jobs-state", "a1b2c3d4.json"), "{");
    expect(() => store.load("a1b2c3d4")).toThrow(JobStateError);
  });
});

const result: RunResultSummary = { at: "", status: "ok", added: 1, removed: 0, dismissed: qid(0), notes: [] };
const record = (jobId: string, at: string): RunRecord => ({ at, jobId, jobName: jobId, result, durationMs: 5 });

describe("fileRunLog", () => {
  it("reads records newest first, filtered by job", () => {
    const log = fileRunLog(dir);
    log.append(record("a", "2026-11-01T00:00:00.000Z"));
    log.append(record("b", "2026-11-02T00:00:00.000Z"));
    log.append(record("a", "2026-11-03T00:00:00.000Z"));
    expect(log.read("a").map((r) => r.at)).toEqual(["2026-11-03T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(log.read(undefined, 1).map((r) => r.jobId)).toEqual(["a"]);
  });

  it("keeps the last 500 records and none older than 90 days", () => {
    const log = fileRunLog(dir);
    const now = new Date("2026-11-02T00:00:00.000Z");
    log.append(record("old", "2026-07-01T00:00:00.000Z"), now);
    for (let i = 0; i < 505; i += 1) {
      log.append(record("x", new Date(now.getTime() - (505 - i) * 1000).toISOString()), now);
    }
    const all = log.read();
    expect(all).toHaveLength(500);
    expect(all.some((r) => r.jobId === "old")).toBe(false);
  });

  it("skips unreadable lines", () => {
    const log = fileRunLog(dir);
    log.append(record("a", "2026-11-01T00:00:00.000Z"));
    appendFileSync(join(dir, "jobs-runs.jsonl"), "garbage\n");
    expect(log.read()).toHaveLength(1);
  });
});

describe("fileGlobalStore", () => {
  it("round-trips the flags", () => {
    const store = fileGlobalStore(dir);
    expect(store.load()).toEqual({});
    store.save({ needsSignIn: { since: "2026-11-02T00:00:00.000Z", message: "expired" } });
    expect(store.load()).toEqual({ needsSignIn: { since: "2026-11-02T00:00:00.000Z", message: "expired" } });
  });
});
