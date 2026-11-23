/**
 * Matching a typed list of artists against songs already in hand (a
 * playlist's), for removing or selecting by artist.
 *
 * Each line is an artist's name (the whole name, ignoring case, accents and
 * extra spaces), a `/regex/` tested against the name as Qobuz spells it, or a
 * Qobuz artist link, which {@link resolveArtistLinks} in playlist-manager.ts
 * looks up first. A song is an artist's when they are its main artist or
 * credited as a joint main artist; featured credits, and names after "feat." or
 * "with" in the title, make them a guest on it.
 *
 * Pure and free of Node dependencies, so the web UI uses it too.
 */

import type { ArtistId } from "../services/ids.js";
import type { Artist, Track } from "../services/model.js";
import { parseMusicLink } from "./music-links.js";
import { compileArtistTerm, normaliseArtistName } from "./track-filter.js";

/** One usable line: what it matches. */
export interface ArtistTerm {
  /** The line as typed (trimmed). */
  line: string;
  /** Who it names, when that is known: the typed name, or a link's artist. */
  name?: string;
  /** For a link: the artist's id, which the main artist is matched by. */
  id?: ArtistId;
  /** Whether it matches an artist's name. */
  matches(name: string): boolean;
}

export interface ParsedArtistTerms {
  terms: ArtistTerm[];
  /** Lines that cannot be used, and why. */
  problems: Array<{ line: string; reason: string }>;
}

/** The lines that are Qobuz links, which need looking up before matching. */
export function linkLines(lines: readonly string[]): string[] {
  return cleanLines(lines).filter((line) => parseMusicLink(line) !== undefined);
}

function cleanLines(lines: readonly string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0))];
}

/**
 * Parse typed lines, blank and repeated ones aside. `links` holds what each
 * link line was resolved to (its artist, or why not).
 */
export function parseArtistTerms(
  lines: readonly string[],
  links: ReadonlyMap<string, Artist | { problem: string }> = new Map(),
): ParsedArtistTerms {
  const terms: ArtistTerm[] = [];
  const problems: ParsedArtistTerms["problems"] = [];
  for (const line of cleanLines(lines)) {
    if (parseMusicLink(line) !== undefined) {
      const found = links.get(line);
      if (found === undefined || "problem" in found) {
        problems.push({ line, reason: found?.problem ?? "this link has not been looked up" });
      } else {
        const matches = compileArtistTerm(found.name.startsWith("/") ? `/^${escapeRegex(found.name)}$/` : found.name);
        terms.push({ line, name: found.name, id: found.id, matches });
      }
      continue;
    }
    try {
      const matches = compileArtistTerm(line);
      terms.push(line.startsWith("/") ? { line, matches } : { line, name: line, matches });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push({ line, reason: reason.replace(/^Invalid exclude pattern ".*": /s, "not a valid pattern: ") });
    }
  }
  return { terms, problems };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The song fields matched on. */
export type MatchableTrack = Pick<
  Track,
  "title" | "version" | "artist" | "artistId" | "jointArtists" | "guestArtists"
>;

/** What a line matched: indexes into the songs given. */
export interface ArtistMatchResult {
  line: string;
  /** The name to show: the link's artist, or the line. */
  name: string;
  /** Songs where they are a main artist. */
  main: number[];
  /** Songs where they are only a guest. */
  guest: number[];
  /** When nothing matched: an artist in the songs spelled like it. */
  suggestion?: { name: string; count: number };
}

/** Which songs each term matches, in the terms' order. */
export function matchArtists(
  tracks: readonly MatchableTrack[],
  terms: readonly ArtistTerm[],
): ArtistMatchResult[] {
  const guests = tracks.map((track) => [...(track.guestArtists ?? []), ...guestsInTitle(track)]);
  return terms.map((term) => {
    const main: number[] = [];
    const guest: number[] = [];
    tracks.forEach((track, index) => {
      if (isMainArtist(track, term)) {
        main.push(index);
      } else if (guests[index]!.some((name) => term.matches(name))) {
        guest.push(index);
      }
    });
    const result: ArtistMatchResult = { line: term.line, name: term.name ?? term.line, main, guest };
    if (main.length === 0 && guest.length === 0 && term.name !== undefined) {
      const suggestion = suggest(term.name, artistCounts(tracks));
      if (suggestion !== undefined) {
        result.suggestion = suggestion;
      }
    }
    return result;
  });
}

function isMainArtist(track: MatchableTrack, term: ArtistTerm): boolean {
  if (term.id !== undefined && track.artistId !== undefined) {
    // Ids tell apart two artists of one name; credits carry names only.
    if (track.artistId === term.id) {
      return true;
    }
  } else if (track.artist !== undefined && term.matches(track.artist)) {
    return true;
  }
  return (track.jointArtists ?? []).some((name) => term.matches(name));
}

/**
 * The songs a set of lines picks: those where any is a main artist (and, if
 * asked, a guest), in order.
 */
export function matchedIndexes(
  results: readonly ArtistMatchResult[],
  includeGuests: boolean,
): number[] {
  const picked = new Set(results.flatMap((r) => (includeGuests ? [...r.main, ...r.guest] : r.main)));
  return [...picked].sort((a, b) => a - b);
}

/** Names after "feat.", "ft.", "featuring" or "(with ...)" in a title or version. */
function guestsInTitle(track: MatchableTrack): string[] {
  const text = `${track.title}\n${track.version ?? ""}`;
  const names: string[] = [];
  for (const match of text.matchAll(/(?:\b(?:feat|ft|featuring)\b\.?|[([]with\b)\s*([^()[\]\n]+)/gi)) {
    const list = match[1]!.trim();
    names.push(list, ...list.split(/\s*(?:,|&|\band\b|\bx\b)\s*/i));
  }
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/** An artist's songs among those given. */
export interface ArtistCount {
  name: string;
  id?: ArtistId;
  count: number;
}

/** Every main artist with their song count, most songs first, then by name. */
export function artistCounts(tracks: readonly MatchableTrack[]): ArtistCount[] {
  const counts = new Map<string, ArtistCount>();
  for (const track of tracks) {
    if (track.artist === undefined || track.artist.trim().length === 0) {
      continue;
    }
    const key = track.artistId === undefined ? `n:${normaliseArtistName(track.artist)}` : `i:${track.artistId}`;
    const known = counts.get(key);
    if (known === undefined) {
      counts.set(key, {
        name: track.artist,
        ...(track.artistId !== undefined && { id: track.artistId }),
        count: 1,
      });
    } else {
      known.count += 1;
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The artist whose name is nearest to `typed`, when near enough to be a slip. */
function suggest(typed: string, artists: readonly ArtistCount[]): { name: string; count: number } | undefined {
  const wanted = normaliseArtistName(typed);
  let best: { name: string; count: number } | undefined;
  let bestDistance = Infinity;
  for (const { name, count } of artists) {
    const other = normaliseArtistName(name);
    const contains =
      Math.min(wanted.length, other.length) >= 4 && (other.includes(wanted) || wanted.includes(other));
    const allowed = Math.max(1, Math.floor(Math.max(wanted.length, other.length) / 4));
    const distance = editDistance(wanted, other);
    // One name inside the other ("Beatles", "The Beatles") ranks after a near miss.
    const score = distance <= allowed ? distance : contains ? allowed + 1 : Infinity;
    if (score < bestDistance) {
      best = { name, count };
      bestDistance = score;
    }
  }
  return best;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}
