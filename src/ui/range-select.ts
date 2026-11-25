/**
 * Shift-click range ticking for a list of checkboxes, as in a file manager or
 * Gmail. Pure: the page passes the ids of the rows it shows, in order, and
 * applies what comes back (src/web/range-tick.ts).
 *
 * - The anchor is the last row clicked without Shift.
 * - Shift+click sets every shown row from the anchor to the target, inclusive,
 *   to the target's new state; the anchor stays where it was.
 * - Only the rows shown count; if the anchor is not among them, the click is
 *   a plain one.
 */

export interface RangeTick {
  /** The rows to set to the clicked state (the target alone for a plain click). */
  ids: string[];
  /** The anchor to keep for the next click. */
  anchor: string;
}

export function rangeTick(visible: readonly string[], anchor: string | undefined, target: string, shift: boolean): RangeTick {
  const to = visible.indexOf(target);
  const from = anchor === undefined ? -1 : visible.indexOf(anchor);
  if (!shift || anchor === undefined || from < 0 || to < 0) {
    return { ids: [target], anchor: target };
  }
  const [low, high] = from <= to ? [from, to] : [to, from];
  return { ids: visible.slice(low, high + 1), anchor };
}
