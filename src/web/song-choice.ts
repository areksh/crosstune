/**
 * A list of songs to check, each with a select of the songs it may be: used by
 * the copy review (likely matches) and the import preview (title-only lines).
 * Nothing is chosen at first -- the user picks, or leaves a song out.
 */

import type { TrackId } from "../services/ids.js";
import { optionLine, type SongLineFields } from "../ui/song-line.js";

/** A song offered as a choice. */
export type ChoiceSong = SongLineFields & { id: TrackId };

/** What the user chose for a row: a song; null to leave it out; undefined while undecided. */
export type Choice = TrackId | null | undefined;

export interface ChoiceRow {
  /** The song or line being checked, as the page shows it. */
  song: string;
  /** Why it needs checking, under it. */
  why?: string;
  options: readonly ChoiceSong[];
  onChange(choice: Choice): void;
}

export interface ChoiceListOptions {
  heading: string;
  hint: string;
  /** The label for leaving a song out. */
  leaveOut?: string;
}

/**
 * The rows, each with a select starting on "Choose..." (nothing chosen), then
 * the leave-out option, then the songs; with more than one row, a button that
 * takes the first song for every row still undecided.
 */
export function choiceList(rows: readonly ChoiceRow[], options: ChoiceListOptions): HTMLElement {
  const box = document.createElement("div");
  box.className = "transfer-list";
  const heading = document.createElement("h3");
  heading.textContent = options.heading;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = options.hint;
  box.append(heading, hint);
  for (const row of rows) {
    const line = document.createElement("label");
    line.className = "transfer-row";
    const from = document.createElement("span");
    from.className = "transfer-song";
    from.textContent = row.song;
    const why = document.createElement("span");
    why.className = "hint";
    why.textContent = row.why ?? "";
    const select = document.createElement("select");
    select.append(new Option("Choose...", "", true, true), new Option(options.leaveOut ?? "Leave it out", "none"));
    for (const option of row.options) {
      select.append(new Option(optionLine(option), option.id));
    }
    select.addEventListener("change", () => {
      const value = select.value;
      row.onChange(value === "" ? undefined : value === "none" ? null : (value as TrackId));
    });
    line.append(from, why, select);
    box.append(line);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "secondary small";
  all.textContent = "Take the first suggestion for all";
  all.addEventListener("click", () => {
    box.querySelectorAll("select").forEach((select) => {
      if (select.value === "" && select.options.length > 2) {
        select.selectedIndex = 2;
        select.dispatchEvent(new Event("change"));
      }
    });
  });
  if (rows.length > 1) {
    hint.after(all);
  }
  return box;
}
