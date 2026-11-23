import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { parseCollection, serializeCollection, type Collection } from "./import-export.js";

describe("hostile titles in exported files", () => {
  const hostile: Collection = {
    kind: "tracks",
    items: [
      { id: qid(1), title: "=1+1", artist: "-Remix-" },
      { id: qid(2), title: "@SUM(A1)", artist: "+x" },
      { id: qid(3), title: "'=already", artist: "\tTab" },
    ],
  };

  it("guards formula starts in CSV with a leading apostrophe", () => {
    const lines = serializeCollection(hostile, "csv").trimEnd().split("\r\n");
    expect(lines[1]).toMatch(/^'=1\+1,'-Remix-,/);
    expect(lines[2]).toMatch(/^'@SUM\(A1\),'\+x,/);
  });

  it("reads a guarded CSV back unchanged", () => {
    const back = parseCollection(serializeCollection(hostile, "csv"), "csv", "tracks");
    expect(back.items).toMatchObject([
      { title: "=1+1", artist: "-Remix-" },
      { title: "@SUM(A1)", artist: "+x" },
      { title: "'=already", artist: "\tTab" },
    ]);
  });

  it("does not let a newline in a title start another M3U or text entry", () => {
    const evil: Collection = {
      kind: "tracks",
      items: [{ id: qid(1), title: "a\r\nqobuz://track/999\n#EXTINF:-1,b", artist: "x\u0007y" }],
    };
    const m3u = serializeCollection(evil, "m3u").trimEnd().split("\n");
    expect(m3u).toHaveLength(3);
    expect(m3u[1]).toBe("#EXTINF:-1,x y - a  qobuz://track/999 #EXTINF:-1,b");
    expect(serializeCollection(evil, "text").trimEnd().split("\n")).toHaveLength(1);
  });
});
