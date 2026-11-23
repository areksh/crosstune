/**
 * An artist's releases: the domain type and a defensive parser.
 *
 * The releases come from `artist/getReleasesList` (see {@link paths}), the
 * undocumented endpoint the Qobuz web player uses. The parser accepts both
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

import { classifyRelease, type ReleaseType } from "../releases.js";
import type { Album } from "./models.js";

export { classifyRelease, RELEASE_TYPES, type ReleaseType } from "../releases.js";

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
  /**
   * How many items Qobuz returned on this page, read or not: what the next
   * page's offset moves on by (an item that cannot be read is still one).
   */
  returned: number;
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
    return { releases: [], hasMore: false, returned: 0 };
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
  return { releases, hasMore, returned: items.length };
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
