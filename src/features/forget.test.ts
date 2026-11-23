import { describe, expect, it } from "vitest";

import { tagId } from "../services/ids.js";
import { forgetInHistory, forgetInHistoryText } from "./forget.js";
import type { HistoryRecord } from "./history.js";

const entry = (id: string, ops: unknown[]): HistoryRecord =>
  ({ type: "entry", id, at: "2026-11-23T10:00:00.000Z", tool: "t", source: "web", label: id, ops }) as HistoryRecord;

const q = (n: number) => tagId("qobuz", n);
const t = (n: number) => tagId("tidal", n);

describe("forgetInHistory", () => {
  it("drops a service's entries, and keeps others' and markers", () => {
    const records: HistoryRecord[] = [
      entry("a", [{ kind: "create-playlist", playlistId: t(1), name: "T" }]),
      entry("b", [{ kind: "create-playlist", playlistId: q(1), name: "Q" }]),
      { type: "undone", id: "b", at: "x" },
      { type: "undone", id: "a", at: "x" },
      entry("c", [{ kind: "add-favourites", type: "tracks", ids: [t(5)] }]),
    ];
    const { records: kept, dropped } = forgetInHistory(records, "tidal");
    expect(kept.map((record) => [record.type, record.id])).toEqual([
      ["entry", "b"],
      ["undone", "b"],
    ]);
    expect(dropped).toBe(2);
  });

  it("keeps an entry that also changed another service, without the forgotten parts, and no longer undoable", () => {
    const records: HistoryRecord[] = [
      entry("m", [
        { kind: "create-playlist", playlistId: t(1), name: "T" },
        { kind: "remove-tracks", playlistId: q(1), entries: [{ trackId: q(2), playlistTrackId: q(3), position: 0 }] },
      ]),
    ];
    const [kept] = forgetInHistory(records, "tidal").records as Extract<HistoryRecord, { type: "entry" }>[];
    expect(kept).toMatchObject({ id: "m", label: "m", ops: [], forgotten: "tidal" });
  });
});

describe("an entry kept after forgetting", () => {
  it("reads back, and cannot be undone", async () => {
    const { parseHistory, serializeRecords, foldHistory } = await import("./history.js");
    const { planUndo } = await import("./undo.js");
    const [record] = forgetInHistory(
      [entry("m", [{ kind: "create-playlist", playlistId: t(1), name: "T" }, { kind: "add-favourites", type: "tracks", ids: [q(1)] }])],
      "tidal",
    ).records;
    const items = foldHistory(parseHistory(serializeRecords([record!])));
    expect(items[0]).toMatchObject({ forgotten: "tidal" });
    const plan = await planUndo({ getPlaylistTracks: async () => [] } as never, items[0]!, items);
    expect(plan.blocked).toMatch(/TIDAL.*forgotten/);
  });
});

describe("forgetInHistoryText", () => {
  it("changes only the lines about the service, keeping every other line as it was", async () => {
    const { serializeRecords } = await import("./history.js");
    const mine = serializeRecords([entry("a", [{ kind: "create-playlist", playlistId: t(1), name: "T" }])]);
    const marker = serializeRecords([{ type: "undone", id: "a", at: "2026-11-23T11:00:00.000Z" }]);
    const theirs = serializeRecords([entry("b", [{ kind: "create-playlist", playlistId: q(1), name: "Q" }])]);
    const damaged = "{not json\n";
    const future = `${JSON.stringify({ v: 99, type: "entry", id: "c", ops: [{ kind: "new-thing", playlistId: t(2) }] })}\n`;
    const { text, dropped } = forgetInHistoryText(`${mine}${damaged}${theirs}${marker}${future}`, "tidal");
    expect(text).toBe(`${damaged}${theirs}${future}`);
    expect(dropped).toBe(1);
  });
});
