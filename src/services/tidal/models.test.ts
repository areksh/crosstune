import { describe, expect, it } from "vitest";

import { ServiceError, type TrackId } from "../model.js";
import {
  identifiersOf,
  indexIncluded,
  itemId,
  parseAccount,
  parseAlbum,
  parseArtist,
  parseDuration,
  parsePlaylist,
  parseRelease,
  parseTrack,
  refOf,
  relatedOf,
  resourceOf,
  toAlbum,
  toArtist,
  toItem,
  type Identifier,
} from "./models.js";

const many = (type: string, ...ids: string[]) => ({ data: ids.map((id) => ({ type, id })), links: { self: "/" } });

const artwork = (id: string, sizes: number[], extra: Record<string, unknown> = {}) => ({
  type: "artworks",
  id,
  attributes: {
    mediaType: "IMAGE",
    files: sizes.map((size) => ({ href: `https://img.example/${id}/${size}.jpg`, meta: { width: size, height: size } })),
    ...extra,
  },
});

const ROADS = {
  type: "tracks",
  id: "75413016",
  attributes: {
    title: "Roads",
    version: "Live",
    duration: "PT5M2S",
    isrc: "GBF089400010",
    explicit: false,
    popularity: 0.5,
    mediaTags: ["LOSSLESS", "HIRES_LOSSLESS"],
    availability: ["STREAM", "DJ"],
    externalLinks: [
      { href: "tidal://track/75413016", meta: { type: "TIDAL_AUTOPLAY_WEB" } },
      { href: "https://tidal.com/track/75413016", meta: { type: "TIDAL_SHARING" } },
    ],
  },
  relationships: { artists: many("artists", "1", "2", "3"), albums: many("albums", "10", "11") },
};

const INCLUDED = [
  { type: "artists", id: "1", attributes: { name: "Portishead", popularity: 1 } },
  { type: "artists", id: "2", attributes: { name: "Adrian Utley", popularity: 1 } },
  { type: "artists", id: "3", attributes: {} },
  {
    type: "albums",
    id: "10",
    attributes: {
      title: "Dummy",
      albumType: "ALBUM",
      barcodeId: "0042282852229",
      numberOfItems: 11,
      releaseDate: "1994-08-22",
      mediaTags: ["LOSSLESS"],
      version: "Deluxe",
    },
    relationships: { artists: many("artists", "1"), coverArt: many("artworks", "c") },
  },
  artwork("c", [80, 160, 320, 640]),
];

const index = indexIncluded({ included: INCLUDED });

