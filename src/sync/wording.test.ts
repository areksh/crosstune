import { describe, expect, it } from "vitest";

import type { RunResultSummary } from "../jobs/model.js";
import type { TrackId } from "../services/ids.js";
import { emptyLinkState, type Conflict, type LinkState } from "./model.js";
import {
  andList,
  attentionBadge,
  attentionLines,
  describeChange,
  describeConflict,
  describeLinkResult,
  describeLinksSummary,
  describeQuestion,
  describeSide,
  fixFor,
  linkAttention,
  linkMark,
} from "./wording.js";

const song = (title: string, artist?: string) => ({ title, id: `qobuz:${title}` as TrackId, ...(artist !== undefined && { artist }) });

const result = (over: Partial<RunResultSummary>): RunResultSummary => ({
  at: "2026-11-23T10:00:00Z",
  status: "ok",
  added: 0,
  removed: 0,
  dismissed: 0,
  notes: [],
  ...over,
});

describe("describeConflict", () => {
  it.each<[Conflict, string]>([
    [
      { kind: "removed-and-changed", song: song("Blue", "Joni"), removedOn: "qobuz", changedOn: "tidal", change: "moved" },
      "Removed on Qobuz but moved on TIDAL: Blue by Joni.",
    ],
    [
      { kind: "removed-and-changed", song: song("Blue"), removedOn: "spotify", changedOn: "qobuz", change: "duplicated" },
      "Removed on Spotify but added again on Qobuz: Blue.",
    ],
    [{ kind: "reordered", services: ["qobuz", "tidal"] }, "Reordered differently on Qobuz and TIDAL."],
    [{ kind: "reordered", services: ["qobuz", "tidal", "spotify"] }, "Reordered differently on Qobuz, TIDAL and Spotify."],
    [
      { kind: "renamed", names: [{ service: "qobuz", name: "A" }, { service: "tidal", name: "B" }] },
      "Renamed differently: A (Qobuz), B (TIDAL).",
    ],
    [{ kind: "gone", service: "tidal" }, "The TIDAL copy was deleted, or can no longer be read."],
    [{ kind: "not-editable", service: "spotify" }, "The Spotify copy can no longer be edited by you."],
    [{ kind: "many-removed", service: "spotify", removed: 12, of: 40 }, "Many songs were removed from the Spotify copy (12 of 40)."],
    [{ kind: "many-removed", service: "tidal", removed: 40, of: 40 }, "The TIDAL copy was emptied (all 40 songs removed)."],
    [{ kind: "interrupted", service: "tidal" }, "A sync was cut off and the TIDAL copy changed meanwhile."],
    [{ kind: "first-link" }, "The copies differ; choose how to start."],
  ])("words %o", (conflict, text) => {
    expect(describeConflict(conflict)).toBe(text);
  });
});

describe("fixFor", () => {
  it("offers only unlinking when a copy is gone or read-only", () => {
    expect(fixFor([{ kind: "reordered", services: ["qobuz", "tidal"] }, { kind: "gone", service: "tidal" }, { kind: "gone", service: "tidal" }])).toEqual({
      kind: "unlink",
      services: ["tidal"],
    });
    expect(fixFor([{ kind: "not-editable", service: "spotify" }])).toEqual({ kind: "unlink", services: ["spotify"] });
  });

  it("offers choosing, and starting from what they share for a first link", () => {
    expect(fixFor([{ kind: "reordered", services: ["qobuz", "tidal"] }])).toEqual({ kind: "choose", fromCommon: false });
    expect(fixFor([{ kind: "first-link" }])).toEqual({ kind: "choose", fromCommon: true });
  });
});

