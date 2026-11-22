import { describe, expect, it } from "vitest";

import { applyMove, planOrder, stayingIds, type OrderMove } from "./playlist-order.js";

const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** A small seeded random source, so a failure can be repeated. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function shuffled(ids: readonly number[], random: () => number): number[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Apply a plan, checking that no move anchors on an entry it moves. */
function run(current: readonly number[], moves: readonly OrderMove[]): number[] {
  return moves.reduce<number[]>((list, move) => {
    expect(move.insertBefore).toBeGreaterThanOrEqual(1);
    expect(move.insertBefore).toBeLessThanOrEqual(list.length + 1);
    expect(move.playlistTrackIds).not.toContain(list[move.insertBefore - 1]);
    return applyMove(list, move.playlistTrackIds, move.insertBefore);
  }, [...current]);
}

describe("applyMove", () => {
  // As observed on the live API, November 2026.
  it("places the ids in the order sent", () => {
    expect(applyMove(upTo(10), [5, 1, 8], 1)).toEqual([5, 1, 8, 0, 2, 3, 4, 6, 7, 9]);
  });

  it("goes after the unmoved entries ahead when the anchor itself moves", () => {
    expect(applyMove(upTo(18), [12, 10, 14], 11).slice(8)).toEqual([8, 9, 12, 10, 14, 11, 13, 15, 16, 17]);
    expect(applyMove(upTo(24), [20, 15, 18], 21).slice(13)).toEqual([13, 14, 16, 17, 19, 20, 15, 18, 21, 22, 23]);
  });

  it("moves forward, to the end, and ignores unknown ids", () => {
    expect(applyMove(upTo(12), [5, 3, 4], 11)).toEqual([0, 1, 2, 6, 7, 8, 9, 5, 3, 4, 10, 11]);
    expect(applyMove(upTo(4), [0, 1], 5)).toEqual([2, 3, 0, 1]);
    expect(applyMove(upTo(4), [3, 999], 1)).toEqual([3, 0, 1, 2]);
    expect(applyMove(upTo(3), [2], 0)).toEqual([2, 0, 1]);
  });
});

describe("stayingIds", () => {
  it("is a longest run already in order", () => {
    expect([...stayingIds([1, 2, 3, 4], [4, 1, 2, 3])].sort()).toEqual([1, 2, 3]);
    expect(stayingIds([1, 2, 3], [1, 2, 3]).size).toBe(3);
    expect(stayingIds([], []).size).toBe(0);
  });
});

describe("planOrder", () => {
  it("plans nothing for the same order", () => {
    expect(planOrder([3, 1, 2], [3, 1, 2])).toEqual([]);
    expect(planOrder([], [])).toEqual([]);
  });

  it("makes one request of a drag, in either direction and to the end", () => {
    const list = upTo(1000);
    for (const wanted of [
      applyMove(list, [900], 3),
      applyMove(list, [2], 901),
      applyMove(list, [0], 1001),
      applyMove(list, [10, 500, 700, 20, 3], 1),
      applyMove(list, [10, 11, 12], 500),
    ]) {
      const moves = planOrder(list, wanted);
      expect(moves).toHaveLength(1);
      expect(run(list, moves)).toEqual(wanted);
    }
  });

  it("re-sends a reversal of 1,400 entries in seven blocks", () => {
    const list = upTo(1400);
    const wanted = [...list].reverse();
    const moves = planOrder(list, wanted);
    expect(moves).toHaveLength(7);
    expect(run(list, moves)).toEqual(wanted);
  });

  it("leaves the unchanged ends alone", () => {
    const wanted = [0, 1, 4, 3, 2, 5, 6];
    const moves = planOrder(upTo(7), wanted, 3);
    expect(run(upTo(7), moves)).toEqual(wanted);
    expect(moves.flatMap((m) => m.playlistTrackIds).every((id) => id >= 2 && id <= 4)).toBe(true);
  });

  it("reaches any order within the block limit", () => {
    const random = seeded(7);
    for (let round = 0; round < 400; round += 1) {
      const size = 1 + Math.floor(random() * 30);
      const block = 1 + Math.floor(random() * 6);
      const current = shuffled(upTo(size), random);
      // Mostly small edits, sometimes a whole shuffle.
      let wanted: number[] = current;
      if (random() < 0.3) {
        wanted = shuffled(current, random);
      } else {
        for (let edit = 0; edit < 1 + random() * 3; edit += 1) {
          const picked = shuffled(current, random).slice(0, 1 + Math.floor(random() * 4));
          wanted = applyMove(wanted, picked, 1 + Math.floor(random() * (size + 1)));
        }
      }
      const moves = planOrder(current, wanted, block);
      expect(run(current, moves)).toEqual(wanted);
      expect(moves.length).toBeLessThanOrEqual(Math.ceil(size / block));
      expect(moves.every((m) => m.playlistTrackIds.length <= block)).toBe(true);
    }
  });

  it("refuses an order that is not the same entries", () => {
    expect(() => planOrder([1, 2], [1, 3])).toThrow();
    expect(() => planOrder([1, 2], [1])).toThrow();
    expect(() => planOrder([1, 2], [1, 1])).toThrow();
    expect(() => planOrder([1, 1], [1, 1])).toThrow();
  });
});
