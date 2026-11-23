import { describe, expect, it, vi } from "vitest";

import { MemoryMatches } from "../features/match.js";
import { ServiceError } from "./errors.js";
import { fillGaps } from "./gap-filler.js";
import { tagId, type ArtistId, type ServiceName, type TrackId } from "./ids.js";
import type { AlbumId } from "./ids.js";
import type { Album, Artist, Track } from "./model.js";
import { CAN, cannot, type MusicService } from "./service.js";

const song = (service: ServiceName, n: number, over: Partial<Track> = {}): Track => ({
  id: tagId<TrackId>(service, n),
  title: `Song ${n}`,
  artist: "Portishead",
  artistId: tagId<ArtistId>(service, 7),
  isrc: `ISRC${n}`,
  duration: 200,
  ...over,
});

function spotify(over: Partial<MusicService> = {}): MusicService {
  const own = [1, 2, 3].map((n) => song("spotify", n));
  return {
    name: "spotify",
    capabilities: { topTracks: cannot("Spotify does not say"), similarArtists: cannot("Spotify does not say") },
    getArtist: vi.fn(async (id: ArtistId) => ({ id, name: "Portishead" })),
    getArtistTopTracks: vi.fn(async () => {
      throw new ServiceError("spotify", "unsupported", "Spotify does not say");
    }),
    getSimilarArtists: vi.fn(async () => {
      throw new ServiceError("spotify", "unsupported", "Spotify does not say");
    }),
    findByIsrc: vi.fn(async (isrcs: readonly string[]) => {
      const out = new Map<string, Track[]>();
      for (const isrc of isrcs) {
        const found = own.filter((track) => track.isrc === isrc);
        if (found.length > 0) out.set(isrc, found);
      }
      return out;
    }),
    searchTracks: vi.fn(async () => []),
    getTrack: vi.fn(),
    searchArtists: vi.fn(async (name: string): Promise<Artist[]> =>
      name === "Tricky" ? [{ id: tagId<ArtistId>("spotify", 8), name: "Tricky" }] : [{ id: tagId<ArtistId>("spotify", 9), name: `${name} Tribute` }],
    ),
    getPlaylist: vi.fn(),
    ...over,
  } as unknown as MusicService;
}

function qobuz(): MusicService {
  return {
    name: "qobuz",
    capabilities: { topTracks: CAN, similarArtists: CAN },
    searchArtists: vi.fn(async (name: string) => [{ id: tagId<ArtistId>("qobuz", 70), name }]),
    getArtistTopTracks: vi.fn(async () => [3, 1, 4, 2].map((n) => song("qobuz", n))),
    getSimilarArtists: vi.fn(async () => [
      { id: tagId<ArtistId>("qobuz", 80), name: "Tricky" },
      { id: tagId<ArtistId>("qobuz", 81), name: "Massive Attack" },
    ]),
  } as unknown as MusicService;
}

const artist = tagId<ArtistId>("spotify", 7);

