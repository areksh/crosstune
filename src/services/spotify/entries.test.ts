import { describe, expect, it } from "vitest";

import { applyMove } from "../../features/playlist-order.js";
import { tagId } from "../ids.js";
import type { EntryId } from "../model.js";
import { appendEntries, findEntries, identify, numberEntries, planRemoval, rangeMoves, spreadMoves, type RangeMove } from "./entries.js";

const song = (name: string) => `spotify:track:${name}`;
const songs = (names: string) => names.split("").map((n) => (n === "-" ? undefined : song(n)));
const entry = (native: string) => tagId<EntryId>("spotify", native);

/** What Spotify does with a range move. */
function moveRange<T>(list: readonly T[], { start, length, before }: RangeMove): T[] {
  const moving = list.slice(start, start + length);
  const rest = [...list.slice(0, start), ...list.slice(start + length)];
  const at = before > start ? before - length : before;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** A repeatable source of numbers below `n`. */
function randomness(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * n);
  };
}

describe("numberEntries", () => {
  it("names each entry by its song and which copy it is", () => {
    expect(numberEntries(songs("abaca"))).toEqual(["a#1", "b#1", "a#2", "c#1", "a#3"].map(entry));
  });

  it("names episodes, local files and what cannot be read, apart", () => {
    const ids = numberEntries(["spotify:episode:e", "spotify:local:a#b:c:d:1", undefined, undefined]);
    expect(ids.slice(0, 2)).toEqual([entry("episode:e#1"), entry("local:a#b:c:d:1#1")]);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("appendEntries", () => {
  it("gives what is added ids that were not used", () => {
    const view = { uris: songs("ba"), ids: [entry("b#1"), entry("a#2")] };
    expect(appendEntries(view, [song("a"), song("c"), song("a")])).toEqual({
      uris: songs("baaca"),
      ids: ["b#1", "a#2", "a#3", "c#1", "a#4"].map(entry),
    });
  });
});

describe("identify and findEntries", () => {
  const known = { uris: songs("aba"), ids: numberEntries(songs("aba")) };

  it("finds entries by the last read", () => {
    const now = identify(songs("aba"), known);
    expect(now.changed).toBe(false);
    expect(findEntries(now, known, [entry("a#2"), entry("b#1"), entry("a#2")])).toEqual([2, 1]);
  });

  it("finds them without a last read, by counting", () => {
    expect(findEntries(identify(songs("aab"), undefined), undefined, [entry("a#2")])).toEqual([1]);
  });

  it("keeps the ids of the last read through our own changes", () => {
    // The first copy was removed: the one left is still the second.
    const left = { uris: songs("ba"), ids: [entry("b#1"), entry("a#2")] };
    const now = identify(songs("ba"), left);
    expect(findEntries(now, left, [entry("a#2")])).toEqual([1]);
    expect(findEntries(now, left, [entry("a#1")])).toBeUndefined();
  });

  it("still finds a song there is one of after others changed the playlist", () => {
    const now = identify(songs("cbaa"), known);
    expect(now.changed).toBe(true);
    expect(findEntries(now, known, [entry("b#1")])).toEqual([1]);
  });

  it("does not guess which copy was meant after others changed the playlist", () => {
    expect(findEntries(identify(songs("ba"), known), known, [entry("a#1")])).toBeUndefined();
    expect(findEntries(identify(songs("baa"), known), known, [entry("a#1")])).toBeUndefined();
    expect(findEntries(identify(songs("abba"), known), known, [entry("b#1")])).toBeUndefined();
    expect(findEntries(identify(songs("aa"), known), known, [entry("b#1")])).toBeUndefined();
  });
});

describe("planRemoval", () => {
  it("removes songs no copy of which stays", () => {
    expect(planRemoval(songs("abac"), new Set([0, 2, 3]))).toEqual({ whole: [song("a"), song("c")], repeated: [] });
  });

  it("puts the copies that stay back where they were", () => {
    expect(planRemoval(songs("abaca"), new Set([0, 1]))).toEqual({
      whole: [song("b")],
      repeated: [{ uri: song("a"), keptAt: [0, 2] }],
    });
  });

  it("comes out right, whatever is removed", () => {
    const random = randomness(7);
    for (let run = 0; run < 300; run += 1) {
      const uris = songs(Array.from({ length: 12 }, () => "abcd-"[random(5)]).join(""));
      const going = new Set(uris.flatMap((uri, i) => (uri !== undefined && random(3) === 0 ? [i] : [])));
      const plan = planRemoval(uris, going);
      let list = uris.filter((uri) => uri === undefined || !plan.whole.includes(uri));
      for (const { uri, keptAt } of plan.repeated) {
        // Deleted, added together where the first belongs, then moved apart.
        list = list.filter((other) => other !== uri);
        list.splice(keptAt[0]!, 0, ...keptAt.map(() => uri));
        list = spreadMoves(keptAt).reduce(moveRange<string | undefined>, list);
      }
      expect(list).toEqual(uris.filter((_, i) => !going.has(i)));
    }
  });
});

describe("rangeMoves", () => {
  it("needs nothing when nothing moves", () => {
    const ids = numberEntries(songs("abc"));
    expect(rangeMoves(ids, ids)).toEqual([]);
  });

  it("moves neighbours together, and only what must move", () => {
    const ids = numberEntries(songs("abcdef"));
    const wanted = applyMove(ids, [ids[1]!, ids[2]!], 7);
    expect(rangeMoves(ids, wanted)).toEqual([{ start: 1, length: 2, before: 6 }]);
  });

  it("splits a long range", () => {
    const ids = numberEntries(Array.from({ length: 250 }, (_, i) => song(`s${i}`)));
    const wanted = [...ids.slice(220), ...ids.slice(0, 220)];
    const moves = rangeMoves(ids, wanted, 20);
    expect(moves.map((m) => m.length)).toEqual([20, 10]);
    expect(moves.reduce(moveRange<EntryId>, ids)).toEqual(wanted);
  });

  it("arrives at any order", () => {
    const random = randomness(3);
    for (let run = 0; run < 300; run += 1) {
      const ids = numberEntries(songs(Array.from({ length: 10 }, () => "abcd-"[random(5)]).join("")));
      const moved = ids.filter(() => random(3) === 0).sort(() => random(3) - 1);
      const wanted = applyMove(ids, moved, 1 + random(ids.length + 1));
      expect(rangeMoves(ids, wanted).reduce(moveRange<EntryId>, ids)).toEqual(wanted);
    }
  });
});
