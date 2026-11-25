import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import {
  dayLabel,
  describeEntry,
  foldHistory,
  formatHistoryList,
  HISTORY_LIMITS,
  laterConflicts,
  parseHistory,
  pruneRecords,
  selectEntry,
  serializeRecords,
  summarise,
  timeAgo,
  toolName,
  type HistoryEntry,
  type HistoryItem,
  type HistoryRecord,
  type Operation,
  type PlaylistEntryRecord,
} from "./history.js";

/** `count` playlist entries for track ids from `firstTrack`, at positions from `from`. */
function entries(count: number, firstTrack = 1, from = 0): PlaylistEntryRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    trackId: qid(firstTrack + i),
    playlistTrackId: qid(9000 + firstTrack + i),
    position: from + i,
  }));
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "a1",
    at: "2026-11-02T20:26:00.000Z",
    tool: "playlist-from-artists",
    source: "cli",
    label: "Created Road Trip with 2 tracks",
    ops: [
      { kind: "create-playlist", playlistId: qid(1), name: "Road Trip" },
      { kind: "add-tracks", playlistId: qid(1), entries: entries(2) },
    ],
    ...overrides,
  };
}

function record(e: HistoryEntry): HistoryRecord {
  return { type: "entry", ...e };
}

describe("serializeRecords / parseHistory", () => {
  it("round-trips entries and undone markers as JSON Lines", () => {
    const records: HistoryRecord[] = [
      record(entry()),
      { type: "undone", id: "a1", by: "b2", at: "2026-11-02T21:00:00.000Z" },
    ];
    const text = serializeRecords(records);
    expect(text.split("\n")).toHaveLength(3); // two lines and a trailing newline
    expect(text.endsWith("\n")).toBe(true);
    expect(parseHistory(text)).toEqual(records);
  });

  it("skips blank, malformed, unknown-version and invalid lines", () => {
    const good = serializeRecords([record(entry())]);
    const text = [
      "",
      "not json",
      JSON.stringify({ v: 99, type: "entry", ...entry({ id: "future" }) }),
      JSON.stringify({ v: 1, type: "entry", id: "x" }),
      JSON.stringify({
        v: 1,
        type: "entry",
        ...entry({ id: "bad-op", ops: [{ kind: "explode" } as unknown as Operation] }),
      }),
      good.trim(),
    ].join("\n");
    expect(parseHistory(text).map((r) => r.id)).toEqual(["a1"]);
  });

  it("keeps every kind of operation", () => {
    const ops: Operation[] = [
      { kind: "create-playlist", playlistId: qid(1), name: "A", isPublic: true, description: "d" },
      { kind: "delete-playlist", playlistId: qid(2), name: "B", trackIds: [qid(5), qid(6)], isPublic: false },
      { kind: "add-tracks", playlistId: qid(1), playlistName: "A", entries: entries(1), unconfirmed: [qid(7)] },
      { kind: "remove-tracks", playlistId: qid(1), entries: entries(1, 3, 4) },
      { kind: "move-tracks", playlistId: qid(1), playlistTrackIds: [qid(11)], insertBefore: 1 },
      {
        kind: "move-tracks",
        playlistId: qid(1),
        playlistTrackIds: [qid(11), qid(12)],
        insertBefore: 1,
        from: [3, 4],
        trackIds: [qid(5), qid(6)],
      },
      { kind: "add-favourites", type: "albums", ids: [qid("alb")] },
      { kind: "remove-favourites", type: "tracks", ids: [qid(8)] },
    ];
    const records = [record(entry({ ops }))];
    expect(parseHistory(serializeRecords(records))).toEqual(records);
  });

  it("reads a move whose tracks do not match its entries without them", () => {
    const move = { kind: "move-tracks", playlistId: qid(1), playlistTrackIds: [qid(11), qid(12)], insertBefore: 1 };
    const line = JSON.stringify({ v: 1, type: "entry", ...entry({ ops: [{ ...move, trackIds: [qid(5)] } as Operation] }) });
    expect(parseHistory(line)).toEqual([record(entry({ ops: [move as Operation] }))]);
  });

  it("keeps what an undo renamed and made again", () => {
    const records = [
      record(
        entry({
          tool: "undo",
          undoes: "a0",
          renamed: [{ playlistId: qid(1), entries: [[qid(11), qid(21)], [qid(12), qid(22)]] }],
          recreated: [{ was: qid(2), now: qid(3) }],
        }),
      ),
    ];
    expect(parseHistory(serializeRecords(records))).toEqual(records);
  });

  it("reads an entry whose renamed ids or remade playlists it cannot read, without them", () => {
    const line = JSON.stringify({
      v: 1,
      type: "entry",
      ...entry(),
      renamed: [{ playlistId: "qobuz:1", entries: [["x"]] }],
      recreated: [{ was: "qobuz:2" }],
    });
    expect(parseHistory(line)).toEqual([record(entry())]);
  });

  it("reads the lines earlier versions wrote, as they meant them", () => {
    // Written to the format of history files of November 2026 (composed, not
    // copied from a real file): bare Qobuz ids (before ADR-0010), then tagged ones; an undo with nothing kept about new ids, a
    // move with and without where its entries were, and an undone marker.
    const text = [
      '{"v":1,"type":"entry","id":"3f9a1c2e","at":"2026-11-03T18:02:11.412Z","tool":"deduplicate","source":"cli","label":"Removed 1 duplicate from Late Night","ops":[{"kind":"remove-tracks","playlistId":4242,"playlistName":"Late Night","entries":[{"trackId":101,"playlistTrackId":9001,"position":3}]}]}',
      '{"v":1,"type":"entry","id":"7b2d4e10","at":"2026-11-22T09:15:00.000Z","tool":"playlist-manager","source":"web","label":"Reordered Late Night","ops":[{"kind":"move-tracks","playlistId":"qobuz:4242","playlistName":"Late Night","playlistTrackIds":["qobuz:9002"],"insertBefore":1,"from":[2]},{"kind":"move-tracks","playlistId":"qobuz:4242","playlistTrackIds":["qobuz:9003"],"insertBefore":2}]}',
      '{"v":1,"type":"entry","id":"a81c77f0","at":"2026-11-23T10:00:00.000Z","tool":"undo","source":"web","label":"Undid: Removed 1 duplicate from Late Night","ops":[{"kind":"add-tracks","playlistId":"qobuz:4242","playlistName":"Late Night","entries":[{"trackId":"qobuz:101","playlistTrackId":"qobuz:9100","position":5}]}],"undoes":"3f9a1c2e"}',
      '{"v":1,"type":"undone","id":"3f9a1c2e","by":"a81c77f0","at":"2026-11-23T10:00:00.100Z"}',
      '{"v":1,"type":"entry","id":"c0ffee00","at":"2026-11-24T08:00:00.000Z","tool":"link","source":"cli","label":"Synced Mix","ops":[{"kind":"add-favourites","type":"tracks","ids":["tidal:77"]}],"link":"aaaaaaaa","error":"HTTP 500"}',
    ].join("\n");

    const items = foldHistory(parseHistory(text));

    expect(items.map((i) => i.id)).toEqual(["c0ffee00", "a81c77f0", "7b2d4e10", "3f9a1c2e"]);
    expect(items[3]).toEqual({
      id: "3f9a1c2e",
      at: "2026-11-03T18:02:11.412Z",
      tool: "deduplicate",
      source: "cli",
      label: "Removed 1 duplicate from Late Night",
      ops: [
        {
          kind: "remove-tracks",
          playlistId: qid(4242),
          playlistName: "Late Night",
          entries: [{ trackId: qid(101), playlistTrackId: qid(9001), position: 3 }],
        },
      ],
      undone: { at: "2026-11-23T10:00:00.100Z", by: "a81c77f0" },
    });
    expect(items[2]?.ops).toEqual([
      { kind: "move-tracks", playlistId: qid(4242), playlistName: "Late Night", playlistTrackIds: [qid(9002)], insertBefore: 1, from: [2] },
      { kind: "move-tracks", playlistId: qid(4242), playlistTrackIds: [qid(9003)], insertBefore: 2 },
    ]);
    expect(items[1]).toMatchObject({ undoes: "3f9a1c2e", tool: "undo" });
    expect(items[1]).not.toHaveProperty("renamed");
    expect(items[0]).toMatchObject({ link: "aaaaaaaa", error: "HTTP 500" });
  });
});

