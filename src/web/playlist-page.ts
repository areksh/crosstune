/**
 * The pages for one thing in the library: a playlist's header (over the
 * editor), a service's Favourites, and All playlists. Each has an action row
 * that opens today's tool views filled in for that source, on its service
 * (the tools move inside these pages in the redesign's step 2).
 */

import { serviceOf, type PlaylistId } from "../services/ids.js";
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { coverBackground, generatedCover, glowBackground } from "../ui/cover-art.js";
import { parseRoute } from "../ui/routes.js";
import { el } from "./dom.js";
import { routeHash } from "../ui/routes.js";
import { toolLabel, toolsFor } from "../ui/tools.js";

/** A link in an action row (to a tool on this page's source). */
export function actionLink(text: string, href: string): HTMLAnchorElement {
  const node = document.createElement("a");
  node.className = "action";
  node.href = href;
  node.textContent = text;
  return node;
}

/** A button in an action row. */
export function actionButton(text: string, act: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "secondary small";
  node.textContent = text;
  node.addEventListener("click", act);
  return node;
}

/** Paint a page's header: the cover drawn from its name, its glow, and the eyebrow. */
function paintHero(prefix: string, name: string, eyebrow: string): void {
  const cover = generatedCover(name);
  el(`${prefix}-cover`).style.background = coverBackground(cover);
  el(`${prefix}-hero`).style.background = glowBackground(cover);
  el(`${prefix}-eyebrow`).textContent = eyebrow;
}

/** The playlist page's header; `linkedWith` names the services of its other copies. */
export function renderPlaylistHeader(playlist: { id: PlaylistId; name: string }, linkedWith?: string): void {
  const kind = `${SERVICE_LABELS[serviceOf(playlist.id)]} playlist`;
  paintHero("pl", playlist.name, linkedWith === undefined ? kind : `${kind} · ⇄ ${linkedWith}`);
}

/** Wire up the Favourites page. Call once on load. */
export function initFavouritesView(): void {
  const show = (): void => {
    const where = parseRoute(location.hash);
    if (where.kind === "favourites" && where.tool === undefined) {
      showFavourites(where.service);
    }
  };
  window.addEventListener("hashchange", show);
  show();
}

/** Links to the tools a collection offers ("#/favourites/<service>/<tool>"). */
function collectionActions(kind: "favourites" | "all", service: ServiceName): HTMLAnchorElement[] {
  return toolsFor(kind).map((tool) => actionLink(toolLabel(tool, kind), routeHash({ kind, service, tool })));
}

function showFavourites(service: ServiceName): void {
  paintHero("fav", `Favourites ${service}`, `${SERVICE_LABELS[service]} favourites`);
  el("fav-actions").replaceChildren(...collectionActions("favourites", service));
}

/** The header and action row over a service's list of playlists ("#/all/<service>"). */
export function showAllActions(service: ServiceName): void {
  paintHero("all", `All playlists ${service}`, SERVICE_LABELS[service]);
  el("all-actions").replaceChildren(...collectionActions("all", service));
}