describe("fillGaps", () => {
  it("leaves the capabilities of a service that has them as they are", () => {
    const full = qobuz();
    expect(fillGaps(full, () => [], new MemoryMatches()).capabilities).toEqual(full.capabilities);
  });

  it("takes top tracks from another service, in its order, as the service's own songs", async () => {
    const filled = fillGaps(spotify(), () => [qobuz()], new MemoryMatches());
    const tracks = await filled.getArtistTopTracks(artist, 10);
    expect(tracks.map((track) => track.id)).toEqual(["spotify:3", "spotify:1", "spotify:2"]);
    expect(filled.capabilities.topTracks).toEqual({ ok: true, from: "qobuz" });
  });

  it("gives only exact matches by the same artist: nothing unseen that may be wrong", async () => {
    const own = [
      song("spotify", 1, { title: "Song 1 (Live)" }), // the same ISRC, another title: likely
      song("spotify", 3, { artistId: tagId<ArtistId>("spotify", 99), artist: "Portishead" }), // a namesake
      song("spotify", 4),
    ];
    const base = spotify({
      findByIsrc: vi.fn(async (isrcs: readonly string[]) => {
        const out = new Map<string, Track[]>();
        for (const isrc of isrcs) {
          const found = own.filter((track) => track.isrc === isrc);
          if (found.length > 0) out.set(isrc, found);
        }
        return out;
      }),
    } as Partial<MusicService>);
    const filled = fillGaps(base, () => [qobuz()], new MemoryMatches());
    expect((await filled.getArtistTopTracks(artist, 10)).map((track) => track.id)).toEqual(["spotify:4"]);
  });

  it("honours the limit", async () => {
    const filled = fillGaps(spotify(), () => [qobuz()], new MemoryMatches());
    expect(await filled.getArtistTopTracks(artist, 2)).toHaveLength(2);
  });

  it("takes similar artists there by their exact name, and leaves out the rest", async () => {
    const filled = fillGaps(spotify(), () => [qobuz()], new MemoryMatches());
    expect(await filled.getSimilarArtists(artist, 5)).toEqual([{ id: "spotify:8", name: "Tricky" }]);
  });

  it("says what to connect when no service can tell", async () => {
    const filled = fillGaps(spotify(), () => [], new MemoryMatches());
    await expect(filled.getArtistTopTracks(artist)).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/Connect Qobuz or TIDAL/),
    });
  });

  it("passes everything else through", async () => {
    const base = spotify();
    const filled = fillGaps(base, () => [qobuz()], new MemoryMatches());
    await filled.searchArtists("x");
    expect(base.searchArtists).toHaveBeenCalledWith("x");
    expect(filled.name).toBe("spotify");
  });
});

