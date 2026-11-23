/** What kind of release an album is, whichever service lists it. */

/** What kind of release this is, as the tools group them. */
export type ReleaseType = "album" | "ep-single" | "live" | "compilation" | "other";

/** All release types, for validation. */
export const RELEASE_TYPES: readonly ReleaseType[] = [
  "album",
  "ep-single",
  "live",
  "compilation",
  "other",
];

/** The services' type labels (lower-cased, letters only) mapped to ours. */
const TYPE_LABELS: Record<string, ReleaseType> = {
  album: "album",
  albums: "album",
  live: "live",
  compilation: "compilation",
  compilations: "compilation",
  epsingle: "ep-single",
  epsingles: "ep-single",
  ep: "ep-single",
  single: "ep-single",
  singles: "ep-single",
  other: "other",
};

/** Titles that mark a compilation of earlier material. */
const COMPILATION_TITLE =
  /\b(greatest hits|best of|the very best|anthology|essential|collection|the singles|hits)\b/i;

/** "Live", "Live at ...", "(Live)": a live recording. */
const LIVE_TITLE = /\blive\b/i;

/** An EP or single by name. */
const EP_SINGLE_TITLE = /\b(ep|single)\b/i;

/** At most this many tracks reads as a single or EP when nothing else says. */
const SINGLE_MAX_TRACKS = 3;

/** A greatest-hits title strong enough to overrule a plain "album" label. */
const STRONG_COMPILATION_TITLE = /\b(greatest hits|best of|the very best|anthology)\b/i;

/**
 * Classify a release.
 *
 * A specific type label the service gives -- live, compilation, EP/single -- decides. A plain "album" label only says
 * "not an EP or single": Qobuz labels live albums that way too, so the title
 * and version can still make it a live album or (on a greatest-hits title) a
 * compilation. Without a known label, the title and version decide: "live"
 * makes a live album, a greatest-hits style title a compilation, "EP"/"single"
 * (or at most three tracks) an EP or single; anything else is an album.
 */
export function classifyRelease(info: {
  type?: string;
  title: string;
  version?: string;
  trackCount?: number;
}): ReleaseType {
  const label = info.type?.toLowerCase().replace(/[^a-z]/g, "");
  const known = label === undefined ? undefined : TYPE_LABELS[label];
  const text = info.version === undefined ? info.title : `${info.title} (${info.version})`;
  if (known === "album") {
    if (LIVE_TITLE.test(text)) {
      return "live";
    }
    return STRONG_COMPILATION_TITLE.test(text) ? "compilation" : "album";
  }
  if (known !== undefined) {
    return known;
  }
  if (LIVE_TITLE.test(text)) {
    return "live";
  }
  if (COMPILATION_TITLE.test(text)) {
    return "compilation";
  }
  if (
    EP_SINGLE_TITLE.test(text) ||
    (info.trackCount !== undefined && info.trackCount <= SINGLE_MAX_TRACKS)
  ) {
    return "ep-single";
  }
  return "album";
}
