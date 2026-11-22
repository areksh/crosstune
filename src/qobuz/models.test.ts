import { describe, expect, it } from "vitest";

import {
  parseAlbumReleaseDate,
  parseAlbumTracks,
  parseAlbums,
  parseAlbumsPage,
  parseArtistPageTracks,
  parseArtists,
  parseArtistsPage,
  parseCredits,
  parsePlaylist,
  parsePlaylists,
  parsePlaylistsPage,
  parseTracks,
  parseTracksPage,
} from "./models.js";

describe("parseArtists", () => {
  it("extracts id and name from the artists.items list", () => {
    const json = {
      artists: {
        items: [
          { id: 1, name: "Miles Davis", extra: "ignored" },
          { id: 2, name: "John Coltrane" },
        ],
      },
    };
    expect(parseArtists(json)).toEqual([
      { id: 1, name: "Miles Davis" },
      { id: 2, name: "John Coltrane" },
    ]);
  });

  it("skips entries without a numeric id or name", () => {
    const json = {
      artists: { items: [{ id: 1, name: "Ok" }, { name: "No id" }, { id: 3 }] },
    };
    expect(parseArtists(json)).toEqual([{ id: 1, name: "Ok" }]);
  });

  it("returns an empty array when the shape is unexpected", () => {
    expect(parseArtists({})).toEqual([]);
    expect(parseArtists({ artists: {} })).toEqual([]);
    expect(parseArtists(null)).toEqual([]);
  });
});

describe("parseTracks", () => {
  it("extracts id and title from a tracks container", () => {
    const json = {
      tracks: {
        items: [
          { id: 10, title: "So What" },
          { id: 11, title: "Blue in Green", duration: 327 },
        ],
      },
    };
    expect(parseTracks(json)).toEqual([
      { id: 10, title: "So What" },
      { id: 11, title: "Blue in Green", duration: 327 },
    ]);
  });

  it("reads the duration in seconds, ignoring a malformed one", () => {
    const json = {
      tracks: {
        items: [
          { id: 1, title: "A", duration: 0 },
          { id: 2, title: "B", duration: "327" },
          { id: 3, title: "C", duration: -5 },
          { id: 4, title: "D", duration: null },
        ],
      },
    };
    expect(parseTracks(json).map((t) => t.duration)).toEqual([0, undefined, undefined, undefined]);
  });

  it("skips malformed track entries", () => {
    const json = { tracks: { items: [{ id: 10, title: "Ok" }, { id: 11 }] } };
    expect(parseTracks(json)).toEqual([{ id: 10, title: "Ok" }]);
  });

  it("pulls artist, isrc, album, quality, ids and release date when present", () => {
    const json = {
      tracks: {
        items: [
          {
            id: 10,
            title: "So What",
            isrc: "USSM15900001",
            performer: { name: "Miles Davis" },
            album: {
              id: "abc123",
              title: "Kind of Blue",
              release_date_original: "1959-08-17",
            },
            playlist_track_id: 555,
            maximum_bit_depth: 24,
            maximum_sampling_rate: 96,
            hires: true,
          },
        ],
      },
    };
    expect(parseTracks(json)).toEqual([
      {
        id: 10,
        title: "So What",
        artist: "Miles Davis",
        isrc: "USSM15900001",
        album: "Kind of Blue",
        albumId: "abc123",
        releaseDate: "1959-08-17",
        playlistTrackId: 555,
        bitDepth: 24,
        samplingRate: 96,
        hires: true,
      },
    ]);
  });

  it("reads the album's genre and when a favourite was added", () => {
    // Favourite tracks carry favorited_at (unix seconds); genre sits on the album.
    const json = {
      tracks: {
        items: [
          {
            id: 7,
            title: "Blue in Green",
            favorited_at: 1730000000,
            album: { id: "x", title: "Kind of Blue", genre: { id: 80, name: "Jazz", path: [80] } },
          },
          { id: 8, title: "No genre", album: { genre: { id: 1 } }, favorited_at: "soon" },
        ],
      },
    };
    const [first, second] = parseTracks(json);
    expect(first?.genre).toBe("Jazz");
    expect(first?.favouritedAt).toBe(new Date(1730000000 * 1000).toISOString());
    expect(second?.genre).toBeUndefined();
    expect(second?.favouritedAt).toBeUndefined();
  });

  it("reads the performer id as the track's artist id", () => {
    // playlist/get tracks carry performer { id, name }.
    const json = {
      tracks: { items: [{ id: 1, title: "Changes", performer: { id: 66713, name: "Jeff Mills" } }] },
    };
    expect(parseTracks(json)).toEqual([
      { id: 1, title: "Changes", artist: "Jeff Mills", artistId: 66713 },
    ]);
  });

  it("reads the version and disc number of an album/get track", () => {
    // album/get track items carry media_number (the disc) and a nullable version.
    const json = {
      tracks: {
        items: [
          { id: 1, title: "Hey You", version: "2011 Remaster", media_number: 2 },
          { id: 2, title: "In the Flesh?", version: null, media_number: 1 },
          { id: 3, title: "Empty Version", version: "" },
        ],
      },
    };
    expect(parseTracks(json)).toEqual([
      { id: 1, title: "Hey You", version: "2011 Remaster", discNumber: 2 },
      { id: 2, title: "In the Flesh?", discNumber: 1 },
      { id: 3, title: "Empty Version" },
    ]);
  });

  it("reads whether a track is streamable, leaving it unset when absent", () => {
    const json = {
      tracks: {
        items: [
          { id: 1, title: "Gone", streamable: false },
          { id: 2, title: "Here", streamable: true },
          { id: 3, title: "Unknown" },
          { id: 4, title: "Odd", streamable: "yes" },
        ],
      },
    };
    expect(parseTracks(json).map((t) => t.streamable)).toEqual([
      false,
      true,
      undefined,
      undefined,
    ]);
  });

  it("derives a release date from a released_at timestamp", () => {
    const json = {
      tracks: {
        items: [
          { id: 1, title: "T", album: { released_at: 0 } },
        ],
      },
    };
    expect(parseTracks(json)[0]?.releaseDate).toBe("1970-01-01");
  });
});

