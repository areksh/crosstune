/**
 * The review's plan settings, shared by the playlist builders: the order the
 * playlist plays in, fitting it to a length, the "Plays as ..." preview and
 * the count and length in the commit bar.
 *
 * Everything here works on the ticked track rows of a review, one group per
 * artist (or album) in list order; the ordering and fitting themselves are the
 * tested pure functions of src/features/playlist-shape.ts, so the review writes
 * what the CLI would. A track listed more than once (an artist shared between
 * branches) counts once, at its first place.
 */

import { seededRandom } from "../features/combine.js";
import {
  fitToLength,
  formatDuration,
  orderGroups,
  playsAs,
  totalSeconds,
  type AlbumOrder,
  type PlaylistOrder,
} from "../features/playlist-shape.js";
import { el } from "./dom.js";

/** One ticked track, as read off its row's checkbox. */
interface Pick {
  id: number;
  title: string;
  duration?: number;
}

export interface PlanControlsOptions {
  /** Prefix of the controls' ids: `<prefix>-order` (radio name), `-fit`, `-plays-as`. */
  prefix: string;
  /** The id of the commit bar's count line. */
  countId: string;
  /** Every track checkbox of the review, grouped per artist or album, in list order. */
  groups: () => HTMLInputElement[][];
  /** `fair` trims every group's end in turn; `tail` trims the end of the list. */
  fit: "fair" | "tail";
  /** Called after the count changes (e.g. to enable the commit button). */
  onUpdate?: () => void;
}

export class PlanControls {
  readonly #options: PlanControlsOptions;
  #seed = newSeed();

  constructor(options: PlanControlsOptions) {
    this.#options = options;
    for (const radio of document.querySelectorAll<HTMLInputElement>(
      `input[name="${options.prefix}-order"]`,
    )) {
      radio.addEventListener("change", () => {
        this.#seed = newSeed();
        this.refresh();
      });
    }
    el(`${options.prefix}-fit`).addEventListener("change", () => {
      this.applyFit();
      this.refresh();
    });
  }

  /** A new review: a fresh shuffle, the length fitted, the summary shown. */
  reset(): void {
    this.#seed = newSeed();
    this.applyFit();
    this.refresh();
  }

  /** Update the count, the length and the "Plays as" line from the ticks. */
  refresh(): void {
    // A row the fit left out but the user ticked again is simply ticked.
    for (const box of this.#options.groups().flat()) {
      const row = box.closest(".track");
      if (box.checked && row?.classList.contains("fit-dropped") === true) {
        row.classList.remove("fit-dropped");
        row.querySelector(".fit-reason")?.remove();
      }
    }
    const picks = this.#picks().flat();
    const seconds = totalSeconds(picks, (pick) => pick.duration);
    const count = picks.length;
    el(this.#options.countId).textContent =
      `${count} track${count === 1 ? "" : "s"}, ${formatDuration(seconds)}`;
    el(`${this.#options.prefix}-plays-as`).textContent = playsAs(
      this.#ordered().map((pick) => pick.title),
    );
    this.#options.onUpdate?.();
  }

  /** The ticked track ids in the chosen play order. */
  orderedTrackIds(): number[] {
    return this.#ordered().map((pick) => pick.id);
  }

  /** How many tracks are ticked (each once). */
  count(): number {
    return this.#picks().flat().length;
  }

  /**
   * Re-tick the rows the last fit left out, then untick (and label) the rows
   * that do not fit the chosen length. Rows the user unticked stay unticked.
   */
  applyFit(): void {
    const groups = this.#options.groups();
    for (const box of groups.flat()) {
      const row = box.closest(".track");
      if (row?.classList.contains("fit-dropped") === true) {
        box.checked = true;
        row.classList.remove("fit-dropped");
        row.querySelector(".fit-reason")?.remove();
      }
    }
    const minutes = Number(el<HTMLSelectElement>(`${this.#options.prefix}-fit`).value);
    if (!(minutes > 0)) {
      return;
    }
    const picks = this.#picks();
    const { dropped } = fitToLength(
      this.#options.fit === "tail" ? [picks.flat()] : picks,
      minutes * 60,
      (pick) => pick.duration,
    );
    const droppedIds = new Set(dropped.map((pick) => pick.id));
    for (const box of groups.flat()) {
      if (!droppedIds.has(Number(box.dataset["trackId"]))) {
        continue;
      }
      box.checked = false;
      const row = box.closest(".track");
      if (row !== null && !row.classList.contains("fit-dropped")) {
        row.classList.add("fit-dropped");
        const reason = document.createElement("span");
        reason.className = "reason fit-reason";
        reason.textContent = `Left out to fit about ${minutes} min`;
        row.appendChild(reason);
      }
    }
  }

  /** The ticked tracks per group, each track once (at its first place). */
  #picks(): Pick[][] {
    const seen = new Set<number>();
    return this.#options.groups().map((group) =>
      group.flatMap((box): Pick[] => {
        const id = Number(box.dataset["trackId"]);
        if (!box.checked || seen.has(id)) {
          return [];
        }
        seen.add(id);
        const duration = Number(box.dataset["duration"]);
        return [
          {
            id,
            title: box.dataset["title"] ?? "",
            ...(duration > 0 && { duration }),
          },
        ];
      }),
    );
  }

  #ordered(): Pick[] {
    const checked = document.querySelector<HTMLInputElement>(
      `input[name="${this.#options.prefix}-order"]:checked`,
    );
    const order = (checked?.value ?? "by-artist") as PlaylistOrder | AlbumOrder;
    return orderGroups(this.#picks(), order, seededRandom(this.#seed));
  }
}

function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
