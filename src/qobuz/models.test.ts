import { describe, expect, it } from "vitest";

import {
  parseAlbumReleaseDate,
  parseArtistPageTracks,
  parseArtists,
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
      { id: 11, title: "Blue in Green" },
    ]);
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
        artist: "Portishead",
        isrc: "GBAQT9400066",
        album: "Dummy",
        albumId: "0004228285532",
        bitDepth: 16,
        samplingRate: 44.1,
      },
      { id: 627451, title: "Sour Times" },
    ]);
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

describe("parsePlaylist", () => {
  it("extracts id and name", () => {
    expect(parsePlaylist({ id: 999, name: "Jazz", is_public: false })).toEqual({
      id: 999,
      name: "Jazz",
    });
  });

  it("includes the track count when present", () => {
    expect(parsePlaylist({ id: 1, name: "P", tracks_count: 42 })).toEqual({
      id: 1,
      name: "P",
      trackCount: 42,
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
