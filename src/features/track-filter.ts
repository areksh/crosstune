/**
 * Exclusion filters for the playlist tools.
 *
 * A filter excludes tracks by their title, by their album's title, by their
 * artist, or by the disc they sit on. It never drops anything silently on the web: the tools mark
 * each excluded track with the {@link Exclusion} that caught it, so the preview
 * can show it unticked (and let the user tick it back on). The CLI, which has no
 * review step, simply leaves excluded tracks out.
 *
 * Terms come in two forms:
 *
 *   - a plain term ("live", "live at") matches as a whole word or phrase,
 *     ignoring case, so "live" catches "Live at Wembley" but not "Alive"; and
 *   - a term wrapped in slashes ("/remix|edit$/") is a regular expression,
 *     also case-insensitive. Flags after the closing slash are not accepted.
 *
 * Artist terms are the exception: a plain artist term matches the *whole*
 * artist name, ignoring case, diacritics and extra whitespace, so "Drake"
 * excludes Drake but not Nick Drake, and "bjork" excludes Björk. A slashed
 * artist term is a case-insensitive regex tested against the name as Qobuz
 * spells it ("/^the /" catches every "The ..." band).
 */

import type { Album, Track } from "../services/model.js";

/** The raw, user-supplied filter, as parsed from CLI flags or a request body. */
export interface TrackFilterSpec {
  /** Terms matched against a track's title and version. */
  excludeTracks?: readonly string[];
  /** Terms matched against the album's title (and version, for album releases). */
  excludeAlbums?: readonly string[];
  /** Terms matched against the whole artist (performer) name. */
  excludeArtists?: readonly string[];
  /** Discs to keep; empty or absent keeps every disc. */
  discs?: readonly number[];
}

interface CompiledTerm {
  /** The term as the user wrote it (trimmed), for reporting. */
  term: string;
  pattern: RegExp;
}

interface CompiledArtistTerm {
  /** The term as the user wrote it (trimmed), for reporting. */
  term: string;
  matches: (name: string) => boolean;
}

/** A validated, ready-to-apply filter. Build one with {@link compileTrackFilter}. */
export interface TrackFilter {
  readonly trackTerms: readonly CompiledTerm[];
  readonly albumTerms: readonly CompiledTerm[];
  readonly artistTerms: readonly CompiledArtistTerm[];
  readonly discs: ReadonlySet<number>;
}

/**
 * Why a track (or album release) was excluded: by a filter term or the disc
 * list, or -- by a plan-wide {@link ./song-picker.ts} option -- because it is
 * already a favourite or is a later copy of a song the plan already has (`of`
 * names the first copy).
 */
export type Exclusion =
  | { kind: "track"; term: string }
  | { kind: "album"; term: string }
  | { kind: "artist"; term: string }
  | { kind: "disc"; disc: number }
  | { kind: "favourite" }
  | { kind: "repeat"; of: string };

/** A track with the exclusion that caught it, if any. */
export interface FilteredTrack {
  track: Track;
  exclusion?: Exclusion;
}

/** A filter that excludes nothing. */
export const NO_FILTER: TrackFilter = compileTrackFilter({});

/** The highest disc number accepted, to keep a typo like "1-100000" from expanding. */
const MAX_DISC = 999;

/**
 * Letters, digits and combining marks: the characters a plain term must not be
 * glued to for it to count as a whole word.
 */
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}]";

/**
 * Compile one exclude term to a case-insensitive pattern.
 *
 * @throws {Error} if the term is empty or is an invalid `/regex/`.
 */
export function compileTerm(raw: string): RegExp {
  const term = raw.trim();
  const pattern = compileRegexTerm(term);
  if (pattern !== undefined) {
    return pattern;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, "iu");
}

/**
 * Compile one exclude-artist term to a name matcher: a plain term matches the
 * whole name (see {@link normaliseArtistName}); a `/regex/` is tested against
 * the name as given.
 *
 * @throws {Error} if the term is empty or is an invalid `/regex/`.
 */
export function compileArtistTerm(raw: string): (name: string) => boolean {
  const term = raw.trim();
  const pattern = compileRegexTerm(term);
  if (pattern !== undefined) {
    return (name) => pattern.test(name);
  }
  const wanted = normaliseArtistName(term);
  return (name) => normaliseArtistName(name) === wanted;
}

/**
 * An artist name reduced for comparison: without diacritics, lower-cased, with
 * runs of whitespace collapsed to one space and the ends trimmed.
 */
export function normaliseArtistName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Compile a trimmed `/slashed/` term to a case-insensitive regex, or return
 * undefined for a plain term.
 *
 * @throws {Error} if the term is empty or is an invalid `/regex/`.
 */