describe("foldHistory", () => {
  it("lists entries newest first, marking the undone ones", () => {
    const items = foldHistory([
      record(entry({ id: "a1", at: "2026-11-01T10:00:00.000Z" })),
      record(entry({ id: "b2", at: "2026-11-02T10:00:00.000Z" })),
      { type: "undone", id: "a1", by: "c3", at: "2026-11-02T11:00:00.000Z" },
    ]);
    expect(items.map((i) => i.id)).toEqual(["b2", "a1"]);
    expect(items[1]?.undone).toEqual({ at: "2026-11-02T11:00:00.000Z", by: "c3" });
    expect(items[0]?.undone).toBeUndefined();
  });
});

describe("pruneRecords", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("drops entries older than the age limit, with their markers", () => {
    const old = entry({ id: "old", at: "2026-07-01T00:00:00.000Z" });
    const recent = entry({ id: "new", at: "2026-10-30T00:00:00.000Z" });
    const pruned = pruneRecords(
      [
        record(old),
        { type: "undone", id: "old", at: "2026-07-02T00:00:00.000Z" },
        record(recent),
        { type: "undone", id: "new", at: "2026-10-31T00:00:00.000Z" },
      ],
      now,
    );
    expect(pruned.map((r) => `${r.type}:${r.id}`)).toEqual(["entry:new", "undone:new"]);
  });

  it("keeps only the newest entries beyond the count limit", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record(entry({ id: `e${i}`, at: `2026-11-0${i + 1}T00:00:00.000Z` })),
    );
    const pruned = pruneRecords(records, now, { maxEntries: 2, maxAgeDays: 90 });
    expect(pruned.map((r) => r.id)).toEqual(["e3", "e4"]);
  });

  it("defaults to 200 entries and 90 days", () => {
    expect(HISTORY_LIMITS).toEqual({ maxEntries: 200, maxAgeDays: 90 });
  });
});