describe("parseAlbums", () => {
  it("extracts id, title, artist and metadata from the albums.items list", () => {
    const json = {
      albums: {
        items: [
          {
            id: "0724385",
            title: "OK Computer",
            version: "2017 Remaster",
            artist: { id: 41, name: "Radiohead" },
            release_date_original: "1997-05-21",
            maximum_bit_depth: 24,
            maximum_sampling_rate: 96,
            hires_streamable: true,
            tracks_count: 12,
          },
          { id: "0001", title: "Discovery", artist: { name: "Daft Punk" } },
        ],
      },
    };
    expect(parseAlbums(json)).toEqual([
      {
        id: "0724385",
        title: "OK Computer",
        version: "2017 Remaster",
        artist: "Radiohead",
        releaseDate: "1997-05-21",
        bitDepth: 24,
        samplingRate: 96,
        hires: true,
        trackCount: 12,
      },
      { id: "0001", title: "Discovery", artist: "Daft Punk" },
    ]);
  });

  it("reads whether an album is streamable", () => {
    const json = {
      albums: {
        items: [
          { id: "a", title: "T", artist: { name: "X" }, streamable: false },
          { id: "b", title: "U", artist: { name: "X" } },
        ],
      },
    };
    expect(parseAlbums(json).map((a) => a.streamable)).toEqual([false, undefined]);
  });

  it("reads hires from a plain hires flag when present", () => {
    const json = {
      albums: { items: [{ id: "a", title: "T", artist: { name: "X" }, hires: true }] },
    };
    expect(parseAlbums(json)[0]?.hires).toBe(true);
  });

  it("skips entries without a string id or title", () => {
    const json = {
      albums: {
        items: [
          { id: "a", title: "Ok", artist: { name: "X" } },
          { id: 5, title: "numeric id", artist: { name: "X" } },
          { id: "b" },
        ],
      },
    };
    expect(parseAlbums(json)).toEqual([{ id: "a", title: "Ok", artist: "X" }]);
  });

  it("returns an empty array when the shape is unexpected", () => {
    expect(parseAlbums({})).toEqual([]);
    expect(parseAlbums({ albums: {} })).toEqual([]);
    expect(parseAlbums(null)).toEqual([]);
  });
});

