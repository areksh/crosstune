/**
 * Word play: playlists made out of song titles.
 *
 * Five modes, all split into *resolve* (build an editable plan, reporting what
 * could not be matched rather than failing) and *commit* (write the chosen
 * tracks, in order):
 *
 *   - `contains`: up to N tracks whose title contains a word or phrase, as a
 *     whole word ("night" catches "Night Fever", not "Nightmare");
 *   - `exact`: up to N tracks whose title *is* the word or phrase;
 *   - `sentence`: a sentence split into consecutive phrases, each one a song
 *     title, read in order ("a quick brown fox / jumped / over / ...");
 *   - `acrostic`: titles whose first letters spell a word;
 *   - `a-to-z`: one title per letter of the alphabet.
 *
 * The first three search the Qobuz catalogue; the last two pick from the
 * user's favourites or a playlist (searching the catalogue by first letter
 * would be meaningless). Matching ignores punctuation, case and diacritics and
 * version labels ("(Live)", "- 2011 Remaster") by default, and can optionally
 * accept close forms of a word through a deliberately light English stemmer
 * ("jumped" matches "Jump"). Every chosen slot carries its alternatives so a
 * reviewer can swap a song; by default no artist is used twice where another
 * one could fill the slot.
 *
 * Sentence splitting searches every run of up to `maxSpan` consecutive words
 * (shorter runs first, identical runs once, capped at
 * {@link MAX_SENTENCE_SEARCHES} searches), then picks a split by dynamic
 * programming under a chosen objective, keeping a few runners-up as
 * alternatives. Words no title covers become unmatched gaps.
 */

import type { PlaylistId, TrackId } from "../services/ids.js";
import type { Playlist, Track } from "../services/model.js";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import {
  addTracksToExistingPlaylist,
  createPlaylistWithTracks,
  type ExistingPlaylistClient,
  type PlaylistWriterClient,
} from "./playlist-from-artists.js";
import {
  NO_FILTER,
  normaliseArtistName,
  trackExclusion,
  type TrackFilter,
} from "./track-filter.js";

// ---------------------------------------------------------------------------
// Public types and limits

export const WORD_PLAY_MODES = ["contains", "exact", "sentence", "acrostic", "a-to-z"] as const;
export type WordPlayMode = (typeof WORD_PLAY_MODES)[number];

/**
 * How a sentence is split into songs:
 *
 *   - `fewest`: as few songs as possible (the longest phrases), then the
 *     fewest close forms;
 *   - `words`: one word per song;
 *   - `any`: any mix of phrase lengths, preferring exact matches over close
 *     forms, then the fewest songs.
 *
 * Every objective first leaves as few words unmatched as it can.
 */
export const SPLIT_OBJECTIVES = ["fewest", "words", "any"] as const;
export type SplitObjective = (typeof SPLIT_OBJECTIVES)[number];

