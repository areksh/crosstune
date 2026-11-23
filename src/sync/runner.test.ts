import { describe, expect, it, vi } from "vitest";

import { MemoryMatches } from "../features/match.js";
import { ServiceError } from "../services/errors.js";
import type { ServiceName } from "../services/ids.js";
import { emptyLinkState, type LinkState } from "./model.js";
import { parseLinksFile, pausedByUndo, runLinks, validateLink, type Link, type LinksDeps } from "./runner.js";
import { SyncAccount } from "./world.test-support.js";

const NOW = new Date("2026-11-23T12:00:00Z");

function setup(names: ServiceName[] = ["qobuz", "tidal"]) {
  const accounts = new Map(names.map((name) => [name, new SyncAccount(name)]));
  const link = validateLink({
    id: "aaaaaaaa",
    name: "Mix",
    createdAt: NOW.toISOString(),
    copies: Object.fromEntries(names.map((name) => [name, accounts.get(name)!.seed("Mix", [1, 2])])),
    schedule: { every: "hour" },
  });
  const states = new Map<string, LinkState>();
  const runs: unknown[] = [];
  const entries: string[] = [];
  const deps: LinksDeps = {
    links: { load: () => ({ links: [link], invalid: [] }) },
    state: {
      load: (id) => states.get(id) ?? emptyLinkState(),
      save: (id, state) => void states.set(id, state),
    },
    runs: { append: (record) => void runs.push(record) },
    matches: new MemoryMatches(),
    connect: vi.fn(async (services: readonly ServiceName[]) => ({
      ok: true as const,
      clients: new Map(services.map((name) => [name, accounts.get(name)!])),
    })),
    journalRun: async (_label, fn) => {
      entries.push(`e${entries.length + 1}`);
      return fn({ id: entries[entries.length - 1]! });
    },
  };
  return { accounts, link, states, runs, deps, entries };
}

describe("validateLink", () => {
  it("takes playlists on two or more services, each the user's id", () => {
    expect(() => validateLink({ id: "aaaaaaaa", name: "X", createdAt: "x", copies: { qobuz: "qobuz:1" }, schedule: { every: "hour" } })).toThrow(/two/);
    expect(() =>
      validateLink({ id: "aaaaaaaa", name: "X", createdAt: "x", copies: { qobuz: "tidal:1", tidal: "tidal:2" }, schedule: { every: "hour" } }),
    ).toThrow(/qobuz/);
    expect(validateLink({ id: "aaaaaaaa", name: "X", createdAt: "x", copies: { qobuz: 5, tidal: "tidal:2" }, schedule: { every: "day" } }).copies).toEqual({
      qobuz: "qobuz:5",
      tidal: "tidal:2",
    });
  });

  it("reads a file, keeping the valid links and reporting the others", () => {
    const { links, invalid } = parseLinksFile({ version: 1, links: [{ id: "x" }, { id: "aaaaaaaa", name: "X", createdAt: "x", copies: { qobuz: 1, tidal: "tidal:2" }, schedule: { every: "hour" } }] });
    expect(links).toHaveLength(1);
    expect(invalid).toHaveLength(1);
  });
});

