import { describe, expect, it } from "vitest";

import { tagId } from "../ids.js";
import type { EntryId, PlaylistId } from "../model.js";
import { SpotifyClient } from "./client.js";
import { FakeSpotify } from "./fake-spotify.test-support.js";
import { RemovalInterrupted } from "./playlists.js";
import { SpotifyService } from "./service.js";

const s = (native: string) => tagId<never>("spotify", native);
const P = tagId<PlaylistId>("spotify", "p");
const LOCAL = "spotify:local:Me:Demos:Take+1:61";
const EPISODE = "spotify:episode:e1";

const song = (name: string) => `spotify:track:${name}`;
/** "abL" -> the URIs of songs a and b and a local file; E an episode, - an unreadable item. */
const uris = (text: string) =>
  text.split("").map((c) => (c === "L" ? LOCAL : c === "E" ? EPISODE : c === "-" ? undefined : song(c)));
const letters = (list: readonly (string | undefined)[]) =>
  list
    .map((uri) => (uri === undefined ? "-" : uri === LOCAL ? "L" : uri === EPISODE ? "E" : uri.split(":")[2]))
    .join("");

function world(playlist?: string) {
  const fake = new FakeSpotify();
  for (const name of "abcdefgh") {
    fake.addTrack(name, { name: `Song ${name}` });
  }
  fake.episodes.set("e1", { name: "Pilot", show: "The Show" });
  const open = () =>
    new SpotifyService(new SpotifyClient({ tokens: fake.tokens, fetchImpl: fake.fetchImpl, sleep: async () => {} }));
  if (playlist !== undefined) {
    fake.seedPlaylist("p", uris(playlist));
  }
  const service = open();
  return {
    fake,
    service,
    open,
    read: async () => (await service.getPlaylistTracks(P)).map((t) => t.playlistTrackId!),
    now: () => letters(fake.uris("p")),
    writes: (from = 0) => fake.calls(from).filter((call) => !call.startsWith("GET")),
  };
}

const entry = (native: string) => tagId<EntryId>("spotify", native);