describe("fillGaps: another service's ids", () => {
  const album = (service: ServiceName, n: number | string, over: Partial<Album> = {}): Album => ({
    id: tagId<AlbumId>(service, n),
    title: "Dummy",
    artist: "Portishead",
    ...over,
  });

  function here(over: Partial<MusicService> = {}): MusicService {
    return {
      name: "qobuz",
      capabilities: { topTracks: CAN, similarArtists: CAN },
      getArtist: vi.fn(async (id: ArtistId) => ({ id, name: "Own" })),
      searchArtists: vi.fn(async () => [
        { id: tagId<ArtistId>("qobuz", 1), name: "Portishead Tribute" },
        { id: tagId<ArtistId>("qobuz", 2), name: "portishead" },
      ]),
      getAlbum: vi.fn(async (id: AlbumId) => album("qobuz", "own", { id })),
      searchAlbums: vi.fn(async () => [
        album("qobuz", "a", { title: "Dummy (Live)" }),
        album("qobuz", "b"),
        album("qobuz", "c", { upc: "0042282855329" }),
      ]),
      ...over,
    } as unknown as MusicService;
  }

  const there = (over: Partial<MusicService> = {}) =>
    spotify({ getAlbum: vi.fn(async (id: AlbumId) => album("spotify", "x", { id })), ...over } as Partial<MusicService>);

  it("finds an artist linked on another service here, by its exact name", async () => {
    const filled = fillGaps(here(), () => [there()], new MemoryMatches());
    expect(await filled.getArtist(tagId<ArtistId>("spotify", 7))).toEqual({ id: "qobuz:2", name: "portishead" });
  });

  it("passes its own ids through", async () => {
    const base = here();
    const filled = fillGaps(base, () => [there()], new MemoryMatches());
    await filled.getArtist(tagId<ArtistId>("qobuz", 5));
    await filled.getAlbum(tagId<AlbumId>("qobuz", "z"));
    expect(base.getArtist).toHaveBeenCalledWith("qobuz:5");
    expect(base.getAlbum).toHaveBeenCalledWith("qobuz:z");
  });

  it("chooses no artist when several here have the name, and says so", async () => {
    const namesakes = vi.fn(async () => [
      { id: tagId<ArtistId>("qobuz", 1), name: "Portishead" },
      { id: tagId<ArtistId>("qobuz", 2), name: "portishead" },
    ]);
    const filled = fillGaps(here({ searchArtists: namesakes } as Partial<MusicService>), () => [there()], new MemoryMatches());
    await expect(filled.getArtist(tagId<ArtistId>("spotify", 7))).rejects.toMatchObject({
      kind: "ambiguous",
      message: expect.stringMatching(/2 Qobuz artists are called Portishead/),
    });
  });

  it("says when the artist is not here", async () => {
    const filled = fillGaps(here({ searchArtists: vi.fn(async () => []) } as Partial<MusicService>), () => [there()], new MemoryMatches());
    await expect(filled.getArtist(tagId<ArtistId>("spotify", 7))).rejects.toMatchObject({
      kind: "not-found",
      message: expect.stringMatching(/Portishead.*not on Qobuz/),
    });
  });

  it("says to connect the service a link is to", async () => {
    const filled = fillGaps(here(), () => [], new MemoryMatches());
    await expect(filled.getArtist(tagId<ArtistId>("spotify", 7))).rejects.toMatchObject({
      kind: "not-connected",
      message: expect.stringMatching(/Spotify link.*[Cc]onnect Spotify/),
    });
  });

  it("finds an album by its barcode first", async () => {
    const theirs = there({ getAlbum: vi.fn(async () => album("spotify", "x", { upc: "042282855329" })) } as Partial<MusicService>);
    const filled = fillGaps(here(), () => [theirs], new MemoryMatches());
    expect((await filled.getAlbum(tagId<AlbumId>("spotify", "x"))).id).toBe("qobuz:c");
  });

  it("else by its exact title and artist", async () => {
    const base = here({ searchAlbums: vi.fn(async () => [album("qobuz", "a", { title: "Dummy (Live)" }), album("qobuz", "b")]) } as Partial<MusicService>);
    const filled = fillGaps(base, () => [there()], new MemoryMatches());
    expect((await filled.getAlbum(tagId<AlbumId>("spotify", "x"))).id).toBe("qobuz:b");
  });

  // Spotify's search gives albums without their barcode: the full album has it.
  it("reads the barcodes of same-titled editions to tell them apart", async () => {
    const theirs = there({ getAlbum: vi.fn(async () => album("spotify", "x", { upc: "042282855329" })) } as Partial<MusicService>);
    const base = here({
      searchAlbums: vi.fn(async () => [album("qobuz", "clean"), album("qobuz", "explicit")]),
      getAlbum: vi.fn(async (id: AlbumId) => album("qobuz", "z", { id, ...(id === "qobuz:explicit" && { upc: "0042282855329" }) })),
    } as Partial<MusicService>);
    const filled = fillGaps(base, () => [theirs], new MemoryMatches());
    expect((await filled.getAlbum(tagId<AlbumId>("spotify", "x"))).id).toBe("qobuz:explicit");
  });

  it("chooses no edition when several share the title and none has the barcode", async () => {
    const base = here({ searchAlbums: vi.fn(async () => [album("qobuz", "a"), album("qobuz", "b")]) } as Partial<MusicService>);
    const filled = fillGaps(base, () => [there()], new MemoryMatches());
    await expect(filled.getAlbum(tagId<AlbumId>("spotify", "x"))).rejects.toMatchObject({
      kind: "ambiguous",
      message: expect.stringMatching(/2 Qobuz albums are Portishead - Dummy/),
    });
  });

  it("says when the album is not here", async () => {
    const filled = fillGaps(here({ searchAlbums: vi.fn(async () => []) } as Partial<MusicService>), () => [there()], new MemoryMatches());
    await expect(filled.getAlbum(tagId<AlbumId>("spotify", "x"))).rejects.toMatchObject({
      kind: "not-found",
      message: expect.stringMatching(/Dummy.*not on Qobuz/),
    });
  });
});
