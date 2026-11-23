import { describe, expect, it } from "vitest";

import { describeServiceContract } from "../contract.test-support.js";
import { tagId } from "../ids.js";
import { SpotifyClient } from "./client.js";
import { FakeSpotify } from "./fake-spotify.test-support.js";
import { SpotifyService } from "./service.js";

const s = (native: string) => tagId<never>("spotify", native);

function world() {
  const fake = new FakeSpotify();
  for (const [i, id] of ["t1", "t2", "t3", "t4"].entries()) {
    fake.addTrack(id, { name: `Song ${i + 1}`, artists: ["a1"], album: "al1", isrc: `GBAAA000000${i + 1}` });
  }
  fake.artists.set("a1", "Portishead");
  fake.albums.set("al1", { name: "Dummy", artists: ["a1"], date: "1994", upc: "00042282855328" });
  const service = new SpotifyService(
    new SpotifyClient({ tokens: fake.tokens, fetchImpl: fake.fetchImpl, sleep: async () => {} }),
  );
  return { fake, service };
}

describeServiceContract("spotify", () => {
  const { fake, service } = world();
  return {
    service,
    tracks: ["t1", "t2", "t3", "t4"].map(s),
    albums: [s("al1")],
    artists: [s("a1")],
    recording: { isrc: "GBAAA0000001", track: s("t1"), absent: "GBZZZ9999999" },
    requests: () => fake.requests,
  };
});

describe("SpotifyService account", () => {
  it("knows who is signed in once it has asked", async () => {
    const { service, fake } = world();
    expect(service.account()).toBeUndefined();
    expect(await service.load()).toEqual({ id: "spotify:me", displayName: "Me" });
    expect(service.account()).toEqual({ id: "spotify:me", displayName: "Me" });
    expect(fake.calls()).toEqual(["GET /me"]);
  });

  it("carries on with a new token when the old one ends", async () => {
    const { service, fake } = world();
    fake.expire();
    expect((await service.load()).displayName).toBe("Me");
    expect(fake.seen.map((r) => r.status)).toEqual([401, 200]);
  });

  it("says what Spotify cannot do, in words for the user", () => {
    const { capabilities } = world().service;
    for (const name of [
      "topTracks",
      "similarArtists",
      "readOthersPlaylists",
      "editorialPlaylists",
      "playability",
    ] as const) {
      const can = capabilities[name];
      expect(can.ok, name).toBe(false);
      expect(can.ok ? "" : can.reason, name).toMatch(/^Spotify .*[^.]$/);
    }
    expect(capabilities.quality).toBe("none");
    expect(capabilities.entryIds).toBe("positional");
    expect(capabilities.deletePlaylist).toEqual({ ok: true });
  });
});

describe("SpotifyService searches", () => {
  function many() {
    const { fake, service } = world();
    for (let i = 0; i < 35; i += 1) {
      fake.addTrack(`x${i}`, { name: `Echo ${i}` });
      fake.albums.set(`x${i}`, { name: `Echo ${i}` });
      fake.artists.set(`x${i}`, `Echo ${i}`);
    }
    return { fake, service };
  }

  it("pages by tens up to the limit", async () => {
    const { fake, service } = many();
    const found = await service.searchTracks("Echo", 25);
    expect(found.map((t) => t.id)).toEqual(Array.from({ length: 25 }, (_, i) => `spotify:x${i}`));
    expect(fake.seen.map((r) => [r.query["limit"], r.query["offset"]])).toEqual([
      ["10", "0"],
      ["10", "10"],
      ["5", "20"],
    ]);
  });

  it("asks for no more than is wanted, from where it is wanted", async () => {
    const { fake, service } = many();
    expect((await service.searchTracks("Echo", 3, 4)).map((t) => t.id)).toEqual([s("x4"), s("x5"), s("x6")]);
    expect(fake.seen[0]!.query).toMatchObject({ q: "Echo", type: "track", limit: "3", offset: "4" });
    expect(await service.searchArtists("Echo")).toHaveLength(10);
    expect((await service.searchAlbums("Echo", 12)).at(-1)).toMatchObject({ id: "spotify:x11", title: "Echo 11" });
  });

  it("stops at the end of the results", async () => {
    const { service } = many();
    expect(await service.searchTracks("Echo", 100)).toHaveLength(35);
    expect(await service.searchTracks("nothing like it", 100)).toEqual([]);
    expect(await service.searchTracks("Echo", 0)).toEqual([]);
  });

  it("asks for nothing past where Spotify's results end", async () => {
    const { fake, service } = many();
    await service.searchTracks("Echo", 10, 995);
    expect(fake.seen.map((r) => r.query["limit"])).toEqual(["5"]);
    expect(await service.searchTracks("Echo", 10, 1000)).toEqual([]);
    expect(fake.requests).toBe(1);
  });

  it("finds recordings by ISRC one by one, trusting only equal codes", async () => {
    const { fake, service } = world();
    fake.addTrack("t1b", { name: "Song 1 (again)", isrc: "gb-aaa-00-00001" });
    const found = await service.findByIsrc(["GBAAA0000001", "gbaaa0000001", "GBAAA0000002", ""]);
    expect([...found].map(([isrc, tracks]) => [isrc, tracks.map((t) => t.id)])).toEqual([
      ["GBAAA0000001", ["spotify:t1", "spotify:t1b"]],
      ["GBAAA0000002", ["spotify:t2"]],
    ]);
    expect(fake.seen.map((r) => r.query["q"])).toEqual(["isrc:GBAAA0000001", "isrc:GBAAA0000002"]);
  });
});

