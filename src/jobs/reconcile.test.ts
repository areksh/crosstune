import { describe, expect, it } from "vitest";

import { planMoves, reconcile, type ReconcileInput } from "./reconcile.js";

const desired = (...trackIds: number[]) => trackIds.map((trackId) => ({ trackId, source: "album:x" }));
/** Present entries: playlist-track id = 100 + track id unless given as [ptid, track]. */
const present = (...items: (number | [number, number])[]) =>
  items.map((item) =>
    Array.isArray(item)
      ? { playlistTrackId: item[0], trackId: item[1] }
      : { playlistTrackId: 100 + item, trackId: item },
  );

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  return {
    mode: "respect",
    desired: [],
    complete: true,
    present: [],
    owned: [],
    dismissed: [],
    ...overrides,
  };
}

describe("reconcile (respect edits)", () => {
  it("adds desired tracks not yet present, in desired order", () => {
    const plan = reconcile(input({ desired: desired(3, 1, 2), present: present(1) }));
    expect(plan.add).toEqual([3, 2]);
    expect(plan.remove).toEqual([]);
  });

  it("dismisses an owned entry the user removed and does not add it again", () => {
    const plan = reconcile(
      input({
        desired: desired(1, 2),
        present: present(2),
        owned: present(1, 2),
      }),
    );
    expect(plan.newlyDismissed).toEqual([1]);
    expect(plan.dismissed).toEqual([1]);
    expect(plan.add).toEqual([]);
    expect(plan.keptOwned).toEqual(present(2));
  });

  it("keeps dismissed tracks out on later runs", () => {
    const plan = reconcile(input({ desired: desired(1, 2), present: present(2), owned: present(2), dismissed: [1] }));
    expect(plan.add).toEqual([]);
    expect(plan.newlyDismissed).toEqual([]);
    expect(plan.dismissed).toEqual([1]);
  });

  it("dismisses everything when the user removed every entry, adding nothing", () => {
    const plan = reconcile(input({ desired: desired(1, 2, 3), present: [], owned: present(1, 2, 3) }));
    expect(plan.newlyDismissed).toEqual([1, 2, 3]);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("never removes hand-added entries", () => {
    const plan = reconcile(input({ desired: desired(1), present: present(1, 9), owned: present(1) }));
    expect(plan.remove).toEqual([]);
  });

  it("removes owned entries that are no longer desired (aged out)", () => {
    const plan = reconcile(input({ desired: desired(2), present: present(1, 2), owned: present(1, 2) }));
    expect(plan.remove).toEqual([101]);
    expect(plan.keptOwned).toEqual(present(2));
  });

  it("does not add a desired track the user already added by hand", () => {
    const plan = reconcile(input({ desired: desired(9), present: present(9) }));
    expect(plan.add).toEqual([]);
  });

  it("tells duplicate copies apart by playlist-track id", () => {
    // Track 1 twice: the job owns entry 500, the user added entry 501.
    const plan = reconcile(
      input({ desired: [], present: present([500, 1], [501, 1]), owned: present([500, 1]) }),
    );
    expect(plan.remove).toEqual([500]);
  });
});

describe("reconcile (strict mirror)", () => {
  it("removes hand-added entries", () => {
    const plan = reconcile(input({ mode: "mirror", desired: desired(1), present: present(1, 9), owned: present(1) }));
    expect(plan.remove).toEqual([109]);
  });

  it("removes extra copies of a desired track", () => {
    const plan = reconcile(input({ mode: "mirror", desired: desired(1), present: present([500, 1], [501, 1]) }));
    expect(plan.remove).toEqual([501]);
    expect(plan.keptOwned).toEqual(present([500, 1]));
  });

  it("re-adds a track the user removed and keeps no dismissed list", () => {
    const plan = reconcile(
      input({ mode: "mirror", desired: desired(1, 2), present: present(2), owned: present(1, 2), dismissed: [7] }),
    );
    expect(plan.add).toEqual([1]);
    expect(plan.dismissed).toEqual([]);
    expect(plan.newlyDismissed).toEqual([]);
  });

  it("owns every entry it keeps", () => {
    const plan = reconcile(input({ mode: "mirror", desired: desired(1, 9), present: present(1, 9), owned: present(1) }));
    expect(plan.keptOwned).toEqual(present(1, 9));
  });
});

describe("reconcile (incomplete resolve)", () => {
  it("removes nothing and reports what it withheld", () => {
    const plan = reconcile(
      input({ desired: desired(2, 3), complete: false, present: present(1, 2), owned: present(1, 2) }),
    );
    expect(plan.remove).toEqual([]);
    expect(plan.withheldRemovals).toBe(1);
    expect(plan.add).toEqual([3]);
    expect(plan.keptOwned).toEqual(present(1, 2));
  });

  it("withholds mirror removals too", () => {
    const plan = reconcile(input({ mode: "mirror", desired: [], complete: false, present: present(1, 9) }));
    expect(plan.remove).toEqual([]);
    expect(plan.withheldRemovals).toBe(2);
  });
});

/** Apply moves the way Qobuz does (in front of the 1-based position counted before the move). */
function applyMoves<T extends { playlistTrackId: number }>(
  list: T[],
  moves: { playlistTrackIds: number[]; insertBefore: number }[],
): T[] {
  let current = [...list];
  for (const move of moves) {
    const moving = new Set(move.playlistTrackIds);
    const anchor = current[move.insertBefore - 1];
    const rest = current.filter((entry) => !moving.has(entry.playlistTrackId));
    const moved = current.filter((entry) => moving.has(entry.playlistTrackId));
    const at = anchor === undefined ? rest.length : rest.indexOf(anchor);
    current = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  }
  return current;
}

const entries = (...ranks: (number | undefined)[]) =>
  ranks.map((rank, index) => ({ playlistTrackId: index + 1, ...(rank !== undefined && { rank }) }));

describe("planMoves", () => {
  it("does nothing when the entries are in order", () => {
    expect(planMoves(entries(0, 1, 2))).toEqual([]);
  });

  it("moves new entries appended at the end to the top when they are the newest", () => {
    const list = entries(2, 3, 4, 0, 1);
    const moved = applyMoves(list, planMoves(list));
    expect(moved.map((e) => e.rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("orders a first run whose new entries outnumber the old ones", () => {
    const list = entries(4, 0, 1, 2, 3);
    const moved = applyMoves(list, planMoves(list));
    expect(moved.map((e) => e.rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leaves hand-added entries where they are", () => {
    const list = entries(undefined, 1, undefined, 0);
    const moves = planMoves(list);
    expect(moves.flatMap((m) => m.playlistTrackIds)).not.toContain(1);
    expect(moves.flatMap((m) => m.playlistTrackIds)).not.toContain(3);
    const moved = applyMoves(list, moves);
    expect(moved.filter((e) => e.rank !== undefined).map((e) => e.rank)).toEqual([0, 1]);
  });

  it("sorts any arrangement with the fewest moves an LIS allows", () => {
    // Deterministic pseudo-random permutations, with hand-added entries mixed in.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round += 1) {
      const n = 1 + Math.floor(random() * 12);
      const ranks: (number | undefined)[] = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
      }
      if (random() < 0.5) {
        ranks.splice(Math.floor(random() * n), 0, undefined);
      }
      const list = entries(...ranks);
      const moved = applyMoves(list, planMoves(list));
      const ranked = moved.filter((e) => e.rank !== undefined).map((e) => e.rank);
      expect(ranked).toEqual([...ranked].sort((a, b) => (a ?? 0) - (b ?? 0)));
    }
  });
});
