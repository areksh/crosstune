import { describe, expect, it } from "vitest";

import { parseAlbum, parseArtist, parsePlaylist, parsePlaylistItem, parseRelease, parseTrack } from "./models.js";

const TRACK = {
  type: "track",
  id: "t1",
  uri: "spotify:track:t1",
  name: "Roads",
  artists: [
    { id: "a1", name: "Portishead" },
    { id: "a2", name: "Someone" },
    { id: "a3", name: "Other" },
  ],
  album: {
    id: "al1",
    name: "Dummy",
    release_date: "1994-08-22",
    release_date_precision: "day",
    images: [
      { url: "https://i.scdn.co/640", width: 640, height: 640 },
      { url: "https://i.scdn.co/300", width: 300, height: 300 },
      { url: "https://i.scdn.co/64", width: 64, height: 64 },
    ],
  },
  disc_number: 1,
  track_number: 8,
  duration_ms: 304_600,
  external_ids: { isrc: "GBF089400010" },
  external_urls: { spotify: "https://open.spotify.com/track/t1" },
  is_playable: false,
  is_local: false,
};

describe("parseTrack", () => {
  it("reads a track into the neutral model", () => {
    expect(parseTrack(TRACK)).toEqual({
      id: "spotify:t1",
      title: "Roads",
      artist: "Portishead",
      artistId: "spotify:a1",
      jointArtists: ["Someone", "Other"],
      isrc: "GBF089400010",
      album: "Dummy",
      albumId: "spotify:al1",
      releaseDate: "1994-08-22",
      image: "https://i.scdn.co/300",
      discNumber: 1,
      trackNumber: 8,
      duration: 305,
      url: "https://open.spotify.com/track/t1",
      // Given without a market (seen live): whether the user can play it.
      streamable: false,
    });
  });

  it("keeps a release date as precise as it is given", () => {
    const on = (release_date: string, release_date_precision: string) =>
      parseTrack({ ...TRACK, album: { ...TRACK.album, release_date, release_date_precision } })?.releaseDate;
    expect(on("1994", "year")).toBe("1994");
    expect(on("1994-08", "month")).toBe("1994-08");
    expect(on("1994-08-22", "month")).toBe("1994-08");
    expect(on("1994-08-22", "year")).toBe("1994");
    expect(on("0000", "year")).toBeUndefined();
    expect(on("soon", "day")).toBeUndefined();
  });

  it("leaves out what is missing or not https", () => {
    expect(parseTrack({ id: "t1", name: "Roads", artists: [{ name: "X" }], album: { name: "" } })).toEqual({
      id: "spotify:t1",
      title: "Roads",
      artist: "X",
    });
    const odd = parseTrack({
      ...TRACK,
      artists: [],
      external_urls: { spotify: "javascript:alert(1)" },
      album: { ...TRACK.album, images: [{ url: "http://i.scdn.co/300", width: 300 }] },
    });
    expect(odd).not.toHaveProperty("url");
    expect(odd).not.toHaveProperty("image");
    expect(odd).not.toHaveProperty("artist");
  });

  it("reads an image whose width is unknown", () => {
    expect(
      parseTrack({ ...TRACK, album: { ...TRACK.album, images: [{ url: "https://i.scdn.co/x", width: null }] } })?.image,
    ).toBe("https://i.scdn.co/x");
  });

  it("marks an episode, under its show", () => {
    expect(
      parseTrack({
        type: "episode",
        id: "e1",
        uri: "spotify:episode:e1",
        name: "Pilot",
        show: { name: "The Show" },
        duration_ms: 60_000,
        release_date: "2026-01-01",
        release_date_precision: "day",
        images: [{ url: "https://i.scdn.co/e", width: 300 }],
        external_urls: { spotify: "https://open.spotify.com/episode/e1" },
      }),
    ).toEqual({
      id: "spotify:episode:e1",
      title: "Pilot",
      artist: "The Show",
      releaseDate: "2026-01-01",
      duration: 60,
      image: "https://i.scdn.co/e",
      url: "https://open.spotify.com/episode/e1",
      other: "episode",
    });
  });

  it("marks a local file, whose id is its URI", () => {
    const local = {
      type: "track",
      id: null,
      is_local: true,
      uri: "spotify:local:Me:Demos:Take+1:61",
      name: "Take 1",
      artists: [{ id: null, name: "Me" }],
      album: { id: null, name: "Demos" },
      duration_ms: 61_000,
    };
    expect(parseTrack(local)).toEqual({
      id: "spotify:local:Me:Demos:Take+1:61",
      title: "Take 1",
      artist: "Me",
      album: "Demos",
      duration: 61,
      other: "local",
    });
    const { uri: _, ...without } = local;
    expect(parseTrack(without)?.id).toBe("spotify:local:Me:Demos:Take%201:61");
  });

  it("answers undefined for what is no track", () => {
    for (const value of [null, undefined, "x", {}, { id: "t" }, { id: 4, name: "x" }, { id: "", name: "x" }]) {
      expect(parseTrack(value)).toBeUndefined();
    }
  });
});

