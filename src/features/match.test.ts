import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../services/errors.js";
import { tagId, type TrackId } from "../services/ids.js";
import type { Track } from "../services/model.js";
import { matchTracks, MemoryMatches, writable, type MatchClient } from "./match.js";

const q = (n: number) => tagId<TrackId>("qobuz", n);
const t = (n: number | string) => tagId<TrackId>("tidal", n);

const source = (over: Partial<Track> = {}): Track => ({
  id: q(1),
  title: "Roads",
  artist: "Portishead",
  isrc: "GBF089400010",
  duration: 303,
  ...over,
});
const found = (n: number | string, over: Partial<Track> = {}): Track => ({
  id: t(n),
  title: "Roads",
  artist: "Portishead",
  isrc: "GBF089400010",
  duration: 303,
  ...over,
});

/** TIDAL with these tracks: found by ISRC, by any search, and by id. */
function tidal(tracks: Track[], over: Partial<MatchClient> = {}): MatchClient {
  return {
    name: "tidal",
    findByIsrc: vi.fn(async (isrcs: readonly string[]) => {
      const out = new Map<string, Track[]>();
      for (const isrc of isrcs) {
        const same = tracks.filter((track) => track.isrc === isrc);
        if (same.length > 0) {
          out.set(isrc, same);
        }
      }
      return out;
    }),
    searchTracks: vi.fn(async () => tracks),
    getTrack: vi.fn(async (id: TrackId) => {
      const track = tracks.find((one) => one.id === id);
      if (track === undefined) {
        throw new ServiceError("tidal", "not-found", "gone");
      }
      return track;
    }),
    ...over,
  };
}

const one = async (track: Track, client: MatchClient, matches = new MemoryMatches()) =>
  (await matchTracks(client, [track], matches))[0]!;