describe("reading a playlist", () => {
  it("names entries by song and copy, and marks what is not a song", async () => {
    const { service } = world("abaEL");
    const tracks = await service.getPlaylistTracks(P);
    expect(tracks.map((t) => t.playlistTrackId)).toEqual(
      ["a#1", "b#1", "a#2", "episode:e1#1", "local:Me:Demos:Take+1:61#1"].map(entry),
    );
    expect(tracks.map((t) => t.other)).toEqual([undefined, undefined, undefined, "episode", "local"]);
    expect(tracks[0]).toMatchObject({ title: "Song a", addedAt: expect.stringMatching(/^2026-/) });
  });

  it("reads a long one in full", async () => {
    const { fake, service } = world();
    const names = Array.from({ length: 230 }, (_, i) => `n${i}`);
    names.forEach((name) => fake.addTrack(name));
    fake.seedPlaylist("p", [...names.map(song), LOCAL]);
    const tracks = await service.getPlaylistTracks(P);
    expect(tracks).toHaveLength(231);
    expect(tracks[229]!.id).toBe("spotify:n229");
    expect(tracks[230]!.other).toBe("local");
  });

  it("leaves out what Spotify no longer shows", async () => {
    expect((await world("a-b").service.getPlaylistTracks(P)).map((t) => t.id)).toEqual(["spotify:a", "spotify:b"]);
  });

  it("reads a long one again when it changed meanwhile", async () => {
    const { fake, service } = world();
    const names = Array.from({ length: 150 }, (_, i) => `n${i}`);
    names.forEach((name) => fake.addTrack(name));
    fake.seedPlaylist("p", names.map(song));
    let changes = 1;
    fake.before = ({ path }) => {
      if (path === "/playlists/p/items" && changes-- > 0) {
        fake.edit("p", (list) => list.slice(1));
      }
    };
    expect((await service.getPlaylistTracks(P)).map((t) => t.id)).toEqual(names.slice(1).map(s));
  });

  it("gives up when it keeps changing", async () => {
    const { fake, service } = world();
    const names = Array.from({ length: 300 }, (_, i) => `n${i}`);
    names.forEach((name) => fake.addTrack(name));
    fake.seedPlaylist("p", names.map(song));
    fake.before = ({ path }) => {
      if (path === "/playlists/p/items") {
        fake.edit("p", (list) => list.slice(1));
      }
    };
    await expect(service.getPlaylistTracks(P)).rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("adding to a playlist", () => {
  it("adds in batches, keeping order and repeats", async () => {
    const { service, fake, writes } = world("a");
    const many = Array.from({ length: 250 }, (_, i) => "bcbd"[i % 4]!);
    await service.addTracksToPlaylist(P, many.map(s));
    expect(letters(fake.uris("p"))).toBe("a" + many.join(""));
    expect(writes()).toHaveLength(3);
  });

  it("adds an episode", async () => {
    const { service, now } = world("a");
    await service.addTracksToPlaylist(P, [s("episode:e1")]);
    expect(now()).toBe("aE");
  });

  it("refuses local files, which Spotify cannot add, before adding anything", async () => {
    const { service, fake } = world("a");
    await expect(service.addTracksToPlaylist(P, [s("b"), s("local:Me:Demos:Take+1:61")])).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/local file/),
    });
    expect(fake.requests).toBe(0);
  });
});

describe("removing from a playlist", () => {
  it("removes more than fit in one request", async () => {
    const { fake, service, writes } = world();
    const names = Array.from({ length: 260 }, (_, i) => `n${i}`);
    names.forEach((name) => fake.addTrack(name));
    fake.seedPlaylist("p", names.map(song));
    const ids = (await service.getPlaylistTracks(P)).map((t) => t.playlistTrackId!);
    await service.removeTracksFromPlaylist(P, [...ids.slice(0, 120), ...ids.slice(130)]);
    expect(fake.uris("p")).toEqual(names.slice(120, 130).map(song));
    expect(writes()).toEqual(Array(3).fill("DELETE /playlists/p/items"));
    // The first names no snapshot (a read's is stale); the others name the last answer's.
    expect(fake.seen.filter((r) => r.method === "DELETE").map((r) => r.body["snapshot_id"] !== undefined)).toEqual([false, true, true]);
  });

  it("removes every copy with one request when none stays", async () => {
    const { service, read, now, writes } = world("abac");
    const ids = await read();
    await service.removeTracksFromPlaylist(P, [ids[0]!, ids[2]!]);
    expect(now()).toBe("bc");
    expect(writes()).toEqual(["DELETE /playlists/p/items"]);
  });

  it("removes one copy by putting the others back where they were, touching nothing else", async () => {
    const { fake, service, read, now, writes } = world("abacaLd");
    const ids = await read();
    const dates = new Map(fake.dates("p"));
    await service.removeTracksFromPlaylist(P, [ids[2]!]);
    expect(now()).toBe("abcaLd");
    expect(writes()).toEqual([
      "DELETE /playlists/p/items",
      "POST /playlists/p/items",
      "PUT /playlists/p/items",
    ]);
    const kept = fake.dates("p").filter(([uri]) => uri !== song("a"));
    expect(kept.map(([, at]) => at)).toEqual(kept.map(([uri]) => dates.get(uri)));
  });

  it("says beforehand which songs that is", async () => {
    const { service, read, writes } = world("abacb");
    const ids = await read();
    expect(await service.removesByReAdding(P, [ids[0]!, ids[3]!])).toEqual([s("a")]);
    expect(await service.removesByReAdding(P, [ids[0]!, ids[2]!])).toEqual([]);
    expect(await service.removesByReAdding(P, [])).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("keeps local files, episodes and unreadable items in place", async () => {
    const { service, read, now } = world("LaE-bLcaE");
    const ids = await read();
    // As read (without the unreadable item): L a E b L c a E.
    await service.removeTracksFromPlaylist(P, [ids[3]!, ids[6]!]);
    expect(now()).toBe("LaE-LcE");
    await service.removeTracksFromPlaylist(P, [(await read())[2]!]);
    expect(now()).toBe("La-LcE");
  });

  it("refuses to remove a local file, before any request", async () => {
    const { service, read, fake, now } = world("aL");
    const ids = await read();
    const before = fake.requests;
    await expect(service.removeTracksFromPlaylist(P, ids)).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/local file/),
    });
    expect(fake.requests).toBe(before);
    expect(now()).toBe("aL");
  });

  it("does not take out a copy it could not put the others of back", async () => {
    const { service, read, fake, now, writes } = world("abad");
    const ids = await read();
    const before = fake.requests;
    fake.withdrawn.add("a");
    await expect(service.removeTracksFromPlaylist(P, [ids[0]!, ids[3]!])).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/Song a/),
    });
    expect(writes(before)).toEqual([]);
    expect(now()).toBe("abad");
  });

  it("says so when a copy did not come back", async () => {
    const { service, read, fake } = world("aba");
    const ids = await read();
    fake.droppedOnAdd.add(song("a"));
    const error = await service.removeTracksFromPlaylist(P, [ids[0]!]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemovalInterrupted);
    expect(error).toMatchObject({ kind: "interrupted", missing: [s("a")], message: expect.stringMatching(/Song a/) });
  });

  it("does not remove from a playlist whose songs it cannot see", async () => {
    const { service, fake, writes } = world();
    fake.seedPlaylist("p", uris("ab"), { owner: "them" });
    await expect(service.removeTracksFromPlaylist(P, [entry("a#1")])).rejects.toMatchObject({ kind: "unsupported" });
    expect(writes()).toEqual([]);
  });
});