/** An accepted integer range with its default (shared by the CLI and the API). */
export interface IntBounds {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/** How many songs `contains` and `exact` take. */
export const WORD_PLAY_COUNT: IntBounds = { min: 1, max: 100, fallback: 25 };
/** The longest phrase (in words) a sentence song may cover. */
export const WORD_PLAY_MAX_SPAN: IntBounds = { min: 1, max: 8, fallback: 6 };
/** The longest sentence accepted, in words. */
export const MAX_SENTENCE_WORDS = 30;
/** The longest acrostic word accepted, in letters. */
export const MAX_ACROSTIC_LETTERS = 40;
/** The most catalogue searches one sentence may make (shorter phrases go first). */
export const MAX_SENTENCE_SEARCHES = 120;
/** Results asked for per sentence-phrase search. */
export const SPAN_SEARCH_LIMIT = 50;
/**
 * Extra searches a sentence may spend paging deeper for words that found no
 * exact title in the first {@link SPAN_SEARCH_LIMIT} results. On the live API
 * an exact one-word title often ranks deep (e.g. "Brown" at position 308).
 */
export const MAX_DEEP_SEARCHES = 40;
/** How far a deeper search pages, in results. */
export const DEEP_SEARCH_DEPTH = 550;
/** Results per page, and the most pages read, for `contains`/`exact`. */
export const SEARCH_PAGE_SIZE = 100;
export const MAX_SEARCH_PAGES = 5;
/** The most alternatives listed for one slot. */
export const MAX_ALTERNATIVES = 10;
/** The most alternative sentence splits offered besides the chosen one. */
export const MAX_ALTERNATIVE_SPLITS = 3;

/** How titles are compared. */
export interface MatchOptions {
  /** Ignore punctuation, case and diacritics ("Dog." matches "dog"). */
  ignorePunctuation: boolean;
  /** Ignore version labels: `Track.version` and trailing "(Live)"-style labels. */
  ignoreVersions: boolean;
  /** Accept close forms of a word ("jumped" matches "Jump", "dogs" "Dog"). */
  closeForms: boolean;
  /** Avoid repeating an artist where another one could fill the slot. */
  onePerArtist: boolean;
  /** Prefer hi-res tracks when ranking otherwise equal matches. */
  preferHires: boolean;
}

export const DEFAULT_MATCH_OPTIONS: Readonly<MatchOptions> = {
  ignorePunctuation: true,
  ignoreVersions: true,
  closeForms: false,
  onePerArtist: true,
  preferHires: false,
};

/** Where `acrostic` and `a-to-z` pick their songs from. */
export type WordPlaySource = { type: "favourites" } | { type: "playlist"; playlistId: PlaylistId };

export type WordPlayRequest =
  | { mode: "contains" | "exact"; text: string; count?: number }
  | { mode: "sentence"; text: string; split?: SplitObjective; maxSpan?: number }
  | { mode: "acrostic"; text: string; source: WordPlaySource }
  | { mode: "a-to-z"; source: WordPlaySource };

export interface ResolveWordPlayOptions {
  match?: Partial<MatchOptions>;
  /** Tracks to leave out of the candidates. */
  filter?: TrackFilter;
}

/** A track that matches a slot, and how it matched. */
export interface WordPlayCandidate {
  track: Track;
  /** Matched only as a close form (see {@link stem}). */
  closeForm: boolean;
  /** Matched only once punctuation, case or diacritics were ignored. */
  punctuationIgnored: boolean;
}

/** One place in the playlist: a phrase, a letter, or one of N songs. */
export interface WordPlaySlot {
  /** What the slot stands for: the phrase, the letter, or the word. */
  label: string;
  /** The chosen song; absent when nothing matched (an unmatched gap). */
  chosen?: WordPlayCandidate;
  /** Other matching songs, best first, not chosen by any slot (at most 10). */
  alternatives: WordPlayCandidate[];
  /** How many distinct songs matched the slot in all. */
  matchCount: number;
}

/** A complete reading: the slots in order. */
export interface WordPlaySplit {
  slots: WordPlaySlot[];
  /** Slots with a chosen song. */
  songCount: number;
  /** Labels of the slots nothing matched, in order. */
  unmatched: string[];
  /** Chosen songs that matched only as a close form. */
  closeForms: number;
  /** The objective this split is the best for (sentence mode), if any. */
  objective?: SplitObjective;
}

export interface WordPlayPlan {
  mode: WordPlayMode;
  /** The word, sentence or acrostic word as given (empty for `a-to-z`). */
  text: string;
  /** A default playlist name. */
  suggestedName: string;
  /** At least one split; the first is the recommended one. */
  splits: WordPlaySplit[];
  /** The number of songs asked for (`contains`/`exact`). */
  requested?: number;
  /** Catalogue searches made. */
  searches: number;
  /** Sentence phrases left unsearched because of {@link MAX_SENTENCE_SEARCHES}. */
  skippedSearches: number;
  /** Tracks in the source (`acrostic`/`a-to-z`), before filtering. */
  sourceSize?: number;
  /** Matching tracks the filter left out. */
  excludedCount: number;
}

/** The client surface needed to search the catalogue. */
export interface WordPlaySearchClient {
  searchTracks(query: string, limit?: number, offset?: number): Promise<Track[]>;
}

/** The client surface needed to read favourites and playlists. */
export interface WordPlaySourceClient {
  getFavoriteTracks(): Promise<Track[]>;
  getPlaylistTracks(playlistId: PlaylistId): Promise<Track[]>;
}

export type WordPlayClient = WordPlaySearchClient & WordPlaySourceClient;

// ---------------------------------------------------------------------------
// Normalisation

/**
 * A title or phrase as comparison words, ignoring punctuation, case and
 * diacritics: "Don't Stop (Me Now)!" -> ["dont", "stop", "me", "now"].
 * Apostrophes join ("don't" -> "dont"), "&" reads as "and", and any other run
 * of non-letters, non-digits separates words.
 */
export function foldWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['‘’`´]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** A title or phrase as written, split on whitespace (punctuation and case kept). */
export function rawWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/** Version words that mark a trailing " - ..." suffix as a label, not a title part. */
const DASH_LABEL =
  /\s+[-–—]\s+[^-–—]*\b(?:remaster(?:ed)?|live|version|edit|mix|remix|mono|stereo|demo|acoustic|instrumental|single|radio|bonus|deluxe|edition|take|session|recorded|feat|featuring)\b[^-–—]*$/iu;
const TRAILING_BRACKETS = /\s*(?:\([^()]*\)|\[[^[\]]*\])\s*$/u;

/**
 * A title without its trailing version labels: bracketed groups at the end
 * ("Roads (Live)", "Help! [Remastered 2009]") and a dashed suffix naming a
 * version ("Layla - 2011 Remaster"). A title that is nothing but a label is
 * kept as it is.
 */
export function stripVersionLabels(title: string): string {
  let current = title.trim();
  for (;;) {
    const next = current.replace(TRAILING_BRACKETS, "").replace(DASH_LABEL, "").trim();
    if (next === current || next.length === 0) {
      return current;
    }
    current = next;
  }
}

/**
 * A deliberately light English stemmer for close forms, so "jumped", "jumps"
 * and "jumping" all meet "jump", "dogs" meets "dog", "loved" meets "love" and
 * "cries" meets "cry". It strips a plural, then an "-ed"/"-ing" (undoubling
 * "stopped" to "stop"), then a final "e"; words of three letters or fewer are
 * left alone. It over- and under-reaches at the edges (it is no dictionary),
 * which is why close forms are opt-in and labelled.
 */
export function stem(word: string): string {
  const { base } = stripSuffixes(word);
  // A silent final e ("love" and "loved" both become "lov").
  return base.length >= 4 && base.endsWith("e") ? base.slice(0, -1) : base;
}

/** The plural and tense steps of {@link stem}, saying what they removed. */
function stripSuffixes(word: string): { base: string; tense: boolean; undoubled: boolean } {
  if (word.length <= 3) {
    return { base: word, tense: false, undoubled: false };
  }
  let w = word;
  // Plurals.
  if (w.endsWith("ies") && w.length > 4) {
    w = `${w.slice(0, -3)}y`;
  } else if (/(?:ss|sh|ch|x|z)es$/u.test(w)) {
    w = w.slice(0, -2);
  } else if (w.endsWith("s") && !/(?:ss|us|is)$/u.test(w)) {
    w = w.slice(0, -1);
  }
  // Past tense and participles ("need" and "speed" are not past tenses).
  if (w.endsWith("ied") && w.length > 4) {
    return { base: `${w.slice(0, -3)}y`, tense: true, undoubled: false };
  }
  const suffix = w.endsWith("eed")
    ? undefined
    : w.endsWith("ing")
      ? 3
      : w.endsWith("ed")
        ? 2
        : undefined;
  if (suffix !== undefined && w.length - suffix >= 3) {
    const bare = w.slice(0, -suffix);
    const base = undouble(bare);
    return { base, tense: true, undoubled: base !== bare };
  }
  return { base: w, tense: false, undoubled: false };
}

/**
 * A word's plain form to search for when close forms are on: plural and tense
 * removed, guessing back a silent e ("jumped" -> "jump", "loved" -> "love",
 * "dancing" -> "dance"). A wrong guess only widens the search a little;
 * matching still goes by {@link stem}.
 */
export function searchForm(word: string): string {
  const { base, tense, undoubled } = stripSuffixes(word);
  const silentE =
    tense &&
    !undoubled &&
    /(?:[^aeiou][aeiou][bcdfgklmnprstvz]|[^aeiou]c)$/u.test(base);
  return silentE ? `${base}e` : base;
}

/** "stopp" -> "stop", "runn" -> "run"; "fall", "kiss" and "buzz" stay. */
function undouble(word: string): string {
  return /([b-df-hj-np-tv-z])\1$/u.test(word) && !/(?:ll|ss|zz)$/u.test(word)
    ? word.slice(0, -1)
    : word;
}

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor",
  "of", "on", "or", "over", "so", "the", "to", "up", "via", "vs", "with", "yet",
]);

