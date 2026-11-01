import { describe, expect, it, vi } from "vitest";

import type { Track } from "../qobuz/index.js";
import { compileTrackFilter } from "./track-filter.js";
import {
  acrosticLetters,
  assignSlots,
  bestSegmentations,
  commitWordPlay,
  firstLetter,
  foldWords,
  rankSegmentations,
  resolveWordPlay,
  searchForm,
  splitTrackIds,
  stem,
  stripVersionLabels,
  titleCase,
  DEFAULT_MATCH_OPTIONS,
  MAX_ALTERNATIVES,
  MAX_DEEP_SEARCHES,
  MAX_SENTENCE_SEARCHES,
  SEARCH_PAGE_SIZE,
  type SpanMatch,
  type WordPlayCandidate,
  type WordPlayClient,
  type WordPlayPlan,
} from "./word-play.js";

let nextId = 1;
function track(title: string, artist: string, extra: Partial<Track> = {}): Track {
  nextId += 1;
  return { id: nextId, title, artist, ...extra };
}

/**
 * A fake catalogue search: every track sharing a word with the query (folded),
 * in catalogue order, paged by limit/offset.
 */
function catalogue(tracks: readonly Track[], overrides: Partial<WordPlayClient> = {}) {
  const searchTracks = vi.fn(async (query: string, limit = 20, offset = 0) => {
    const wanted = new Set(foldWords(query));
    return tracks
      .filter((t) => foldWords(t.title).some((word) => wanted.has(word)))
      .slice(offset, offset + limit);
  });
  const client: WordPlayClient = {
    searchTracks,
    getFavoriteTracks: vi.fn(async () => [] as Track[]),
    getPlaylistTracks: vi.fn(async () => [] as Track[]),
    ...overrides,
  };
  return { client, searchTracks };
}

function labels(plan: WordPlayPlan, split = 0): string[] {
  return plan.splits[split]!.slots.map((slot) => slot.label);
}

function chosenTitles(plan: WordPlayPlan, split = 0): (string | undefined)[] {
  return plan.splits[split]!.slots.map((slot) => slot.chosen?.track.title);
}

describe("foldWords", () => {
  it("ignores punctuation, case and diacritics", () => {
    expect(foldWords("Dog.")).toEqual(["dog"]);
    expect(foldWords("Fox!")).toEqual(["fox"]);
    expect(foldWords("Café  Society")).toEqual(["cafe", "society"]);
    expect(foldWords("Hey, Jude -- (Take 2)")).toEqual(["hey", "jude", "take", "2"]);
  });

  it("joins apostrophes and reads & as and", () => {
    expect(foldWords("Don't Stop")).toEqual(["dont", "stop"]);
    expect(foldWords("Rock & Roll")).toEqual(["rock", "and", "roll"]);
    expect(foldWords("Rock ’n’ Roll")).toEqual(["rock", "n", "roll"]);
  });

  it("returns nothing for punctuation only", () => {
    expect(foldWords(" -- !")).toEqual([]);
  });
});

describe("stripVersionLabels", () => {
  it("drops trailing bracketed labels", () => {
    expect(stripVersionLabels("Roads (Live)")).toBe("Roads");
    expect(stripVersionLabels("Help! [Remastered 2009]")).toBe("Help!");
    expect(stripVersionLabels("Song (Live) [Remastered]")).toBe("Song");
  });

  it("drops a dashed suffix naming a version", () => {
    expect(stripVersionLabels("Layla - 2011 Remaster")).toBe("Layla");
    expect(stripVersionLabels("Bohemian Rhapsody - Live Aid")).toBe("Bohemian Rhapsody");
    expect(stripVersionLabels("Hello – Radio Edit")).toBe("Hello");
  });

  it("keeps a dash that is part of the title, and leading brackets", () => {
    expect(stripVersionLabels("Love - Hate")).toBe("Love - Hate");
    expect(stripVersionLabels("(Don't Fear) The Reaper")).toBe("(Don't Fear) The Reaper");
  });

  it("keeps a title that is only a label", () => {
    expect(stripVersionLabels("(Untitled)")).toBe("(Untitled)");
  });
});

