import { describe, expect, it } from "vitest";

import { emptyJobState, type JobsFile, type JobState } from "./model.js";
import { jobsService, UnknownJobError } from "./service.js";
import type { GlobalFlags, RunRecord } from "./stores.js";

const NOW = new Date("2026-11-02T10:00:00.000Z");

const input = {
  name: "Fresh",
  kind: "managed-playlist",
  schedule: { every: "day" },
  recipe: {
    type: "new-releases",
    artists: { type: "list", artists: [{ id: 1, name: "Air" }] },
    similar: { perArtist: 2, refreshDays: 30 },
    window: { type: "last-days", days: 30 },
  },
};

function setup() {
  let file: JobsFile = { version: 1, jobs: [] };
  const states = new Map<string, JobState>();
  const runs: RunRecord[] = [];
  let flags: GlobalFlags = {};
  let n = 0;
  const service = jobsService({
    jobs: { load: () => ({ file, invalid: [] }), save: (f) => void (file = f) },
    state: {
      load: (id) => {
        const state = states.get(id);
        if ((state as unknown) === "unreadable") {
          throw new Error(`jobs-state/${id}.json cannot be read`);
        }
        return state ?? emptyJobState();
      },
      save: (id, s) => void states.set(id, s),
      remove: (id) => void states.delete(id),
    },
    runs: { append: (r) => void runs.push(r), read: (id) => runs.filter((r) => r.jobId === id).reverse() },
    global: { load: () => flags, save: (f) => void (flags = f) },
    newId: () => `0000000${++n}`,
  });
  return { service, states, file: () => file, runs };
}

describe("jobsService", () => {
  it("creates a job with an id and creation time, validated", () => {
    const { service, file } = setup();
    const job = service.create(input, NOW);
    expect(job).toMatchObject({ id: "00000001", createdAt: NOW.toISOString(), edits: "respect", enabled: true });
    expect(file().jobs).toEqual([job]);
    expect(() => service.create({ ...input, schedule: { every: "fortnight" } }, NOW)).toThrow(/every/);
  });

  it("ignores an id or creation time in the input", () => {
    const { service } = setup();
    const job = service.create({ ...input, id: "ffffffff", createdAt: "1999-01-01T00:00:00Z" }, NOW);
    expect(job.id).toBe("00000001");
    expect(job.createdAt).toBe(NOW.toISOString());
  });

  it("lists jobs with their state and recent runs", () => {
    const { service, runs } = setup();
    const job = service.create(input, NOW);
    runs.push({ at: "x", jobId: job.id, jobName: job.name, result: { at: "x", status: "ok", added: 1, removed: 0, dismissed: 0, notes: [] }, durationMs: 1 });
    const listed = service.list();
    expect(listed.jobs).toEqual([{ job, state: emptyJobState(), recentRuns: [runs[0]] }]);
    expect(listed.flags).toEqual({});
    expect(service.get(job.id)?.job).toEqual(job);
    expect(service.get("ffffffff")).toBeUndefined();
  });

  it("keeps the state when a job is edited", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    states.set(job.id, { ...emptyJobState(), playlistId: 5, owned: [{ playlistTrackId: 1, trackId: 2 }], dismissed: [3] });
    const updated = service.update(job.id, { ...input, name: "Renamed", recipe: { ...input.recipe, window: { type: "last-days", days: 60 } } });
    expect(updated).toMatchObject({ id: job.id, createdAt: job.createdAt, name: "Renamed" });
    expect(states.get(job.id)).toMatchObject({ playlistId: 5, dismissed: [3] });
  });

  it("forgets dismissed tracks when switching to mirror mode", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    states.set(job.id, { ...emptyJobState(), dismissed: [3] });
    service.update(job.id, { ...input, edits: "mirror" });
    expect(states.get(job.id)?.dismissed).toEqual([]);
  });

  it("drops the similar-artist snapshot when the artists change", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    const similar = { takenAt: "2026-11-01T00:00:00.000Z", artists: [{ id: 9, name: "Zero 7" }] };
    states.set(job.id, { ...emptyJobState(), similar });
    service.update(job.id, { ...input, name: "Same artists" });
    expect(states.get(job.id)?.similar).toEqual(similar);
    service.update(job.id, {
      ...input,
      recipe: { ...input.recipe, artists: { type: "list", artists: [{ id: 2, name: "Bonobo" }] } },
    });
    expect(states.get(job.id)?.similar).toBeUndefined();
  });

  it("pauses and resumes by enabling", () => {
    const { service } = setup();
    const job = service.create(input, NOW);
    expect(service.setEnabled(job.id, false).enabled).toBe(false);
    expect(service.setEnabled(job.id, true).enabled).toBe(true);
  });

  it("resumes a job whose playlist was deleted, to create a new one", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    states.set(job.id, {
      ...emptyJobState(),
      playlistId: 5,
      owned: [{ playlistTrackId: 1, trackId: 2 }],
      dismissed: [3],
      paused: { reason: "playlist-deleted", since: "x" },
      nextRunAt: "2026-12-01T00:00:00.000Z",
    });
    const state = service.resume(job.id);
    expect(state.paused).toBeUndefined();
    expect(state.playlistId).toBeUndefined();
    expect(state.owned).toEqual([]);
    expect(state.nextRunAt).toBeUndefined();
    expect(state.dismissed).toEqual([3]);
  });

  it("resumes a job the user paused without forgetting its playlist", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    const before = { ...emptyJobState(), playlistId: 5, owned: [{ playlistTrackId: 1, trackId: 2 }], nextRunAt: "x" };
    states.set(job.id, before);
    expect(service.resume(job.id)).toEqual(before);
  });

  it("lists a job whose state cannot be read, saying so", () => {
    const { service, states } = setup();
    const job = service.create(input, NOW);
    states.set(job.id, "unreadable" as never);
    const listed = service.list();
    expect(listed.jobs[0]).toMatchObject({ job: { id: job.id }, stateError: expect.stringMatching(/cannot be read/) });
  });

  it("removes a job and its state, saying which playlist it managed", () => {
    const { service, states, file } = setup();
    const job = service.create(input, NOW);
    states.set(job.id, { ...emptyJobState(), playlistId: 5 });
    expect(service.remove(job.id)).toEqual({ job, playlistId: 5 });
    expect(file().jobs).toEqual([]);
    expect(states.has(job.id)).toBe(false);
  });

  it("throws UnknownJobError for an unknown id", () => {
    const { service } = setup();
    expect(() => service.update("ffffffff", input)).toThrow(UnknownJobError);
    expect(() => service.setEnabled("ffffffff", true)).toThrow(/No job ffffffff/);
    expect(() => service.resume("ffffffff")).toThrow(UnknownJobError);
    expect(() => service.remove("ffffffff")).toThrow(UnknownJobError);
  });
});