/**
 * Title-case a phrase for a playlist name: each word capitalised, except small
 * words ("the", "of", ...) inside the phrase; words already holding a capital
 * ("McCartney", "QOBUZ") are kept as written.
 * "a quick brown fox jumped over the lazy dog" -> "A Quick Brown Fox Jumped
 * over the Lazy Dog".
 */
export function titleCase(text: string): string {
  const words = rawWords(text);
  return words
    .map((word, index) => {
      if (/\p{Lu}/u.test(word)) {
        return word;
      }
      const inside = index > 0 && index < words.length - 1;
      if (inside && SMALL_WORDS.has(word.replace(/[^\p{L}]/gu, ""))) {
        return word;
      }
      return word.replace(/\p{L}/u, (letter) => letter.toUpperCase());
    })
    .join(" ");
}

/** The comparable text of a track's title, with or without its version. */
function titleText(track: Track, options: MatchOptions): string {
  if (options.ignoreVersions) {
    return stripVersionLabels(track.title);
  }
  return track.version === undefined ? track.title : `${track.title} (${track.version})`;
}

/** Comparison words for a text under the options. */
function wordsOf(text: string, options: MatchOptions): string[] {
  return options.ignorePunctuation ? foldWords(text) : rawWords(text);
}

/** A text as written, lower-cased and with whitespace collapsed. */
function plainForm(text: string): string {
  return rawWords(text).join(" ").toLowerCase();
}

function isHires(track: Track): boolean {
  return track.hires ?? ((track.bitDepth ?? 0) > 16 || (track.samplingRate ?? 0) > 48);
}

/** The artist a track counts as for one-song-per-artist, or undefined. */
function artistKey(track: Track): string | undefined {
  if (track.artistId !== undefined) {
    return `#${track.artistId}`;
  }
  const name = track.artist === undefined ? "" : normaliseArtistName(track.artist);
  return name.length === 0 ? undefined : name;
}

// ---------------------------------------------------------------------------
// Candidates

/** A track prepared for matching. */
interface Prepared {
  track: Track;
  /** Comparison words of the title. */
  words: string[];
  /** The same words stemmed (close forms). */
  stems: string[];
  /** The words joined, and the stems joined: whole-title comparison keys. */
  key: string;
  stemKey: string;
  /** The title as written (version-stripped if asked), for the punctuation badge. */
  plain: string;
  /** Rank in its source: search or source order. */
  order: number;
}

function prepare(track: Track, order: number, options: MatchOptions): Prepared {
  const text = titleText(track, options);
  const words = wordsOf(text, options);
  const stems = words.map(stem);
  return {
    track,
    words,
    stems,
    key: words.join(" "),
    stemKey: stems.join(" "),
    plain: plainForm(text),
    order,
  };
}

interface Ranked extends WordPlayCandidate {
  order: number;
}

