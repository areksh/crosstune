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
import { storePrefill, type Prefill } from "./prefill.js";
import { chosenService, connectedServices, rememberService } from "./service.js";

/**
 * Open a tool view filled in for a source on `service`. The tool views load
 * their lists for the page's service once, so when it differs the page loads
 * afresh on `service`, the fill kept in sessionStorage across the reload.
 */
export function openTool(prefill: Prefill, service: ServiceName): void {
  storePrefill(prefill);
  const now = chosenService() ?? connectedServices()[0];
  if (now !== service) {
    rememberService(service);
    // Not `location.hash =`: its hashchange would run this page's router,
    // which applies (and so uses up) the fill before the reload.
    history.pushState(null, "", `#/${prefill.view}`);
    location.reload();
    return;
  }
  location.hash = `#/${prefill.view}`;
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
    if (where.kind === "favourites") {
      showFavourites(where.service);
    }
  };
  window.addEventListener("hashchange", show);
  show();
}

function showFavourites(service: ServiceName): void {
  paintHero("fav", `Favourites ${service}`, `${SERVICE_LABELS[service]} favourites`);
  el("fav-actions").replaceChildren(
    actionButton("Find repeats", () =>
      openTool({ view: "deduplicate", radios: { "dedup-source": "favourites" } }, service),
    ),
    actionButton("Upgrade", () => openTool({ view: "upgrade", fields: { "upgrade-source": "favourites" } }, service)),
    actionButton("Stats", () => openTool({ view: "stats", fields: { "stats-source": "favourites" } }, service)),
    actionButton("Export", () => openTool({ view: "import-export", radios: { "ie-source": "favourite-tracks" } }, service)),
  );
}

/** The header and action row over a service's list of playlists ("#/all/<service>"). */
export function showAllActions(service: ServiceName): void {
  paintHero("all", `All playlists ${service}`, SERVICE_LABELS[service]);
  el("all-actions").replaceChildren(
    actionButton("Find repeats across them", () =>
      openTool({ view: "deduplicate", radios: { "dedup-source": "all-playlists" } }, service),
    ),
    actionButton("Upgrade all", () => openTool({ view: "upgrade", fields: { "upgrade-source": "all-playlists" } }, service)),
    actionButton("Stats", () => openTool({ view: "stats", fields: { "stats-source": "everything" } }, service)),
    actionButton("Export all", () => openTool({ view: "import-export", radios: { "ie-source": "all-playlists" } }, service)),
  );
}