describe("parseArtistPageTracks", () => {
  it("parses the popularity-ordered top_tracks of an artist/page response", () => {
    // Shape mirrors the live /artist/page response: artist name nested under
    // artist.name.display, quality under audio_info, album id a string.
    const json = {
      top_tracks: [
        {
          id: 627460,
          title: "Glory Box",
          version: "Album Version",
          isrc: "GBAQT9400066",
          artist: { id: 41259, name: { display: "Portishead" } },
          album: { id: "0004228285532", title: "Dummy" },
          audio_info: { maximum_bit_depth: 16, maximum_sampling_rate: 44.1 },
        },
        { id: 627451, title: "Sour Times" },
      ],
    };
    expect(parseArtistPageTracks(json)).toEqual([
      {
        id: 627460,
        title: "Glory Box",
        version: "Album Version",
        artist: "Portishead",
        artistId: 41259,
        isrc: "GBAQT9400066",
        album: "Dummy",
        albumId: "0004228285532",
        bitDepth: 16,
        samplingRate: 44.1,
      },
      { id: 627451, title: "Sour Times" },
    ]);
  });

  it("reads a top track's duration", () => {
    const json = { top_tracks: [{ id: 1, title: "Roads", duration: 305 }] };
    expect(parseArtistPageTracks(json)).toEqual([{ id: 1, title: "Roads", duration: 305 }]);
  });

  it("skips malformed entries and tolerates an unexpected shape", () => {
    expect(parseArtistPageTracks({ top_tracks: [{ title: "no id" }] })).toEqual([]);
    expect(parseArtistPageTracks({})).toEqual([]);
    expect(parseArtistPageTracks(null)).toEqual([]);
  });
});

describe("parseAlbumReleaseDate", () => {
  it("reads the original release date from an album/get response", () => {
    expect(
      parseAlbumReleaseDate({ id: "x", release_date_original: "2011-09-26" }),
    ).toBe("2011-09-26");
  });

  it("returns undefined when no date is present", () => {
    expect(parseAlbumReleaseDate({ id: "x" })).toBeUndefined();
    expect(parseAlbumReleaseDate(null)).toBeUndefined();
  });
});

describe("parseTracksPage", () => {
  it("returns the tracks and the total for pagination", () => {
    const json = { tracks: { items: [{ id: 1, title: "A" }], total: 137 } };
    expect(parseTracksPage(json)).toEqual({
      tracks: [{ id: 1, title: "A" }],
      total: 137,
    });
  });

  it("defaults total to zero when absent", () => {
    expect(parseTracksPage({}).total).toBe(0);
  });
});

describe("parseAlbumsPage", () => {
  it("returns the albums and the total for pagination", () => {
    const json = {
      albums: { items: [{ id: "a", title: "T", artist: { name: "X" } }], total: 9 },
    };
    const page = parseAlbumsPage(json);
    expect(page.total).toBe(9);
    expect(page.albums).toEqual([{ id: "a", title: "T", artist: "X" }]);
  });

  it("defaults total to zero when absent", () => {
    expect(parseAlbumsPage({}).total).toBe(0);
  });
});