describe("matchTracks", () => {
  it("takes a song already on the service as it is, asking nothing", async () => {
    const client = tidal([]);
    expect(await one(found(5), client)).toMatchObject({ grade: "exact", via: "same", track: { id: t(5) } });
    expect(client.findByIsrc).not.toHaveBeenCalled();
    expect(client.searchTracks).not.toHaveBeenCalled();
  });

  it("is exact for the same recording, without searching", async () => {
    const client = tidal([found(5)]);
    expect(await one(source(), client)).toMatchObject({ grade: "exact", via: "isrc", track: { id: t(5) } });
    expect(client.searchTracks).not.toHaveBeenCalled();
  });

  it("looks ISRCs up together", async () => {
    const client = tidal([found(5), found(6, { isrc: "GB2", title: "Glory Box" })]);
    await matchTracks(client, [source(), source({ id: q(2), isrc: "GB2", title: "Glory Box" })], new MemoryMatches());
    expect(client.findByIsrc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different title", { title: "Something Else" }, /title/],
    ["a live title", { title: "Roads (Live)" }, /title/],
    ["another artist", { artist: "Someone Else" }, /artist/],
    ["a length over 5 seconds off", { duration: 320 }, /length/],
  ])("is only likely for the same ISRC with %s", async (_what, over, reason) => {
    const match = await one(source(), tidal([found(5, over)]));
    expect(match).toMatchObject({ grade: "likely", via: "isrc", track: { id: t(5) } });
    expect(match.reason).toMatch(reason);
  });

  it.each([
    ["edition noise", { title: "Roads (2011 Remaster)" }],
    ["a featured credit", { title: "Roads (feat. Someone)" }],
    ["a longer artist credit", { artist: "Portishead, Someone" }],
    ["a length within 5 seconds", { duration: 307 }],
    ["no length given", { duration: undefined as unknown as number }],
  ])("stays exact through %s", async (_what, over) => {
    expect((await one(source(), tidal([found(5, over)]))).grade).toBe("exact");
  });

  it("chooses among copies: playable, then the same album, quality, and the earliest", async () => {
    const pick = async (...tracks: Track[]) => (await one(source({ album: "Dummy" }), tidal(tracks))).track?.id;
    expect(await pick(found(1, { streamable: false }), found(2))).toBe(t(2));
    expect(await pick(found(1, { album: "Hits" }), found(2, { album: "Dummy" }))).toBe(t(2));
    expect(await pick(found(1, { quality: "lossless" }), found(2, { quality: "hires" }))).toBe(t(2));
    expect(await pick(found(1, { releaseDate: "2011-01-01" }), found(2, { releaseDate: "1994-08-22" }))).toBe(t(2));
  });

  it("is missing when the only copies cannot be played", async () => {
    const match = await one(source(), tidal([found(5, { streamable: false })]));
    expect(match.grade).toBe("missing");
    expect(match.reason).toMatch(/cannot be played/);
  });

  it("is only likely by name, offering the others", async () => {
    const match = await one(
      source({ isrc: undefined as unknown as string }),
      tidal([found(4, { title: "Roadside" }), found(5), found(6, { album: "Live" })]),
    );
    expect(match).toMatchObject({ grade: "likely", via: "search", track: { id: t(5) } });
    expect(match.options.map((option) => option.id)).toEqual([t(5), t(6)]);
  });

  it("searches by name when the service has no such ISRC", async () => {
    const client = tidal([found(5, { isrc: "OTHER" })]);
    expect(await one(source(), client)).toMatchObject({ grade: "likely", via: "search" });
    expect(client.searchTracks).toHaveBeenCalledWith("Portishead Roads", 10);
  });

  it("offers another version as likely, saying so, after the same one", async () => {
    const live = found(5, { title: "Roads (Live)", isrc: "L" });
    const match = await one(source(), tidal([live]));
    expect(match).toMatchObject({ grade: "likely", track: { id: t(5) } });
    expect(match.reason).toMatch(/version/);
    const both = await one(source(), tidal([live, found(6, { isrc: "X" })]));
    expect(both.track?.id).toBe(t(6));
  });

  it("is missing when nothing has the artist and title", async () => {
    expect(await one(source(), tidal([found(5, { isrc: "X", artist: "Someone Else" })]))).toMatchObject({
      grade: "missing",
      options: [],
    });
  });

  it("never matches what is not a song", async () => {
    const client = tidal([found(5)]);
    const match = await one(source({ other: "episode" }), client);
    expect(match.grade).toBe("missing");
    expect(match.reason).toMatch(/not a song/);
    expect(client.findByIsrc).not.toHaveBeenCalledWith(expect.arrayContaining(["GBF089400010"]));
  });

  it("reports a failed search for one song without losing the others", async () => {
    const client = tidal([found(6, { isrc: "GB2", title: "Glory Box" })], {
      searchTracks: vi.fn(async () => {
        throw new ServiceError("tidal", "api-response", "HTTP 500");
      }),
    });
    const result = await matchTracks(
      client,
      [source(), source({ id: q(2), isrc: "GB2", title: "Glory Box" })],
      new MemoryMatches(),
    );
    expect(result.map((match) => [match.grade, match.failed])).toEqual([
      ["missing", "HTTP 500"],
      ["exact", undefined],
    ]);
  });

  it.each(["authentication", "quota", "not-connected"])("stops for a %s error, which every song would hit", async (kind) => {
    const client = tidal([], {
      searchTracks: vi.fn(async () => {
        throw new ServiceError("tidal", kind, "no");
      }),
    });
    await expect(one(source(), client)).rejects.toMatchObject({ kind });
  });

  it("keeps the order, and repeated songs", async () => {
    const client = tidal([found(5), found(6, { isrc: "GB2", title: "Glory Box" })]);
    const box = source({ id: q(2), isrc: "GB2", title: "Glory Box" });
    const result = await matchTracks(client, [box, source(), box], new MemoryMatches());
    expect(result.map((match) => match.track?.id)).toEqual([t(6), t(5), t(6)]);
  });
});

describe("remembered matches", () => {
  it("are exact, and asked for only to see that they still play", async () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", t(9));
    const client = tidal([found(9, { title: "Anything", isrc: "X" })]);
    expect(await one(source(), client, matches)).toMatchObject({ grade: "exact", via: "remembered", track: { id: t(9) } });
    expect(client.searchTracks).not.toHaveBeenCalled();
  });

  it("are looked up again when the remembered one is gone or unplayable", async () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", t(9));
    expect(await one(source(), tidal([found(5)]), matches)).toMatchObject({ via: "isrc", track: { id: t(5) } });
    const unplayable = found(9, { streamable: false, isrc: "X" });
    expect(await one(source(), tidal([unplayable, found(5)]), matches)).toMatchObject({ via: "isrc", track: { id: t(5) } });
  });

  it("are kept when the service cannot be asked", async () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", t(9));
    const client = tidal([found(5)], {
      getTrack: vi.fn(async () => {
        throw new ServiceError("tidal", "api-response", "HTTP 500");
      }),
    });
    expect(await one(source(), client, matches)).toMatchObject({ grade: "missing", failed: "HTTP 500" });
  });

  it("say when the user wants none", async () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", null);
    const match = await one(source(), tidal([found(5)]), matches);
    expect(match.grade).toBe("missing");
    expect(match.reason).toMatch(/you chose/i);
  });

  it("answer only in their direction and for their service", async () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", t(9));
    expect(matches.recall(t(9), "qobuz")).toBeUndefined();
    expect(matches.recall(q(1), "spotify")).toBeUndefined();
  });

  it("can be forgotten, one or a service's", () => {
    const matches = new MemoryMatches();
    matches.remember(q(1), "tidal", t(9));
    matches.remember(q(2), "spotify", tagId<TrackId>("spotify", "x"));
    matches.remember(t(3), "qobuz", q(3));
    matches.forget(q(1), "tidal");
    expect(matches.recall(q(1), "tidal")).toBeUndefined();
    matches.forgetService("tidal");
    expect(matches.recall(t(3), "qobuz")).toBeUndefined();
    expect(matches.recall(q(2), "spotify")).toBe("spotify:x");
  });
});

describe("writable", () => {
  it("gives the ids to write without asking: exact ones, in order", async () => {
    const result = await matchTracks(
      tidal([found(5), found(6, { isrc: "GB2", title: "Other" })]),
      [source(), source({ id: q(2), isrc: "GB2", title: "Glory Box" }), source({ id: q(3), isrc: "NONE", title: "Zzz" })],
      new MemoryMatches(),
    );
    expect(writable(result)).toEqual([t(5)]);
  });
});