describe("describeQuestion", () => {
  it("asks whether a song was removed or withdrawn", () => {
    expect(describeQuestion({ kind: "removed-or-withdrawn", key: "k", song: song("Blue", "Joni"), service: "spotify" })).toEqual({
      text: "Was Blue by Joni removed from Spotify by you?",
      detail: "Spotify cannot say whether it stopped offering it. Until you answer, the other copies keep it.",
    });
  });

  it("asks whether a song matching several elsewhere goes there too", () => {
    expect(describeQuestion({ kind: "which-was-removed", key: "k", songs: [song("A"), song("A (Live)"), song("A (Remaster)")], service: "tidal" })).toEqual({
      text: "A was removed from TIDAL. Remove it from the other copies too?",
      detail: "There it matches more than one song: A (Live) and A (Remaster).",
    });
  });

  it("asks which song is the match, with the reason", () => {
    expect(describeQuestion({ kind: "match", key: "k", song: song("Blue"), on: "tidal", options: [], reason: "two versions" })).toEqual({
      text: "Which TIDAL song is Blue?",
      detail: "two versions",
    });
    expect(describeQuestion({ kind: "match", key: "k", song: song("Blue"), on: "tidal", options: [] })).toEqual({ text: "Which TIDAL song is Blue?" });
  });

  it("explains a repeated song", () => {
    expect(describeQuestion({ kind: "repeated", key: "k", song: song("Blue"), service: "spotify" }).detail).toBe(
      "Spotify can only remove one copy of a repeated song by removing them all and adding the others back.",
    );
  });
});

describe("describeChange", () => {
  it("counts what is written to a copy", () => {
    expect(describeChange({ service: "tidal", added: 2, removed: 1, moved: true, renamed: true }, "tidal")).toBe(
      "TIDAL: 2 songs added, 1 song removed, reordered, renamed",
    );
    expect(describeChange({ service: "qobuz", added: 0, removed: 0, moved: false, renamed: false }, "qobuz")).toBe("Qobuz: no change");
    expect(describeChange(undefined, "spotify")).toBe("Spotify: no change");
  });
});

describe("describeLinkResult and describeLinksSummary", () => {
  it("words a run", () => {
    expect(describeLinkResult(result({ added: 3, removed: 1, notes: ["1 song(s) wait for an answer"] }))).toBe(
      "synced: 3 songs added, 1 song removed; 1 song(s) wait for an answer",
    );
    expect(describeLinkResult(result({}))).toBe("synced: no changes");
    expect(describeLinkResult(result({ status: "conflict" }))).toBe("stopped: the copies disagree");
    expect(describeLinkResult(result({ status: "failed", error: "offline" }))).toBe("failed: offline");
  });

  it("words a run now", () => {
    const report = (over: Partial<RunResultSummary>) => ({ reports: [{ jobId: "a", name: "A", result: result(over) }], conflicts: 0 });
    expect(describeLinksSummary(report({ added: 1 }))).toBe("Synced: 1 song added.");
    expect(describeLinksSummary(report({ status: "failed", error: "offline" }))).toBe("Sync failed: offline.");
    expect(describeLinksSummary(report({ status: "conflict" }))).toMatch(/^Not synced: the copies disagree/);
    expect(describeLinksSummary({ reports: [], conflicts: 0, blocked: { service: "tidal", message: "sign in" } })).toBe(
      "Not synced: TIDAL needs you (sign in).",
    );
    expect(describeLinksSummary({ reports: [], conflicts: 0 })).toBe("Nothing was synced.");
  });
});

