import { describe, expect, it } from "vitest";

import { describeServiceContract } from "../contract.test-support.js";
import { applyMove } from "../../features/playlist-order.js";
import { tagId } from "../ids.js";
import type { EntryId, PlaylistId, Track } from "../model.js";
import type { TokenSource } from "../tokens.js";
import { TidalClient } from "./client.js";
import { FakeTidal } from "./fake-tidal.test-support.js";
import { TidalService } from "./service.js";

const t = (native: string | number) => tagId<never>("tidal", native);

function connect(fake: FakeTidal, tokens: TokenSource = fake.tokens()) {
  const waits: number[] = [];
  const client = new TidalClient({
    tokens,
    fetchImpl: fake.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { service: new TidalService(client), waits };
}

/** An account with a small catalogue. */
function setup() {
  const fake = new FakeTidal();
  fake.add("artists", "7", { name: "Portishead" });
  fake.add("artists", "8", { name: "Tricky" });
  fake.add("artworks", "art", {
    mediaType: "IMAGE",
    files: [{ href: "https://img.example/320.jpg", meta: { width: 320, height: 320 } }],
  });
  fake.add(
    "albums",
    "70",
    { title: "Dummy", albumType: "ALBUM", barcodeId: "0042282852229", numberOfItems: 2, releaseDate: "1994-08-22", mediaTags: [] },
    { artists: [{ type: "artists", id: "7" }], coverArt: [{ type: "artworks", id: "art" }] },
  );
  for (let n = 1; n <= 120; n += 1) {
    fake.addTrack(String(n), { album: "70" });
  }
  fake.addTrack("1", { album: "70", isrc: "GBAAA0000001" });
  fake.addTrack("999", { title: "Withdrawn" });
  fake.unavailable.add("tracks:999");
  fake.add("videos", "1", { title: "Glory Box (video)", duration: "PT4M" }, { artists: [{ type: "artists", id: "7" }] });
  return { fake, ...connect(fake) };
}

const tracks = (...ids: Array<string | number>) => ids.map((id) => ({ type: "tracks", id: String(id) }));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const natives = (list: readonly Track[]) => list.map((track) => String(track.id).replace("tidal:", ""));
const entries = (list: readonly Track[]): EntryId[] => list.map((track) => track.playlistTrackId!);
const sent = (fake: FakeTidal, method: string) => fake.requests.filter((r) => r.method === method);

describeServiceContract("tidal", () => {
  const { fake, service } = setup();
  return {
    service,
    tracks: [1, 2, 3, 4].map(t),
    dropped: t(999),
    albums: [t(70)],
    artists: [t(7)],
    recording: { isrc: "GBAAA0000001", track: t(1), absent: "GBZZZ9999999" },
    requests: () => fake.requests.length,
  };
});

describe("TidalService account", () => {
  it("knows who is signed in once loaded", async () => {
    const { service } = setup();
    expect(service.account()).toBeUndefined();
    expect(await service.load()).toEqual({ id: "tidal:77", displayName: "John Rambo" });
    expect(service.account()).toEqual({ id: "tidal:77", displayName: "John Rambo" });
  });

  it("asks once, however many need it", async () => {
    const { fake, service } = setup();
    await Promise.all([service.load(), service.getTrack(t(1)), service.getTrack(t(2))]);
    await service.load();
    expect(fake.log().filter((line) => line === "GET /users/me")).toHaveLength(1);
  });

  it("asks again after a failure", async () => {
    const { fake, service } = setup();
    fake.instead.push({ status: 400 });
    await expect(service.load()).rejects.toMatchObject({ kind: "api-response" });
    expect(service.account()).toBeUndefined();
    expect((await service.load()).id).toBe("tidal:77");
  });

  it("asks for the user's own catalogue where an endpoint takes a country", async () => {
    const { fake, service } = setup();
    await service.getTrack(t(1));
    await service.getFavoriteTracks();
    expect(fake.requests.find((r) => r.path === "/tracks/1")!.query.get("countryCode")).toBe("NO");
    expect(fake.requests.at(-1)!.query.has("countryCode")).toBe(false);
  });

  it("does without a country that is not known", async () => {
    const { fake, service } = setup();
    fake.user.attributes.country = "";
    await service.getTrack(t(1));
    expect(fake.requests.at(-1)!.query.has("countryCode")).toBe(false);
  });
});

describe("TidalService sign-in and limits", () => {
  it("renews a stale token once for several requests", async () => {
    const { fake } = setup();
    const { service } = connect(fake, fake.tokens("old"));
    const found = await Promise.all([1, 2, 3].map((n) => service.getTrack(t(n))));
    expect(natives(found)).toEqual(["1", "2", "3"]);
    expect(fake.renewals).toBe(1);
  });

  it("waits when asked to", async () => {
    const { fake, service, waits } = setup();
    fake.instead.push({ status: 429, headers: { "Retry-After": "4" } });
    await service.load();
    expect(waits).toEqual([4000]);
  });

  it("adds once even when TIDAL's answer is lost", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", []);
    fake.loseAnswers = 1;
    await service.addTracksToPlaylist(t(id), [t(1), t(2)]);
    expect(fake.contents(id)).toEqual(["tracks:1", "tracks:2"]);
    expect(sent(fake, "POST")).toHaveLength(2);
  });
});

describe("TidalService playlists", () => {
  it("lists the user's own, all pages, marked as theirs", async () => {
    const { fake, service } = setup();
    fake.seedPlaylist("Theirs", [], { owner: "99" });
    const ids = range(1, 45).map((n) => fake.seedPlaylist(`Mine ${n}`, tracks(1)));
    const read = await service.getUserPlaylists();
    expect(new Set(read.map((p) => p.id))).toEqual(new Set(ids.map(t)));
    expect(read.every((p) => p.ownerId === "tidal:77")).toBe(true);
    expect(read[0]).toMatchObject({ trackCount: 1, isPublic: false });
  });

  it("says whose another's playlist is", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Theirs", tracks(1), { owner: "99" });
    expect(await service.getPlaylist(t(id))).toMatchObject({
      name: "Theirs",
      ownerId: "tidal:99",
      url: `https://tidal.com/playlist/${id}`,
    });
  });

  it("reads every page in order, with entry ids and dates", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Long", tracks(...range(1, 45)));
    const read = await service.getPlaylistTracks(t(id));
    expect(natives(read)).toEqual(range(1, 45).map(String));
    expect(entries(read)).toEqual(fake.itemIds(id).map(t));
    expect(read[44]).toMatchObject({
      title: "Track 45",
      artist: "Portishead",
      artistId: "tidal:7",
      album: "Dummy",
      albumId: "tidal:70",
      image: "https://img.example/320.jpg",
      addedAt: expect.stringMatching(/^2026-01-01T/),
    });
  });

  it("keeps videos and unavailable tracks in their places", async () => {
    const { fake, service } = setup();
    fake.hidden.add("tracks:2");
    const id = fake.seedPlaylist("Mixed", [...tracks(1, 2), { type: "videos", id: "1" }, ...tracks(3)]);
    const read = await service.getPlaylistTracks(t(id));
    expect(read.map((track) => [track.id, track.title, track.other])).toEqual([
      ["tidal:1", "Track 1", undefined],
      ["tidal:2", "Unavailable track", undefined],
      ["tidal:videos:1", "Glory Box (video)", "video"],
      ["tidal:3", "Track 3", undefined],
    ]);
    expect(new Set(entries(read)).size).toBe(4);
  });

  it("never reads a broken answer as an empty playlist", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(1));
    await service.load();
    fake.instead.push({ status: 200, body: { links: { self: "/" } } });
    await expect(service.getPlaylistTracks(t(id))).rejects.toMatchObject({ kind: "api-response" });
  });

  it("works on ids that need encoding", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Odd", tracks(1, 2), { id: "a/b c?d#e%" });
    const read = await service.getPlaylistTracks(t(id));
    await service.removeTracksFromPlaylist(t(id), entries(read).slice(0, 1));
    expect(fake.contents(id)).toEqual(["tracks:2"]);
    expect((await service.getPlaylist(t(id))).name).toBe("Odd");
    await expect(service.getPlaylist(t(".."))).rejects.toMatchObject({ kind: "bad-id" });
  });

  it("makes a playlist unlisted unless it is to be public", async () => {
    const { fake, service } = setup();
    const made = await service.createPlaylist("Quiet", { description: "d" });
    expect(made).toMatchObject({ name: "Quiet", description: "d", isPublic: false, ownerId: "tidal:77" });
    expect((await service.createPlaylist("Loud", { isPublic: true })).isPublic).toBe(true);
    expect([...fake.playlists.values()].map((p) => p.accessType)).toEqual(["UNLISTED", "PUBLIC"]);
  });

  it("changes only what is asked", async () => {
    const { fake, service } = setup();
    const { id } = await service.createPlaylist("Old", { description: "kept" });
    expect(await service.updatePlaylist(id, { name: "New" })).toMatchObject({ id, name: "New", description: "kept" });
    expect((await service.updatePlaylist(id, { isPublic: true })).isPublic).toBe(true);
    await service.updatePlaylist(id, { description: "" });
    expect([...fake.playlists.values()][0]!.description).toBe("");
    const writes = sent(fake, "PATCH").length;
    expect((await service.updatePlaylist(id, {})).name).toBe("New");
    expect(sent(fake, "PATCH")).toHaveLength(writes);
  });
});

