import { describe, expect, it, vi } from "vitest";

import type { Track } from "../services/model.js";
import {
  createSongPicker,
  parseSongPickerState,
  SongPicker,
  songKeys,
} from "./song-picker.js";

const roads: Track = { id: 1, title: "Roads", artist: "Portishead", isrc: "GBF089400010" };

describe("songKeys", () => {
  it("keys a track by id, ISRC and normalised artist and title", () => {
    expect(songKeys(roads)).toEqual(["id:1", "isrc:GBF089400010", "sig:portishead\u0000roads"]);
  });

  it("counts the version label as part of the title, so live takes stay apart", () => {
    expect(songKeys({ id: 2, title: "Roads", version: "Live", artist: "Portishead" })).toContain(
      "sig:portishead\u0000roads live",
    );
    // Edition noise is dropped, as the deduplicator does.
    expect(
      songKeys({ id: 3, title: "Roads", version: "2014 Remaster", artist: "Portishead" }),
    ).toContain("sig:portishead\u0000roads");
  });

  it("leaves out the signature when the artist is unknown", () => {
    expect(songKeys({ id: 4, title: "Roads" })).toEqual(["id:4"]);
  });
});

describe("SongPicker", () => {
  it("excludes nothing when neither option is on", () => {
    const picker = new SongPicker({ oneCopy: false });
    expect(picker.active).toBe(false);
    picker.take(roads);
    expect(picker.exclusion(roads)).toBeUndefined();
  });

  it("excludes favourites by id, ISRC or song", () => {
    const picker = SongPicker.fromFavourites([roads], { oneCopy: false });
    expect(picker.active).toBe(true);
    expect(picker.exclusion({ id: 1, title: "Anything" })).toEqual({ kind: "favourite" });
    expect(picker.exclusion({ id: 9, title: "Roads (other)", isrc: "GBF089400010" })).toEqual({
      kind: "favourite",
    });
    expect(
      picker.exclusion({ id: 10, title: "Roads", version: "Remastered", artist: "PORTISHEAD" }),
    ).toEqual({ kind: "favourite" });
    expect(
      picker.exclusion({ id: 11, title: "Roads", version: "Live", artist: "Portishead" }),
    ).toBeUndefined();
  });

  it("with one copy, excludes later copies of a song already taken", () => {
    const picker = new SongPicker({ oneCopy: true });
    expect(picker.exclusion(roads)).toBeUndefined();
    picker.take(roads);
    expect(picker.exclusion({ id: 20, title: "Roads", version: "Remastered", artist: "Portishead" })).toEqual(
      { kind: "repeat", of: "Roads" },
    );
    expect(picker.exclusion({ id: 21, title: "Glory Box", artist: "Portishead" })).toBeUndefined();
  });

  it("names the first copy with its version", () => {
    const picker = new SongPicker({ oneCopy: true });
    picker.take({ id: 30, title: "Roads", version: "Live", artist: "Portishead", isrc: "X1" });
    expect(picker.exclusion({ id: 31, title: "Roads (Live in NYC)", isrc: "X1" })).toEqual({
      kind: "repeat",
      of: "Roads (Live)",
    });
  });

  it("chains matches through excluded copies", () => {
    const picker = new SongPicker({ oneCopy: true });
    picker.take({ id: 1, title: "Song", artist: "A", isrc: "I1" });
    // Same ISRC, different title: a repeat whose title is remembered too...
    const second: Track = { id: 2, title: "Song (Radio Mix)", artist: "A", isrc: "I1" };
    expect(picker.exclusion(second)).toEqual({ kind: "repeat", of: "Song" });
    picker.skip(second);
    // ...so a third copy matching only the second is still the same song.
    expect(picker.exclusion({ id: 3, title: "Song (Radio Mix)", artist: "A" })).toEqual({
      kind: "repeat",
      of: "Song",
    });
  });

  it("does not remember skipped tracks without one copy", () => {
    const picker = SongPicker.fromFavourites([], { oneCopy: false });
    picker.skip(roads);
    picker.take(roads);
    expect(picker.exclusion(roads)).toBeUndefined();
  });

  it("checks favourites before repeats", () => {
    const picker = SongPicker.fromFavourites([roads], { oneCopy: true });
    picker.take({ id: 5, title: "Roads", artist: "Portishead" });
    expect(picker.exclusion(roads)).toEqual({ kind: "favourite" });
  });

  it("round-trips its state, so a run can continue across requests", () => {
    const picker = SongPicker.fromFavourites([roads], { oneCopy: true });
    picker.take({ id: 7, title: "Glory Box", artist: "Portishead" });
    const state = JSON.parse(JSON.stringify(picker.state()));
    const resumed = SongPicker.fromState(parseSongPickerState(state));
    expect(resumed.exclusion(roads)).toEqual({ kind: "favourite" });
    expect(resumed.exclusion({ id: 8, title: "Glory Box", artist: "Portishead" })).toEqual({
      kind: "repeat",
      of: "Glory Box",
    });
  });
});

describe("parseSongPickerState", () => {
  it("accepts a well-formed state", () => {
    expect(parseSongPickerState({ oneCopy: true, favourites: ["id:1"], seen: [["id:2", "X"]] })).toEqual(
      { oneCopy: true, favourites: ["id:1"], seen: [["id:2", "X"]] },
    );
    expect(parseSongPickerState({ oneCopy: false })).toEqual({ oneCopy: false, seen: [] });
  });

  it("rejects anything else", () => {
    for (const raw of [
      null,
      "x",
      {},
      { oneCopy: "yes" },
      { oneCopy: true, favourites: [1] },
      { oneCopy: true, seen: [["only-key"]] },
      { oneCopy: true, seen: "nope" },
    ]) {
      expect(() => parseSongPickerState(raw)).toThrow(/picker/);
    }
  });
});

describe("createSongPicker", () => {
  it("fetches the favourites once when skipping them", async () => {
    const client = { getFavoriteTracks: vi.fn(async () => [roads]) };
    const picker = await createSongPicker(client, { skipFavourites: true, oneCopy: false });
    expect(client.getFavoriteTracks).toHaveBeenCalledTimes(1);
    expect(picker.exclusion(roads)).toEqual({ kind: "favourite" });
  });

  it("does not fetch the favourites otherwise", async () => {
    const client = { getFavoriteTracks: vi.fn(async () => [roads]) };
    const picker = await createSongPicker(client, { oneCopy: true });
    expect(client.getFavoriteTracks).not.toHaveBeenCalled();
    expect(picker.active).toBe(true);
  });
});
