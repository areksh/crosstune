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
});