describe("parseTrack", () => {
  it("reads everything the tools use", () => {
    expect(parseTrack(ROADS, index)).toEqual({
      id: "tidal:75413016",
      title: "Roads",
      version: "Live",
      duration: 302,
      isrc: "GBF089400010",
      artist: "Portishead",
      artistId: "tidal:1",
      jointArtists: ["Adrian Utley"],
      album: "Dummy",
      albumId: "tidal:10",
      releaseDate: "1994-08-22",
      image: "https://img.example/c/320.jpg",
      quality: "hires",
      streamable: true,
      url: "https://tidal.com/track/75413016",
    });
  });

  it("leaves out what is missing or malformed", () => {
    const bare = { type: "tracks", id: "5", attributes: { title: "Untold" } };
    expect(parseTrack(bare, index)).toEqual({ id: "tidal:5", title: "Untold" });
    const odd = {
      type: "tracks",
      id: "6",
      attributes: {
        title: "Odd",
        version: "",
        duration: "a while",
        isrc: null,
        mediaTags: "LOSSLESS",
        availability: "STREAM",
        externalLinks: [null, { href: "http://tidal.com/6", meta: { type: "TIDAL_SHARING" } }, { href: 4 }],
      },
      relationships: { artists: { links: {} }, albums: null },
    };
    expect(parseTrack(odd, index)).toEqual({ id: "tidal:6", title: "Odd" });
  });

  it("is nothing without an id or a title", () => {
    expect(parseTrack({ type: "tracks", id: "5", attributes: {} }, index)).toBeUndefined();
    expect(parseTrack({ type: "tracks", id: "5" }, index)).toBeUndefined();
    expect(parseTrack({ type: "tracks", attributes: { title: "x" } }, index)).toBeUndefined();
    expect(parseTrack(undefined, index)).toBeUndefined();
  });

  it("does not know the quality from tags it does not know", () => {
    const tagged = (mediaTags: unknown) =>
      parseTrack({ ...ROADS, attributes: { ...ROADS.attributes, mediaTags } }, index)!.quality;
    expect(tagged(["DOLBY_ATMOS"])).toBeUndefined();
    expect(tagged([])).toBeUndefined();
    expect(tagged(["DOLBY_ATMOS", "LOSSLESS"])).toBe("lossless");
    // The document's example for an album is one string holding both.
    expect(tagged(["HIRES_LOSSLESS, LOSSLESS"])).toBe("hires");
    expect(tagged([7, null])).toBeUndefined();
  });

  it("says a track that cannot be streamed cannot", () => {
    const usable = (availability: unknown) =>
      parseTrack({ ...ROADS, attributes: { ...ROADS.attributes, availability } }, index)!.streamable;
    expect(usable(["DJ"])).toBe(false);
    expect(usable([])).toBe(false);
    expect(usable(undefined)).toBeUndefined();
  });

  it("marks a video, which is never matched", () => {
    const video = {
      type: "videos",
      id: "75413016",
      attributes: { title: "Roads", duration: "PT4M", isrc: "TIDAL2274", releaseDate: "1995-01-01" },
      relationships: { artists: many("artists", "1") },
    };
    expect(parseTrack(video, index)).toEqual({
      id: "tidal:videos:75413016",
      title: "Roads",
      duration: 240,
      artist: "Portishead",
      artistId: "tidal:1",
      releaseDate: "1995-01-01",
      other: "video",
    });
  });

  it("takes only https covers, the smallest that is large enough", () => {
    const cover = (file: unknown) =>
      parseTrack(ROADS, indexIncluded({ included: [...INCLUDED.slice(0, 4), file] }))!.image;
    expect(cover(artwork("c", [80, 160]))).toBe("https://img.example/c/160.jpg");
    expect(cover(artwork("c", [1280, 750, 80]))).toBe("https://img.example/c/750.jpg");
    expect(cover(artwork("c", [320], { mediaType: "VIDEO" }))).toBeUndefined();
    expect(
      cover({
        ...artwork("c", []),
        attributes: { mediaType: "IMAGE", files: [{ href: "http://x/1.jpg" }, { href: "https://x/2.jpg" }, null] },
      }),
    ).toBe("https://x/2.jpg");
    expect(cover(artwork("c", []))).toBeUndefined();
  });
});

describe("parseDuration", () => {
  it.each([
    ["PT2M58S", 178],
    ["PT1H2M3S", 3723],
    ["P1DT1S", 86401],
    ["PT46M", 2760],
    ["PT3M5.6S", 186],
    ["PT0S", 0],
  ])("%s", (text, seconds) => expect(parseDuration(text)).toBe(seconds));

  it("knows no other", () => {
    for (const value of ["P", "PT", "PT5", "", "5", 5, null, undefined, "P1M"]) {
      expect(parseDuration(value), String(value)).toBeUndefined();
    }
  });
});

describe("ids of items", () => {
  const round = (ref: { type: string; id: string }) => refOf(itemId(ref));

  it("never makes a video's id a track's", () => {
    expect(itemId({ type: "tracks", id: "12" })).toBe("tidal:12");
    expect(itemId({ type: "videos", id: "12" })).toBe("tidal:videos:12");
  });

  it("reads back what it made, whatever the id looks like", () => {
    for (const ref of [
      { type: "tracks", id: "12" },
      { type: "videos", id: "12" },
      { type: "tracks", id: "videos:12" },
      { type: "tracks", id: "tracks:12" },
      { type: "videos", id: "a/b:c d" },
    ]) {
      expect(round(ref)).toEqual(ref);
    }
  });

  it("refuses another service's", () => {
    expect(() => refOf("qobuz:1" as unknown as TrackId)).toThrow(ServiceError);
  });
});

