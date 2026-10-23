/**
 * Exclusion filters for the playlist tools.
 *
 * A filter excludes tracks by their title, by their album's title, or by the
 * disc they sit on. It never drops anything silently on the web: the tools mark
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
 */

import type { Album, Track } from "../qobuz/index.js";

/** The raw, user-supplied filter, as parsed from CLI flags or a request body. */
export interface TrackFilterSpec {
  /** Terms matched against a track's title and version. */
  excludeTracks?: readonly string[];
  /** Terms matched against the album's title (and version, for album releases). */
  excludeAlbums?: readonly string[];
  /** Discs to keep; empty or absent keeps every disc. */
  discs?: readonly number[];
}

interface CompiledTerm {
  /** The term as the user wrote it (trimmed), for reporting. */
  term: string;
  pattern: RegExp;
}

/** A validated, ready-to-apply filter. Build one with {@link compileTrackFilter}. */
export interface TrackFilter {
  readonly trackTerms: readonly CompiledTerm[];
  readonly albumTerms: readonly CompiledTerm[];
  readonly discs: ReadonlySet<number>;
}

/** Why a track (or album release) was excluded. */
export type Exclusion =
  | { kind: "track"; term: string }
  | { kind: "album"; term: string }
  | { kind: "disc"; disc: number };

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
  const regexBody =
    term.length >= 2 && term.startsWith("/") && term.endsWith("/")
      ? term.slice(1, -1)
      : undefined;
  if (term.length === 0 || regexBody === "") {
    throw new Error("Exclude term is empty");
  }
  if (regexBody !== undefined) {
    try {
      return new RegExp(regexBody, "i");
    } catch (error) {
      throw new Error(`Invalid exclude pattern "${term}": ${(error as Error).message}`);
    }
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, "iu");
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
  const compile = (terms: readonly string[] = []): CompiledTerm[] =>
    terms
      .filter((term) => term.trim().length > 0)
      .map((term) => ({ term: term.trim(), pattern: compileTerm(term) }));
  return {
    trackTerms: compile(spec.excludeTracks),
    albumTerms: compile(spec.excludeAlbums),
    discs: new Set(spec.discs ?? []),
  };
}

/** True when the filter could exclude anything. */
export function isFilterActive(filter: TrackFilter): boolean {
  return filter.trackTerms.length > 0 || filter.albumTerms.length > 0 || filter.discs.size > 0;
}

/**
 * Why the filter excludes this track, or undefined to keep it.
 *
 * The disc is checked first, then the track terms, then the album terms. A track
 * with no disc number is never excluded by the disc list.
 */
export function trackExclusion(track: Track, filter: TrackFilter): Exclusion | undefined {
  if (
    filter.discs.size > 0 &&
    track.discNumber !== undefined &&
    !filter.discs.has(track.discNumber)
  ) {
    return { kind: "disc", disc: track.discNumber };
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
