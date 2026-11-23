/**
 * Where the page is, for the view modules: a view asks whether it is the one
 * shown, rather than comparing the hash with an address of its own (which
 * broke when addresses changed; see src/ui/routes.ts).
 */

import { parseRoute, viewOf, type Route } from "../ui/routes.js";

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

/** Whether `view` (as in `view-<name>`) is the section the page shows. */
export function isViewShown(view: string): boolean {
  return viewOf(currentRoute()) === view;
}

/**
 * Fired on `window` (detail: the view's name) once the page shows a view and
 * stays: not before a reload. Hand-overs meant for the next page apply here.
 */
export const VIEW_SHOWN = "crosstune:view-shown";
