/**
 * Track rows and filter inputs shared by the playlist views.
 *
 * The server decides what a filter excludes; these helpers only read the
 * inputs and render each track, ticked unless the server excluded it.
 */

import type { ExcludedTrack, Exclusion, Track } from "./api.js";
import { coverSlot } from "./artwork.js";
import { el } from "./dom.js";

/** The non-blank lines of a textarea, trimmed: one exclude term per line. */
export function readTerms(id: string): string[] {
  return el<HTMLTextAreaElement>(id)
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Merge an artist's kept tracks with the excluded ones back into popularity
 * order, putting each excluded track at its `position`, so the preview (and a
 * re-ticked track's place in the playlist) follows the ranking.
 */
export function inRankOrder(
  tracks: readonly Track[],
  excluded: readonly ExcludedTrack[],
): { track: Track; exclusion?: Exclusion }[] {
  const merged: { track: Track; exclusion?: Exclusion }[] = [];
  let kept = 0;
  for (const entry of [...excluded].sort((a, b) => a.position - b.position)) {
    while (merged.length < entry.position && kept < tracks.length) {
      merged.push({ track: tracks[kept]! });
      kept += 1;
    }
    merged.push({ track: entry.track, exclusion: entry.exclusion });
  }
  for (; kept < tracks.length; kept += 1) {
    merged.push({ track: tracks[kept]! });
  }
  return merged;
}

/**
 * A group's header: the name as a heading, then an optional muted note (e.g.
 * what it matched) and an optional muted count.
 */
export function groupHead(
  tag: "h3" | "h4",
  name: string,
  options: { note?: string; count?: string } = {},
): HTMLElement {
  const head = document.createElement("header");
  head.className = "group-head";
  const heading = document.createElement(tag);
  heading.textContent = name;
  head.appendChild(heading);
  if (options.note !== undefined && options.note.length > 0) {
    const note = document.createElement("span");
    note.className = "matched";
    note.textContent = options.note;
    head.appendChild(note);
  }
  if (options.count !== undefined) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = options.count;
    head.appendChild(count);
  }
  return head;
}

/** "5 tracks", or "5 tracks, 1 excluded" when the filters excluded some. */
export function trackCountLabel(entry: {
  tracks: readonly unknown[];
  excluded: readonly unknown[];
}): string {
  const kept = entry.tracks.length;
  const label = `${kept} track${kept === 1 ? "" : "s"}`;
  return entry.excluded.length > 0 ? `${label}, ${entry.excluded.length} excluded` : label;
}

/** A track's muted sub-line: its album and release year, when known. */
export function trackSubline(track: Track): string | undefined {
  const parts = [track.album, track.releaseDate?.slice(0, 4)].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * A quality badge such as "24/96" (bit depth / sampling rate in kHz), lit up
 * for hi-res; undefined when the quality is unknown.
 */
export function qualityPill(quality: {
  bitDepth?: number;
  samplingRate?: number;
}): HTMLElement | undefined {
  const { bitDepth, samplingRate } = quality;
  if (bitDepth === undefined || samplingRate === undefined) {
    return undefined;
  }
  const pill = document.createElement("span");
  pill.className = bitDepth > 16 || samplingRate > 48 ? "quality hires" : "quality";
  pill.textContent = `${bitDepth}/${samplingRate}`;
  pill.title = `${bitDepth}-bit / ${samplingRate} kHz`;
  return pill;
}

/** A track's title (with its version label) over an optional muted sub-line. */
export function trackText(title: string, sub: string | undefined): HTMLElement {
  const text = document.createElement("span");
  text.className = "track-text";
  const main = document.createElement("span");
  main.className = "title";
  main.textContent = title;
  text.appendChild(main);
  if (sub !== undefined) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = sub;
    text.appendChild(meta);
  }
  return text;
}

/** A track's title with its version label, e.g. "Roads (Live)". */
export function titleOf(track: Track): string {
  return track.version === undefined ? track.title : `${track.title} (${track.version})`;
}

/** A checkbox row for a track; excluded tracks start unticked, with the reason. */
export function trackRow(
  track: Track,
  options: {
    meta?: string;
    exclusion?: Exclusion;
    onChange: () => void;
    /** Leave out the cover (e.g. under an album that shows its own). */
    noCover?: boolean;
  },
): HTMLElement {
  const row = document.createElement("label");
  row.className = options.noCover === true ? "track no-cover" : "track";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = options.exclusion === undefined;
  checkbox.dataset["trackId"] = String(track.id);
  checkbox.addEventListener("change", options.onChange);
  row.appendChild(checkbox);

  if (options.noCover !== true) {
    row.appendChild(coverSlot(track.image));
  }
  row.appendChild(trackText(titleOf(track), options.meta));
  const pill = qualityPill(track);
  if (pill !== undefined) {
    row.appendChild(pill);
  }
  if (options.exclusion !== undefined) {
    row.classList.add("excluded");
    const reason = document.createElement("span");
    reason.className = "reason";
    reason.textContent = exclusionLabel(options.exclusion);
    row.appendChild(reason);
  }
  return row;
}

/** A short explanation of why a track was excluded. */
function exclusionLabel(exclusion: Exclusion): string {
  switch (exclusion.kind) {
    case "disc":
      return `excluded: disc ${exclusion.disc}`;
    case "track":
      return `excluded: title matches "${exclusion.term}"`;
    case "album":
      return `excluded: album matches "${exclusion.term}"`;
    case "artist":
      return `excluded: artist matches "${exclusion.term}"`;
  }
}