/**
 * Rank matching candidates (exact before close forms, then hi-res when
 * preferred, then source order) and keep one copy of each recording (the same
 * artist and title from another album), the best-ranked.
 */
function rankCandidates(candidates: readonly Ranked[], options: MatchOptions): Ranked[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      Number(a.closeForm) - Number(b.closeForm) ||
      (options.preferHires ? Number(isHires(b.track)) - Number(isHires(a.track)) : 0) ||
      a.order - b.order,
  );
  const seen = new Set<string>();
  const kept: Ranked[] = [];
  for (const candidate of sorted) {
    const recording = `${artistKey(candidate.track) ?? `id:${candidate.track.id}`}|${foldWords(
      titleText(candidate.track, options),
    ).join(" ")}`;
    const id = `id:${candidate.track.id}`;
    if (seen.has(recording) || seen.has(id)) {
      continue;
    }
    seen.add(recording);
    seen.add(id);
    kept.push(candidate);
  }
  return kept;
}

/** Whether `needle` occurs in `haystack` as a run of consecutive words. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** How a whole title matches a phrase (`exact`, sentence), or undefined. */
function matchWhole(
  prepared: Prepared,
  phrase: { words: readonly string[]; plain: string },
  options: MatchOptions,
): Ranked | undefined {
  const key = phrase.words.join(" ");
  if (key.length === 0) {
    return undefined;
  }
  if (prepared.key === key) {
    return {
      track: prepared.track,
      closeForm: false,
      punctuationIgnored: options.ignorePunctuation && prepared.plain !== phrase.plain,
      order: prepared.order,
    };
  }
  if (options.closeForms && prepared.stemKey === phrase.words.map(stem).join(" ")) {
    return { track: prepared.track, closeForm: true, punctuationIgnored: false, order: prepared.order };
  }
  return undefined;
}

/** How a title contains a phrase as whole words (`contains`), or undefined. */
function matchContains(
  prepared: Prepared,
  phraseWords: readonly string[],
  options: MatchOptions,
): Ranked | undefined {
  if (containsRun(prepared.words, phraseWords)) {
    return { track: prepared.track, closeForm: false, punctuationIgnored: false, order: prepared.order };
  }
  if (options.closeForms && containsRun(prepared.stems, phraseWords.map(stem))) {
    return { track: prepared.track, closeForm: true, punctuationIgnored: false, order: prepared.order };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Choosing one song per slot

/**
 * Choose one candidate per slot (each list ranked best first). The slots with
 * the fewest candidates choose first, each taking its best candidate whose
 * track is not already chosen and -- with `onePerArtist` -- whose artist is not
 * already used; failing that, the best unused track (repeating an artist);
 * failing that, its best candidate. A slot with no candidates stays empty.
 */
export function assignSlots<T extends WordPlayCandidate>(
  candidateLists: readonly (readonly T[])[],
  onePerArtist: boolean,
): (T | undefined)[] {
  const chosen: (T | undefined)[] = candidateLists.map(() => undefined);
  const order = candidateLists
    .map((list, index) => ({ index, size: list.length }))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => a.size - b.size || a.index - b.index);
  const usedTracks = new Set<number>();
  const usedArtists = new Set<string>();
  for (const { index } of order) {
    const list = candidateLists[index]!;
    const freshTrack = (c: T): boolean => !usedTracks.has(c.track.id);
    const freshArtist = (c: T): boolean => {
      const key = artistKey(c.track);
      return key === undefined || !usedArtists.has(key);
    };
    const pick =
      (onePerArtist ? list.find((c) => freshTrack(c) && freshArtist(c)) : undefined) ??
      list.find(freshTrack) ??
      list[0]!;
    chosen[index] = pick;
    usedTracks.add(pick.track.id);
    const key = artistKey(pick.track);
    if (key !== undefined) {
      usedArtists.add(key);
    }
  }
  return chosen;
}

/** A candidate without its ranking bookkeeping. */
function publicCandidate(candidate: Ranked): WordPlayCandidate {
  return {
    track: candidate.track,
    closeForm: candidate.closeForm,
    punctuationIgnored: candidate.punctuationIgnored,
  };
}

/**
 * Build a split's slots from labelled candidate lists: choose a song for each,
 * then list each slot's alternatives (candidates no slot chose).
 */
function buildSplit(
  entries: readonly { label: string; candidates: readonly Ranked[] }[],
  options: MatchOptions,
  objective?: SplitObjective,
): WordPlaySplit {
  const chosen = assignSlots(
    entries.map((entry) => entry.candidates),
    options.onePerArtist,
  );
  const chosenIds = new Set(
    chosen.filter((c): c is Ranked => c !== undefined).map((c) => c.track.id),
  );
  const slots: WordPlaySlot[] = entries.map((entry, index) => {
    const pick = chosen[index];
    const slot: WordPlaySlot = {
      label: entry.label,
      alternatives: entry.candidates
        .filter((c) => !chosenIds.has(c.track.id))
        .slice(0, MAX_ALTERNATIVES)
        .map(publicCandidate),
      matchCount: entry.candidates.length,
    };
    if (pick !== undefined) {
      slot.chosen = publicCandidate(pick);
    }
    return slot;
  });
  return {
    slots,
    songCount: slots.filter((slot) => slot.chosen !== undefined).length,
    unmatched: slots.filter((slot) => slot.chosen === undefined).map((slot) => slot.label),
    closeForms: slots.filter((slot) => slot.chosen?.closeForm === true).length,
    ...(objective !== undefined && { objective }),
  };
}

/** The chosen songs' track ids in slot order, each once. */
export function splitTrackIds(split: WordPlaySplit): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const slot of split.slots) {
    const id = slot.chosen?.track.id;
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Sentence splitting

/** A run of words (`start` inclusive, `end` exclusive) some title matches. */
export interface SpanMatch {
  start: number;
  end: number;
  /** Only close forms match it. */
  closeOnly: boolean;
}

export interface SplitCost {
  unmatched: number;
  songs: number;
  closeForms: number;
}

/** One piece of a segmentation: a matched run, or a single unmatched word. */
export interface Segment {
  start: number;
  end: number;
  matched: boolean;
}

export interface Segmentation {
  segments: Segment[];
  cost: SplitCost;
}

const COST_ORDER: Record<SplitObjective, readonly (keyof SplitCost)[]> = {
  fewest: ["unmatched", "songs", "closeForms"],
  words: ["unmatched", "closeForms", "songs"],
  any: ["unmatched", "closeForms", "songs"],
};

function compareSegmentations(
  a: Segmentation,
  b: Segmentation,
  objective: SplitObjective,
): number {
  for (const key of COST_ORDER[objective]) {
    const difference = a.cost[key] - b.cost[key];
    if (difference !== 0) {
      return difference;
    }
  }
  // Equal cost: prefer the longer phrase earliest, so the order is stable.
  const length = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < length; i += 1) {
    const difference = b.segments[i]!.end - a.segments[i]!.end;
    if (difference !== 0) {
      return difference;
    }
  }
  return a.segments.length - b.segments.length;
}