function compileRegexTerm(term: string): RegExp | undefined {
  const regexBody =
    term.length >= 2 && term.startsWith("/") && term.endsWith("/")
      ? term.slice(1, -1)
      : undefined;
  if (term.length === 0 || regexBody === "") {
    throw new Error("Exclude term is empty");
  }
  if (regexBody === undefined) {
    return undefined;
  }
  try {
    return new RegExp(regexBody, "i");
  } catch (error) {
    throw new Error(`Invalid exclude pattern "${term}": ${(error as Error).message}`);
  }
}

/**
 * Parse a disc list such as "1", "1,3" or "1-3, 5" into sorted, unique disc
 * numbers. A blank list means "every disc" and parses to `[]`.
 *
 * @throws {Error} if any part is not a positive disc number or ascending range.
 */
export function parseDiscList(raw: string): number[] {
  if (raw.trim().length === 0) {
    return [];
  }
  const discs = new Set<number>();
  for (const part of raw.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const from = match === null ? NaN : Number(match[1]);
    const to = match?.[2] === undefined ? from : Number(match[2]);
    if (!(from >= 1 && to >= from && to <= MAX_DISC)) {
      throw new Error(
        `Invalid disc list "${raw}": use disc numbers 1-${MAX_DISC} such as "1", "1,3" or "1-2"`,
      );
    }
    for (let disc = from; disc <= to; disc += 1) {
      discs.add(disc);
    }
  }
  return [...discs].sort((a, b) => a - b);
}

/**
 * Validate and compile a filter spec. Blank terms are ignored.
 *
 * @throws {Error} if a term is an invalid `/regex/`.
 */
export function compileTrackFilter(spec: TrackFilterSpec): TrackFilter {
  const nonBlank = (terms: readonly string[] = []): string[] =>
    terms.map((term) => term.trim()).filter((term) => term.length > 0);
  const compile = (terms: readonly string[] = []): CompiledTerm[] =>
    nonBlank(terms).map((term) => ({ term, pattern: compileTerm(term) }));
  return {
    trackTerms: compile(spec.excludeTracks),
    albumTerms: compile(spec.excludeAlbums),
    artistTerms: nonBlank(spec.excludeArtists).map((term) => ({
      term,
      matches: compileArtistTerm(term),
    })),
    discs: new Set(spec.discs ?? []),
  };
}

/** True when the filter could exclude anything. */
export function isFilterActive(filter: TrackFilter): boolean {
  return (
    filter.trackTerms.length > 0 ||
    filter.albumTerms.length > 0 ||
    filter.artistTerms.length > 0 ||
    filter.discs.size > 0
  );
}

/**
 * Why the filter excludes this track, or undefined to keep it.
 *
 * The disc is checked first, then the artist terms (against the track's
 * performer), then the track terms, then the album terms. A track with no disc
 * number is never excluded by the disc list, nor one with no artist by the
 * artist terms.
 */
export function trackExclusion(track: Track, filter: TrackFilter): Exclusion | undefined {
  if (
    filter.discs.size > 0 &&
    track.discNumber !== undefined &&
    !filter.discs.has(track.discNumber)
  ) {
    return { kind: "disc", disc: track.discNumber };
  }
  const artistTerm =
    track.artist === undefined ? undefined : artistExclusion(track.artist, filter);
  if (artistTerm !== undefined) {
    return { kind: "artist", term: artistTerm };
  }
  const trackTerm = firstMatch(filter.trackTerms, labelled(track.title, track.version));
  if (trackTerm !== undefined) {
    return { kind: "track", term: trackTerm };
  }
  const albumTerm =
    track.album === undefined ? undefined : firstMatch(filter.albumTerms, track.album);
  return albumTerm === undefined ? undefined : { kind: "album", term: albumTerm };
}

/** Why the filter excludes this album release (album terms only), or undefined. */
export function albumExclusion(album: Album, filter: TrackFilter): Exclusion | undefined {
  const term = firstMatch(filter.albumTerms, labelled(album.title, album.version));
  return term === undefined ? undefined : { kind: "album", term };
}

/** The first artist term that excludes an artist of this name, or undefined. */
export function artistExclusion(name: string, filter: TrackFilter): string | undefined {
  return filter.artistTerms.find((term) => term.matches(name))?.term;
}

/** Annotate each track (in order) with the exclusion that caught it, if any. */
export function applyTrackFilter(
  tracks: readonly Track[],
  filter: TrackFilter,
): FilteredTrack[] {
  return tracks.map((track) => {
    const exclusion = trackExclusion(track, filter);
    return exclusion === undefined ? { track } : { track, exclusion };
  });
}

/** "Title (Version)", as Qobuz displays it, so terms can match either part. */
function labelled(title: string, version: string | undefined): string {
  return version === undefined ? title : `${title} (${version})`;
}

function firstMatch(terms: readonly CompiledTerm[], text: string): string | undefined {
  return terms.find((term) => term.pattern.test(text))?.term;
}
