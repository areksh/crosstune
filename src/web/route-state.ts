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