describe("attention", () => {
  const state = (over: Partial<LinkState>): { state: LinkState } => ({ state: { ...emptyLinkState(), ...over } });
  const question = { kind: "repeated", key: "k", song: song("A"), service: "spotify" } as const;

  it("is nothing while every link is in sync", () => {
    const attention = linkAttention([state({}), state({})]);
    expect(attentionLines(attention)).toEqual([]);
    expect(attentionBadge(attention)).toBeUndefined();
  });

  it("is urgent for conflicts, quieter for questions", () => {
    const attention = linkAttention([
      state({ conflicts: [{ kind: "first-link" }] }),
      state({ conflicts: [{ kind: "gone", service: "tidal" }], questions: [question] }),
      state({ questions: [question, question] }),
    ]);
    expect(attention).toEqual({ conflicted: 2, questions: 3, links: 3 });
    expect(attentionLines(attention)).toEqual([
      { text: "2 linked playlists need you: their copies disagree, and nothing is synced until you choose.", urgent: true },
      { text: "3 songs in linked playlists wait for your answer; the rest is synced.", urgent: false },
    ]);
    expect(attentionBadge(attention)).toEqual({ count: 3, text: "3 need you", urgent: true });
  });

  it("words one of each", () => {
    const attention = linkAttention([state({ conflicts: [{ kind: "first-link" }] }), state({ questions: [question] })]);
    expect(attentionLines(attention).map((line) => line.text)).toEqual([
      "1 linked playlist needs you: its copies disagree, and nothing is synced until you choose.",
      "1 song in linked playlists waits for your answer; the rest is synced.",
    ]);
    expect(attentionBadge(linkAttention([state({ questions: [question] })]))).toEqual({ count: 1, text: "1 need you", urgent: false });
  });
});

describe("andList", () => {
  it("joins", () => {
    expect(andList([])).toBe("");
    expect(andList(["A"])).toBe("A");
    expect(andList(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("describeSide", () => {
  const side = { service: "qobuz" as const, name: "Mix", songs: 3, renamed: false, reordered: false, added: [], removed: [] };

  it("titles a copy with its name and song count, and says when nothing changed", () => {
    expect(describeSide(side, "last-sync")).toEqual({ title: "Qobuz: Mix, 3 songs", lines: ["No change since the last sync."] });
  });

  it("lists what was added and removed, and a rename or reorder", () => {
    const changed = { ...side, renamed: true, reordered: true, added: [song("A", "X")], removed: [song("B"), song("C")] };
    expect(describeSide(changed, "last-sync")).toEqual({
      title: "Qobuz: Mix, 3 songs",
      lines: ["Renamed.", "Reordered.", "Added 1 song: A by X.", "Removed 2 songs: B, C."],
    });
  });

  // Against what all copies share, a song two of three have is not "only here".
  it("says what is not on every copy, for a first link of three or more", () => {
    expect(describeSide({ ...side, added: [song("A")] }, "in-common", 3).lines).toEqual(["Not on every copy: A."]);
  });

  it("says what only it has, for a first link", () => {
    expect(describeSide({ ...side, added: [song("A")] }, "in-common").lines).toEqual(["Only here: A."]);
    expect(describeSide(side, "in-common").lines).toEqual(["Nothing that the others do not have."]);
  });

  it("names the first songs of a long list and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, n) => song(`S${n}`));
    expect(describeSide({ ...side, added: many }, "last-sync").lines[0]).toBe(
      "Added 12 songs: S0, S1, S2, S3, S4, S5, S6, S7, S8, S9 and 2 more.",
    );
  });
});

describe("linkMark", () => {
  const view = (copies: Record<string, string>, conflicts: Conflict[] = []) => ({
    link: { id: "abcdef01", name: "Mix", copies },
    state: { ...emptyLinkState(), conflicts },
  });

  it("marks a playlist that is a copy, naming the others", () => {
    expect(linkMark("qobuz:1", [view({ qobuz: "qobuz:1", spotify: "spotify:x" })])).toEqual({
      text: "Linked with Spotify",
      conflict: false,
    });
  });

  it("marks a copy whose link is in conflict loudly", () => {
    expect(linkMark("spotify:x", [view({ qobuz: "qobuz:1", spotify: "spotify:x" }, [{ kind: "first-link" }])])).toEqual({
      text: "Linked with Qobuz: the copies disagree",
      conflict: true,
    });
  });

  it("leaves other playlists unmarked", () => {
    expect(linkMark("qobuz:2", [view({ qobuz: "qobuz:1", spotify: "spotify:x" })])).toBeUndefined();
  });
});
