import { describe, expect, it, vi } from "vitest";

import { MemoryMatches } from "../features/match.js";
import type { ServiceName, TrackId } from "../services/ids.js";
import { emptyLinkState, type LinkState } from "./model.js";
import type { Link } from "./runner.js";
import { linksService } from "./service.js";
import { SyncAccount } from "./world.test-support.js";

const NOW = new Date("2026-11-23T12:00:00Z");

function setup() {
  const accounts = new Map<ServiceName, SyncAccount>(["qobuz", "tidal"].map((name) => [name as ServiceName, new SyncAccount(name as ServiceName)]));
  let file: Link[] = [];
  const states = new Map<string, LinkState>();
  const matches = new MemoryMatches();
  let entry = 0;
  let locked = 0;
  const service = linksService({
    links: { load: () => ({ links: file, invalid: [] }), save: (links) => void (file = links) },
    state: {
      load: (id) => states.get(id) ?? emptyLinkState(),
      save: (id, state) => {
        if (locked === 0) {
          throw new Error("a link's state written without the lock");
        }
        states.set(id, state);
      },
      remove: (id) => void states.delete(id),
    },
    runs: { append: () => {}, read: () => [] },
    matches,
    connect: async (services) => ({ ok: true, clients: new Map(services.map((name) => [name, accounts.get(name)!])) }),
    journalRun: async (_label, fn) => fn({ id: `e${++entry}` }),
    lock: async (fn) => {
      locked += 1;
      try {
        return await fn();
      } finally {
        locked -= 1;
      }
    },
    newId: () => "abcdef01",
    now: () => NOW,
  });
  const q = accounts.get("qobuz")!;
  const t = accounts.get("tidal")!;
  return { service, states, matches, q, t, file: () => file };
}

describe("linksService", () => {
  it("creates a link, syncing it once", async () => {
    const { service, q, t } = setup();
    const a = q.seed("Mix", [1, 2]);
    const b = t.seed("Mix", [1, 2]);
    const { link, summary } = await service.create({ name: "Mix", copies: { qobuz: a, tidal: b }, schedule: { every: "day" } });
    expect(link).toMatchObject({ id: "abcdef01", name: "Mix" });
    expect(summary.reports[0]?.result.status).toBe("ok");
    expect(service.list().links[0]?.state.base?.songs).toHaveLength(2);
  });

  it("refuses a playlist that is already in a link", async () => {
    const { service, q, t } = setup();
    const a = q.seed("Mix", [1]);
    await service.create({ name: "Mix", copies: { qobuz: a, tidal: t.seed("Mix", [1]) } });
    await expect(service.create({ name: "Again", copies: { qobuz: a, tidal: t.seed("Other", [1]) } })).rejects.toThrow(/already/);
  });

  it("settles a first link that differs by merging, then keeps it so", async () => {
    const { service, q, t } = setup();
    const a = q.seed("Mix", [1, 2]);
    const b = t.seed("Mix", [1, 3]);
    const { summary } = await service.create({ name: "Mix", copies: { qobuz: a, tidal: b } });
    expect(summary.conflicts).toBe(1);
    const preview = await service.resolve("abcdef01", { merge: "qobuz" }, true);
    expect(q.songs(a)).toEqual([1, 2]);
    expect(preview.changes.length).toBeGreaterThan(0);
    await service.resolve("abcdef01", { merge: "qobuz" }, false);
    expect(q.songs(a)).toEqual(t.songs(b));
    expect(new Set(q.songs(a))).toEqual(new Set([1, 2, 3]));
  });

  it("takes an answer to a question and runs again", async () => {
    const { service, q, t, states } = setup();
    const a = q.seed("Mix", [1, 2, 3]);
    const b = t.seed("Mix", [1, 2, 3]);
    await service.create({ name: "Mix", copies: { qobuz: a, tidal: b } });
    t.knowsAvailability = false;
    t.edit(b, (songs) => songs.filter((n) => n !== 2));
    await service.run("abcdef01");
    const [question] = states.get("abcdef01")!.questions;
    expect(question?.kind).toBe("removed-or-withdrawn");
    await service.answer("abcdef01", question!.key, "removed");
    expect(q.songs(a)).toEqual([1, 3]);
  });

  it("takes a chosen match, remembered for next time", async () => {
    const { service, q, t, matches } = setup();
    const a = q.seed("Mix", [1]);
    const b = t.seed("Mix", [1]);
    await service.create({ name: "Mix", copies: { qobuz: a, tidal: b } });
    t.findByIsrc = async () => new Map();
    q.edit(a, (songs) => [...songs, 9]);
    await service.run("abcdef01");
    const state = service.list().links[0]!.state;
    const question = state.questions.find((one) => one.kind === "match")!;
    await service.chooseMatch("abcdef01", question.key, "tidal:9" as TrackId);
    expect(matches.recall("qobuz:9" as TrackId, "tidal")).toBe("tidal:9");
    expect(t.songs(b)).toEqual([1, 9]);
  });

  it("pauses, resumes through a check, and removes without touching the playlists", async () => {
    const { service, q, t, states, file } = setup();
    const a = q.seed("Mix", [1]);
    await service.create({ name: "Mix", copies: { qobuz: a, tidal: t.seed("Mix", [1]) } });
    await service.setEnabled("abcdef01", false);
    expect(file()[0]?.enabled).toBe(false);
    states.set("abcdef01", { ...states.get("abcdef01")!, paused: { since: "x", reason: "undone" } });
    await service.setEnabled("abcdef01", true);
    // Resuming after an undo looks at the copies afresh, as a first link.
    expect(states.get("abcdef01")).not.toHaveProperty("paused");
    expect(states.get("abcdef01")).not.toHaveProperty("base");
    await service.remove("abcdef01");
    expect([file(), states.size, q.songs(a)]).toEqual([[], 0, [1]]);
  });

  it("pauses a link whose sync was undone, and not for others", async () => {
    const { service, q, t, states } = setup();
    const a = q.seed("Mix", [1]);
    await service.create({ name: "Mix", copies: { qobuz: a, tidal: t.seed("Mix", [1]) } });
    q.edit(a, (songs) => [...songs, 2]);
    await service.run("abcdef01");
    expect(await service.undone("nope")).toEqual([]);
    expect(await service.undone("e2")).toEqual(["abcdef01"]);
    expect(states.get("abcdef01")?.paused?.reason).toBe("undone");
  });

  it("pauses a link when the settling of its conflict is undone", async () => {
    const { service, q, t, states } = setup();
    await service.create({ name: "Mix", copies: { qobuz: q.seed("Mix", [1, 2]), tidal: t.seed("Mix", [1, 3]) } });
    await service.resolve("abcdef01", { merge: "qobuz" }, false);
    expect(await service.undone("e2")).toEqual(["abcdef01"]);
    expect(states.get("abcdef01")?.paused?.reason).toBe("undone");
  });

  it("refuses ids it does not know", async () => {
    const { service } = setup();
    await expect(service.run("ffffffff")).rejects.toThrow(/No link/);
    await expect(service.create({ name: "", copies: {} })).rejects.toThrow();
  });
});
