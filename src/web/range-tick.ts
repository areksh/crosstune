/**
 * Shift-click range ticking for checkboxes (thin glue over src/ui/range-select.ts).
 *
 * Each box carries a key (`data-range-key`); the rows of one list share a root
 * element, which remembers the anchor. The click event (not `change`) has
 * shiftKey; a click on a label reaches the box as a synthetic click without
 * it, so the label's own click is noted too.
 */

import { rangeTick } from "../ui/range-select.js";

const anchors = new WeakMap<Element, string>();
let labelShift = { at: -1e9, shift: false };
let installed = false;

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement && target.type === "checkbox")) {
        labelShift = { at: event.timeStamp, shift: event.shiftKey };
      }
    },
    true,
  );
}

function shiftOf(event: MouseEvent): boolean {
  return event.shiftKey || (labelShift.shift && event.timeStamp - labelShift.at < 100);
}

/**
 * Make `box` tick a range with Shift. `set` records one row's new state in the
 * page's own model (the target's too); `done` runs once afterwards.
 */
export function wireRangeTick(
  box: HTMLInputElement,
  key: string,
  root: () => Element | null,
  set: (key: string, checked: boolean) => void,
  done: () => void,
): void {
  install();
  box.dataset["rangeKey"] = key;
  box.addEventListener("click", (event) => {
    const list = root();
    if (list === null) {
      set(key, box.checked);
      done();
      return;
    }
    const boxes = [...list.querySelectorAll<HTMLInputElement>("input[data-range-key]")].filter(
      (other) => !other.disabled && other.getClientRects().length > 0,
    );
    const result = rangeTick(
      boxes.map((other) => other.dataset["rangeKey"] ?? ""),
      anchors.get(list),
      key,
      shiftOf(event),
    );
    anchors.set(list, result.anchor);
    const wanted = new Set(result.ids);
    for (const other of boxes) {
      const otherKey = other.dataset["rangeKey"] ?? "";
      if (wanted.has(otherKey)) {
        other.checked = box.checked;
        set(otherKey, box.checked);
      }
    }
    done();
  });
}
