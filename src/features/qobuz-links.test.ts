import { describe, expect, it } from "vitest";

import {
  classifyPaste,
  describeLinkMismatch,
  parsePlaylistId,
  parseQobuzLink,
} from "./qobuz-links.js";

describe("parseQobuzLink", () => {
  it.each([
    ["https://play.qobuz.com/artist/41259", { kind: "artist", id: "qobuz:41259" }],
    ["https://open.qobuz.com/artist/41259", { kind: "artist", id: "qobuz:41259" }],
    ["https://play.qobuz.com/album/pvsb64n704d0b", { kind: "album", id: "qobuz:pvsb64n704d0b" }],
    ["https://open.qobuz.com/album/0724384559953", { kind: "album", id: "qobuz:0724384559953" }],
    [
      "https://www.qobuz.com/gb-en/album/mezzanine-massive-attack/pvsb64n704d0b",
      { kind: "album", id: "qobuz:pvsb64n704d0b" },
    ],
    // The API's own relative URL has no locale.
    [
      "https://www.qobuz.com/album/mezzanine-massive-attack/0724384559953",
      { kind: "album", id: "qobuz:0724384559953" },
    ],
    [
      "https://www.qobuz.com/us-en/interpreter/portishead/41259",
      { kind: "artist", id: "qobuz:41259" },
    ],
    ["https://play.qobuz.com/playlist/72685925", { kind: "playlist", id: "qobuz:72685925" }],
    ["https://open.qobuz.com/playlist/72685925", { kind: "playlist", id: "qobuz:72685925" }],
    [
      "https://www.qobuz.com/gb-en/playlists/new-releases/72685925",
      { kind: "playlist", id: "qobuz:72685925" },
    ],
    ["https://open.qobuz.com/track/1066045", { kind: "track", id: "qobuz:1066045" }],
    ["https://play.qobuz.com/track/1066045", { kind: "track", id: "qobuz:1066045" }],
    ["https://play.qobuz.com/label/64873", { kind: "label", id: "64873" }],
    [
      "https://www.qobuz.com/fr-fr/label/circa-1/download-streaming-albums/64873",
      { kind: "label", id: "64873" },
    ],
  ])("parses %s", (url, expected) => {
    expect(parseQobuzLink(url)).toEqual(expected);
  });

  it("tolerates a missing scheme, http, case, spaces, trailing slashes, queries and fragments", () => {
    const expected = { kind: "artist", id: "qobuz:41259" };
    for (const url of [
      "play.qobuz.com/artist/41259",
      "  http://play.qobuz.com/artist/41259/  ",
      "https://PLAY.Qobuz.com/artist/41259?ref=share#top",
      "https://play.qobuz.com/artist/41259#x",
      "<https://play.qobuz.com/artist/41259>",
      "qobuz.com/us-en/interpreter/portishead/41259",
    ]) {
      expect(parseQobuzLink(url)).toEqual(expected);
    }
  });

  it("returns undefined for anything that is not a Qobuz item link", () => {
    for (const text of [
      "",
      "Portishead",
      "Portishead - Dummy",
      "https://example.com/artist/41259",
      "https://play.qobuz.com.evil.example/artist/41259",
      "https://play.qobuz.com/",
      "https://play.qobuz.com/artist/",
      "https://play.qobuz.com/artist/abc",
      "https://play.qobuz.com/album/not!valid",
      "https://play.qobuz.com/discover",
      "https://www.qobuz.com/gb-en/shop",
      "ftp://play.qobuz.com/artist/41259",
      "https://play.qobuz.com/artist/41259/extra/bits",
    ]) {
      expect(parseQobuzLink(text)).toBeUndefined();
    }
  });
});

describe("parsePlaylistId", () => {
  it("accepts a positive id or a playlist link", () => {
    expect(parsePlaylistId("72685925")).toBe("qobuz:72685925");
    expect(parsePlaylistId(" https://play.qobuz.com/playlist/72685925 ")).toBe("qobuz:72685925");
  });

  it("rejects anything else", () => {
    expect(parsePlaylistId("0")).toBeUndefined();
    expect(parsePlaylistId("abc")).toBeUndefined();
    expect(parsePlaylistId("https://play.qobuz.com/album/abc")).toBeUndefined();
  });

  it("accepts an id that names its service, and rejects a missing one", () => {
    expect(parsePlaylistId("tidal:a-b")).toBe("tidal:a-b");
    expect(parsePlaylistId("nope:1")).toBeUndefined();
    expect(parsePlaylistId(undefined)).toBeUndefined();
    expect(parsePlaylistId("")).toBeUndefined();
  });
});

describe("describeLinkMismatch", () => {
  it("names the link's kind and the kind wanted", () => {
    expect(describeLinkMismatch({ kind: "album", id: "qobuz:x" }, "artist")).toBe(
      "an album link, not an artist",
    );
    expect(describeLinkMismatch({ kind: "playlist", id: "qobuz:1" }, "album")).toBe(
      "a playlist link, not an album",
    );
  });
});

describe("classifyPaste", () => {
  it("sorts lines into links, album lines and names, and says what it found", () => {
    const result = classifyPaste(
      [
        "https://play.qobuz.com/playlist/72685925",
        "",
        "https://open.qobuz.com/album/pvsb64n704d0b",
        "Massive Attack - Mezzanine",
        "https://play.qobuz.com/artist/41259",
        "Tricky",
        "https://open.qobuz.com/track/1066045",
        "   ",
      ].join("\n"),
    );
    expect(result.artists).toEqual(["https://play.qobuz.com/artist/41259", "Tricky"]);
    expect(result.albums).toEqual([
      "https://open.qobuz.com/album/pvsb64n704d0b",
      "Massive Attack - Mezzanine",
    ]);
    expect(result.playlists).toEqual([
      { line: "https://play.qobuz.com/playlist/72685925", id: "qobuz:72685925" },
    ]);
    expect(result.tracks).toEqual(["https://open.qobuz.com/track/1066045"]);
    expect(result.summary).toBe("Found 1 playlist, 2 albums, 2 artists and 1 track.");
  });

  it("counts singular and plural, and says when nothing was found", () => {
    expect(classifyPaste("Portishead").summary).toBe("Found 1 artist.");
    expect(classifyPaste("A - B\nC - D").summary).toBe("Found 2 albums.");
    expect(classifyPaste(" \n").summary).toBe("Paste links or a list to begin.");
  });

  it("keeps other Qobuz links apart", () => {
    const result = classifyPaste("https://play.qobuz.com/label/64873");
    expect(result.other).toEqual(["https://play.qobuz.com/label/64873"]);
    expect(result.summary).toBe("Found 1 other Qobuz link.");
  });
});