describe("summarise", () => {
  it("counts what an entry added and removed", () => {
    expect(
      summarise(
        entry({
          ops: [
            { kind: "add-tracks", playlistId: qid(1), entries: entries(4), unconfirmed: [qid(99)] },
            { kind: "remove-tracks", playlistId: qid(1), entries: entries(4, 10) },
            { kind: "add-favourites", type: "albums", ids: ["a", "b"] },
            { kind: "remove-favourites", type: "tracks", ids: [qid(1)] },
            { kind: "delete-playlist", playlistId: qid(3), name: "X", trackIds: [qid(1), qid(2), qid(3)] },
            { kind: "move-tracks", playlistId: qid(1), playlistTrackIds: [qid(1)], insertBefore: 1 },
          ],
        }),
      ),
    ).toEqual({ added: 7, removed: 8 });
  });
});

describe("describeEntry", () => {
  it("names a created playlist with its track count", () => {
    expect(
      describeEntry("playlist-from-artists", [
        { kind: "create-playlist", playlistId: qid(1), name: "Road Trip" },
        { kind: "add-tracks", playlistId: qid(1), entries: entries(15) },
      ]),
    ).toBe("Created Road Trip with 15 tracks");
    expect(
      describeEntry("word-play", [
        { kind: "create-playlist", playlistId: qid(1), name: "Solo" },
        { kind: "add-tracks", playlistId: qid(1), entries: entries(1) },
      ]),
    ).toBe("Created Solo with 1 track");
    expect(describeEntry("other", [{ kind: "create-playlist", playlistId: qid(1), name: "Empty" }])).toBe(
      "Created Empty",
    );
  });

  it("speaks of duplicates for the deduplicator", () => {
    expect(
      describeEntry("deduplicate", [
        { kind: "remove-favourites", type: "tracks", ids: Array.from({ length: 12 }, (_, i) => i) },
      ]),
    ).toBe("Removed 12 duplicates from Favourites");
    expect(
      describeEntry("deduplicate", [
        { kind: "remove-tracks", playlistId: qid(5), playlistName: "Late Night", entries: entries(3) },
      ]),
    ).toBe("Removed 3 duplicates from Late Night");
    expect(
      describeEntry("deduplicate", [
        { kind: "remove-tracks", playlistId: qid(5), playlistName: "A", entries: entries(3) },
        { kind: "remove-tracks", playlistId: qid(6), playlistName: "B", entries: entries(2) },
      ]),
    ).toBe("Removed 5 duplicates from 2 playlists");
  });

  it("counts replacements for upgrade & repair", () => {
    expect(
      describeEntry("upgrade", [
        { kind: "add-tracks", playlistId: qid(5), playlistName: "Late Night", entries: entries(4) },
        { kind: "remove-tracks", playlistId: qid(5), playlistName: "Late Night", entries: entries(4, 20) },
        { kind: "move-tracks", playlistId: qid(5), playlistTrackIds: [qid(1)], insertBefore: 3 },
      ]),
    ).toBe("Upgraded 4 tracks in Late Night");
    expect(
      describeEntry("upgrade", [
        { kind: "add-favourites", type: "tracks", ids: [qid(1), qid(2)] },
        { kind: "remove-favourites", type: "tracks", ids: [qid(3), qid(4), qid(5)] },
      ]),
    ).toBe("Upgraded 2 tracks in Favourites and removed 1");
  });

  it("imports into favourites and adds to playlists", () => {
    expect(
      describeEntry("import", [
        { kind: "add-favourites", type: "tracks", ids: Array.from({ length: 230 }, (_, i) => i) },
      ]),
    ).toBe("Imported 230 tracks into Favourites");
    expect(
      describeEntry("new-releases", [{ kind: "add-favourites", type: "albums", ids: ["a", "b", "c"] }]),
    ).toBe("Added 3 albums to Favourites");
    expect(
      describeEntry("similar-artists", [
        { kind: "add-tracks", playlistId: qid(9), playlistName: "Mix", entries: entries(20) },
      ]),
    ).toBe("Added 20 tracks to Mix");
    expect(describeEntry("other", [{ kind: "add-tracks", playlistId: qid(42), entries: entries(2) }])).toBe(
      "Added 2 tracks to playlist 42",
    );
  });

  it("sums several created playlists and joins the clauses", () => {
    expect(
      describeEntry("restore", [
        { kind: "add-favourites", type: "tracks", ids: Array.from({ length: 100 }, (_, i) => i) },
        { kind: "add-favourites", type: "albums", ids: ["a", "b", "c"] },
        { kind: "create-playlist", playlistId: qid(1), name: "A" },
        { kind: "add-tracks", playlistId: qid(1), entries: entries(10) },
        { kind: "create-playlist", playlistId: qid(2), name: "B" },
        { kind: "add-tracks", playlistId: qid(2), entries: entries(5) },
      ]),
    ).toBe("Imported 100 tracks and 3 albums into Favourites; created 2 playlists with 15 tracks");
  });

  it("describes removals, deletions and reorders", () => {
    expect(
      describeEntry("other", [
        { kind: "remove-tracks", playlistId: qid(5), playlistName: "Late Night", entries: entries(2) },
      ]),
    ).toBe("Removed 2 tracks from Late Night");
    expect(
      describeEntry("undo", [{ kind: "delete-playlist", playlistId: qid(5), name: "Road Trip", trackIds: [] }]),
    ).toBe("Deleted Road Trip");
    expect(
      describeEntry("other", [
        { kind: "move-tracks", playlistId: qid(5), playlistName: "Late Night", playlistTrackIds: [qid(1)], insertBefore: 1 },
      ]),
    ).toBe("Reordered Late Night");
    expect(describeEntry("other", [])).toBe("No changes");
  });
});