describe("parseArtistsPage", () => {
  it("returns the artists and the total for pagination", () => {
    const json = { artists: { items: [{ id: 3, name: "Bjork" }], total: 4 } };
    expect(parseArtistsPage(json)).toEqual({
      artists: [{ id: 3, name: "Bjork" }],
      total: 4,
    });
  });

  it("defaults total to zero when absent", () => {
    expect(parseArtistsPage({}).total).toBe(0);
  });
});

describe("parsePlaylist", () => {
  it("extracts id and name", () => {
    expect(parsePlaylist({ id: 999, name: "Jazz" })).toEqual({ id: 999, name: "Jazz" });
  });

  it("includes the track count when present", () => {
    expect(parsePlaylist({ id: 1, name: "P", tracks_count: 42 })).toEqual({
      id: 1,
      name: "P",
      trackCount: 42,
    });
  });

  it("includes its details when present", () => {
    expect(
      parsePlaylist({
        id: 1,
        name: "P",
        description: "For the car",
        is_public: false,
        is_collaborative: true,
        duration: 195054,
        updated_at: 1795049786,
        owner: { id: 7, name: "someone" },
      }),
    ).toEqual({
      id: 1,
      name: "P",
      description: "For the car",
      isPublic: false,
      isCollaborative: true,
      duration: 195054,
      updatedAt: "2026-11-19T00:56:26.000Z",
      ownerId: 7,
    });
  });

  it("throws when the response has no numeric id", () => {
    expect(() => parsePlaylist({ name: "no id" })).toThrow();
  });
});

describe("parsePlaylists", () => {
  it("extracts the playlists.items list with track counts", () => {
    const json = {
      playlists: {
        items: [
          { id: 1, name: "Road Trip", tracks_count: 12 },
          { id: 2, name: "Focus" },
        ],
      },
    };
    expect(parsePlaylists(json)).toEqual([
      { id: 1, name: "Road Trip", trackCount: 12 },
      { id: 2, name: "Focus" },
    ]);
  });

  it("skips malformed entries and tolerates an unexpected shape", () => {
    expect(parsePlaylists({ playlists: { items: [{ name: "no id" }] } })).toEqual(
      [],
    );
    expect(parsePlaylists({})).toEqual([]);
    expect(parsePlaylists(null)).toEqual([]);
  });
});

describe("parsePlaylistsPage", () => {
  it("returns the playlists and the total for pagination", () => {
    const json = {
      playlists: { items: [{ id: 1, name: "A" }], total: 9 },
    };
    expect(parsePlaylistsPage(json)).toEqual({
      playlists: [{ id: 1, name: "A" }],
      total: 9,
    });
  });

  it("defaults total to zero when absent", () => {
    expect(parsePlaylistsPage({}).total).toBe(0);
  });
});

