import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

/** A worker whose completion can be released out of order, tracking in-flight count. */
function controllable() {
  const release = new Map<number, () => void>();
  let active = 0;
  let maxActive = 0;
  const worker = (item: number): Promise<number> =>
    new Promise<number>((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      release.set(item, () => {
        active -= 1;
        resolve(item * 10);
      });
    });
  return { worker, release, get maxActive() { return maxActive; } };
}

describe("mapWithConcurrency", () => {
  it("returns results in input order even when work finishes out of order", async () => {
    const { worker, release } = controllable();
    const promise = mapWithConcurrency([1, 2, 3], 3, worker);
    await Promise.resolve();

    release.get(3)!();
    release.get(1)!();
    release.get(2)!();

    expect(await promise).toEqual([10, 20, 30]);
  });

  it("runs at most `limit` workers at once", async () => {
    const tracker = controllable();
    const promise = mapWithConcurrency([1, 2, 3, 4, 5], 2, tracker.worker);
    await Promise.resolve();

    // Only two may be in flight before any completes.
    expect(tracker.maxActive).toBe(2);

    // Drain in order; each completion frees a slot for the next item.
    for (const item of [1, 2, 3, 4, 5]) {
      tracker.release.get(item)?.();
      await Promise.resolve();
    }
    await promise;
    expect(tracker.maxActive).toBe(2);
  });

  it("handles an empty list without invoking the worker", async () => {
    let called = false;
    const result = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it("caps the pool at the item count when limit exceeds it", async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(result).toEqual([2, 3]);
  });

  it("runs one at a time when the limit is zero, negative, fractional or not a number", async () => {
    for (const limit of [0, -3, Number.NaN, 0.5]) {
      const result = await mapWithConcurrency([1, 2, 3], limit, async (n) => n * 2);
      expect(result).toEqual([2, 4, 6]);
      expect(Object.keys(result)).toEqual(["0", "1", "2"]);
    }
  });

  it("floors a fractional limit", async () => {
    const tracker = controllable();
    const promise = mapWithConcurrency([1, 2, 3, 4], 2.9, tracker.worker);
    await Promise.resolve();
    expect(tracker.maxActive).toBe(2);
    for (const item of [1, 2, 3, 4]) {
      tracker.release.get(item)?.();
      await Promise.resolve();
    }
    expect(await promise).toEqual([10, 20, 30, 40]);
  });

  it("stops claiming new items once one has failed, and rejects with the first error", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 100 }, (_, index) => index);
    const promise = mapWithConcurrency(items, 3, async (n) => {
      started.push(n);
      await Promise.resolve();
      if (n === 1) {
        throw new Error("first");
      }
      if (n === 2) {
        throw new Error("second");
      }
      return n;
    });
    await expect(promise).rejects.toThrow("first");
    // Let any runner that was still going finish its current item.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The three first items were in flight; nothing beyond a few more is asked for.
    expect(started.length).toBeLessThan(10);
  });
});