describe("laterConflicts", () => {
  const items: HistoryItem[] = foldHistory([
    record(entry({ id: "e1", at: "2026-11-01T10:00:00.000Z", ops: [{ kind: "add-tracks", playlistId: qid(1), entries: entries(1) }] })),
    record(entry({ id: "e2", at: "2026-11-01T11:00:00.000Z", ops: [{ kind: "remove-tracks", playlistId: qid(1), entries: entries(1) }] })),
    record(entry({ id: "e3", at: "2026-11-01T12:00:00.000Z", ops: [{ kind: "add-tracks", playlistId: qid(2), entries: entries(1) }] })),
    record(entry({ id: "e4", at: "2026-11-01T13:00:00.000Z", ops: [{ kind: "add-favourites", type: "tracks", ids: [qid(1)] }] })),
    record(entry({ id: "e5", at: "2026-11-01T14:00:00.000Z", ops: [{ kind: "remove-tracks", playlistId: qid(1), entries: entries(1) }] })),
    { type: "undone", id: "e5", at: "2026-11-01T15:00:00.000Z" },
  ]);

  it("finds later, not undone entries touching the same playlist or favourites", () => {
    const e1 = items.find((i) => i.id === "e1")!;
    expect(laterConflicts(e1, items).map((i) => i.id)).toEqual(["e2"]);
    const e3 = items.find((i) => i.id === "e3")!;
    expect(laterConflicts(e3, items)).toEqual([]);
  });
});

