import { describe, expect, it } from "vitest";

import { tagId, type TrackId } from "../services/ids.js";
import type { Track } from "../services/model.js";
import { SyncAccount } from "../sync/world.test-support.js";
import { MemoryMatches } from "./match.js";
import { commitTransfer, resolveTransfer, type Pick } from "./transfer.js";

const q = (n: number) => tagId<TrackId>("qobuz", n);
const track = (n: number, over: Partial<Track> = {}): Track => ({
  id: q(n),
  title: `Song ${n}`,
  artist: "Artist",
  isrc: `ISRC${n}`,
  duration: 200,
  ...over,
});

function setup() {
  const tidal = new SyncAccount("tidal");
  const client = Object.assign(tidal, {
    createPlaylist: async (name: string) => ({ id: tidal.seed(name, []), name }),
    favourites: [] as TrackId[],
    addFavoriteTracks: async (ids: readonly TrackId[]) => void client.favourites.push(...ids),
    getFavoriteTracks: async () => client.favourites.map((id) => ({ id, title: "x" })),
  });
  return { client, matches: new MemoryMatches() };
}

describe("resolveTransfer", () => {
  it("says what is exact, likely and missing, writing nothing", async () => {
    const { client, matches } = setup();
    client.absent.add(3);
    const plan = await resolveTransfer(client, [track(1), track(2, { title: "Song 2 (Live)" }), track(3)], matches);
    expect(plan.to).toBe("tidal");
    expect(plan.counts).toEqual({ exact: 1, likely: 1, missing: 1 });
    expect(client.writes).toEqual([]);
  });
});

describe("commitTransfer", () => {
  const picks = (...list: [number, number | null, boolean?][]): Pick[] =>
    list.map(([source, match, decided = false]) => ({
      source: q(source),
      track: match === null ? null : tagId<TrackId>("tidal", match),
      decided,
    }));

  it("makes a new playlist there, in order, repeats included", async () => {
    const { client, matches } = setup();
    const result = await commitTransfer(
      client,
      { type: "new", name: "Copy", isPublic: false },
      picks([2, 2], [1, 1], [2, 2]),
      matches,
    );
    expect(client.songs(result.playlistId!)).toEqual([2, 1, 2]);
    expect(result).toMatchObject({ added: 3, leftOut: 0 });
  });

  it("adds to an existing one, and says what did not arrive", async () => {
    const { client, matches } = setup();
    const id = client.seed("Old", [9]);
    client.withdrawn.add(2);
    const result = await commitTransfer(client, { type: "existing", playlistId: id }, picks([1, 1], [2, 2]), matches);
    expect(client.songs(id)).toEqual([9, 1]);
    expect(result).toMatchObject({ added: 1, missing: [tagId("tidal", 2)] });
  });

  it("adds favourites, only new ones", async () => {
    const { client, matches } = setup();
    client.favourites = [tagId("tidal", 1)];
    const result = await commitTransfer(client, { type: "favourites" }, picks([1, 1], [2, 2]), matches);
    expect(client.favourites).toEqual(["tidal:1", "tidal:2"]);
    expect(result.added).toBe(1);
  });

  it("remembers what the user decided, and only that", async () => {
    const { client, matches } = setup();
    await commitTransfer(
      client,
      { type: "new", name: "Copy", isPublic: false },
      picks([1, 1], [2, 7, true], [3, null, true], [4, null]),
      matches,
    );
    expect(matches.recall(q(1), "tidal")).toBeUndefined();
    expect(matches.recall(q(2), "tidal")).toBe("tidal:7");
    expect(matches.recall(q(3), "tidal")).toBeNull();
    expect(matches.recall(q(4), "tidal")).toBeUndefined();
  });

  it("remembers even when writing fails: the user need not decide again", async () => {
    const { client, matches } = setup();
    const id = client.seed("Old", []);
    client.failWrite = 1;
    await expect(
      commitTransfer(client, { type: "existing", playlistId: id }, picks([2, 7, true]), matches),
    ).rejects.toThrow();
    expect(matches.recall(q(2), "tidal")).toBe("tidal:7");
  });

  it("refuses songs of another service, and nothing at all, before writing", async () => {
    const { client, matches } = setup();
    await expect(
      commitTransfer(client, { type: "new", name: "X", isPublic: false }, [{ source: q(1), track: q(1), decided: true }], matches),
    ).rejects.toMatchObject({ kind: "bad-id" });
    await expect(
      commitTransfer(client, { type: "new", name: "X", isPublic: false }, picks([1, null]), matches),
    ).rejects.toThrow(/no songs/i);
    expect(client.writes).toEqual([]);
    expect(matches.recall(q(1), "tidal")).toBeUndefined();
  });
});
