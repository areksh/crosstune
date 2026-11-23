import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileLinkStore } from "./link-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qh-links-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "links.json");
const link = {
  id: "aaaaaaaa",
  name: "Mine",
  createdAt: "2026-11-02T10:00:00Z",
  copies: { qobuz: "qobuz:1", tidal: "tidal:2" },
  schedule: { every: "hour" },
};

describe("fileLinkStore", () => {
  it("loads nothing from a missing file", () => {
    expect(fileLinkStore(dir).load()).toEqual({ links: [], invalid: [] });
  });

  it("loads the valid links of a file", () => {
    writeFileSync(file(), JSON.stringify({ version: 1, links: [link] }));
    const { links, invalid } = fileLinkStore(dir).load();
    expect(links.map((l) => l.id)).toEqual(["aaaaaaaa"]);
    expect(invalid).toEqual([]);
  });

  it("refuses a file that is not JSON", () => {
    writeFileSync(file(), "{nope");
    expect(() => fileLinkStore(dir).load()).toThrow(/cannot be read.*fix or remove it/);
  });

  it.each(["null", "5", '"x"', '{"links":5}', '{"links":{}}'])(
    "refuses %s with the same error, not a TypeError",
    (text) => {
      writeFileSync(file(), text);
      expect(() => fileLinkStore(dir).load()).toThrow(/cannot be read.*fix or remove it/);
      expect(() => fileLinkStore(dir).save([])).toThrow(/cannot be read.*fix or remove it/);
      expect(readFileSync(file(), "utf8")).toBe(text); // never overwritten
    },
  );

  it("saves owner-only and round-trips, keeping links it cannot read for a hand fix", () => {
    writeFileSync(file(), JSON.stringify({ version: 1, links: [link, { id: "broken" }] }));
    const store = fileLinkStore(dir);
    const { links } = store.load();
    store.save(links.map((l) => ({ ...l, name: "Renamed" })));
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file(), "utf8")) as { links: unknown[] };
    expect(saved.links).toHaveLength(2);
    expect(saved.links[1]).toEqual({ id: "broken" });
    expect(fileLinkStore(dir).load().links[0]?.name).toBe("Renamed");
  });
});
