import { describe, expect, it } from "vitest";

import { createOutput, extractJsonFlag, logSinksFor, omitKeys, toJson } from "./output.js";

describe("extractJsonFlag", () => {
  it("pulls --json out from anywhere in the arguments", () => {
    expect(extractJsonFlag(["--json", "stats", "--favourites"])).toEqual({
      json: true,
      rest: ["stats", "--favourites"],
    });
    expect(extractJsonFlag(["deduplicate", "--favourites", "--json"])).toEqual({
      json: true,
      rest: ["deduplicate", "--favourites"],
    });
  });

  it("is off when absent, and leaves other arguments alone", () => {
    expect(extractJsonFlag(["import", "--json-ish", "f.json"])).toEqual({
      json: false,
      rest: ["import", "--json-ish", "f.json"],
    });
  });
});

describe("toJson", () => {
  it("pretty-prints one newline-terminated document", () => {
    expect(toJson({ a: 1, b: [2] })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  });

  it("writes Maps as objects and Sets as arrays, and drops undefined", () => {
    const value = {
      byId: new Map([[7, "x"]]),
      ids: new Set([1, 2]),
      gone: undefined,
    };
    expect(JSON.parse(toJson(value))).toEqual({ byId: { "7": "x" }, ids: [1, 2] });
  });
});

describe("omitKeys", () => {
  it("removes the named keys at any depth without touching the input", () => {
    const stats = { count: 2, decades: [{ key: "1990s", trackIds: [1, 2] }], trackIds: [3] };
    expect(omitKeys(stats, ["trackIds"])).toEqual({ count: 2, decades: [{ key: "1990s" }] });
    expect(stats.decades[0]!.trackIds).toEqual([1, 2]);
  });
});

describe("createOutput", () => {
  const capture = (): { writes: string[]; write: (text: string) => void } => {
    const writes: string[] = [];
    return { writes, write: (text) => writes.push(text) };
  };

  it("writes nothing in text mode", () => {
    const { writes, write } = capture();
    const output = createOutput(false, "deduplicate", write);
    output.set("groups", []);
    output.flush();
    expect(output.json).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes exactly one document, the command first and then fields in order", () => {
    const { writes, write } = capture();
    const output = createOutput(true, "import", write);
    output.set("plan", { matched: [] });
    output.assign({ applied: false, counts: { isrc: 1 } });
    output.set("plan", { matched: [1] }); // a later value replaces, keeping its place
    output.flush();
    output.flush();
    expect(writes).toHaveLength(1);
    expect(Object.keys(JSON.parse(writes[0]!))).toEqual(["command", "plan", "applied", "counts"]);
    expect(JSON.parse(writes[0]!)).toEqual({
      command: "import",
      plan: { matched: [1] },
      applied: false,
      counts: { isrc: 1 },
    });
  });

  it("still writes the bare document when a command set nothing", () => {
    const { writes, write } = capture();
    const output = createOutput(true, "logout", write);
    output.flush();
    expect(writes).toEqual(['{\n  "command": "logout"\n}\n']);
  });
});

describe("logSinksFor", () => {
  it("keeps progress on stdout in text mode", () => {
    const streams = { out: () => {}, err: () => {} };
    expect(logSinksFor(false, streams)).toBe(streams);
  });

  it("sends every log line to stderr in JSON mode", () => {
    const lines: string[] = [];
    const sinks = logSinksFor(true, { out: () => lines.push("stdout"), err: () => lines.push("stderr") });
    sinks.out("progress");
    sinks.err("warning");
    expect(lines).toEqual(["stderr", "stderr"]);
  });
});
