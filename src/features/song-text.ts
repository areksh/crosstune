/** Comparing song titles and artists as different services write them. */

import { normalise } from "./deduplicate.js";

/**
 * A trailing featured-artist credit in a title: "(feat. X)", "[with X]",
 * " - feat. X". Spotify keeps these in the title; Qobuz in the version.
 */
const FEATURING =
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+-\s+(?:feat\.?|ft\.?|featuring)\s.*$/gi;

export function withoutFeaturing(title: string): string {
  const stripped = title.replace(FEATURING, "").trim();
  return stripped.length > 0 ? stripped : title;
}

/** Normalised forms a title may be compared by: as given, and without "feat.". */
export function titleKeys(title: string): string[] {
  const keys = [normalise(title), normalise(withoutFeaturing(title))];
  return keys.filter((key, index) => key.length > 0 && keys.indexOf(key) === index);
}

export function tokens(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((token) => token.length > 0);
}

/** True when either token list is a subset of the other (catches band prefixes). */
export function tokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) || b.every((t) => setA.has(t));
}

/** A title without its version label: "Roads (Live)" and "Roads - Live" are "Roads". */
export function baseTitle(title: string): string {
  const base = withoutFeaturing(title)
    .replace(/\s*[([][^)\]]*[)\]]\s*$/g, "")
    .replace(/\s+-\s+[^-]*$/, "")
    .trim();
  return normalise(base.length > 0 ? base : title);
}