describe("SpotifyService catalogue", () => {
  it("looks up a track, an album and an artist", async () => {
    const { service } = world();
    expect(await service.getTrack(s("t1"))).toMatchObject({
      title: "Song 1",
      artist: "Portishead",
      album: "Dummy",
      releaseDate: "1994",
      isrc: "GBAAA0000001",
    });
    expect(await service.getAlbum(s("al1"))).toMatchObject({ title: "Dummy", upc: "00042282855328", trackCount: 4 });
    expect(await service.getAlbumReleaseDate(s("al1"))).toBe("1994");
    expect(await service.getArtist(s("a1"))).toEqual({ id: "spotify:a1", name: "Portishead" });
  });

  it("does not look up an episode or a local file as if it were a song", async () => {
    const { service, fake } = world();
    for (const id of ["episode:e1", "local:a:b:c:1"]) {
      await expect(service.getTrack(s(id))).rejects.toMatchObject({ kind: "unsupported" });
    }
    expect(fake.requests).toBe(0);
  });

  it("reads all of a long album, with what the album says", async () => {
    const { service, fake } = world();
    fake.albums.set("long", { name: "Long", artists: ["a1"], date: "2001-05-06" });
    for (let i = 0; i < 120; i += 1) {
      fake.addTrack(`l${i}`, { name: `L ${i}`, artists: ["a1"], album: "long" });
    }
    const tracks = await service.getAlbumTracks(s("long"));
    expect(tracks).toHaveLength(120);
    expect(tracks[119]).toMatchObject({
      id: "spotify:l119",
      album: "Long",
      albumId: "spotify:long",
      releaseDate: "2001-05-06",
      image: "https://i.scdn.co/long",
    });
    expect(fake.calls()).toEqual(["GET /albums/long", "GET /albums/long/tracks", "GET /albums/long/tracks"]);
  });

  it("lists an artist's releases by type, ten at a time, and says when there are more", async () => {
    const { service, fake } = world();
    for (let i = 0; i < 24; i += 1) {
      fake.albums.set(`r${i}`, { name: `R ${i}`, artists: ["a1"], type: i % 2 === 0 ? "single" : "album" });
    }
    const all = await service.getArtistReleases(s("a1"));
    expect(all.releases).toHaveLength(25);
    expect(all.truncated).toBe(false);
    expect(all.releases.slice(0, 3).map((r) => r.releaseType)).toEqual(["album", "ep-single", "album"]);
    expect(fake.seen[0]!.query).toMatchObject({ include_groups: "album,single,compilation", limit: "10" });
    const some = await service.getArtistReleases(s("a1"), 12);
    expect(some.releases).toHaveLength(12);
    expect(some.truncated).toBe(true);
  });

  it("stops when the quota is used up", async () => {
    const { service, fake } = world();
    fake.quotaUsedUp = true;
    await expect(service.findByIsrc(["GBAAA0000001"])).rejects.toMatchObject({ kind: "quota" });
    expect(fake.requests).toBe(1);
  });
});

