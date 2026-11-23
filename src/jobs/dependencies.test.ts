import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { emptyJobState, validateJob, type Job } from "./model.js";
import { conflictWith, runOrder } from "./dependencies.js";

function job(id: string, raw: Record<string, unknown>): Job {
  return validateJob({
    id,
    name: `Job ${id.slice(0, 1)}`,
    createdAt: "2026-11-02T00:00:00.000Z",
    kind: "playlist",
    schedule: { every: "day" },
    ...raw,
  });
}

const follow = (playlist: number) => ({ type: "follow", playlistId: qid(playlist) });
const withState = (j: Job, playlist?: number) => ({
  job: j,
  state: { ...emptyJobState(), ...(playlist !== undefined && { playlistId: qid(playlist) }) },
});

describe("runOrder", () => {
  it("runs a job after the one managing a playlist it reads", () => {
    const reader = withState(job("aaaaaaaa", { target: { type: "created" }, source: follow(10) }), 20);
    const feed = withState(job("bbbbbbbb", { target: { type: "created" }, source: follow(99) }), 10);
    const other = withState(job("cccccccc", { target: { type: "adopted", playlistId: 30 }, tidy: { dedupe: {} } }));
    expect(runOrder([reader, other, feed]).map((item) => item.job.id)).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
  });

  it("runs a favourites tidy-up before a source that reads the favourites", () => {
    const smart = withState(
      job("aaaaaaaa", {
        target: { type: "created" },
        source: { type: "smart", from: [{ type: "favourites" }], rules: [{ type: "quality", quality: "hires" }] },
      }),
      20,
    );
    const favourites = withState(job("bbbbbbbb", { target: { type: "favourites" }, tidy: { upgrade: {} } }));
    expect(runOrder([smart, favourites]).map((item) => item.job.id)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
  });
});

describe("conflictWith", () => {
  it("refuses a second job on the same playlist", () => {
    const existing = withState(job("aaaaaaaa", { target: { type: "created" }, source: follow(5) }), 10);
    const adopting = withState(job("bbbbbbbb", { target: { type: "adopted", playlistId: 10 }, tidy: { dedupe: {} } }));
    expect(conflictWith(adopting, [existing])).toMatch(/already managed by "Job a"/);
    expect(conflictWith(existing, [existing])).toBeUndefined();
  });

  it("refuses a second favourites job", () => {
    const a = withState(job("aaaaaaaa", { target: { type: "favourites" }, tidy: { dedupe: {} } }));
    const b = withState(job("bbbbbbbb", { target: { type: "favourites" }, tidy: { upgrade: {} } }));
    expect(conflictWith(b, [a])).toMatch(/favourites/);
  });

  it("refuses a chain of sources leading back to the playlist", () => {
    const a = withState(job("aaaaaaaa", { target: { type: "adopted", playlistId: 1 }, source: follow(2) }));
    const b = withState(job("bbbbbbbb", { target: { type: "adopted", playlistId: 2 }, source: follow(1) }));
    expect(conflictWith(b, [a])).toMatch(/read back its own playlist through "Job a"/);
  });
});
