import { describe, expect, it } from "vitest";

import { tagId } from "../ids.js";
import type { AlbumId, TrackId } from "../model.js";
import { isLocal, nativeOfUri, plainId, uriOf } from "./uris.js";

const track = (native: string) => tagId<TrackId>("spotify", native);

describe("Spotify URIs", () => {
  it("turns a track's, an episode's and a local file's id into its URI and back", () => {
    for (const [native, uri] of [
      ["4iV5W9uYEdYUVa79Axb7Rh", "spotify:track:4iV5W9uYEdYUVa79Axb7Rh"],
      ["episode:512ojhOuo1ktJprKbVcKyQ", "spotify:episode:512ojhOuo1ktJprKbVcKyQ"],
      ["local:Some+One:LP:A+Song:185", "spotify:local:Some+One:LP:A+Song:185"],
    ] as const) {
      expect(uriOf(track(native))).toBe(uri);
      expect(nativeOfUri(uri)).toBe(native);
    }
  });

  it("knows no native id for anything else", () => {
    expect(nativeOfUri("spotify:user:me")).toBeUndefined();
    expect(nativeOfUri(undefined)).toBeUndefined();
  });

  it("refuses another service's ids, and what cannot be a Spotify id", () => {
    expect(() => uriOf(tagId<TrackId>("qobuz", 1))).toThrow(/not on Spotify/);
    for (const native of ["a,b", "track:abc", "../me", "episode:", "episode:a,b"]) {
      expect(() => uriOf(track(native)), native).toThrow(/not a Spotify id/);
    }
    expect(() => plainId(tagId<AlbumId>("spotify", "a/b"))).toThrow(/not a Spotify id/);
    expect(plainId(tagId<AlbumId>("spotify", "abc1"))).toBe("abc1");
  });

  it("tells local files", () => {
    expect(isLocal(track("local:a:b:c:1"))).toBe(true);
    expect(isLocal(track("abc"))).toBe(false);
  });
});