/** What is in `wanted` more often than in `have`. */
function lacking(wanted: string, have: string): string {
  const left = have.split("");
  return wanted
    .split("")
    .filter((c) => {
      const at = left.indexOf(c);
      if (at >= 0) {
        left.splice(at, 1);
      }
      return at < 0;
    })
    .join("");
}

describe("an interrupted removal", () => {
  const START = "abacLbadbE";
  // Out: the first a, the first b and d; the other copies of a and b stay.
  const GOING = [0, 1, 7];
  const wanted = "acLbabE";

  async function run(nth: number, options: { applied: boolean; once: boolean }) {
    const w = world(START);
    const ids = await w.read();
    const before = w.fake.requests;
    w.fake.failAt(nth, options);
    const error: unknown = await w.service
      .removeTracksFromPlaylist(P, GOING.map((i) => ids[i]!))
      .then(() => undefined, (e: unknown) => e);
    const failed = w.fake.requests - before > nth;
    w.fake.recover();
    return { ...w, error, failed };
  }

  for (const applied of [false, true]) {
    it(`leaves at most one song out, and names it (the last request ${applied ? "went" : "did not go"} through)`, async () => {
      let steps = 0;
      for (; ; steps += 1) {
        const { error, failed, now } = await run(steps, { applied, once: false });
        if (!failed) {
          expect(error).toBeUndefined();
          expect(now()).toBe(wanted);
          break;
        }
        const lost = lacking(wanted, now());
        expect(new Set(lost).size, `${steps}: ${now()}`).toBeLessThanOrEqual(1);
        // Nothing but copies that were there, and everything else in its order.
        expect(lacking(now(), START)).toBe("");
        if (lost !== "") {
          expect(error, `${steps}: ${now()}`).toBeInstanceOf(RemovalInterrupted);
          expect((error as RemovalInterrupted).missing).toEqual(lost.split("").map(s));
          expect((error as RemovalInterrupted).message).toContain(`Song ${lost[0]}`);
          expect((error as RemovalInterrupted).message).toMatch(/add/);
        }
      }
      expect(steps).toBeGreaterThan(6);
    });

    it(`puts everything back after a single failure (which ${applied ? "went" : "did not go"} through)`, async () => {
      for (let step = 0; ; step += 1) {
        const { error, failed, now, read } = await run(step, { applied, once: true });
        expect(lacking(wanted, now()), `${step}: ${now()}`).toBe("");
        if (error === undefined) {
          expect(now(), String(step)).toBe(wanted);
        }
        expect((await read()).length).toBe(now().length);
        if (!failed) {
          break;
        }
      }
    });
  }

  for (const method of ["DELETE", "POST"]) {
    it(`goes on when ${method} was carried out but its answer was lost`, async () => {
      const { fake, service, read, now } = world(START);
      const ids = await read();
      fake.before = (request) => {
        if (request.method === method) {
          fake.before = undefined;
          fake.failAt(0, { applied: true, once: true });
        }
      };
      await service.removeTracksFromPlaylist(P, [ids[0]!]);
      expect(now()).toBe(START.slice(1));
      await service.movePlaylistTracks(P, [ids[2]!], 10);
      expect(now()).toBe("bcLbadbEa");
    });
  }

  it("names the song when the quota runs out in between", async () => {
    const { fake, service, read, now } = world("abac");
    const ids = await read();
    fake.before = ({ method }) => {
      fake.quotaUsedUp = method === "POST";
    };
    const error = await service.removeTracksFromPlaylist(P, [ids[0]!]).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "interrupted", missing: [s("a")], cause: { kind: "quota" } });
    expect(now()).toBe("bc");
  });

  it("is only itself when nothing was removed", async () => {
    const { fake, service, read, now } = world("abac");
    const ids = await read();
    fake.before = ({ method }) => {
      fake.quotaUsedUp = method === "DELETE";
    };
    await expect(service.removeTracksFromPlaylist(P, [ids[0]!])).rejects.toMatchObject({ kind: "quota" });
    expect(now()).toBe("abac");
  });
});

