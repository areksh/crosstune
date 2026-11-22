import { describe, expect, it } from "vitest";

import {
  addedIds,
  alreadyInIds,
  draftChanges,
  driftOf,
  duplicateIds,
  EditStack,
  liveIds,
  moveBy,
  moveTo,
  notHiResIds,
  otherVersionIds,
  putBack,
  rangeBetween,
  rebase,
  reorder,
  searchIds,
  shuffleIds,
  sortIds,
  spreadArtists,
  startDraft,
  summarise,
  takeOut,
  unplayableIds,
  type Destination,
  type Entry,
} from "./playlist-draft.js";

const entry = (id: number, rest: Partial<Entry> = {}): Entry => ({
  id: id * 10,
  title: `T${id}`,
  artist: `A${id}`,
  playlistTrackId: id,
  ...rest,
});

const OTHER: Destination = { type: "existing", playlistId: 5, name: "Other" };
const NEW: Destination = { type: "new", name: "Split", isPublic: false };

describe("taking out and putting back", () => {
  it("takes entries out and counts them, ignoring ones not there", () => {
    const draft = takeOut(startDraft([1, 2, 3]), [2, 9]);
    expect(draft.order).toEqual([1, 3]);
    expect(summarise(draft)).toEqual({ removed: 1, moved: [], reordered: 0, changed: true });
    expect(takeOut(draft, [2])).toBe(draft);
  });

  it("tells moves to each destination apart from removals", () => {
    let draft = takeOut(startDraft([1, 2, 3, 4, 5]), [4, 2], OTHER);
    draft = takeOut(draft, [1], NEW);
    draft = takeOut(draft, [5]);
    expect(summarise(draft)).toMatchObject({
      removed: 1,
      moved: [
        { destination: OTHER, count: 2 },
        { destination: NEW, count: 1 },
      ],
    });
    expect(draftChanges(draft)).toEqual({
      base: [1, 2, 3, 4, 5],
      order: [3],
      remove: [5],
      moves: [
        { destination: NEW, entries: [1] },
        { destination: OTHER, entries: [2, 4] },
      ],
    });
  });

  it("puts entries back after the one they followed, wherever that is now", () => {
    let draft = takeOut(startDraft([1, 2, 3, 4, 5]), [1, 3, 4]);
    draft = moveTo(draft, [2], 2);
    expect(draft.order).toEqual([5, 2]);
    expect(putBack(draft, [3, 4]).order).toEqual([5, 2, 3, 4]);
    expect(putBack(draft, [1]).order).toEqual([1, 5, 2]);
    expect(putBack(draft, [5])).toBe(draft);
    expect(summarise(putBack(takeOut(startDraft([1, 2, 3]), [2]), [2])).changed).toBe(false);
  });

  it("keeps two copies of one track apart", () => {
    const entries = [entry(1, { id: 7 }), entry(2, { id: 7 })];
    const draft = takeOut(startDraft(entries.map((e) => e.playlistTrackId)), [2]);
    expect(draft.order).toEqual([1]);
  });
});

describe("moving", () => {
  const draft = startDraft([1, 2, 3, 4, 5, 6]);

  it("drops a scattered selection where asked, in its order", () => {
    expect(moveTo(draft, [5, 1], 3).order).toEqual([2, 3, 1, 5, 4, 6]);
    expect(moveTo(draft, [5, 1], 0).order).toEqual([1, 5, 2, 3, 4, 6]);
    expect(moveTo(draft, [1, 2], 6).order).toEqual([3, 4, 5, 6, 1, 2]);
  });

  it("changes nothing when dropped where it is", () => {
    expect(moveTo(draft, [2, 3], 1)).toBe(draft);
    expect(moveTo(draft, [2, 3], 3)).toBe(draft);
    expect(moveTo(draft, [2, 3], 2)).toBe(draft);
  });

  it("nudges each selected entry, stopping at the edges", () => {
    expect(moveBy(draft, [2, 5], -1).order).toEqual([2, 1, 3, 5, 4, 6]);
    expect(moveBy(draft, [1, 2, 4], -1).order).toEqual([1, 2, 4, 3, 5, 6]);
    expect(moveBy(draft, [5, 6, 3], 1).order).toEqual([1, 2, 4, 3, 5, 6]);
    expect(moveBy(draft, [1], -1)).toBe(draft);
  });

  it("orders the whole playlist, or some entries among their places", () => {
    expect(reorder(draft, [6, 5, 4, 3, 2, 1]).order).toEqual([6, 5, 4, 3, 2, 1]);
    expect(reorder(draft, [5, 1, 3]).order).toEqual([5, 2, 1, 4, 3, 6]);
    expect(reorder(draft, [1, 2, 3, 4, 5, 6])).toBe(draft);
  });

  it("counts as reordered only what had to move", () => {
    expect(summarise(moveTo(draft, [6], 0)).reordered).toBe(1);
    expect(summarise(takeOut(draft, [1])).reordered).toBe(0);
    expect(summarise(moveTo(takeOut(draft, [1, 2]), [3, 4], 4)).reordered).toBe(2);
  });
});

