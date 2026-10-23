/**
 * Track rows and filter inputs shared by the playlist views.
 *
 * The server decides what a filter excludes; these helpers only read the
 * inputs and render each track, ticked unless the server excluded it.
 */

import type { Exclusion, Track } from "./api.js";
import { el } from "./dom.js";

/** The non-blank lines of a textarea, trimmed: one exclude term per line. */
export function readTerms(id: string): string[] {
  return el<HTMLTextAreaElement>(id)
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