describe("parsePlaylistItem", () => {
  it("reads the new wrapper and the old one", () => {
    const wrapped = { added_at: "2026-05-01T10:00:00Z", is_local: false, item: TRACK };
    expect(parsePlaylistItem(wrapped)).toMatchObject({ id: "spotify:t1", addedAt: "2026-05-01T10:00:00Z" });
    expect(parsePlaylistItem({ added_at: null, track: TRACK })?.id).toBe("spotify:t1");
  });

  it("leaves out an added date Spotify does not know", () => {
    expect(parsePlaylistItem({ added_at: "1970-01-01T00:00:00Z", item: TRACK })).not.toHaveProperty("addedAt");
    expect(parsePlaylistItem({ added_at: null, item: TRACK })).not.toHaveProperty("addedAt");
  });

  it("takes is_local from the wrapper too", () => {
    const item = { uri: "spotify:local:::x:1", id: null, name: "x", artists: [], duration_ms: 1000 };
    expect(parsePlaylistItem({ is_local: true, item })?.other).toBe("local");
  });

  it("answers undefined for what it cannot read", () => {
    expect(parsePlaylistItem({ added_at: null, item: null })).toBeUndefined();
    expect(parsePlaylistItem(null)).toBeUndefined();
    expect(parsePlaylistItem({ item: { type: "chapter", id: "c", name: "x", uri: "spotify:chapter:c" } })).toBeUndefined();
  });
});

describe("parseAlbum and parseRelease", () => {
  const ALBUM = {
    id: "al1",
    name: "Dummy",
    album_type: "album",
    artists: [{ id: "a1", name: "Portishead" }],
    release_date: "1994-08-22",
    release_date_precision: "day",
    total_tracks: 11,
    images: [{ url: "https://i.scdn.co/300", width: 300 }],
    external_ids: { upc: "00042282855328" },
    external_urls: { spotify: "https://open.spotify.com/album/al1" },
  };

  it("reads an album", () => {
    expect(parseAlbum(ALBUM)).toEqual({
      id: "spotify:al1",
      title: "Dummy",
      artist: "Portishead",
      releaseDate: "1994-08-22",
      trackCount: 11,
      image: "https://i.scdn.co/300",
      upc: "00042282855328",
      url: "https://open.spotify.com/album/al1",
    });
    expect(parseAlbum({ id: "x", name: "y" })).toEqual({ id: "spotify:x", title: "y", artist: "" });
    expect(parseAlbum({ name: "y" })).toBeUndefined();
  });

  it("classifies a release by its album type and title", () => {
    expect(parseRelease(ALBUM)).toMatchObject({ releaseType: "album", artistId: "spotify:a1" });
    expect(parseRelease({ ...ALBUM, album_type: "single" })?.releaseType).toBe("ep-single");
    expect(parseRelease({ ...ALBUM, album_type: "compilation" })?.releaseType).toBe("compilation");
    expect(parseRelease({ ...ALBUM, name: "Roseland NYC Live" })?.releaseType).toBe("live");
  });
});

describe("parseArtist and parsePlaylist", () => {
  it("reads an artist", () => {
    expect(parseArtist({ id: "a1", name: "Portishead", genres: [] })).toEqual({ id: "spotify:a1", name: "Portishead" });
    expect(parseArtist({ id: "a1" })).toBeUndefined();
  });

  it("reads a playlist", () => {
    expect(
      parsePlaylist({
        id: "p1",
        name: "Mix",
        description: "d",
        public: false,
        collaborative: true,
        owner: { id: "me" },
        items: { total: 3 },
        external_urls: { spotify: "https://open.spotify.com/playlist/p1" },
      }),
    ).toEqual({
      id: "spotify:p1",
      name: "Mix",
      description: "d",
      // Not read: live, every read says public, private ones too (2026-11-23).
      isCollaborative: true,
      ownerId: "spotify:me",
      trackCount: 3,
      url: "https://open.spotify.com/playlist/p1",
    });
  });

  it("leaves out what another user's playlist does not say", () => {
    expect(parsePlaylist({ id: "p1", name: "Mix", description: "", public: null })).toEqual({
      id: "spotify:p1",
      name: "Mix",
    });
    expect(parsePlaylist({ id: "p1" })).toBeUndefined();
  });

  it("takes the playlist's cover from its images, none when Spotify sends null", () => {
    const images = [{ url: "https://i.scdn.co/image/ab67616d00001e02", width: 640, height: 640 }];
    expect(parsePlaylist({ id: "p1", name: "Mix", images })?.image).toBe("https://i.scdn.co/image/ab67616d00001e02");
    expect(parsePlaylist({ id: "p1", name: "Mix", images: null })).not.toHaveProperty("image");
  });
});