describe("changes made elsewhere", () => {
  it("says how the playlist changed", () => {
    expect(driftOf([1, 2, 3], [1, 2, 3])).toEqual({ added: 0, gone: 0, reordered: false });
    expect(driftOf([1, 2, 3], [3, 1, 9])).toEqual({ added: 1, gone: 1, reordered: true });
  });

  it("keeps the draft's edits, drops what has gone and slots in what is new", () => {
    let draft = takeOut(startDraft([1, 2, 3, 4, 5]), [2], OTHER);
    draft = moveTo(draft, [5], 0);
    const next = rebase(draft, [1, 2, 90, 3, 5, 91]);
    expect(next.order).toEqual([5, 91, 1, 90, 3]);
    expect([...next.removed]).toEqual([[2, OTHER]]);
    expect(next.base).toEqual([1, 2, 90, 3, 5, 91]);
  });

  it("forgets a removal of something already gone", () => {
    expect(rebase(takeOut(startDraft([1, 2]), [2]), [1]).removed.size).toBe(0);
  });

  it("takes the new order when the draft has not reordered", () => {
    expect(rebase(takeOut(startDraft([1, 2, 3]), [2]), [3, 2, 1]).order).toEqual([3, 1]);
  });
});

describe("rangeBetween", () => {
  it("is inclusive in either direction, over what is shown", () => {
    expect(rangeBetween([4, 8, 15, 16], 15, 8)).toEqual([8, 15]);
    expect(rangeBetween([4, 8], 99, 8)).toEqual([8]);
    expect(rangeBetween([4, 8], 4, 99)).toEqual([]);
  });
});

describe("EditStack", () => {
  it("undoes and redoes, dropping redo after a new edit", () => {
    const stack = new EditStack("a");
    stack.push("b");
    stack.push("b");
    stack.undo();
    expect([stack.now, stack.canUndo, stack.canRedo]).toEqual(["a", false, true]);
    stack.undo();
    stack.redo();
    expect(stack.now).toBe("b");
    stack.undo();
    stack.push("c");
    stack.redo();
    expect(stack.now).toBe("c");
  });
});

