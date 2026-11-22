import { describe, expect, it } from "vitest";

import {
  artistCounts,
  linkLines,
  matchArtists,
  matchedIndexes,
  parseArtistTerms,
  type MatchableTrack,
} from "./artist-match.js";

const song = (artist: string, title = "T", rest: Partial<MatchableTrack> = {}): MatchableTrack => ({
  title,
  artist,
  ...rest,
});

function match(tracks: readonly MatchableTrack[], ...lines: string[]) {
  const { terms, problems } = parseArtistTerms(lines);
  expect(problems).toEqual([]);
  return matchArtists(tracks, terms);
}

describe("parseArtistTerms", () => {
  it("ignores blank and repeated lines", () => {
    expect(parseArtistTerms(["", " Portishead ", "Portishead"]).terms.map((t) => t.line)).toEqual(["Portishead"]);
  });

  it("reports lines it cannot use", () => {
    const link = "https://play.qobuz.com/artist/41259";
    const { terms, problems } = parseArtistTerms(["/[/", link, "Portishead"]);
    expect(terms.map((t) => t.line)).toEqual(["Portishead"]);
    expect(problems.map((p) => p.line)).toEqual(["/[/", link]);
    expect(parseArtistTerms([link], new Map([[link, { problem: "no such artist" }]])).problems).toEqual([
      { line: link, reason: "no such artist" },
    ]);
  });

  it("picks out the lines that are links", () => {
    expect(linkLines(["Portishead", " https://play.qobuz.com/artist/41259 "])).toEqual([
      "https://play.qobuz.com/artist/41259",
    ]);
  });
});

describe("matchArtists", () => {
  it("matches the whole name, ignoring case and accents", () => {
    const tracks = [song("Björk"), song("Nick Drake"), song("DRAKE")];
    expect(match(tracks, "bjork", "Drake").map((r) => r.main)).toEqual([[0], [2]]);
  });

  it("matches a regex, and names in any script", () => {
    expect(match([song("The Beatles"), song("Кино")], "/^the /", "кино").map((r) => r.main)).toEqual([[0], [1]]);
  });

  it("counts joint main artists as main and featured ones as guests", () => {
    const tracks = [
      song("Slash", "Oh Well", { guestArtists: ["Chris Stapleton"] }),
      song("Chris Stapleton"),
      song("Somebody", "Duet", { jointArtists: ["Chris Stapleton"] }),
    ];
    expect(match(tracks, "Chris Stapleton")[0]).toMatchObject({ main: [1, 2], guest: [0] });
  });

  it("finds guests named in the title or version, once each", () => {
    const tracks = [
      song("A", "One feat. Chris Stapleton", { guestArtists: ["Chris Stapleton"] }),
      song("A", "Two (ft. X & Chris Stapleton)"),
      song("A", "Three (with Chris Stapleton)"),
      song("A", "Four", { version: "featuring Chris Stapleton" }),
      song("A", "Alone with Chris Stapleton"),
      song("A", "Soft Feature"),
      song("A", "Five (feat. Florence & The Machine)"),
    ];
    expect(match(tracks, "Chris Stapleton")[0]).toMatchObject({ main: [], guest: [0, 1, 2, 3] });
    expect(match(tracks, "Florence & The Machine")[0]?.guest).toEqual([6]);
  });

  it("matches a link by id for the main artist and by name for credits", () => {
    const link = "https://play.qobuz.com/artist/7";
    const { terms } = parseArtistTerms([link], new Map([[link, { id: 7, name: "Nirvana" }]]));
    const tracks = [
      song("Nirvana", "US", { artistId: 7 }),
      song("Nirvana", "UK", { artistId: 8 }),
      song("Nirvana", "no id"),
      song("Other", "T", { artistId: 9, guestArtists: ["Nirvana"] }),
    ];
    expect(matchArtists(tracks, terms)[0]).toMatchObject({ name: "Nirvana", main: [0, 2], guest: [3] });
  });

  it("suggests a near spelling only when nothing matched", () => {
    const tracks = [song("Radiohead"), song("Radiohead"), song("The Beatles")];
    expect(match(tracks, "Radiohed", "Beatles", "Metallica", "Radiohead").map((r) => r.suggestion)).toEqual([
      { name: "Radiohead", count: 2 },
      { name: "The Beatles", count: 1 },
      undefined,
      undefined,
    ]);
  });

  it("does not suggest short unrelated names", () => {
    expect(match([song("ABBA"), song("U2")], "Muse", "R.E.M.").map((r) => r.suggestion)).toEqual([undefined, undefined]);
  });

  it("copes with songs without an artist", () => {
    expect(match([{ title: "T" }], "A")[0]).toMatchObject({ main: [], guest: [] });
  });
});

describe("matchedIndexes", () => {
  it("joins the lines' songs in order, with guests when asked", () => {
    const results = match([song("B"), song("A", "x feat. B"), song("A")], "A", "B");
    expect(matchedIndexes(results, false)).toEqual([0, 1, 2]);
    expect(matchedIndexes([results[1]!], false)).toEqual([0]);
    expect(matchedIndexes([results[1]!], true)).toEqual([0, 1]);
  });
});

describe("artistCounts", () => {
  it("counts by id, most first", () => {
    expect(
      artistCounts([song("A", "1", { artistId: 1 }), song("B"), song("a", "2", { artistId: 1 }), { title: "x" }]),
    ).toEqual([
      { name: "A", id: 1, count: 2 },
      { name: "B", count: 1 },
    ]);
  });
});