describe("selectEntry", () => {
  const items = foldHistory([
    record(entry({ id: "e1", at: "2026-11-01T10:00:00.000Z" })),
    record(entry({ id: "e2", at: "2026-11-01T11:00:00.000Z" })),
    record(entry({ id: "u1", at: "2026-11-01T12:00:00.000Z", tool: "undo", undoes: "e2" })),
    { type: "undone", id: "e2", by: "u1", at: "2026-11-01T12:00:00.000Z" },
  ]);

  it("picks the latest entry that is neither undone nor an undo", () => {
    expect(selectEntry(items)?.id).toBe("e1");
  });

  it("picks an entry by id, or nothing", () => {
    expect(selectEntry(items, "u1")?.id).toBe("u1");
    expect(selectEntry(items, "zz")).toBeUndefined();
  });
});

describe("time and tool labels", () => {
  const now = new Date(2026, 10, 2, 21, 30);

  it("says how long ago", () => {
    expect(timeAgo(new Date(2026, 10, 2, 21, 29, 40), now)).toBe("just now");
    expect(timeAgo(new Date(2026, 10, 2, 21, 29), now)).toBe("1 minute ago");
    expect(timeAgo(new Date(2026, 10, 2, 21, 18), now)).toBe("12 minutes ago");
    expect(timeAgo(new Date(2026, 10, 2, 18, 30), now)).toBe("3 hours ago");
    expect(timeAgo(new Date(2026, 10, 1, 18, 30), now)).toBe("yesterday");
    expect(timeAgo(new Date(2026, 9, 28, 18, 30), now)).toBe("5 days ago");
  });

  it("names the day", () => {
    expect(dayLabel(new Date(2026, 10, 2, 1, 0), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 1, 23, 0), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 28, 12, 0), now)).toBe("28 October");
    expect(dayLabel(new Date(2025, 11, 31, 12, 0), now)).toBe("31 December 2025");
  });

  it("names the tools", () => {
    expect(toolName("deduplicate")).toBe("Deduplicator");
    expect(toolName("upgrade")).toBe("Upgrade & repair");
    expect(toolName("something-new")).toBe("something-new");
  });
});

describe("formatHistoryList", () => {
  it("lists id, time, label, counts and the undone marker", () => {
    const items = foldHistory([
      record(entry({ id: "a1", at: new Date(2026, 10, 2, 21, 26).toISOString() })),
      record(
        entry({
          id: "b2",
          at: new Date(2026, 10, 1, 18, 40).toISOString(),
          tool: "deduplicate",
          label: "Removed 12 duplicates from Favourites",
          ops: [{ kind: "remove-favourites", type: "tracks", ids: Array.from({ length: 12 }, (_, i) => i) }],
        }),
      ),
      { type: "undone", id: "b2", at: new Date(2026, 10, 2, 9, 0).toISOString() },
    ]);
    expect(formatHistoryList(items)).toBe(
      [
        "a1  2026-11-02 21:26  Created Road Trip with 2 tracks  +2  (Playlist from artists)",
        "b2  2026-11-01 18:40  Removed 12 duplicates from Favourites  -12  (Deduplicator)  [undone]",
      ].join("\n"),
    );
  });

  it("says when there is no history", () => {
    expect(formatHistoryList([])).toBe("No changes recorded yet.");
  });
});

