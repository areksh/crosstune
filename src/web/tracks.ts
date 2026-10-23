/**
 * Track rows and filter inputs shared by the playlist views.
 *
 * The server decides what a filter excludes; these helpers only read the
 * inputs and render each track, ticked unless the server excluded it.
 */

import type { ExcludedTrack, Exclusion, Track } from "./api.js";
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

/** A checkbox row for a track; excluded tracks start unticked, with the reason. */
export function trackRow(
  track: Track,
  options: { meta?: string; exclusion?: Exclusion; onChange: () => void },
): HTMLElement {
  const row = document.createElement("label");
  row.className = "track";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = options.exclusion === undefined;
  checkbox.dataset["trackId"] = String(track.id);
  checkbox.addEventListener("change", options.onChange);
  row.appendChild(checkbox);

  const title = document.createElement("span");
  title.className = "title";
  title.textContent =
    track.version === undefined ? track.title : `${track.title} (${track.version})`;
  row.appendChild(title);

  if (options.meta !== undefined) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = options.meta;
    row.appendChild(meta);
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
  }
}