describe("stem", () => {
  it.each([
    ["jumped", "jump"],
    ["jumps", "jump"],
    ["jumping", "jump"],
    ["jump", "jump"],
    ["dogs", "dog"],
    ["dog", "dog"],
    ["loved", "lov"],
    ["love", "lov"],
    ["loving", "lov"],
    ["stopped", "stop"],
    ["running", "run"],
    ["cries", "cry"],
    ["cried", "cry"],
    ["kisses", "kiss"],
    ["kiss", "kiss"],
    ["falls", "fall"],
    ["mornings", "morn"],
    ["morning", "morn"],
    ["need", "need"],
    ["needs", "need"],
    ["speed", "speed"],
    ["sing", "sing"],
    ["thing", "thing"],
    ["this", "this"],
    ["the", "the"],
    ["is", "is"],
  ])("%s -> %s", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("brings close forms together", () => {
    expect(stem("jumped")).toBe(stem("jump"));
    expect(stem("dogs")).toBe(stem("dog"));
    expect(stem("loved")).toBe(stem("love"));
  });
});

describe("searchForm", () => {
  it.each([
    ["jumped", "jump"],
    ["loved", "love"],
    ["dancing", "dance"],
    ["stopped", "stop"],
    ["dogs", "dog"],
    ["dog", "dog"],
  ])("%s -> %s", (word, expected) => {
    expect(searchForm(word)).toBe(expected);
  });
});

describe("titleCase", () => {
  it("capitalises words but not small words inside", () => {
    expect(titleCase("a quick brown fox jumped over the lazy dog")).toBe(
      "A Quick Brown Fox Jumped over the Lazy Dog",
    );
    expect(titleCase("the end of the world")).toBe("The End of the World");
  });

  it("keeps words already holding a capital", () => {
    expect(titleCase("songs by McCartney and QOBUZ")).toBe("Songs by McCartney and QOBUZ");
  });

  it("capitalises the first letter after leading punctuation", () => {
    expect(titleCase('"night"')).toBe('"Night"');
  });
});

describe("acrosticLetters and firstLetter", () => {
  it("keeps letters and digits, folded and upper-cased", () => {
    expect(acrosticLetters("Qobuz!")).toEqual(["Q", "O", "B", "U", "Z"]);
    expect(acrosticLetters("café 2")).toEqual(["C", "A", "F", "E", "2"]);
  });

  it("reads a title's first letter past punctuation when ignoring it", () => {
    const reaper = track("(Don't Fear) The Reaper", "BOC");
    expect(firstLetter(reaper, DEFAULT_MATCH_OPTIONS)).toBe("D");
    expect(firstLetter(reaper, { ...DEFAULT_MATCH_OPTIONS, ignorePunctuation: false })).toBe("(");
    expect(firstLetter(track("élan", "X"), DEFAULT_MATCH_OPTIONS)).toBe("E");
  });
});

describe("bestSegmentations", () => {
  // "a quick brown fox": "a quick brown fox" whole, and every single word.
  const spans: SpanMatch[] = [
    { start: 0, end: 4, closeOnly: false },
    { start: 0, end: 1, closeOnly: false },
    { start: 1, end: 2, closeOnly: false },
    { start: 2, end: 3, closeOnly: false },
    { start: 3, end: 4, closeOnly: false },
  ];

  it("fewest takes the longest phrases", () => {
    const [best] = bestSegmentations(4, spans, "fewest", 1);
    expect(best!.segments).toEqual([{ start: 0, end: 4, matched: true }]);
    expect(best!.cost).toEqual({ unmatched: 0, songs: 1, closeForms: 0 });
  });

  it("words takes one word per song", () => {
    const [best] = bestSegmentations(4, spans, "words", 1);
    expect(best!.segments.map((s) => s.end - s.start)).toEqual([1, 1, 1, 1]);
    expect(best!.cost.songs).toBe(4);
  });

  it("leaves uncoverable words as gaps, keeping as few as it can", () => {
    // Words 0-2; nothing matches word 1, and "0-2" as a whole does not exist.
    const [best] = bestSegmentations(
      3,
      [
        { start: 0, end: 1, closeOnly: false },
        { start: 2, end: 3, closeOnly: false },
      ],
      "fewest",
      1,
    );
    expect(best!.segments).toEqual([
      { start: 0, end: 1, matched: true },
      { start: 1, end: 2, matched: false },
      { start: 2, end: 3, matched: true },
    ]);
    expect(best!.cost.unmatched).toBe(1);
  });

  it("prefers covering every word over fewer songs", () => {
    // "0-2" covers words 0-1 only; singles cover all three.
    const [best] = bestSegmentations(
      3,
      [
        { start: 0, end: 2, closeOnly: false },
        { start: 0, end: 1, closeOnly: false },
        { start: 1, end: 2, closeOnly: false },
        { start: 2, end: 3, closeOnly: false },
      ],
      "fewest",
      1,
    );
    expect(best!.cost).toEqual({ unmatched: 0, songs: 2, closeForms: 0 });
    expect(best!.segments[0]).toEqual({ start: 0, end: 2, matched: true });
  });

  it("fewest accepts close forms to save songs; any prefers exact matches", () => {
    const withClose: SpanMatch[] = [
      { start: 0, end: 2, closeOnly: true },
      { start: 0, end: 1, closeOnly: false },
      { start: 1, end: 2, closeOnly: false },
    ];
    expect(bestSegmentations(2, withClose, "fewest", 1)[0]!.cost).toEqual({
      unmatched: 0,
      songs: 1,
      closeForms: 1,
    });
    expect(bestSegmentations(2, withClose, "any", 1)[0]!.cost).toEqual({
      unmatched: 0,
      songs: 2,
      closeForms: 0,
    });
  });

  it("returns runners-up best first, all distinct", () => {
    const all = bestSegmentations(4, spans, "fewest", 4);
    expect(all).toHaveLength(4);
    // Full coverage first (1 song, then 4), then readings with one gap.
    expect(all.map((s) => [s.cost.unmatched, s.cost.songs])).toEqual([
      [0, 1],
      [0, 4],
      [1, 3],
      [1, 3],
    ]);
    const keys = new Set(all.map((s) => JSON.stringify(s.segments)));
    expect(keys.size).toBe(4);
  });

  it("always has a reading, even with nothing matched", () => {
    const [best] = bestSegmentations(2, [], "fewest", 1);
    expect(best!.cost).toEqual({ unmatched: 2, songs: 0, closeForms: 0 });
  });
});

describe("rankSegmentations", () => {
  it("puts the chosen objective first, then other objectives' bests, distinct", () => {
    const spans: SpanMatch[] = [
      { start: 0, end: 2, closeOnly: false },
      { start: 0, end: 1, closeOnly: false },
      { start: 1, end: 2, closeOnly: false },
    ];
    const ranked = rankSegmentations(2, spans, "fewest");
    expect(ranked[0]!.objective).toBe("fewest");
    expect(ranked[0]!.segmentation.cost.songs).toBe(1);
    expect(ranked[1]!.objective).toBe("words");
    expect(ranked[1]!.segmentation.cost.songs).toBe(2);
    // "any" has the same best as "fewest" here, so it is not repeated.
    expect(ranked.filter((r) => r.objective === "any")).toEqual([]);
    expect(ranked.length).toBeLessThanOrEqual(4);
  });
});

describe("assignSlots", () => {
  const candidate = (id: number, artist: string): WordPlayCandidate => ({
    track: { id, title: `t${id}`, artist },
    closeForm: false,
    punctuationIgnored: false,
  });

  it("avoids repeating an artist where another can fill the slot", () => {
    const a1 = candidate(1, "A");
    const a2 = candidate(2, "A");
    const b3 = candidate(3, "B");
    const chosen = assignSlots([[a1, b3], [a2, b3]], true);
    expect(chosen.map((c) => c?.track.id)).toEqual([1, 3]);
  });

  it("lets the most constrained slot choose first", () => {
    const a1 = candidate(1, "A");
    const b2 = candidate(2, "B");
    // Slot 0 could take A or B; slot 1 can only take A.
    const chosen = assignSlots([[a1, b2], [a1]], true);
    expect(chosen.map((c) => c?.track.id)).toEqual([2, 1]);
  });

  it("repeats an artist when nothing else fits, but never a track if avoidable", () => {
    const a1 = candidate(1, "A");
    const a2 = candidate(2, "A");
    const chosen = assignSlots([[a1, a2], [a1, a2]], true);
    expect(chosen.map((c) => c?.track.id)).toEqual([1, 2]);
  });

  it("reuses a track only when it is the slot's only candidate", () => {
    const a1 = candidate(1, "A");
    expect(assignSlots([[a1], [a1]], true).map((c) => c?.track.id)).toEqual([1, 1]);
  });

  it("takes the best track regardless of artist when one-per-artist is off", () => {
    const a1 = candidate(1, "A");
    const a2 = candidate(2, "A");
    const b3 = candidate(3, "B");
    const chosen = assignSlots([[a1, b3], [a2, b3]], false);
    expect(chosen.map((c) => c?.track.id)).toEqual([1, 2]);
  });

  it("leaves a slot without candidates empty", () => {
    expect(assignSlots([[], [candidate(1, "A")]], true).map((c) => c?.track.id)).toEqual([
      undefined,
      1,
    ]);
  });
});

describe("resolveWordPlay: sentence", () => {
  const fox = track("A Quick Brown Fox", "Foxes");
  const quick = track("Quick", "Speedy");
  const jump = track("Jump", "Van Halen");
  const over = track("Over", "Drake");
  const overLive = track("Over (Live)", "Live Band");
  const the = track("The", "Article");
  const lazy = track("Lazy", "Deep Purple");
  const dog = track("Dog.", "Dog Band");
  const brown = track("Brown", "Colour");
  const a = track("A", "Letter");
  const fox2 = track("Fox", "Animal");
  const songs = [fox, quick, jump, over, overLive, the, lazy, dog, brown, a, fox2];
  const sentence = "a quick brown fox jumped over the lazy dog";

  it("splits into the fewest songs and reports an unmatched word", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: sentence });
    expect(labels(plan)).toEqual(["a quick brown fox", "jumped", "over", "the", "lazy", "dog"]);
    expect(chosenTitles(plan)).toEqual([
      "A Quick Brown Fox",
      undefined,
      "Over",
      "The",
      "Lazy",
      "Dog.",
    ]);
    expect(plan.splits[0]!.unmatched).toEqual(["jumped"]);
    expect(plan.splits[0]!.songCount).toBe(5);
    expect(plan.suggestedName).toBe("A Quick Brown Fox Jumped over the Lazy Dog");
  });

  it("matches a close form when allowed, and says so", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(
      client,
      { mode: "sentence", text: sentence },
      { match: { closeForms: true } },
    );
    const jumped = plan.splits[0]!.slots[1]!;
    expect(jumped.label).toBe("jumped");
    expect(jumped.chosen?.track.title).toBe("Jump");
    expect(jumped.chosen?.closeForm).toBe(true);
    expect(plan.splits[0]!.unmatched).toEqual([]);
    expect(plan.splits[0]!.closeForms).toBe(1);
  });

  it("flags a match found only by ignoring punctuation", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: sentence });
    const slots = plan.splits[0]!.slots;
    expect(slots[5]!.chosen?.punctuationIgnored).toBe(true); // "Dog."
    expect(slots[2]!.chosen?.punctuationIgnored).toBe(false); // "Over" is only a case change
  });

  it("does not match punctuation or case when told to keep them", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(
      client,
      { mode: "sentence", text: "lazy Dog." },
      { match: { ignorePunctuation: false } },
    );
    expect(chosenTitles(plan)).toEqual([undefined, "Dog."]);
    expect(plan.splits[0]!.unmatched).toEqual(["lazy"]);
  });

  it("offers alternative splits, each a full reading", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: sentence });
    expect(plan.splits.length).toBeGreaterThan(1);
    expect(plan.splits.length).toBeLessThanOrEqual(4);
    const words = plan.splits.find((split) => split.objective === "words");
    expect(words?.slots.map((slot) => slot.label)).toEqual([
      "a",
      "quick",
      "brown",
      "fox",
      "jumped",
      "over",
      "the",
      "lazy",
      "dog",
    ]);
    expect(words?.songCount).toBe(8);
  });

  it("merges neighbouring unmatched words into one gap", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: "lazy zebras yawn dog" });
    expect(labels(plan)).toEqual(["lazy", "zebras yawn", "dog"]);
    expect(plan.splits[0]!.unmatched).toEqual(["zebras yawn"]);
  });

  it("searches each distinct run once, shorter runs first", async () => {
    const { client, searchTracks } = catalogue(songs);
    await resolveWordPlay(client, { mode: "sentence", text: "the dog the", maxSpan: 2 });
    const queries = searchTracks.mock.calls.map((call) => call[0]);
    expect(queries).toEqual(["the", "dog", "the dog", "dog the"]);
  });

  it("gives a repeated phrase different songs where it can", async () => {
    const the2 = track("The", "Other Article");
    const { client } = catalogue([...songs, the2]);
    const plan = await resolveWordPlay(client, {
      mode: "sentence",
      text: "the dog the",
      split: "words",
    });
    const ids = plan.splits[0]!.slots.map((slot) => slot.chosen?.track.id);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("caps the number of searches, dropping the longest runs", async () => {
    const { client, searchTracks } = catalogue(songs);
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const plan = await resolveWordPlay(client, { mode: "sentence", text: words });
    // The run searches are capped; deeper pages for unmatched words have
    // their own, separate budget.
    const firstPass = searchTracks.mock.calls.filter(([, , offset]) => (offset ?? 0) === 0);
    expect(firstPass).toHaveLength(MAX_SENTENCE_SEARCHES);
    expect(searchTracks.mock.calls.length - firstPass.length).toBeLessThanOrEqual(
      MAX_DEEP_SEARCHES,
    );
    expect(plan.searches).toBe(searchTracks.mock.calls.length);
    expect(plan.skippedSearches).toBeGreaterThan(0);
    // Every single word was searched.
    const queries = new Set(searchTracks.mock.calls.map((call) => call[0]));
    expect(queries.has("w29")).toBe(true);
  });

  it("refuses an empty or overlong sentence", async () => {
    const { client } = catalogue(songs);
    await expect(resolveWordPlay(client, { mode: "sentence", text: " ! " })).rejects.toThrow(
      /sentence/,
    );
    const long = Array.from({ length: 31 }, () => "la").join(" ");
    await expect(resolveWordPlay(client, { mode: "sentence", text: long })).rejects.toThrow(
      /at most 30/,
    );
  });

  it("ignores version labels unless told to keep them", async () => {
    const live = track("Over", "Live Band", { version: "Live" });
    const bracketed = track("Lazy (Live)", "Live Band 2");
    const { client } = catalogue([live, bracketed]);
    const kept = await resolveWordPlay(client, { mode: "sentence", text: "over lazy", split: "words" });
    expect(chosenTitles(kept)).toEqual(["Over", "Lazy (Live)"]);
    const strict = await resolveWordPlay(
      client,
      { mode: "sentence", text: "over lazy", split: "words" },
      { match: { ignoreVersions: false } },
    );
    expect(strict.splits[0]!.unmatched).toEqual(["over lazy"]);
  });

  it("leaves out tracks the filter excludes, and counts them", async () => {
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(
      client,
      { mode: "sentence", text: "lazy dog", split: "words" },
      { filter: compileTrackFilter({ excludeArtists: ["Deep Purple"] }) },
    );
    expect(chosenTitles(plan)).toEqual([undefined, "Dog."]);
    expect(plan.excludedCount).toBe(1);
  });

  it("lists other matches as alternatives, without the chosen ones", async () => {
    const overs = Array.from({ length: 15 }, (_, i) => track("Over", `Artist ${i}`));
    const { client } = catalogue(overs);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: "over" });
    const slot = plan.splits[0]!.slots[0]!;
    expect(slot.matchCount).toBe(15);
    expect(slot.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(slot.alternatives.map((c) => c.track.id)).not.toContain(slot.chosen?.track.id);
  });

  it("prefers hi-res as a tie-break, and keeps one copy of a recording", async () => {
    const cd = track("Over", "Drake", { bitDepth: 16, samplingRate: 44.1 });
    const hires = track("Over", "Drake", { bitDepth: 24, samplingRate: 96, hires: true });
    const { client } = catalogue([cd, hires]);
    const plain = await resolveWordPlay(client, { mode: "sentence", text: "over" });
    expect(plain.splits[0]!.slots[0]!.chosen?.track.id).toBe(cd.id);
    expect(plain.splits[0]!.slots[0]!.matchCount).toBe(1);
    const preferred = await resolveWordPlay(
      client,
      { mode: "sentence", text: "over" },
      { match: { preferHires: true } },
    );
    expect(preferred.splits[0]!.slots[0]!.chosen?.track.id).toBe(hires.id);
  });

  // On the live API an exact one-word title often ranks deep: "Brown" first
  // came up at position 308 of a search for "brown".
  it("searches deeper for a word that found no exact title", async () => {
    const nearMisses = Array.from({ length: 120 }, (_, i) => track(`Brown Eyed Girl ${i}`, "V"));
    const deep = track("Brown", "Colour");
    const { client, searchTracks } = catalogue([...nearMisses, deep, fox2]);
    const plan = await resolveWordPlay(client, { mode: "sentence", text: "brown fox" });
    expect(chosenTitles(plan)).toEqual(["Brown", "Fox"]);
    // The deeper pages are only fetched for the word that needed them.
    const deeper = searchTracks.mock.calls.filter(([, , offset]) => (offset ?? 0) > 0);
    expect(deeper.length).toBeGreaterThan(0);
    expect(deeper.every(([query]) => query === "brown")).toBe(true);
    expect(plan.searches).toBe(searchTracks.mock.calls.length);
  });

  it("stops searching deeper once the extra budget is spent", async () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const { client, searchTracks } = catalogue([]);
    await resolveWordPlay(client, { mode: "sentence", text: words.join(" "), maxSpan: 1 });
    const deeper = searchTracks.mock.calls.filter(([, , offset]) => (offset ?? 0) > 0);
    expect(deeper.length).toBeLessThanOrEqual(MAX_DEEP_SEARCHES);
  });
});