/**
 * The best ways to split `wordCount` words into matched runs and unmatched
 * words, best first (at most `keep`), under an objective -- a k-best dynamic
 * programme over word positions. `words` only uses single-word runs. Every
 * word can be left unmatched, so at least one segmentation always exists.
 */
export function bestSegmentations(
  wordCount: number,
  spans: readonly SpanMatch[],
  objective: SplitObjective,
  keep: number,
): Segmentation[] {
  const byStart = new Map<number, SpanMatch[]>();
  for (const span of spans) {
    if (objective === "words" && span.end - span.start !== 1) {
      continue;
    }
    const list = byStart.get(span.start) ?? [];
    list.push(span);
    byStart.set(span.start, list);
  }
  const table: Segmentation[][] = Array.from({ length: wordCount + 1 }, () => []);
  table[0] = [{ segments: [], cost: { unmatched: 0, songs: 0, closeForms: 0 } }];
  const offer = (at: number, entry: Segmentation): void => {
    const list = table[at]!;
    list.push(entry);
    list.sort((a, b) => compareSegmentations(a, b, objective));
    list.length = Math.min(list.length, keep);
  };
  for (let i = 0; i < wordCount; i += 1) {
    for (const entry of table[i]!) {
      offer(i + 1, {
        segments: [...entry.segments, { start: i, end: i + 1, matched: false }],
        cost: { ...entry.cost, unmatched: entry.cost.unmatched + 1 },
      });
      for (const span of byStart.get(i) ?? []) {
        offer(span.end, {
          segments: [...entry.segments, { start: i, end: span.end, matched: true }],
          cost: {
            unmatched: entry.cost.unmatched,
            songs: entry.cost.songs + 1,
            closeForms: entry.cost.closeForms + (span.closeOnly ? 1 : 0),
          },
        });
      }
    }
  }
  return table[wordCount]!;
}

/** A segmentation's identity, to tell alternatives apart. */
function segmentationKey(segmentation: Segmentation): string {
  return segmentation.segments
    .map((s) => `${s.start}-${s.end}${s.matched ? "" : "?"}`)
    .join(",");
}

/**
 * The recommended segmentation under `objective`, followed by up to
 * {@link MAX_ALTERNATIVE_SPLITS} distinct alternatives: first the best under
 * each other objective, then the runners-up under the chosen one. Each comes
 * with the objective it is best for, if any.
 */