describe("TidalService adding", () => {
  it("adds 50 at a time, in order, copies and all", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(3));
    const order = [...range(1, 60), 3, 3, ...range(1, 60)];
    await service.addTracksToPlaylist(t(id), order.map(t));
    expect(fake.contents(id)).toEqual([3, ...order].map((n) => `tracks:${n}`));
    expect(sent(fake, "POST").map((r) => r.body.data.length)).toEqual([50, 50, 22]);
    expect(sent(fake, "POST").every((r) => r.body.meta.onDuplicates === "ADD")).toBe(true);
    expect(new Set(sent(fake, "POST").map((r) => r.key)).size).toBe(3);
  });

  it("adds a video as one", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", []);
    await service.addTracksToPlaylist(t(id), [t(1), t("videos:1")]);
    expect(fake.contents(id)).toEqual(["tracks:1", "videos:1"]);
  });

  it("says when the playlist is full", async () => {
    const { fake, service } = setup();
    fake.maxPlaylistItems = 1;
    const id = fake.seedPlaylist("Mix", tracks(1));
    await expect(service.addTracksToPlaylist(t(id), [t(2)])).rejects.toMatchObject({ kind: "playlist-full" });
  });
});

describe("TidalService removing", () => {
  it("knows the entries it added or read, and does not read again", async () => {
    const { fake, service } = setup();
    const { id } = await service.createPlaylist("Mix");
    await service.addTracksToPlaylist(id, [t(1), t("videos:1"), t(2)]);
    const reads = sent(fake, "GET").length;
    const native = String(id).replace("tidal:", "");
    await service.removeTracksFromPlaylist(id, [t(fake.itemIds(native)[1]!), t(fake.itemIds(native)[0]!)]);
    expect(fake.contents(native)).toEqual(["tracks:2"]);
    expect(sent(fake, "GET")).toHaveLength(reads);
  });

  it("reads the playlist for entries it does not know, once", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Long", tracks(...range(1, 120)));
    const gone = fake.itemIds(id).slice(5, 110).map(t);
    await service.removeTracksFromPlaylist(t(id), gone);
    expect(fake.contents(id)).toEqual([...range(1, 5), ...range(111, 120)].map((n) => `tracks:${n}`));
    expect(sent(fake, "DELETE").map((r) => r.body.data.length)).toEqual([50, 50, 5]);
    expect(sent(fake, "GET").filter((r) => r.path.endsWith("/items"))).toHaveLength(6);
  });

  it("leaves another playlist's entries alone", async () => {
    const { fake, service } = setup();
    const mine = fake.seedPlaylist("Mine", tracks(1, 2));
    const other = fake.seedPlaylist("Other", tracks(1, 2));
    const [read, foreign] = [await service.getPlaylistTracks(t(mine)), await service.getPlaylistTracks(t(other))];
    await service.removeTracksFromPlaylist(t(mine), entries(foreign));
    expect(sent(fake, "DELETE")).toHaveLength(0);
    await service.removeTracksFromPlaylist(t(mine), [entries(foreign)[0]!, entries(read)[1]!]);
    expect(fake.contents(mine)).toEqual(["tracks:1"]);
    expect(fake.contents(other)).toEqual(["tracks:1", "tracks:2"]);
  });

  it.each([true, false])("removes the rest when some are gone already (TIDAL ignores that: %s)", async (ignores) => {
    const { fake, service } = setup();
    fake.ignoresGoneEntries = ignores;
    const id = fake.seedPlaylist("Mix", tracks(1, 2, 3, 4));
    const read = entries(await service.getPlaylistTracks(t(id)));
    const playlist = fake.playlists.get(id)!;
    playlist.items = playlist.items.filter((item) => item.id !== "2");
    await service.removeTracksFromPlaylist(t(id), read.slice(0, 3));
    expect(fake.contents(id)).toEqual(["tracks:4"]);
    // And when all of them are.
    await service.removeTracksFromPlaylist(t(id), read.slice(0, 3));
    expect(fake.contents(id)).toEqual(["tracks:4"]);
  });

  it("has removed them when TIDAL failed to say so", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(1, 2));
    const [first] = entries(await service.getPlaylistTracks(t(id)));
    // Removed elsewhere meanwhile, and then every try fails.
    fake.playlists.get(id)!.items.shift();
    fake.instead.push({ status: 500 }, { status: 500 }, { status: 500 });
    await service.removeTracksFromPlaylist(t(id), [first!]);
    expect(fake.contents(id)).toEqual(["tracks:2"]);
  });

  it("passes on a refusal that is not about gone entries", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Theirs", tracks(1), { owner: "99" });
    const read = entries(await service.getPlaylistTracks(t(id)));
    await expect(service.removeTracksFromPlaylist(t(id), read)).rejects.toMatchObject({ kind: "not-found" });
    expect(sent(fake, "DELETE")).toHaveLength(1);
  });

  it("removes an entry named twice once", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(1, 2));
    const [first] = entries(await service.getPlaylistTracks(t(id)));
    await service.removeTracksFromPlaylist(t(id), [first!, first!]);
    expect(fake.contents(id)).toEqual(["tracks:2"]);
    expect(sent(fake, "DELETE")[0]!.body.data).toHaveLength(1);
  });
});

