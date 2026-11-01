/**
 * An artist's releases: the domain type and a defensive parser.
 *
 * The releases come from `artist/getReleasesList` (see {@link paths}), an
 * endpoint inferred from the Qobuz web player and not verified against the
 * live API. Its exact JSON is therefore unknown, so the parser accepts both
 * shapes Qobuz is known to use for an artist's albums:
 *
 *   - the web player's releases list: `{ has_more, items: [...] }`, each item
 *     with `release_type`, `dates.original`, `audio_info` and an artist whose
 *     name may be nested as `name.display`; and
 *   - the older `artist/get?extra=albums`: `{ albums: { total, offset, items } }`,
 *     each item an ordinary album object with `release_type` or `product_type`.
 *
 * Every release is classified into a {@link ReleaseType}; when Qobuz gives no
 * usable type, the title and version decide ("Live at ...", "Greatest Hits").
 */

import type { Album } from "./models.js";

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

/** An album release of an artist, with its type and (when known) its main artist id. */
export interface Release extends Album {
  releaseType: ReleaseType;
  /** Id of the release's main artist, when present. */
  artistId?: number;
}

/** One page of an artist's releases, and whether more follow. */
export interface ReleasesPage {
  releases: Release[];
  hasMore: boolean;
}

/** An artist's releases as fetched, and whether a cap cut the list short. */
export interface ArtistReleases {
  releases: Release[];
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse one page of an artist's releases, in either known shape (see the
 * module comment). Items without a string id and title are skipped.
 *
 * `hasMore` comes from `has_more` when present, otherwise from the albums
 * container's `total` against `offset` plus the items on this page.
 */
export function parseReleasesPage(response: unknown): ReleasesPage {
  if (!isRecord(response)) {
    return { releases: [], hasMore: false };
  }
  const container = isRecord(response["albums"])
    ? response["albums"]
    : isRecord(response["releases"])
      ? response["releases"]
      : response;
  const items = Array.isArray(container["items"]) ? container["items"] : [];

  const releases: Release[] = [];
  for (const item of items) {
    const release = parseRelease(item);
    if (release !== undefined) {
      releases.push(release);
    }
  }

  let hasMore = false;
  const flag = container["has_more"] ?? response["has_more"];
  if (typeof flag === "boolean") {
    hasMore = flag;
  } else if (typeof container["total"] === "number") {
    const offset = typeof container["offset"] === "number" ? container["offset"] : 0;
    hasMore = items.length > 0 && offset + items.length < container["total"];
  }
  return { releases, hasMore };
}

/** Parse one release item, tolerating both known shapes. */
function parseRelease(item: unknown): Release | undefined {
  if (!isRecord(item) || typeof item["id"] !== "string" || typeof item["title"] !== "string") {
    return undefined;
  }
  const artist = isRecord(item["artist"]) ? item["artist"] : {};
  const release: Release = {
    id: item["id"],
    title: item["title"],
    artist: artistName(artist["name"]),
    releaseType: "other",
  };
  if (typeof artist["id"] === "number") {
    release.artistId = artist["id"];
  }
  if (typeof item["version"] === "string" && item["version"].length > 0) {
    release.version = item["version"];
  }
  const date = releaseDate(item);
  if (date !== undefined) {
    release.releaseDate = date;
  }
  const audio = isRecord(item["audio_info"]) ? item["audio_info"] : item;
  if (typeof audio["maximum_bit_depth"] === "number") {
    release.bitDepth = audio["maximum_bit_depth"];
  }
  if (typeof audio["maximum_sampling_rate"] === "number") {
    release.samplingRate = audio["maximum_sampling_rate"];
  }
  if (typeof item["hires"] === "boolean") {
    release.hires = item["hires"];
  } else if (typeof item["hires_streamable"] === "boolean") {
    release.hires = item["hires_streamable"];
  }
  if (typeof item["tracks_count"] === "number") {
    release.trackCount = item["tracks_count"];
  }
  const image = coverOf(item["image"]);
  if (image !== undefined) {
    release.image = image;
  }
  release.releaseType = classifyRelease({
    type: firstString(item["release_type"], item["product_type"]),
    title: release.title,
    ...(release.version !== undefined && { version: release.version }),
    ...(release.trackCount !== undefined && { trackCount: release.trackCount }),
  });
  return release;
}

/** An artist name given as a string, or nested as `{ display }`. */
function artistName(name: unknown): string {
  if (typeof name === "string") {
    return name;
  }
  if (isRecord(name) && typeof name["display"] === "string") {
    return name["display"];
  }
  return "";
}

/** The first argument that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

/** A release date (YYYY-MM-DD) from either shape's date fields. */
function releaseDate(item: Record<string, unknown>): string | undefined {
  const dates = isRecord(item["dates"]) ? item["dates"] : {};
  const text = firstString(
    item["release_date_original"],
    dates["original"],
    dates["stream"],
    dates["download"],
  );
  if (text !== undefined && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }
  const releasedAt = item["released_at"];
  if (typeof releasedAt === "number") {
    return new Date(releasedAt * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * A cover URL from a Qobuz image object, preferring the ~230px `small`.
 * Mirrors the album parser in models.ts: only https URLs are accepted.
 */
function coverOf(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const size of ["small", "thumbnail", "large"]) {
    const url = value[size];
    if (typeof url === "string" && url.startsWith("https://")) {
      return url;
    }
  }
  return undefined;
}

/** Qobuz's type labels (lower-cased, letters only) mapped to ours. */
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

/**
 * Classify a release.
 *
 * A type label Qobuz gives (`release_type`, else `product_type`) decides when
 * it is one we know. Without one, the title and version do: "live" makes a
 * live album, a greatest-hits style title a compilation, "EP"/"single" (or at
 * most three tracks) an EP or single; anything else is an album.
 */
export function classifyRelease(info: {
  type?: string;
  title: string;
  version?: string;
  trackCount?: number;
}): ReleaseType {
  const label = info.type?.toLowerCase().replace(/[^a-z]/g, "");
  const known = label === undefined ? undefined : TYPE_LABELS[label];
  if (known !== undefined) {
    return known;
  }
  const text = info.version === undefined ? info.title : `${info.title} (${info.version})`;
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