describe("ids in the history file", () => {
  /** One line of each kind, as written before ids carried their service. */
  const OLD = [
    { kind: "create-playlist", playlistId: 5, name: "Mix" },
    { kind: "delete-playlist", playlistId: 5, name: "Mix", trackIds: [1, 2] },
    { kind: "update-playlist", playlistId: 5, before: { name: "a" }, after: { name: "b" } },
    { kind: "add-tracks", playlistId: 5, entries: [{ trackId: 1, playlistTrackId: 90, position: 0 }], unconfirmed: [7] },
    { kind: "remove-tracks", playlistId: 5, entries: [{ trackId: 1, playlistTrackId: 90, position: 0 }] },
    { kind: "move-tracks", playlistId: 5, playlistTrackIds: [90, 91], insertBefore: 1, from: [3, 4] },
    { kind: "add-favourites", type: "tracks", ids: [1] },
    { kind: "add-favourites", type: "albums", ids: [qid("0060254735156")] },
    { kind: "remove-favourites", type: "artists", ids: [3] },
  ];
  const line = (ops: unknown[], id = "a") =>
    `${JSON.stringify({ v: 1, type: "entry", id, at: "2026-11-02T10:00:00.000Z", tool: "t", source: "cli", label: "L", ops })}\n`;
  const opsOf = (text: string) => parseHistory(text).flatMap((r) => (r.type === "entry" ? r.ops : []));

  it("reads older lines as Qobuz's", () => {
    expect(opsOf(line(OLD))).toEqual([
      { kind: "create-playlist", playlistId: "qobuz:5", name: "Mix" },
      { kind: "delete-playlist", playlistId: "qobuz:5", name: "Mix", trackIds: ["qobuz:1", "qobuz:2"] },
      { kind: "update-playlist", playlistId: "qobuz:5", before: { name: "a" }, after: { name: "b" } },
      {
        kind: "add-tracks",
        playlistId: "qobuz:5",
        entries: [{ trackId: "qobuz:1", playlistTrackId: "qobuz:90", position: 0 }],
        unconfirmed: ["qobuz:7"],
      },
      {
        kind: "remove-tracks",
        playlistId: "qobuz:5",
        entries: [{ trackId: "qobuz:1", playlistTrackId: "qobuz:90", position: 0 }],
      },
      {
        kind: "move-tracks",
        playlistId: "qobuz:5",
        playlistTrackIds: ["qobuz:90", "qobuz:91"],
        insertBefore: 1,
        from: [3, 4],
      },
      { kind: "add-favourites", type: "tracks", ids: ["qobuz:1"] },
      { kind: "add-favourites", type: "albums", ids: ["qobuz:0060254735156"] },
      { kind: "remove-favourites", type: "artists", ids: ["qobuz:3"] },
    ]);
  });

  it("reads what it writes, and a file holding both", () => {
    const tagged = opsOf(line(OLD));
    expect(opsOf(line(tagged))).toEqual(tagged);
    const both = line(OLD, "a") + line([{ kind: "create-playlist", playlistId: "tidal:x-1", name: "T" }], "b");
    expect(parseHistory(both)).toHaveLength(2);
  });

  it.each(["qobuz:", "nope:1", "", 12.5, 0, null])("skips a line with the id %j", (playlistId) => {
    expect(parseHistory(line([{ kind: "create-playlist", playlistId, name: "x" }]))).toEqual([]);
  });

  it("shows Qobuz's ids as before where a playlist has no name", () => {
    expect(describeEntry("t", opsOf(line([OLD[3]])))).toContain(
      "playlist 5",
    );
  });
});