export function rankSegmentations(
  wordCount: number,
  spans: readonly SpanMatch[],
  objective: SplitObjective,
): { segmentation: Segmentation; objective?: SplitObjective }[] {
  const primary = bestSegmentations(wordCount, spans, objective, MAX_ALTERNATIVE_SPLITS + 1);
  const ordered: { segmentation: Segmentation; objective?: SplitObjective }[] = [
    { segmentation: primary[0]!, objective },
  ];
  for (const other of SPLIT_OBJECTIVES) {
    if (other !== objective) {
      ordered.push({ segmentation: bestSegmentations(wordCount, spans, other, 1)[0]!, objective: other });
    }
  }
  for (const runnerUp of primary.slice(1)) {
    ordered.push({ segmentation: runnerUp });
  }
  const seen = new Set<string>();
  const result: { segmentation: Segmentation; objective?: SplitObjective }[] = [];
  for (const entry of ordered) {
    const key = segmentationKey(entry.segmentation);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result.slice(0, MAX_ALTERNATIVE_SPLITS + 1);
}

/** A sentence word: as typed, and as comparison words. */
interface SentenceWord {
  display: string;
  words: string[];
}

function sentenceWords(text: string, options: MatchOptions): SentenceWord[] {
  return rawWords(text)
    .map((display) => ({ display, words: wordsOf(display, options) }))
    .filter((word) => word.words.length > 0);
}

async function resolveSentence(
  client: WordPlaySearchClient,
  text: string,
  objective: SplitObjective,
  maxSpan: number,
  options: MatchOptions,
  filter: TrackFilter,
): Promise<Omit<WordPlayPlan, "mode" | "text" | "suggestedName">> {
  const words = sentenceWords(text, options);
  if (words.length === 0) {
    throw new Error("Enter a sentence");
  }
  if (words.length > MAX_SENTENCE_WORDS) {
    throw new Error(`A sentence may have at most ${MAX_SENTENCE_WORDS} words`);
  }

  // Every run of up to maxSpan words, shortest first; identical runs searched once.
  const spans: { start: number; end: number; key: string; query: string }[] = [];
  for (let length = 1; length <= maxSpan; length += 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const run = words.slice(start, start + length);
      spans.push({
        start,
        end: start + length,
        key: run.flatMap((w) => w.words).join(" "),
        query: run.map((w) => w.display).join(" "),
      });
    }
  }
  const queries: string[] = [];
  const queued = new Set<string>();
  const queue = (key: string, query: string): void => {
    if (!queued.has(key)) {
      queued.add(key);
      queries.push(query);
    }
  };
  const singles = spans.filter((span) => span.end - span.start === 1);
  for (const span of singles) {
    queue(span.key, span.query);
  }
  if (options.closeForms) {
    for (const span of singles) {
      const base = span.key.split(" ").map(searchForm).join(" ");
      queue(base, base);
    }
  }
  for (const span of spans.filter((s) => s.end - s.start > 1)) {
    queue(span.key, span.query);
  }
  const searched = queries.slice(0, MAX_SENTENCE_SEARCHES);
  const results = await mapWithConcurrency(searched, DEFAULT_CONCURRENCY, (query) =>
    client.searchTracks(query, SPAN_SEARCH_LIMIT),
  );
  const deep = await searchDeeper(client, singles, results, options);
  results.push(...deep.results);

  // One pool of every result (in search order), so a run can match a title
  // another search found, indexed by whole-title key and stem key.
  const seen = new Set<number>();
  const byKey = new Map<string, Prepared[]>();
  const byStemKey = new Map<string, Prepared[]>();
  const excluded: Prepared[] = [];
  for (const list of results) {
    for (const track of list) {
      if (seen.has(track.id)) {
        continue;
      }
      seen.add(track.id);
      const prepared = prepare(track, seen.size, options);
      if (trackExclusion(track, filter) !== undefined) {
        excluded.push(prepared);
        continue;
      }
      pushTo(byKey, prepared.key, prepared);
      pushTo(byStemKey, prepared.stemKey, prepared);
    }
  }

  // Candidates for every run, and which runs the splitter may use.
  const candidatesBySpan = new Map<string, Ranked[]>();
  const available: SpanMatch[] = [];
  const spanKeys = new Set<string>();
  const spanStemKeys = new Set<string>();
  for (const span of spans) {
    const phrase = { words: span.key.split(" "), plain: plainForm(span.query) };
    const stemKey = phrase.words.map(stem).join(" ");
    spanKeys.add(span.key);
    spanStemKeys.add(stemKey);
    const pool = [
      ...(byKey.get(span.key) ?? []),
      ...(options.closeForms ? byStemKey.get(stemKey) ?? [] : []),
    ];
    const matches = pool
      .map((prepared) => matchWhole(prepared, phrase, options))
      .filter((match): match is Ranked => match !== undefined);
    const ranked = rankCandidates(matches, options);
    if (ranked.length > 0) {
      candidatesBySpan.set(`${span.start}:${span.end}`, ranked);
      available.push({
        start: span.start,
        end: span.end,
        closeOnly: ranked.every((c) => c.closeForm),
      });
    }
  }
  const excludedCount = excluded.filter(
    (prepared) =>
      spanKeys.has(prepared.key) || (options.closeForms && spanStemKeys.has(prepared.stemKey)),
  ).length;

  const splits = rankSegmentations(words.length, available, objective).map(
    ({ segmentation, objective: best }) =>
      buildSplit(
        mergeGaps(segmentation.segments).map((segment) => ({
          label: words
            .slice(segment.start, segment.end)
            .map((w) => w.display)
            .join(" "),
          candidates: segment.matched
            ? candidatesBySpan.get(`${segment.start}:${segment.end}`) ?? []
            : [],
        })),
        options,
        best,
      ),
  );
  return {
    splits,
    searches: searched.length + deep.searches,
    skippedSearches: queries.length - searched.length,
    excludedCount,
  };
}

/**
 * Page deeper (past the first {@link SPAN_SEARCH_LIMIT} results, up to
 * {@link DEEP_SEARCH_DEPTH}) for each single word no first-pass result matches
 * exactly, stopping a word once a page has its exact title, and stopping
 * altogether at {@link MAX_DEEP_SEARCHES}. Words are tried in sentence order.
 */
