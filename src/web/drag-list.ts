/**
 * Dragging rows of a long list to a new place, by a handle on each row.
 *
 * Built on pointer events rather than native drag and drop, so it works by
 * touch, scrolls the page near its edges, and lets a selection be dragged as
 * one. The list is only reordered by the caller, on drop.
 */

export interface DragListOptions {
  list: HTMLElement;
  /** The rows' selector, and the handle's within a row. */
  row: string;
  handle: string;
  /** Whether a drag may start now. */
  enabled(): boolean;
  /** The rows to drag when dragging starts on `row` (itself, or the selection). */
  rowsToDrag(row: HTMLElement): readonly HTMLElement[];
  /** Dropped in front of the row at `index` (the count of rows: at the end). */
  onDrop(rows: readonly HTMLElement[], index: number): void;
}

/** Pixels the pointer must move before a press becomes a drag. */
const THRESHOLD = 4;
/** How close to the window's edge the page scrolls, and how fast at most. */
const EDGE_TOP = 90;
const EDGE_BOTTOM = 190;
const MAX_SPEED = 26;

export function enableDrag(options: DragListOptions): void {
  const { list } = options;
  list.addEventListener("pointerdown", (event) => {
    const handle = (event.target as Element).closest<HTMLElement>(options.handle);
    const row = handle?.closest<HTMLElement>(options.row);
    if (event.button !== 0 || handle == null || row == null || !options.enabled()) {
      return;
    }
    event.preventDefault();
    startDrag(options, handle, row, event);
  });
}

function startDrag(options: DragListOptions, handle: HTMLElement, row: HTMLElement, down: PointerEvent): void {
  const { list } = options;
  let dragging = false;
  let rows: readonly HTMLElement[] = [];
  let all: HTMLElement[] = [];
  let index = -1;
  let x = down.clientX;
  let y = down.clientY;
  let frame = 0;
  let ghost: HTMLElement | undefined;
  const marker = document.createElement("div");
  marker.className = "drag-marker";
  marker.setAttribute("aria-hidden", "true");
  handle.setPointerCapture(down.pointerId);

  const begin = (): void => {
    dragging = true;
    rows = options.rowsToDrag(row);
    all = [...list.querySelectorAll<HTMLElement>(options.row)];
    rows.forEach((item) => item.classList.add("dragging"));
    document.body.classList.add("is-dragging");
    ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = rows.length === 1 ? (row.dataset["label"] ?? "1 song") : `${rows.length} songs`;
    document.body.append(ghost, marker);
    frame = requestAnimationFrame(tick);
  };

  /** Where a drop would go, and the line showing it. */
  const locate = (): void => {
    const bounds = list.getBoundingClientRect();
    const first = all[0];
    if (first === undefined) {
      return;
    }
    const probeX = bounds.left + bounds.width / 2;
    const over = document
      .elementsFromPoint(probeX, Math.min(Math.max(y, 0), window.innerHeight - 1))
      .map((node) => node.closest<HTMLElement>(options.row))
      .find((node) => node !== null && list.contains(node));
    if (over != null) {
      const box = over.getBoundingClientRect();
      index = all.indexOf(over) + (y > box.top + box.height / 2 ? 1 : 0);
    } else if (y <= bounds.top) {
      index = 0;
    } else if (y >= bounds.bottom) {
      index = all.length;
    }
    if (index >= 0) {
      const at = index < all.length ? all[index]!.getBoundingClientRect().top : all[all.length - 1]!.getBoundingClientRect().bottom;
      marker.style.transform = `translate(${bounds.left}px, ${at - 1}px)`;
      marker.style.width = `${bounds.width}px`;
    }
  };

  const tick = (): void => {
    const fromBottom = window.innerHeight - y;
    const speed =
      y < EDGE_TOP
        ? -MAX_SPEED * Math.min(1, (EDGE_TOP - y) / EDGE_TOP)
        : fromBottom < EDGE_BOTTOM
          ? MAX_SPEED * Math.min(1, (EDGE_BOTTOM - fromBottom) / EDGE_BOTTOM)
          : 0;
    if (speed !== 0) {
      window.scrollBy(0, speed);
    }
    locate();
    ghost!.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    frame = requestAnimationFrame(tick);
  };

  const end = (drop: boolean): void => {
    cancelAnimationFrame(frame);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    handle.removeEventListener("lostpointercapture", onCancel);
    window.removeEventListener("keydown", onKey, true);
    marker.remove();
    ghost?.remove();
    document.body.classList.remove("is-dragging");
    rows.forEach((item) => item.classList.remove("dragging"));
    if (drop && dragging && index >= 0) {
      options.onDrop(rows, index);
    }
  };

  const onMove = (event: PointerEvent): void => {
    x = event.clientX;
    y = event.clientY;
    if (!dragging && Math.hypot(x - down.clientX, y - down.clientY) >= THRESHOLD) {
      begin();
    }
  };
  const onUp = (): void => {
    if (dragging) {
      locate();
    }
    end(true);
  };
  const onCancel = (): void => end(false);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      end(false);
    }
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  // E.g. the row left the list; after a drop this comes too late to matter.
  handle.addEventListener("lostpointercapture", onCancel);
  window.addEventListener("keydown", onKey, true);
}