describe("toItem", () => {
  const at = (meta: Record<string, unknown>, type = "tracks", id = "75413016"): Identifier => ({ type, id, meta });
  const both = indexIncluded({ included: [...INCLUDED, ROADS] });

  it("adds what the list says of it", () => {
    expect(toItem(at({ itemId: "e-1", addedAt: "2026-01-02T03:04:05Z" }), both, "playlist")).toMatchObject({
      id: "tidal:75413016",
      title: "Roads",
      playlistTrackId: "tidal:e-1",
      addedAt: "2026-01-02T03:04:05Z",
    });
    expect(toItem(at({ addedAt: "2026-01-02T03:04:05Z" }), both, "favourites")).toMatchObject({
      id: "tidal:75413016",
      favouritedAt: "2026-01-02T03:04:05Z",
    });
    expect(toItem(at({ trackNumber: 4, volumeNumber: 2 }), both, "album")).toMatchObject({
      trackNumber: 4,
      discNumber: 2,
    });
  });

  it("leaves out dates that are none", () => {
    expect(toItem(at({ addedAt: "soon" }), both, "favourites")).not.toHaveProperty("favouritedAt");
  });

  it("keeps an item TIDAL tells nothing about", () => {
    expect(toItem(at({ itemId: "e-9" }, "tracks", "404"), both, "playlist")).toEqual({
      id: "tidal:404",
      title: "Unavailable track",
      playlistTrackId: "tidal:e-9",
    });
    expect(toItem(at({ itemId: "e-9" }, "videos", "404"), both, "playlist")).toEqual({
      id: "tidal:videos:404",
      title: "Unavailable video",
      other: "video",
      playlistTrackId: "tidal:e-9",
    });
  });
});

describe("parseAlbum and parseRelease", () => {
  const dummy = INCLUDED[3]!;

  it("reads everything the tools use", () => {
    expect(parseAlbum(dummy, index)).toEqual({
      id: "tidal:10",
      title: "Dummy",
      artist: "Portishead",
      version: "Deluxe",
      releaseDate: "1994-08-22",
      trackCount: 11,
      image: "https://img.example/c/320.jpg",
      quality: "lossless",
      upc: "0042282852229",
    });
  });

  it("reads one with nothing but a title", () => {
    expect(parseAlbum({ type: "albums", id: "1", attributes: { title: "X", barcodeId: null } }, index)).toEqual({
      id: "tidal:1",
      title: "X",
      artist: "",
    });
    expect(parseAlbum({ type: "albums", id: "1" }, index)).toBeUndefined();
  });

  it("keeps the place of one TIDAL tells nothing about", () => {
    expect(toAlbum({ type: "albums", id: "404", meta: {} }, index)).toEqual({
      id: "tidal:404",
      title: "Unavailable album",
      artist: "",
    });
  });

  it("classifies a release by its type and title", () => {
    const release = (attributes: Record<string, unknown>) =>
      parseRelease({ type: "albums", id: "1", attributes }, index)!.releaseType;
    expect(parseRelease(dummy, index)).toMatchObject({ id: "tidal:10", releaseType: "album", artistId: "tidal:1" });
    expect(release({ title: "X", albumType: "EP" })).toBe("ep-single");
    expect(release({ title: "X", albumType: "SINGLE" })).toBe("ep-single");
    expect(release({ title: "Roseland NYC Live", albumType: "ALBUM" })).toBe("live");
    expect(release({ title: "Greatest Hits", albumType: "ALBUM" })).toBe("compilation");
    expect(release({ title: "X", albumType: "BOXSET", numberOfItems: 40 })).toBe("album");
    // Deprecated, but still sent.
    expect(release({ title: "X", type: "SINGLE" })).toBe("ep-single");
  });
});

describe("parseArtist", () => {
  it("reads the name", () => {
    expect(parseArtist(INCLUDED[0], index)).toEqual({ id: "tidal:1", name: "Portishead" });
    expect(parseArtist({ type: "artists", id: "1", attributes: {} }, index)).toBeUndefined();
  });

  it("keeps the place of one TIDAL tells nothing about", () => {
    expect(toArtist({ type: "artists", id: "404", meta: {} }, index)).toEqual({
      id: "tidal:404",
      name: "Unavailable artist",
    });
  });
});