describe("sorting", () => {
  it("sorts by title and number in it, ignoring case, missing values last either way", () => {
    const entries = [entry(1, { artist: "b" }), entry(2, { artist: undefined }), entry(3, { artist: "A" })];
    expect(sortIds(entries, "artist")).toEqual([3, 1, 2]);
    expect(sortIds(entries, "artist", true)).toEqual([1, 3, 2]);
    expect(sortIds([entry(10), entry(9)], "title")).toEqual([9, 10]);
  });

  it("keeps an album in track order, also when albums are reversed", () => {
    const on = (id: number, album: string, discNumber: number, trackNumber: number) =>
      entry(id, { album, discNumber, trackNumber });
    const entries = [on(1, "B", 2, 1), on(2, "A", 1, 2), on(3, "B", 1, 9), on(4, "A", 1, 1)];
    expect(sortIds(entries, "album")).toEqual([4, 2, 3, 1]);
    expect(sortIds(entries, "album", true)).toEqual([3, 1, 4, 2]);
  });

  it("sorts by the other values, ties in place", () => {
    const entries = [
      entry(1, { addedAt: "2026-02-01T00:00:00Z", duration: 300, bitDepth: 16, samplingRate: 44.1, releaseDate: "1999-01-01" }),
      entry(2, { addedAt: "2026-01-01T00:00:00Z", duration: 100, bitDepth: 24, samplingRate: 96, releaseDate: "2001-01-01" }),
      entry(3, { addedAt: "2026-01-01T00:00:00Z", duration: 200, bitDepth: 24, samplingRate: 44.1, releaseDate: "1980-01-01" }),
    ];
    expect(sortIds(entries, "added")).toEqual([2, 3, 1]);
    expect(sortIds(entries, "length", true)).toEqual([1, 3, 2]);
    expect(sortIds(entries, "released")).toEqual([3, 1, 2]);
    expect(sortIds(entries, "quality")).toEqual([1, 3, 2]);
  });

  it("shuffles with the given random source, keeping every entry", () => {
    const entries = [1, 2, 3, 4].map((id) => entry(id));
    expect(shuffleIds(entries, () => 0).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("spreadArtists", () => {
  const by = (...artists: string[]) => artists.map((artist, i) => entry(i + 1, { artist }));
  const artistsOf = (entries: Entry[], ids: number[]) => ids.map((id) => entries[id - 1]!.artist).join("");

  it("leaves a list alone that has no repeats in a row", () => {
    expect(spreadArtists(by("A", "B", "A", "C"))).toEqual([1, 2, 3, 4]);
  });

  it("separates an artist's songs whenever that can be done", () => {
    for (const artists of ["AABBC", "AAAB", "BAAA", "AAABB", "CBAAAA", "ABBBCCA", "AABBAABB", "ZAAAAAB"]) {
      const entries = by(...artists);
      const result = artistsOf(entries, spreadArtists(entries));
      expect([...result].sort().join("")).toBe([...artists].sort().join(""));
      const most = Math.max(...[...new Set(artists)].map((a) => [...artists].filter((x) => x === a).length));
      if (most <= Math.ceil(artists.length / 2)) {
        expect(result).not.toMatch(/(.)\1/);
      }
    }
  });

  it("does not lump together entries without an artist", () => {
    const entries = [entry(1, { artist: undefined }), entry(2, { artist: undefined })];
    expect(spreadArtists(entries)).toEqual([1, 2]);
  });
});

describe("picking entries", () => {
  const song = (id: number, rest: Partial<Entry> = {}) => entry(id, { title: "Roads", artist: "Portishead", ...rest });

  it("picks duplicates as the Deduplicator does, keeping the copy asked for", () => {
    const entries = [song(1), song(2, { bitDepth: 24 }), song(3, { version: "Live" }), song(4, { id: 10 })];
    expect(duplicateIds(entries, "first-added")).toEqual([2, 4]);
    expect(duplicateIds(entries, "highest-quality")).toEqual([1, 4]);
    expect(duplicateIds(entries, "first-added", { includeVersions: true })).toEqual([2, 3, 4]);
  });

  it("picks other versions, not the ordinary one", () => {
    const entries = [song(1, { version: "Live" }), song(2), song(3, { version: "Remaster" }), song(4, { version: "Remix" })];
    expect(otherVersionIds(entries)).toEqual([1, 4]);
    expect(otherVersionIds([song(1, { version: "Live" }), song(2, { version: "Remix" })])).toEqual([2]);
  });

  it("picks unplayable, not hi-res and live entries", () => {
    expect(unplayableIds([entry(1, { streamable: false }), entry(2, { streamable: true }), entry(3)])).toEqual([1]);
    expect(
      notHiResIds([
        entry(1, { bitDepth: 16, samplingRate: 44.1 }),
        entry(2, { bitDepth: 24, samplingRate: 44.1 }),
        entry(3),
      ]),
    ).toEqual([1]);
    expect(
      liveIds([
        entry(1, { version: "Live at Wembley" }),
        entry(2, { title: "Roads (Live)" }),
        entry(3, { title: "Roads - Live in Wacken" }),
        entry(4, { title: "Live and Let Die" }),
        entry(5, { title: "Long Live (Her Version)" }),
        entry(6, { title: "Alive" }),
      ]),
    ).toEqual([1, 2, 3]);
  });

  it("picks by date added", () => {
    const entries = [entry(1, { addedAt: "2026-01-01T12:00:00Z" }), entry(2, { addedAt: "2026-03-01T12:00:00Z" }), entry(3)];
    expect(addedIds(entries, "before", "2026-02-01")).toEqual([1]);
    expect(addedIds(entries, "since", "2026-02-01")).toEqual([2]);
    expect(addedIds(entries, "since", "nonsense")).toEqual([]);
  });

  it("picks songs already elsewhere, but not their live versions", () => {
    const others = [{ id: 999, title: "Roads (Remastered)", artist: "Portishead" }];
    expect(alreadyInIds([song(1), song(2, { version: "Live" })], others)).toEqual([1]);
  });

  it("searches every word across title, artist, album and guests, ignoring accents", () => {
    const entries = [
      entry(1, { title: "Jóga", artist: "Björk", album: "Homogenic" }),
      entry(2, { title: "T", guestArtists: ["Bjork"] }),
    ];
    expect(searchIds(entries, "bjork")).toEqual([1, 2]);
    expect(searchIds(entries, "  homo JOGA ")).toEqual([1]);
    expect(searchIds(entries, "")).toEqual([1, 2]);
  });
});