describe("runLinks", () => {
  it("syncs what is due, as one history entry, and schedules the next", async () => {
    const { deps, states, accounts, runs, link } = setup();
    await runLinks(deps, NOW); // first link: equal copies
    accounts.get("qobuz")!.edit(link.copies.qobuz!, (songs) => [...songs, 3]);
    const summary = await runLinks(deps, new Date(NOW.getTime() + 3_600_000));
    expect(accounts.get("tidal")!.songs(link.copies.tidal!)).toEqual([1, 2, 3]);
    expect(summary.reports[0]).toMatchObject({ jobId: "aaaaaaaa", result: { status: "ok", added: 1 } });
    expect(states.get("aaaaaaaa")).toMatchObject({ nextRunAt: "2026-11-23T14:00:00.000Z", entries: ["e2"] });
    expect(runs).toHaveLength(2);
  });

  it("does not run what is not due, or paused", async () => {
    const { deps, states } = setup();
    states.set("aaaaaaaa", { ...emptyLinkState(), nextRunAt: "2026-11-23T13:00:00.000Z" });
    expect((await runLinks(deps, NOW)).reports).toEqual([]);
    states.set("aaaaaaaa", { ...emptyLinkState(), paused: { since: "x", reason: "undone" } });
    expect((await runLinks(deps, NOW)).reports).toEqual([]);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("reports a conflict without counting a failure, and tries again at the next slot", async () => {
    const { deps, states, accounts, link } = setup();
    accounts.get("tidal")!.edit(link.copies.tidal!, () => [2]);
    const summary = await runLinks(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "conflict" });
    expect(summary.conflicts).toBe(1);
    expect(states.get("aaaaaaaa")).toMatchObject({ consecutiveFailures: 0, nextRunAt: "2026-11-23T13:00:00.000Z", conflicts: [{ kind: "first-link" }] });
  });

  it("backs off after a failure", async () => {
    const { deps, states, accounts, link } = setup();
    accounts.get("tidal")!.getPlaylistTracks = async () => {
      throw new ServiceError("tidal", "network", "offline");
    };
    const summary = await runLinks(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "failed", error: "offline" });
    expect(states.get("aaaaaaaa")).toMatchObject({ consecutiveFailures: 1, nextRunAt: "2026-11-23T12:15:00.000Z" });
    void link;
  });

  it("leaves a link whose service needs a sign-in, saying so", async () => {
    const { deps, states } = setup();
    deps.connect = vi.fn(async () => ({ ok: false as const, reason: "needs-sign-in" as const, message: "TIDAL expired", service: "tidal" as const }));
    const summary = await runLinks(deps, NOW);
    expect(summary).toMatchObject({ reports: [], blocked: { service: "tidal", message: "TIDAL expired" } });
    expect(states.get("aaaaaaaa")).toBeUndefined();
  });

  it("is paused by undoing one of its syncs", async () => {
    const { deps, states, accounts, link } = setup();
    await runLinks(deps, NOW);
    accounts.get("qobuz")!.edit(link.copies.qobuz!, (songs) => [...songs, 3]);
    await runLinks(deps, new Date(NOW.getTime() + 3_600_000));
    expect(pausedByUndo(deps, "nope", NOW)).toEqual([]);
    expect(pausedByUndo(deps, "e2", NOW)).toEqual(["aaaaaaaa"]);
    expect(states.get("aaaaaaaa")?.paused).toEqual({ since: NOW.toISOString(), reason: "undone" });
  });

  it("records only the syncs that wrote something, so a real one is not pushed out", async () => {
    const { deps, states, accounts, link } = setup();
    for (let hour = 0; hour < 25; hour += 1) {
      await runLinks(deps, new Date(NOW.getTime() + hour * 3_600_000));
    }
    expect(states.get("aaaaaaaa")?.entries ?? []).toEqual([]);
    accounts.get("tidal")!.rename(link.copies.tidal!, "A");
    accounts.get("qobuz")!.rename(link.copies.qobuz!, "B");
    await runLinks(deps, new Date(NOW.getTime() + 30 * 3_600_000));
    expect(states.get("aaaaaaaa")?.conflicts.length).toBeGreaterThan(0);
    expect(states.get("aaaaaaaa")?.entries ?? []).toEqual([]);
  });

  it("does not run a paused link, even when asked to run it now", async () => {
    const { deps, states } = setup();
    states.set("aaaaaaaa", { ...emptyLinkState(), paused: { since: "x", reason: "undone" } });
    expect((await runLinks(deps, NOW, { onlyLinkId: "aaaaaaaa" })).reports).toEqual([]);
  });

  it("reports a link whose state cannot be read, and goes on", async () => {
    const { deps } = setup();
    deps.state.load = () => {
      throw new Error("links-state/aaaaaaaa.json cannot be read");
    };
    const summary = await runLinks(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "failed", error: expect.stringMatching(/cannot be read/) });
  });

  it("backs off while a service cannot be reached", async () => {
    const { deps, states } = setup();
    deps.connect = vi.fn(async () => {
      throw new ServiceError("tidal", "network", "offline");
    });
    const summary = await runLinks(deps, NOW);
    expect(summary.reports[0]?.result).toMatchObject({ status: "failed", error: "offline" });
    expect(states.get("aaaaaaaa")).toMatchObject({ consecutiveFailures: 1, nextRunAt: "2026-11-23T12:15:00.000Z" });
  });

  it("runs one link now, due or not", async () => {
    const { deps, states } = setup();
    states.set("aaaaaaaa", { ...emptyLinkState(), nextRunAt: "2027-01-01T00:00:00.000Z" });
    expect((await runLinks(deps, NOW, { onlyLinkId: "aaaaaaaa" })).reports).toHaveLength(1);
  });
});
