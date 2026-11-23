/**
 * A tool opened on a source ("#/p/<id>/repeats", "#/favourites/tidal/stats",
 * "#/new/artists"): today's tool view, shown under a context bar, its title
 * and source picker hidden (body.hosted), and filled in from the route.
 *
 * The tool views load their lists for the page's service once, and keep the
 * last source's results; so a tool on another service, or on another source
 * than last time, needs the page loaded afresh. Before that, any unsaved
 * preview in a tool is asked about, as the playlist editor asks about a draft.
 */

import { serviceOf } from "../services/ids.js";
import type { ServiceName } from "../services/names.js";
import { coverBackground, generatedCover, glowBackground } from "../ui/cover-art.js";
import { parseRoute, routeHash, viewOf, type Route } from "../ui/routes.js";
import { sourceToolFill, toolLabel, type Source } from "../ui/tools.js";
import { openDialog } from "./dialog.js";
import { el } from "./dom.js";
import { knownPlaylist, LIBRARY_LOADED } from "./library.js";
import { applyPrefill, storePrefill } from "./prefill.js";
import { chosenService, rememberService, workingService } from "./service.js";
import { currentTab } from "./shell.js";

/**
 * For each view, the address it was opened at as a hosted tool on this page
 * load. A fresh page has no results to clear, so it starts empty.
 */
const hostedHere = new Map<string, string>();

type Hosted = { source?: Source; service: ServiceName | undefined; back: string; name: string; title: string; part?: "export" | "import" };

/** What a route hosts, or undefined when it shows no tool. */
function hostedBy(route: Route): Hosted | undefined {
  switch (route.kind) {
    case "playlist": {
      if (route.tool === undefined) {
        return undefined;
      }
      const name = knownPlaylist(route.id)?.name ?? "Playlist";
      return {
        source: { kind: "playlist", id: route.id },
        service: serviceOf(route.id),
        back: routeHash({ kind: "playlist", id: route.id }),
        name,
        title: toolLabel(route.tool),
        ...(route.tool === "export" && { part: "export" as const }),
      };
    }
    case "favourites":
    case "all": {
      if (route.tool === undefined) {
        return undefined;
      }
      return {
        source: { kind: route.kind },
        service: route.service,
        back: routeHash({ kind: route.kind, service: route.service }),
        name: route.kind === "favourites" ? "Favourites" : "All playlists",
        title: toolLabel(route.tool, route.kind),
        ...(route.tool === "export" && { part: "export" as const }),
      };
    }
    case "new": {
      const tab = currentTab();
      return {
        service: tab === "all" ? workingService() : tab,
        back: "#/",
        name: "New playlist",
        title: toolLabel(route.tool),
        ...(route.tool === "import" && { part: "import" as const }),
      };
    }
    default:
      return undefined;
  }
}

/** The tools whose preview is up and not saved (by their titles). */
function unsavedPreviews(): string[] {
  const titles = new Set<string>();
  const pending = [
    ...document.querySelectorAll<HTMLElement>(".view .review:not([hidden])"),
    ...document.querySelectorAll<HTMLElement>("#ie-import-preview:not([hidden]), #pl-artists-bar:not([hidden])"),
  ].filter((node) => node.querySelector(".result:not([hidden])") === null);
  for (const node of pending) {
    const view = node.closest<HTMLElement>(".view");
    titles.add(view?.querySelector("h1")?.textContent?.trim() || "a tool");
  }
  return [...titles];
}

/**
 * Load the page afresh for this address, asking first about unsaved previews;
 * `before` runs just before. False when the user stays.
 */
async function reloadHere(before: () => void): Promise<boolean> {
  const unsaved = unsavedPreviews();
  if (unsaved.length > 0) {
    const leave = await openDialog({
      title: "Leave without saving?",
      body: [
        `Opening this loads the page afresh, which clears what you have not saved in ${unsaved.join(", ")}.`,
      ],
      confirm: "Leave and lose it",
      cancel: "Stay here",
      danger: true,
    });
    if (!leave) {
      return false;
    }
  }
  before();
  location.reload();
  return true;
}

/**
 * Prepare a route that hosts a tool. "reload" when the page is being loaded
 * afresh (or the user chose to stay, and is being taken back): show nothing.
 */
export function prepareHosting(route: Route): "reload" | "show" {
  const hosted = hostedBy(route);
  if (hosted === undefined) {
    return "show";
  }
  const view = viewOf(route);
  const target = hosted.service;
  const switchService = target !== undefined && target !== (chosenService() ?? workingService());
  const last = hostedHere.get(view);
  const freshSource = last !== undefined && last !== location.hash;
  if (switchService || freshSource) {
    void reloadHere(() => {
      if (switchService) {
        rememberService(target);
      }
    }).then((reloading) => {
      if (!reloading) {
        history.back();
      }
    });
    return "reload";
  }
  hostedHere.set(view, location.hash);
  return "show";
}

// The playlist's name is known once the library has been read (after a reload, later).
window.addEventListener(LIBRARY_LOADED, () => {
  const route = parseRoute(location.hash);
  if (route.kind === "playlist" && route.tool !== undefined) {
    paintContext(knownPlaylist(route.id)?.name ?? "Playlist");
  }
});

function paintContext(name: string): void {
  const cover = generatedCover(name);
  el("context-cover").style.background = coverBackground(cover);
  el("context-bar").style.background = glowBackground(cover);
  el("context-name").textContent = name;
}

/** Show the context bar and hide the tool's own title and source picker, for a hosted route. */
export function showHosting(route: Route): void {
  const hosted = hostedBy(route);
  const body = document.body;
  body.classList.toggle("hosted", hosted !== undefined);
  el("context-bar").hidden = hosted === undefined;
  if (hosted === undefined) {
    delete body.dataset["hostedPart"];
    return;
  }
  if (hosted.part === undefined) {
    delete body.dataset["hostedPart"];
  } else {
    body.dataset["hostedPart"] = hosted.part;
  }
  paintContext(hosted.name);
  el<HTMLAnchorElement>("context-back").href = hosted.back;
  el("context-title").textContent = hosted.title;
  if (hosted.source !== undefined && (route.kind === "playlist" || route.kind === "favourites" || route.kind === "all") && route.tool !== undefined) {
    const fill = sourceToolFill(route.tool, hosted.source);
    if (fill !== undefined) {
      storePrefill(fill);
      applyPrefill(fill.view);
    }
  }
}