describe("parsePlaylist", () => {
  const playlist = (attributes: Record<string, unknown>, relationships?: unknown) =>
    parsePlaylist({ type: "playlists", id: "550e-84", attributes, relationships });

  it("reads everything the tools use", () => {
    expect(
      playlist(
        {
          name: "Mix",
          description: "Of things",
          accessType: "PUBLIC",
          duration: "PT30M5S",
          numberOfItems: 12,
          numberOfTrackItems: 11,
          lastModifiedAt: "2026-02-03T04:05:06Z",
          externalLinks: [{ href: "https://tidal.com/playlist/550e-84", meta: { type: "TIDAL_SHARING" } }],
        },
        { owners: many("users", "77") },
      ),
    ).toEqual({
      id: "tidal:550e-84",
      name: "Mix",
      description: "Of things",
      isPublic: true,
      duration: 1805,
      trackCount: 12,
      updatedAt: "2026-02-03T04:05:06Z",
      ownerId: "tidal:77",
      url: "https://tidal.com/playlist/550e-84",
    });
  });

  it("takes unlisted and private for not public, and an unknown access for unknown", () => {
    expect(playlist({ name: "x", accessType: "UNLISTED" })!.isPublic).toBe(false);
    expect(playlist({ name: "x", accessType: "PRIVATE" })!.isPublic).toBe(false);
    expect(playlist({ name: "x", accessType: "SECRET" })!).not.toHaveProperty("isPublic");
  });

  it("counts the tracks when the items are not counted", () => {
    expect(playlist({ name: "x", numberOfTrackItems: 3 })!.trackCount).toBe(3);
  });

  it("reads one with nothing but a name", () => {
    expect(playlist({ name: "Mix" })).toEqual({ id: "tidal:550e-84", name: "Mix" });
    expect(playlist({})).toBeUndefined();
  });
});

describe("parseAccount", () => {
  const user = (attributes: Record<string, unknown>) =>
    parseAccount({ data: { type: "users", id: "77", attributes } });

  it("says who is signed in, and where", () => {
    expect(user({ username: "a@b.c", country: "NO", firstName: "John", lastName: "Rambo" })).toEqual({
      account: { id: "tidal:77", displayName: "John Rambo" },
      countryCode: "NO",
    });
    expect(user({ username: "jr", country: "nowhere" })).toEqual({
      account: { id: "tidal:77", displayName: "jr" },
    });
    expect(user({}).account.displayName).toBe("77");
  });

  it("is an error without an id", () => {
    expect(() => parseAccount({ data: {} })).toThrow(expect.objectContaining({ kind: "api-response" }));
  });
});

describe("documents", () => {
  it("lists identifiers with what is said of them", () => {
    expect(identifiersOf({ data: [{ type: "tracks", id: "1", meta: { itemId: "e" } }, { type: "videos", id: "2" }] })).toEqual([
      { type: "tracks", id: "1", meta: { itemId: "e" } },
      { type: "videos", id: "2", meta: {} },
    ]);
  });

  it("never reads a broken list as a shorter one", () => {
    for (const document of [{}, { data: null }, { data: { id: "1", type: "tracks" } }, { data: [{ type: "tracks" }] }, undefined]) {
      expect(() => identifiersOf(document)).toThrow(expect.objectContaining({ kind: "api-response" }));
    }
  });

  it("finds a resource and its related ones, however broken", () => {
    expect(resourceOf({ data: ROADS })).toBe(ROADS);
    expect(resourceOf({ data: [] })).toBeUndefined();
    expect(relatedOf(ROADS, "artists").map((ref) => ref.id)).toEqual(["1", "2", "3"]);
    expect(relatedOf(ROADS, "credits")).toEqual([]);
    expect(relatedOf({ type: "x", id: "1", relationships: { y: { data: [null, { id: 3, type: "z" }] } } }, "y")).toEqual([]);
    // To-one.
    expect(relatedOf({ type: "x", id: "1", relationships: { y: { data: { id: "3", type: "z" } } } }, "y")).toHaveLength(1);
    expect(indexIncluded({ included: [null, 4, { id: "1" }] }).size).toBe(0);
    expect(indexIncluded(undefined).size).toBe(0);
  });
});