async function searchDeeper(
  client: WordPlaySearchClient,
  singles: readonly { key: string; query: string }[],
  firstPass: readonly Track[][],
  options: MatchOptions,
): Promise<{ results: Track[][]; searches: number }> {
  const found = new Set(firstPass.flat().map((track) => prepare(track, 0, options).key));
  const words: { key: string; query: string }[] = [];
  for (const single of singles) {
    if (!found.has(single.key) && !words.some((w) => w.key === single.key)) {
      words.push(single);
    }
  }
  let budget = MAX_DEEP_SEARCHES;
  const results: Track[][] = [];
  let searches = 0;
  const pages: { word: { key: string; query: string }; offset: number }[] = [];
  for (let offset = SPAN_SEARCH_LIMIT; offset < DEEP_SEARCH_DEPTH; offset += SEARCH_PAGE_SIZE) {
    for (const word of words) {
      pages.push({ word, offset });
    }
  }
  // Breadth first: every word's next page before anyone's page after it, so
  // the budget is shared fairly; a word is dropped once it is found.
  const done = new Set<string>();
  for (let i = 0; i < pages.length && budget > 0; ) {
    const batch: typeof pages = [];
    for (; i < pages.length && batch.length < Math.min(budget, DEFAULT_CONCURRENCY); i += 1) {
      if (!done.has(pages[i]!.word.key)) {
        batch.push(pages[i]!);
      }
    }
    if (batch.length === 0) {
      break;
    }
    budget -= batch.length;
    searches += batch.length;
    const fetched = await Promise.all(
      batch.map((page) => client.searchTracks(page.word.query, SEARCH_PAGE_SIZE, page.offset)),
    );
    fetched.forEach((tracks, index) => {
      const word = batch[index]!.word;
      results.push(tracks);
      if (
        tracks.length < SEARCH_PAGE_SIZE ||
        tracks.some((track) => prepare(track, 0, options).key === word.key)
      ) {
        done.add(word.key);
      }
    });
  }
  return { results, searches };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

/** Merge runs of single unmatched words into one gap. */
function mergeGaps(segments: readonly Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last !== undefined && !last.matched && !segment.matched) {
      last.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Contains / exact

async function resolveByTitle(
  client: WordPlaySearchClient,
  mode: "contains" | "exact",
  text: string,
  count: number,
  options: MatchOptions,
  filter: TrackFilter,
): Promise<Omit<WordPlayPlan, "mode" | "text" | "suggestedName">> {
  const phrase = { words: wordsOf(text, options), plain: plainForm(text) };
  if (phrase.words.length === 0) {
    throw new Error("Enter a word or phrase");
  }
  const query = rawWords(text).join(" ");
  const match = (prepared: Prepared): Ranked | undefined =>
    mode === "exact"
      ? matchWhole(prepared, phrase, options)
      : matchContains(prepared, phrase.words, options);

  const seen = new Set<number>();
  const matches: Ranked[] = [];
  let excludedCount = 0;
  let searches = 0;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const tracks = await client.searchTracks(query, SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
    searches += 1;
    let fresh = 0;
    for (const track of tracks) {
      if (seen.has(track.id)) {
        continue;
      }
      seen.add(track.id);
      fresh += 1;
      const found = match(prepare(track, seen.size, options));
      if (found === undefined) {
        continue;
      }
      if (trackExclusion(track, filter) !== undefined) {
        excludedCount += 1;
        continue;
      }
      matches.push(found);
    }
    if (tracks.length < SEARCH_PAGE_SIZE || fresh === 0 || enough(matches, count, options)) {
      break;
    }
  }

  const ranked = rankCandidates(matches, options);
  const label = rawWords(text).join(" ");
  const split = buildSplit(
    Array.from({ length: Math.min(count, ranked.length) }, () => ({ label, candidates: ranked })),
    options,
  );
  return { splits: [split], requested: count, searches, skippedSearches: 0, excludedCount };
}

/** Whether enough matches are in hand to fill `count` slots with some to spare. */
function enough(matches: readonly Ranked[], count: number, options: MatchOptions): boolean {
  if (matches.length < count + MAX_ALTERNATIVES) {
    return false;
  }
  if (!options.onePerArtist) {
    return true;
  }
  const artists = new Set(matches.map((m) => artistKey(m.track) ?? `id:${m.track.id}`));
  return artists.size >= count;
}

// ---------------------------------------------------------------------------
// Acrostic / A to Z

/** The letters of an acrostic word: letters and digits, folded and upper-cased. */
export function acrosticLetters(text: string): string[] {
  return [
    ...text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]/gu, "")
      .toUpperCase(),
  ];
}

const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/**
 * The letter a title starts with, upper-cased: its first comparison word's
 * first letter when punctuation is ignored ("(Don't Fear) The Reaper" -> D,
 * "Élan" -> E), else its first character as written.
 */
export function firstLetter(track: Track, options: MatchOptions): string | undefined {
  const text = titleText(track, options);
  const first = options.ignorePunctuation ? foldWords(text)[0]?.[0] : text.trim()[0];
  return first?.toUpperCase();
}