describe("TidalService moving", () => {
  async function order(move: number[], insertBefore: number, length = 6): Promise<number[]> {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(...range(1, length)));
    const ids = fake.itemIds(id);
    await service.movePlaylistTracks(t(id), move.map((n) => t(ids[n - 1]!)), insertBefore);
    return fake.contents(id).map((name) => Number(name.replace("tracks:", "")));
  }

  it("goes in front of the entry at that place in the list as it is", async () => {
    expect(await order([5, 2], 1)).toEqual([5, 2, 1, 3, 4, 6]);
    expect(await order([1], 4)).toEqual([2, 3, 1, 4, 5, 6]);
    expect(await order([1, 2], 7)).toEqual([3, 4, 5, 6, 1, 2]);
    expect(await order([6, 1], 99)).toEqual([2, 3, 4, 5, 6, 1]);
    expect(await order([4], 0)).toEqual([4, 1, 2, 3, 5, 6]);
  });

  it("finds its place when the entry there moves too", async () => {
    expect(await order([3, 4], 3)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await order([4, 3], 3)).toEqual([1, 2, 4, 3, 5, 6]);
    expect(await order([6, 5], 5)).toEqual([1, 2, 3, 4, 6, 5]);
  });

  it("keeps the order given when it takes several requests", async () => {
    const backwards = range(1, 50).reverse();
    const rest = range(51, 60);
    expect(await order(backwards, 55, 60)).toEqual([51, 52, 53, 54, ...backwards, ...range(55, 60)]);
    expect(await order(backwards, 61, 60)).toEqual([...rest, ...backwards]);
  });

  it("moves 20 at a time, and videos too", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", [...tracks(...range(1, 44)), { type: "videos", id: "1" }]);
    const ids = fake.itemIds(id);
    await service.movePlaylistTracks(t(id), [44, ...range(0, 43)].map((i) => t(ids[i]!)), 46);
    expect(fake.contents(id)[0]).toBe("videos:1");
    expect(sent(fake, "PATCH").map((r) => r.body.data.length)).toEqual([20, 20, 5]);
    expect(sent(fake, "PATCH").every((r) => r.body.meta === undefined)).toBe(true);
  });

  it("does what planning takes a move to do, whatever is moved where", async () => {
    let seed = 7;
    const random = (below: number) => (seed = (seed * 48271) % 2147483647) % below;
    for (let round = 0; round < 60; round += 1) {
      const { fake, service } = setup();
      const id = fake.seedPlaylist("Mix", tracks(...range(1, 1 + random(70))));
      const before = fake.itemIds(id).map(t) as EntryId[];
      const moved = before.filter(() => random(3) > 0).sort(() => random(3) - 1);
      const insertBefore = random(before.length + 3);
      await service.movePlaylistTracks(t(id), moved, insertBefore);
      expect(fake.itemIds(id).map(t)).toEqual(applyMove(before, moved, insertBefore));
    }
  });

  it("ignores entries that are not in the playlist", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(1, 2));
    const other = fake.seedPlaylist("Other", tracks(3));
    const [a, b] = fake.itemIds(id);
    await service.movePlaylistTracks(t(id), [t(fake.itemIds(other)[0]!)], 1);
    expect(sent(fake, "PATCH")).toHaveLength(0);
    await service.movePlaylistTracks(t(id), [t(b!), t(fake.itemIds(other)[0]!), t(a!)], 1);
    expect(fake.contents(id)).toEqual(["tracks:2", "tracks:1"]);
  });

  it("does nothing for nothing", async () => {
    const { fake, service } = setup();
    const id = fake.seedPlaylist("Mix", tracks(1));
    await service.movePlaylistTracks(t(id), [], 1);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("TidalService favourites", () => {
  it("says when each track was added, newest first", async () => {
    const { service } = setup();
    await service.addFavoriteTracks(range(1, 30).map(t));
    const read = await service.getFavoriteTracks();
    expect(natives(read)).toEqual(range(1, 30).reverse().map(String));
    expect(read[0]).toMatchObject({ title: "Track 30", artist: "Portishead", favouritedAt: expect.any(String) });
    expect(read[0]).not.toHaveProperty("playlistTrackId");
  });

  it("adds and removes 50 at a time, each once", async () => {
    const { fake, service } = setup();
    await service.addFavoriteTracks([...range(1, 110), 1].map(t));
    await service.removeFavoriteTracks(range(1, 105).map(t));
    expect(fake.collections["tracks"]!.map((item) => item.id)).toEqual(["106", "107", "108", "109", "110"]);
    expect(sent(fake, "POST").map((r) => r.body.data.length)).toEqual([50, 50, 10]);
    expect(sent(fake, "DELETE").map((r) => r.body.data.length)).toEqual([50, 50, 5]);
  });

  it("reads albums and artists, and keeps those that are unavailable", async () => {
    const { fake, service } = setup();
    fake.add("albums", "71", { title: "Gone" });
    fake.add("artists", "9", { name: "Gone" });
    await service.addFavoriteAlbums([t(70), t(71)]);
    await service.addFavoriteArtists([t(7), t(9)]);
    fake.hidden.add("albums:71").add("artists:9");
    expect((await service.getFavoriteAlbums()).map((a) => [a.id, a.title, a.artist])).toEqual([
      ["tidal:71", "Unavailable album", ""],
      ["tidal:70", "Dummy", "Portishead"],
    ]);
    expect(await service.getFavoriteArtists()).toEqual([
      { id: "tidal:9", name: "Unavailable artist" },
      { id: "tidal:7", name: "Portishead" },
    ]);
  });

  it("refuses a video among favourite tracks, before any request", async () => {
    const { fake, service } = setup();
    for (const call of [service.addFavoriteTracks([t(1), t("videos:1")]), service.removeFavoriteTracks([t("videos:1")])]) {
      await expect(call).rejects.toMatchObject({ kind: "unsupported" });
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("TidalService catalogue", () => {
  it("looks up a track, or a video by the id a playlist gave it", async () => {
    const { service } = setup();
    expect(await service.getTrack(t(1))).toMatchObject({ id: "tidal:1", isrc: "GBAAA0000001", album: "Dummy" });
    expect(await service.getTrack(t("videos:1"))).toMatchObject({ id: "tidal:videos:1", other: "video" });
  });

  it("asks TIDAL for nothing but music", async () => {
    const { fake, service } = setup();
    await expect(service.getTrack(t("users:me"))).rejects.toMatchObject({ kind: "not-found" });
    expect(fake.requests).toHaveLength(0);
  });

  it("finds every copy of a recording", async () => {
    const { fake, service } = setup();
    fake.addTrack("500", { isrc: "GBAAA0000001", title: "On a compilation" });
    fake.addTrack("501", { isrc: "GBAAA0000002" });
    const found = await service.findByIsrc(["gb-aaa-00-00001", "GBAAA0000001", "GBAAA0000002", "GBZZZ9999999", ""]);
    expect([...found].map(([isrc, list]) => [isrc, natives(list)])).toEqual([
      ["GBAAA0000001", ["1", "500"]],
      ["GBAAA0000002", ["501"]],
    ]);
    // One at a time: several at once would give one copy each.
    expect(fake.requests.filter((r) => r.path === "/tracks").every((r) => !r.query.get("filter[isrc]")!.includes(","))).toBe(true);
  });

  it("takes a 404 for an ISRC as having none", async () => {
    const { fake, service } = setup();
    await service.load();
    fake.instead.push({ status: 404 });
    expect((await service.findByIsrc(["GBAAA0000001"])).size).toBe(0);
  });

  it("gives an artist's own tracks, as many as asked", async () => {
    const { fake, service } = setup();
    fake.addTrack("300", { artists: ["8", "7"] });
    fake.add("artists", "7", { name: "Portishead" }, { tracks: tracks(300, ...range(1, 60)) });
    expect(natives(await service.getArtistTopTracks(t(7)))).toEqual(range(1, 10).map(String));
    expect(natives(await service.getArtistTopTracks(t(7), 25))).toEqual(range(1, 25).map(String));
    expect(await service.getArtistTopTracks(t(7), 200)).toHaveLength(60);
    expect(fake.requests.at(-1)!.query.get("collapseBy")).toBe("FINGERPRINT");
  });

  it("gives similar artists, as many as asked", async () => {
    const { fake, service } = setup();
    const others = range(100, 140).map(String);
    others.forEach((id) => fake.add("artists", id, { name: `Artist ${id}` }));
    fake.add("artists", "7", { name: "Portishead" }, { similarArtists: others.map((id) => ({ type: "artists", id })) });
    const found = await service.getSimilarArtists(t(7), 25);
    expect(found.map((artist) => artist.id)).toEqual(others.slice(0, 25).map(t));
    expect(await service.getSimilarArtists(t(7), 0)).toEqual([]);
  });

  it("gives an artist's releases, newest first, and says when there are more", async () => {
    const { fake, service } = setup();
    const albums = range(200, 230).map(String);
    albums.forEach((id, i) =>
      fake.add("albums", id, { title: `Album ${id}`, albumType: i === 0 ? "SINGLE" : "ALBUM", releaseDate: `20${10 + (i % 7)}-01-01` }, {
        artists: [{ type: "artists", id: "7" }],
      }),
    );
    fake.add("artists", "7", { name: "Portishead" }, { albums: albums.map((id) => ({ type: "albums", id })) });
    const { releases, truncated } = await service.getArtistReleases(t(7));
    expect(releases).toHaveLength(31);
    expect(truncated).toBe(false);
    const dates = releases.map((release) => release.releaseDate!);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(releases.find((release) => release.id === "tidal:200")).toMatchObject({
      releaseType: "ep-single",
      artist: "Portishead",
      artistId: "tidal:7",
    });
    expect(await service.getArtistReleases(t(7), 25)).toMatchObject({ truncated: true, releases: { length: 25 } });
    expect(await service.getArtistReleases(t(7), 20)).toMatchObject({ truncated: true, releases: { length: 20 } });
    expect((await service.getArtistReleases(t(7), 31)).truncated).toBe(false);
  });

  it("gives an album and its tracks, numbered, without its videos", async () => {
    const { fake, service } = setup();
    fake.add("albums", "70", { title: "Dummy", releaseDate: "1994-08-22" }, {
      artists: [{ type: "artists", id: "7" }],
      coverArt: [{ type: "artworks", id: "art" }],
      items: [
        ...range(1, 25).map((n) => ({ type: "tracks", id: String(n), meta: { trackNumber: n, volumeNumber: 1 } })),
        { type: "videos", id: "1", meta: { trackNumber: 26, volumeNumber: 1 } },
      ],
    });
    expect(await service.getAlbum(t(70))).toMatchObject({ id: "tidal:70", title: "Dummy", artist: "Portishead" });
    const read = await service.getAlbumTracks(t(70));
    expect(natives(read)).toEqual(range(1, 25).map(String));
    expect(read[24]).toMatchObject({
      trackNumber: 25,
      discNumber: 1,
      album: "Dummy",
      albumId: "tidal:70",
      releaseDate: "1994-08-22",
      image: "https://img.example/320.jpg",
    });
    expect(await service.getAlbumReleaseDate(t(70))).toBe("1994-08-22");
    fake.add("albums", "72", { title: "Undated" });
    expect(await service.getAlbumReleaseDate(t(72))).toBeUndefined();
    await expect(service.getAlbum(t(404))).rejects.toMatchObject({ kind: "not-found" });
  });

  it("gives an artist", async () => {
    const { service } = setup();
    expect(await service.getArtist(t(7))).toEqual({ id: "tidal:7", name: "Portishead" });
  });
});

describe("TidalService search", () => {
  it("finds tracks, albums and artists", async () => {
    const { fake, service } = setup();
    expect(await service.searchTracks("track 12")).toHaveLength(2);
    expect((await service.searchTracks("track 120"))[0]).toMatchObject({
      id: "tidal:120",
      artist: "Portishead",
      album: "Dummy",
      image: "https://img.example/320.jpg",
    });
    expect(await service.searchAlbums("dummy")).toMatchObject([{ id: "tidal:70", artist: "Portishead" }]);
    expect(await service.searchArtists("tri")).toEqual([{ id: "tidal:8", name: "Tricky" }]);
    expect(await service.searchTracks("no such song")).toEqual([]);
    expect(fake.requests.at(-1)!.path).toBe("/searchResults");
  });

  it("gives any stretch of the results", async () => {
    const { service } = setup();
    expect(await service.searchTracks("track")).toHaveLength(20);
    expect(natives(await service.searchTracks("track", 3, 0))).toEqual(["1", "2", "3"]);
    expect(natives(await service.searchTracks("track", 30, 35))).toEqual(range(36, 65).map(String));
    expect(natives(await service.searchTracks("track", 100, 100))).toEqual(range(101, 120).map(String));
    expect(await service.searchTracks("track", 10, 500)).toEqual([]);
  });

  it("goes on from where it was, without asking for the same page again", async () => {
    const { fake, service } = setup();
    const pages = [];
    for (let offset = 0; offset < 120; offset += 40) {
      pages.push(...(await service.searchTracks("track", 40, offset)));
    }
    expect(natives(pages)).toEqual(range(1, 120).map(String));
    expect(fake.requests.filter((r) => r.path.startsWith("/searchResults"))).toHaveLength(6);
  });

  it("gives the right stretches to several at once", async () => {
    const { fake, service } = setup();
    const pages = await Promise.all([0, 40, 80].map((offset) => service.searchTracks("track", 40, offset)));
    expect(natives(pages.flat())).toEqual(range(1, 120).map(String));
    expect(fake.requests.filter((r) => r.path.startsWith("/searchResults")).length).toBeLessThanOrEqual(6);
  });

  it("starts over when it cannot go on", async () => {
    const { fake, service } = setup();
    await service.searchTracks("track", 40);
    fake.instead.push({ status: 400 });
    expect(natives(await service.searchTracks("track", 40, 40))).toEqual(range(41, 80).map(String));
  });

  it("asks afresh for the start", async () => {
    const { fake, service } = setup();
    await service.searchTracks("track 120");
    fake.addTrack("900", { title: "Track 120 again" });
    expect(natives(await service.searchTracks("track 120"))).toEqual(["120", "900"]);
  });

  it("cuts a query to what TIDAL takes, and asks nothing for none", async () => {
    const { fake, service } = setup();
    expect(await service.searchTracks("x".repeat(400))).toEqual([]);
    const asked = fake.requests.length;
    expect(await service.searchTracks("  ")).toEqual([]);
    expect(await service.searchTracks("track", 0)).toEqual([]);
    expect(fake.requests).toHaveLength(asked);
  });
});

describe("TidalService ids", () => {
  it("refuses another service's, and one that cannot be in a path", async () => {
    const { fake, service } = setup();
    await expect(service.getTrack(tagId("qobuz", 1))).rejects.toMatchObject({ kind: "bad-id" });
    await expect(service.deletePlaylist(t(".") as PlaylistId)).rejects.toMatchObject({ kind: "bad-id" });
    expect(sent(fake, "DELETE")).toHaveLength(0);
  });
});