describe("SpotifyService favourites", () => {
  it("adds and removes more than fit in one request", async () => {
    const { service, fake } = world();
    const ids = Array.from({ length: 95 }, (_, i) => `f${i}`);
    ids.forEach((id) => fake.addTrack(id));
    await service.addFavoriteTracks(ids.map(s));
    expect(fake.calls()).toEqual(["PUT /me/library", "PUT /me/library", "PUT /me/library"]);
    expect(fake.seen[0]!.query["uris"]?.split(",").slice(0, 2)).toEqual(["spotify:track:f0", "spotify:track:f1"]);
    const read = await service.getFavoriteTracks();
    expect(read).toHaveLength(95);
    expect(read[0]).toMatchObject({ id: "spotify:f94", favouritedAt: expect.stringMatching(/^2026-/) });
    await service.removeFavoriteTracks(ids.slice(0, 90).map(s));
    expect(await service.getFavoriteTracks()).toHaveLength(5);
  });

  it("reads every followed artist, by cursor", async () => {
    const { service, fake } = world();
    const ids = Array.from({ length: 120 }, (_, i) => `z${i}`);
    ids.forEach((id) => fake.artists.set(id, id));
    await service.addFavoriteArtists(ids.map(s));
    expect(new Set((await service.getFavoriteArtists()).map((a) => a.id))).toEqual(new Set(ids.map(s)));
  });

  it("refuses to add a local file, before any request", async () => {
    const { service, fake } = world();
    await expect(service.addFavoriteTracks([s("t1"), s("local:a:b:c:1")])).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(fake.requests).toBe(0);
  });
});

describe("SpotifyService playlists", () => {
  it("lists every playlist, including those of others", async () => {
    const { service, fake } = world();
    for (let i = 0; i < 60; i += 1) {
      fake.seedPlaylist(`p${i}`, []);
    }
    fake.seedPlaylist("theirs", ["spotify:track:t1"], { owner: "them" });
    const playlists = await service.getUserPlaylists();
    expect(playlists).toHaveLength(61);
    expect(playlists[60]).toMatchObject({ id: "spotify:theirs", ownerId: "spotify:them" });
    expect(playlists[60]).not.toHaveProperty("trackCount");
  });

  it("does not read the songs of a playlist that is not the user's, but does of a shared one", async () => {
    const { service, fake } = world();
    fake.seedPlaylist("theirs", ["spotify:track:t1"], { owner: "them" });
    fake.seedPlaylist("shared", ["spotify:track:t1"], { owner: "them", collaborators: ["me"] });
    const { readOthersPlaylists } = service.capabilities;
    await expect(service.getPlaylistTracks(s("theirs"))).rejects.toMatchObject({
      kind: "unsupported",
      message: readOthersPlaylists.ok ? "" : readOthersPlaylists.reason,
    });
    expect((await service.getPlaylist(s("theirs"))).name).toBe("theirs");
    expect(await service.getPlaylistTracks(s("shared"))).toHaveLength(1);
  });

  it("creates private playlists unless told otherwise", async () => {
    const { service, fake } = world();
    const mine = await service.createPlaylist("Mix");
    expect(mine).toMatchObject({ name: "Mix", isPublic: false, trackCount: 0 });
    expect((await service.createPlaylist("Open", { isPublic: true, description: "d" })).isPublic).toBe(true);
    expect(fake.seen.map((r) => r.body)).toEqual([
      { name: "Mix", public: false },
      { name: "Open", public: true, description: "d" },
    ]);
  });

  it("changes a playlist's details", async () => {
    const { service, fake } = world();
    fake.seedPlaylist("p", []);
    expect(await service.updatePlaylist(s("p"), { description: "new", isPublic: true })).toMatchObject({
      name: "p",
      description: "new",
      isPublic: true,
    });
    expect(fake.seen[0]).toMatchObject({ method: "PUT", path: "/playlists/p", body: { description: "new", public: true } });
  });

  it("deletes a playlist by taking it out of the library", async () => {
    const { service, fake } = world();
    fake.seedPlaylist("p", []);
    await service.deletePlaylist(s("p"));
    expect(fake.seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/me/library",
      query: { uris: "spotify:playlist:p" },
    });
    expect(fake.playlists.has("p")).toBe(true);
  });
});