async function resolveLetters(
  client: WordPlaySourceClient,
  letters: readonly string[],
  source: WordPlaySource,
  options: MatchOptions,
  filter: TrackFilter,
): Promise<Omit<WordPlayPlan, "mode" | "text" | "suggestedName">> {
  const tracks =
    source.type === "favourites"
      ? await client.getFavoriteTracks()
      : await client.getPlaylistTracks(source.playlistId);
  const wanted = new Set(letters);
  const byLetter = new Map<string, Ranked[]>();
  let excludedCount = 0;
  tracks.forEach((track, order) => {
    const letter = firstLetter(track, options);
    if (letter === undefined || !wanted.has(letter)) {
      return;
    }
    if (trackExclusion(track, filter) !== undefined) {
      excludedCount += 1;
      return;
    }
    const list = byLetter.get(letter) ?? [];
    list.push({ track, closeForm: false, punctuationIgnored: false, order });
    byLetter.set(letter, list);
  });
  const ranked = new Map(
    [...byLetter].map(([letter, list]) => [letter, rankCandidates(list, options)] as const),
  );
  const split = buildSplit(
    letters.map((letter) => ({ label: letter, candidates: ranked.get(letter) ?? [] })),
    options,
  );
  return {
    splits: [split],
    searches: 0,
    skippedSearches: 0,
    sourceSize: tracks.length,
    excludedCount,
  };
}

// ---------------------------------------------------------------------------
// Resolve and commit

/**
 * Build a word-play plan (phase 1). Nothing is written.
 *
 * @throws {Error} on empty input, a sentence over {@link MAX_SENTENCE_WORDS}
 *   words, an acrostic over {@link MAX_ACROSTIC_LETTERS} letters, or a count or
 *   span outside its bounds.
 */
export async function resolveWordPlay(
  client: WordPlayClient,
  request: WordPlayRequest,
  resolveOptions: ResolveWordPlayOptions = {},
): Promise<WordPlayPlan> {
  const options: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...resolveOptions.match };
  const filter = resolveOptions.filter ?? NO_FILTER;
  switch (request.mode) {
    case "contains":
    case "exact": {
      const count = checkBounds("count", request.count, WORD_PLAY_COUNT);
      const text = request.text.trim();
      return {
        mode: request.mode,
        text,
        suggestedName: titleCase(text),
        ...(await resolveByTitle(client, request.mode, text, count, options, filter)),
      };
    }
    case "sentence": {
      const maxSpan = checkBounds("maxSpan", request.maxSpan, WORD_PLAY_MAX_SPAN);
      const text = request.text.trim();
      return {
        mode: "sentence",
        text,
        suggestedName: titleCase(text),
        ...(await resolveSentence(
          client,
          text,
          request.split ?? "fewest",
          maxSpan,
          options,
          filter,
        )),
      };
    }
    case "acrostic": {
      const letters = acrosticLetters(request.text);
      if (letters.length === 0) {
        throw new Error("Enter a word to spell");
      }
      if (letters.length > MAX_ACROSTIC_LETTERS) {
        throw new Error(`An acrostic may have at most ${MAX_ACROSTIC_LETTERS} letters`);
      }
      const text = request.text.trim();
      return {
        mode: "acrostic",
        text,
        suggestedName: text.toUpperCase(),
        ...(await resolveLetters(client, letters, request.source, options, filter)),
      };
    }
    case "a-to-z":
      return {
        mode: "a-to-z",
        text: "",
        suggestedName: "A to Z",
        ...(await resolveLetters(client, ALPHABET, request.source, options, filter)),
      };
  }
}

function checkBounds(name: string, value: number | undefined, bounds: IntBounds): number {
  const resolved = value ?? bounds.fallback;
  if (!Number.isSafeInteger(resolved) || resolved < bounds.min || resolved > bounds.max) {
    throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return resolved;
}

/** Where to write a word-play playlist. */
export type WordPlayTarget =
  | { type: "new"; name: string; isPublic?: boolean; description?: string }
  | { type: "existing"; playlistId: PlaylistId };

export interface WordPlayCommitResult {
  /** The created playlist (new target only). */
  playlist?: Playlist;
  playlistId: PlaylistId;
  /** Track ids written, in order. */
  added: number[];
  /** Track ids skipped: repeated, or already in an existing playlist. */
  skipped: number[];
}

/**
 * Write the chosen songs, in order (phase 2): create a new playlist with them,
 * or append them to an existing one (skipping any already in it). A track
 * repeated in the list is written once.
 */
export async function commitWordPlay(
  client: PlaylistWriterClient & ExistingPlaylistClient,
  options: { target: WordPlayTarget; trackIds: readonly TrackId[] },
): Promise<WordPlayCommitResult> {
  const { target } = options;
  if (target.type === "existing") {
    const { added, skipped } = await addTracksToExistingPlaylist(client, {
      playlistId: target.playlistId,
      trackIds: options.trackIds,
    });
    return { playlistId: target.playlistId, added, skipped };
  }
  const added: number[] = [];
  const skipped: number[] = [];
  const seen = new Set<number>();
  for (const id of options.trackIds) {
    if (seen.has(id)) {
      skipped.push(id);
    } else {
      seen.add(id);
      added.push(id);
    }
  }
  const playlist = await createPlaylistWithTracks(client, {
    name: target.name,
    trackIds: added,
    isPublic: target.isPublic ?? false,
    ...(target.description !== undefined && { description: target.description }),
  });
  return { playlist, playlistId: playlist.id, added, skipped };
}
