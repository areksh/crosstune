import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tagId, type TrackId } from "../services/ids.js";
import { fileMatches } from "./match-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qh-matches-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const q = tagId<TrackId>("qobuz", 1);
const t = tagId<TrackId>("tidal", "x:1");

describe("fileMatches", () => {
  it("keeps matches, rejections included, owner-only, ids only", () => {
    const matches = fileMatches(dir);
    matches.remember(q, "tidal", t);
    matches.remember(q, "spotify", null);
    const again = fileMatches(dir);
    expect(again.recall(q, "tidal")).toBe(t);
    expect(again.recall(q, "spotify")).toBeNull();
    expect(again.recall(t, "qobuz")).toBeUndefined();
    expect(statSync(join(dir, "matches.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "matches.json"), "utf8"))).toEqual({
      version: 1,
      matches: { tidal: { "qobuz:1": "tidal:x:1" }, spotify: { "qobuz:1": null } },
    });
  });

  it("sees what another process remembered", () => {
    const a = fileMatches(dir);
    const b = fileMatches(dir);
    a.remember(q, "tidal", t);
    expect(b.recall(q, "tidal")).toBe(t);
    b.remember(q, "spotify", null);
    expect(a.recall(q, "tidal")).toBe(t);
    expect(fileMatches(dir).recall(q, "spotify")).toBeNull();
  });

  it("forgets one, or a service's both ways", () => {
    const matches = fileMatches(dir);
    matches.remember(q, "tidal", t);
    matches.remember(t, "qobuz", q);
    matches.remember(q, "spotify", null);
    matches.forgetService("tidal");
    expect(matches.recall(q, "tidal")).toBeUndefined();
    expect(matches.recall(t, "qobuz")).toBeUndefined();
    expect(matches.recall(q, "spotify")).toBeNull();
    matches.forget(q, "spotify");
    expect(matches.recall(q, "spotify")).toBeUndefined();
  });

  it("passes over entries that make no sense", () => {
    writeFileSync(
      join(dir, "matches.json"),
      JSON.stringify({ version: 1, matches: { tidal: { "qobuz:1": "spotify:2", nope: "tidal:1", "qobuz:3": 5 }, deezer: {} } }),
    );
    const matches = fileMatches(dir);
    expect(matches.recall(q, "tidal")).toBeUndefined();
    expect(matches.recall(tagId<TrackId>("qobuz", 3), "tidal")).toBeUndefined();
  });

  it("refuses to overwrite a file it cannot read", () => {
    writeFileSync(join(dir, "matches.json"), "{");
    expect(() => fileMatches(dir).remember(q, "tidal", t)).toThrow(/matches\.json/);
    expect(fileMatches(dir).recall(q, "tidal")).toBeUndefined();
  });
});