describe("album artwork", () => {
  const image = {
    small: "https://static.qobuz.com/images/covers/ab/cd/x_230.jpg",
    thumbnail: "https://static.qobuz.com/images/covers/ab/cd/x_50.jpg",
    large: "https://static.qobuz.com/images/covers/ab/cd/x_600.jpg",
  };

  it("reads a track's cover from its embedded album, preferring the small size", () => {
    const json = { tracks: { items: [{ id: 1, title: "Roads", album: { title: "Dummy", image } }] } };
    expect(parseTracks(json)[0]?.image).toBe(image.small);
  });

  it("falls back to the thumbnail, then the large image", () => {
    const track = (img: unknown) =>
      parseTracks({ tracks: { items: [{ id: 1, title: "T", album: { image: img } }] } })[0];
    expect(track({ thumbnail: image.thumbnail, large: image.large })?.image).toBe(image.thumbnail);
    expect(track({ large: image.large })?.image).toBe(image.large);
  });

  it("accepts only https URLs, and tolerates a missing or odd image", () => {
    const track = (img: unknown) =>
      parseTracks({ tracks: { items: [{ id: 1, title: "T", album: { image: img } }] } })[0];
    expect(track({ small: "http://static.qobuz.com/x.jpg" })).toEqual({ id: 1, title: "T" });
    expect(track({ small: "javascript:alert(1)", large: image.large })?.image).toBe(image.large);
    expect(track("https://static.qobuz.com/x.jpg")).toEqual({ id: 1, title: "T" });
    expect(track(null)).toEqual({ id: 1, title: "T" });
  });

  it("reads an artist-page top track's cover from its album", () => {
    const json = { top_tracks: [{ id: 1, title: "Glory Box", album: { id: "a", image } }] };
    expect(parseArtistPageTracks(json)[0]?.image).toBe(image.small);
  });

  it("reads an album's cover", () => {
    const json = { albums: { items: [{ id: "a", title: "Dummy", image }] } };
    expect(parseAlbums(json)[0]?.image).toBe(image.small);
  });

  it("gives album/get tracks, which embed no album, the parent album's cover", () => {
    const own = "https://static.qobuz.com/images/covers/other_230.jpg";
    const json = {
      id: "a",
      image,
      tracks: {
        items: [
          { id: 1, title: "Mysterons" },
          { id: 2, title: "Sour Times", album: { image: { small: own } } },
        ],
      },
    };
    expect(parseAlbumTracks(json)).toEqual([
      { id: 1, title: "Mysterons", image: image.small },
      { id: 2, title: "Sour Times", image: own },
    ]);
    expect(parseAlbumTracks({ tracks: { items: [{ id: 1, title: "T" }] } })).toEqual([
      { id: 1, title: "T" },
    ]);
  });
});

describe("parseCredits", () => {
  it("finds guests and joint main artists, in either spelling", () => {
    expect(
      parseCredits(
        "Portishead, MainArtist - A Guest, FeaturedArtist\r - X, Composer\r\n - B Joint, Main Artist, Producer - C Guest, Featured Artist",
        "Portishead",
      ),
    ).toEqual({ joint: ["B Joint"], guests: ["A Guest", "C Guest"] });
  });

  it("finds the role among others, and compares the main artist without case", () => {
    expect(
      parseCredits("Cam'ron, MainArtist - Juelz Santana, Composer, FeaturedArtist", "Cam'Ron"),
    ).toEqual({ joint: [], guests: ["Juelz Santana"] });
  });

  it("keeps names that hold a comma", () => {
    expect(
      parseCredits("Tyler, The Creator, FeaturedArtist - Crosby, Stills & Nash, MainArtist", "Crosby, Stills & Nash"),
    ).toEqual({ joint: [], guests: ["Tyler, The Creator"] });
  });

  it("passes over credits without a role, other roles and repeats", () => {
    expect(parseCredits("Copyright Control - A, FeaturedArtist - a, FeaturedArtist - B, Vocals", "M")).toEqual({
      joint: [],
      guests: ["A"],
    });
    expect(parseCredits("", "M")).toEqual({ joint: [], guests: [] });
  });
});

describe("playlist track fields", () => {
  it("reads the added date of a playlist track, and its credits", () => {
    const [track] = parseTracks({
      tracks: {
        items: [
          {
            id: 1,
            title: "T",
            track_number: 4,
            performer: { id: 9, name: "Main" },
            performers: "Main, MainArtist - Guest, FeaturedArtist",
            created_at: 1794176267,
            playlist_track_id: 55,
          },
        ],
      },
    });
    expect(track).toMatchObject({
      trackNumber: 4,
      guestArtists: ["Guest"],
      addedAt: "2026-11-08T22:17:47.000Z",
      playlistTrackId: 55,
    });
    expect(track).not.toHaveProperty("jointArtists");
  });

  it("ignores created_at outside playlists, and impossible dates", () => {
    const [plain, broken] = parseTracks({
      tracks: {
        items: [
          { id: 1, title: "T", created_at: 1794176267 },
          { id: 2, title: "U", created_at: 1e300, playlist_track_id: 5 },
        ],
      },
    });
    expect(plain).not.toHaveProperty("addedAt");
    expect(broken).not.toHaveProperty("addedAt");
  });
});