describe("moving in a playlist", () => {
  it("moves entries in the order given, by range, keeping added dates", async () => {
    const { fake, service, read, now } = world("abcdefgh");
    const dates = new Map(fake.dates("p"));
    const ids = await read();
    const before = fake.requests;
    await service.movePlaylistTracks(P, [ids[6]!, ids[1]!, ids[2]!], 5);
    expect(now()).toBe("adgbcefh");
    expect(new Map(fake.dates("p"))).toEqual(dates);
    const puts = fake.seen.slice(before).filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts.map((r) => typeof r.body["snapshot_id"])).toEqual(["undefined", "string"]);
  });

  it("moves to the start and to the end", async () => {
    const { service, read, now } = world("abcd");
    const ids = await read();
    await service.movePlaylistTracks(P, [ids[2]!], 1);
    expect(now()).toBe("cabd");
    await service.movePlaylistTracks(P, [ids[0]!, ids[2]!], 5);
    expect(now()).toBe("bdac");
  });

  it("makes no write when everything is in place", async () => {
    const { service, read, writes } = world("abcd");
    const ids = await read();
    await service.movePlaylistTracks(P, [ids[1]!], 2);
    await service.movePlaylistTracks(P, [], 1);
    expect(writes()).toEqual([]);
  });

  it("keeps unreadable items in place, and counts places as they were read", async () => {
    const { service, read, now } = world("a-bLcE-d");
    const ids = await read();
    // As read: a b L c E d.
    await service.movePlaylistTracks(P, [ids[0]!, ids[2]!], 4);
    expect(now()).toBe("-baLcE-d");
    await service.movePlaylistTracks(P, [ids[4]!], 7);
    expect(now()).toBe("-baLc-dE");
  });

  it("tells copies of a song apart", async () => {
    const { fake, service, read } = world("abac");
    const ids = await read();
    const [first] = fake.dates("p");
    await service.movePlaylistTracks(P, [ids[0]!], 5);
    expect(fake.dates("p").at(-1)).toEqual(first);
  });

  it("splits a long range", async () => {
    const { fake, service } = world();
    const names = Array.from({ length: 240 }, (_, i) => `n${i}`);
    names.forEach((name) => fake.addTrack(name));
    fake.seedPlaylist("p", names.map(song));
    const ids = (await service.getPlaylistTracks(P)).map((t) => t.playlistTrackId!);
    await service.movePlaylistTracks(P, ids.slice(0, 110), 241);
    expect(fake.uris("p")).toEqual([...names.slice(110), ...names.slice(0, 110)].map(song));
  });

  it("merges with a change made between its writes", async () => {
    const { fake, service, read, now } = world("abcdefgh");
    const ids = await read();
    let puts = 0;
    fake.before = ({ method }) => {
      if (method === "PUT" && ++puts === 2) {
        fake.before = undefined;
        // Somebody takes "h" out, keeping the others as they are.
        fake.playlists.get("p")!.snapshots.set("theirs", fake.current("p").filter((e) => e.uri !== song("h")));
      }
    };
    await service.movePlaylistTracks(P, [ids[6]!, ids[1]!, ids[2]!], 5);
    expect(now()).toBe("adgbcef");
  });

  // Live, a read names a stale snapshot; a DELETE against it removed nothing,
  // and taking out one copy of a repeated song added another (2026-11-23).
  // Review: with no snapshot to name, a copy added meanwhile would go with the others.
  it("writes nothing when the playlist changed while it was getting ready", async () => {
    const { fake, service, read, now } = world("abca");
    const ids = await read();
    fake.before = ({ method, path }) => {
      if (method === "GET" && path.startsWith("/tracks")) {
        fake.before = undefined;
        fake.edit("p", (list) => [...list, song("a")]);
      }
    };
    await expect(service.removeTracksFromPlaylist(P, [ids[3]!])).rejects.toMatchObject({ kind: "conflict" });
    expect(now()).toBe("abcaa");
    expect(fake.seen.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("takes out one copy of a repeated song though a read names a stale snapshot", async () => {
    const { fake, service, read, now } = world("abca");
    fake.edit("p", (list) => [...list, song("b")]);
    const ids = await read();
    await service.removeTracksFromPlaylist(P, [ids[3]!]);
    expect(now()).toBe("abcb");
  });
});

describe("a playlist changed between reading and writing", () => {
  it("still finds a song there is one of", async () => {
    const { fake, service, read, now } = world("abca");
    const ids = await read();
    fake.edit("p", (list) => [song("h"), ...list]);
    await service.removeTracksFromPlaylist(P, [ids[1]!]);
    expect(now()).toBe("haca");
  });

  it("stops when an entry is gone, or it cannot tell which copy was meant", async () => {
    for (const [change, going] of [
      [(list: (string | undefined)[]) => list.filter((uri) => uri !== song("b")), 1],
      [(list: (string | undefined)[]) => list.slice(1), 0],
      [(list: (string | undefined)[]) => list.slice(1), 3],
      [(list: (string | undefined)[]) => [song("a"), ...list], 0],
    ] as const) {
      const { fake, service, read, writes, now } = world("abca");
      const ids = await read();
      fake.edit("p", change);
      const left = now();
      await expect(service.removeTracksFromPlaylist(P, [ids[going]!])).rejects.toMatchObject({
        service: "spotify",
        kind: "conflict",
        message: expect.stringMatching(/changed meanwhile/),
      });
      // Nor the second time, without reading again.
      await expect(service.removeTracksFromPlaylist(P, [ids[going]!])).rejects.toMatchObject({ kind: "conflict" });
      expect(writes()).toEqual([]);
      expect(now()).toBe(left);
    }
  });

  it("does not move anything, as places may have shifted", async () => {
    const { fake, service, read, writes } = world("abcd");
    const ids = await read();
    fake.edit("p", (list) => [song("h"), ...list]);
    await expect(service.movePlaylistTracks(P, [ids[3]!], 1)).rejects.toMatchObject({ kind: "conflict" });
    expect(writes()).toEqual([]);
    await expect(world("ab").service.movePlaylistTracks(P, [entry("a#1")], 9)).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("goes on after reading again", async () => {
    const { fake, service, read, now } = world("abca");
    await read();
    fake.edit("p", (list) => list.slice(1));
    const ids = await read();
    await service.movePlaylistTracks(P, [ids[2]!], 1);
    expect(now()).toBe("abc");
  });
});

describe("several changes after one read", () => {
  it("keeps naming the entries that were read", async () => {
    const { service, read, now } = world("abacad");
    const ids = await read();
    await service.removeTracksFromPlaylist(P, [ids[0]!]);
    expect(now()).toBe("bacad");
    // The copy read as the third, though it is now the second.
    await service.movePlaylistTracks(P, [ids[4]!], 1);
    expect(now()).toBe("abacd");
    await service.addTracksToPlaylist(P, [s("a")]);
    await service.removeTracksFromPlaylist(P, [ids[2]!]);
    expect(now()).toBe("abcda");
    await service.removeTracksFromPlaylist(P, [ids[3]!, ids[4]!]);
    expect(now()).toBe("bda");
  });

  it("does not remove the same entry twice", async () => {
    const { service, read, now } = world("aba");
    const ids = await read();
    await service.removeTracksFromPlaylist(P, [ids[0]!]);
    await expect(service.removeTracksFromPlaylist(P, [ids[0]!])).rejects.toMatchObject({ kind: "conflict" });
    expect(now()).toBe("ba");
  });

  it("makes changes asked for at once one after another", async () => {
    const { service, read, now } = world("abacad");
    const ids = await read();
    await Promise.all([
      service.removeTracksFromPlaylist(P, [ids[0]!]),
      service.removeTracksFromPlaylist(P, [ids[2]!]),
      service.movePlaylistTracks(P, [ids[5]!], 1),
      service.addTracksToPlaylist(P, [s("e")]),
    ]);
    expect(now()).toBe("dbcae");
  });

  it("goes on with the next when one fails", async () => {
    const { service, read, now } = world("ab");
    const ids = await read();
    const failing = service.removeTracksFromPlaylist(P, [entry("z#1")]);
    const next = service.removeTracksFromPlaylist(P, [ids[0]!]);
    await expect(failing).rejects.toMatchObject({ kind: "conflict" });
    await next;
    expect(now()).toBe("b");
  });

  it("goes by counting in a new process", async () => {
    const { open, read, now } = world("abac");
    const ids = await read();
    const other = open();
    await other.removeTracksFromPlaylist(P, [ids[0]!]);
    expect(now()).toBe("bac");
    await other.removeTracksFromPlaylist(P, [ids[2]!]);
    expect(now()).toBe("bc");
  });
});