describe("resolveWordPlay: contains and exact", () => {
  it("finds titles containing the word as a whole word", async () => {
    const songs = [
      track("Night Fever", "Bee Gees"),
      track("Nightmare", "Avenged"),
      track("Into the Night", "Santana"),
      track("Knights", "Someone"),
    ];
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "contains", text: "night", count: 5 });
    expect(chosenTitles(plan)).toEqual(["Night Fever", "Into the Night"]);
    expect(plan.requested).toBe(5);
    expect(plan.suggestedName).toBe("Night");
  });

  it("matches a plural close form when allowed", async () => {
    const { client } = catalogue([track("Hot Dogs", "Band")]);
    const strict = await resolveWordPlay(client, { mode: "contains", text: "dog" });
    expect(strict.splits[0]!.slots).toEqual([]);
    const close = await resolveWordPlay(
      { ...client, searchTracks: async () => [track("Hot Dogs", "Band")] },
      { mode: "contains", text: "dog" },
      { match: { closeForms: true } },
    );
    expect(close.splits[0]!.slots[0]!.chosen?.closeForm).toBe(true);
  });

  it("takes up to N, a different artist each where possible", async () => {
    const songs = [
      track("Home", "A"),
      track("Home Again", "A"),
      track("Home", "B"),
      track("Going Home", "C"),
    ];
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "contains", text: "home", count: 3 });
    expect(plan.splits[0]!.slots.map((s) => s.chosen?.track.artist)).toEqual(["A", "B", "C"]);
  });

  it("exact takes only titles that are the word", async () => {
    const songs = [
      track("Home", "A"),
      track("Home Again", "B"),
      track("HOME!", "C"),
      track("Home (Live)", "D"),
    ];
    const { client } = catalogue(songs);
    const plan = await resolveWordPlay(client, { mode: "exact", text: "home" });
    expect(chosenTitles(plan)).toEqual(["Home", "HOME!", "Home (Live)"]);
    expect(plan.splits[0]!.slots[1]!.chosen?.punctuationIgnored).toBe(true);
  });

  it("reads further pages until it has enough, then stops", async () => {
    const many = Array.from({ length: 250 }, (_, i) => track(`Love ${i}`, `Artist ${i}`));
    const { client, searchTracks } = catalogue(many);
    const plan = await resolveWordPlay(client, { mode: "contains", text: "love", count: 25 });
    expect(searchTracks).toHaveBeenCalledTimes(1);
    expect(searchTracks).toHaveBeenCalledWith("love", SEARCH_PAGE_SIZE, 0);
    expect(plan.splits[0]!.songCount).toBe(25);

    const sparse = [
      ...Array.from({ length: 150 }, (_, i) => track(`Lovely ${i}`, `X ${i}`)),
      track("Love", "Late"),
    ];
    const second = catalogue(sparse);
    const found = await resolveWordPlay(second.client, { mode: "contains", text: "love lovely" });
    expect(second.searchTracks).toHaveBeenCalledTimes(2);
    expect(found.searches).toBe(2);
  });

  it("rejects a count out of range", async () => {
    const { client } = catalogue([]);
    await expect(
      resolveWordPlay(client, { mode: "contains", text: "x", count: 0 }),
    ).rejects.toThrow(/count/);
  });
});

describe("resolveWordPlay: acrostic and A to Z", () => {
  const favourites = [
    track("Queen of Hearts", "Q1"),
    track("One", "U2"),
    track("Only You", "Yazoo"),
    track("Bohemian Rhapsody", "Queen"),
    track("Umbrella", "Rihanna"),
    track("(Don't Fear) The Reaper", "BOC"),
  ];

  it("spells a word from favourites, reporting missing letters", async () => {
    const { client } = catalogue([], { getFavoriteTracks: vi.fn(async () => favourites) });
    const plan = await resolveWordPlay(client, {
      mode: "acrostic",
      text: "Qobuz",
      source: { type: "favourites" },
    });
    expect(labels(plan)).toEqual(["Q", "O", "B", "U", "Z"]);
    expect(chosenTitles(plan)).toEqual([
      "Queen of Hearts",
      "One",
      "Bohemian Rhapsody",
      "Umbrella",
      undefined,
    ]);
    expect(plan.splits[0]!.unmatched).toEqual(["Z"]);
    expect(plan.sourceSize).toBe(favourites.length);
    expect(plan.suggestedName).toBe("QOBUZ");
  });

  it("gives a repeated letter different songs", async () => {
    const { client } = catalogue([], { getFavoriteTracks: vi.fn(async () => favourites) });
    const plan = await resolveWordPlay(client, {
      mode: "acrostic",
      text: "OO",
      source: { type: "favourites" },
    });
    expect(chosenTitles(plan)).toEqual(["One", "Only You"]);
  });

  it("reads a playlist when asked", async () => {
    const getPlaylistTracks = vi.fn(async () => favourites);
    const { client } = catalogue([], { getPlaylistTracks });
    await resolveWordPlay(client, {
      mode: "acrostic",
      text: "d",
      source: { type: "playlist", playlistId: 42 },
    });
    expect(getPlaylistTracks).toHaveBeenCalledWith(42);
  });

  it("A to Z has a slot per letter", async () => {
    const { client } = catalogue([], { getFavoriteTracks: vi.fn(async () => favourites) });
    const plan = await resolveWordPlay(client, { mode: "a-to-z", source: { type: "favourites" } });
    expect(plan.splits[0]!.slots).toHaveLength(26);
    expect(plan.splits[0]!.slots[3]!.chosen?.track.title).toBe("(Don't Fear) The Reaper");
    expect(plan.splits[0]!.songCount).toBe(5);
    expect(plan.suggestedName).toBe("A to Z");
  });

  it("applies the filter to the source", async () => {
    const { client } = catalogue([], { getFavoriteTracks: vi.fn(async () => favourites) });
    const plan = await resolveWordPlay(
      client,
      { mode: "acrostic", text: "U", source: { type: "favourites" } },
      { filter: compileTrackFilter({ excludeTracks: ["umbrella"] }) },
    );
    expect(chosenTitles(plan)).toEqual([undefined]);
    expect(plan.excludedCount).toBe(1);
  });

  it("refuses an acrostic without letters", async () => {
    const { client } = catalogue([]);
    await expect(
      resolveWordPlay(client, { mode: "acrostic", text: "--", source: { type: "favourites" } }),
    ).rejects.toThrow(/word/);
  });
});

describe("splitTrackIds", () => {
  it("lists chosen ids in order, once each", () => {
    const t1 = { id: 1, title: "a" };
    const pick = (t: Track): WordPlayCandidate => ({
      track: t,
      closeForm: false,
      punctuationIgnored: false,
    });
    expect(
      splitTrackIds({
        slots: [
          { label: "a", chosen: pick(t1), alternatives: [], matchCount: 1 },
          { label: "b", alternatives: [], matchCount: 0 },
          { label: "a", chosen: pick(t1), alternatives: [], matchCount: 1 },
          { label: "c", chosen: pick({ id: 2, title: "c" }), alternatives: [], matchCount: 1 },
        ],
        songCount: 3,
        unmatched: ["b"],
        closeForms: 0,
      }),
    ).toEqual([1, 2]);
  });
});

describe("commitWordPlay", () => {
  function writer() {
    return {
      createPlaylist: vi.fn(async (name: string) => ({ id: 9, name })),
      addTracksToPlaylist: vi.fn(async () => {}),
      getPlaylistTracks: vi.fn(async () => [{ id: 2, title: "x" }] as Track[]),
    };
  }

  it("creates a playlist with the songs in order, once each", async () => {
    const client = writer();
    const result = await commitWordPlay(client, {
      target: { type: "new", name: "A Quick Brown Fox", isPublic: true },
      trackIds: [3, 1, 3, 2],
    });
    expect(client.createPlaylist).toHaveBeenCalledWith("A Quick Brown Fox", { isPublic: true });
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(9, [3, 1, 2]);
    expect(result).toEqual({
      playlist: { id: 9, name: "A Quick Brown Fox" },
      playlistId: 9,
      added: [3, 1, 2],
      skipped: [3],
    });
  });

  it("appends to an existing playlist, skipping tracks already there", async () => {
    const client = writer();
    const result = await commitWordPlay(client, {
      target: { type: "existing", playlistId: 5 },
      trackIds: [1, 2, 3],
    });
    expect(client.addTracksToPlaylist).toHaveBeenCalledWith(5, [1, 3]);
    expect(result).toEqual({ playlistId: 5, added: [1, 3], skipped: [2] });
  });
});
