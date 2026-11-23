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
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { coverBackground, generatedCover, glowBackground } from "../ui/cover-art.js";
import { parseRoute, routeHash, viewOf, type Route } from "../ui/routes.js";
import { hostingDecision } from "../ui/hosting-decision.js";
import { sourceToolFill, toolLabel, type Fill, type Source } from "../ui/tools.js";
import { openDialog } from "./dialog.js";
import { el } from "./dom.js";
import { knownPlaylist, LIBRARY_LOADED } from "./library.js";
import { applyPrefill, storePrefill } from "./prefill.js";
import { chosenService, connectedServices, rememberService } from "./service.js";
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
        // Under "All", the page's own choice stands (Combine can work on all of them).
        service: tab === "all" ? undefined : tab,
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
 * Load the page afresh, asking first about unsaved previews; `before` runs
 * just before the reload (and may stop it by returning false), `stay` when
 * the user chooses to stay. Every reload the frame makes goes through here.
 */
export async function reloadHere(before: () => boolean | void, stay: () => void = () => {}): Promise<void> {
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
      stay();
      return;
    }
  }
  if (before() === false) {
    return;
  }
  location.reload();
}

/** Why the hosted tool cannot be shown (a service not connected...), or undefined. */
let problem: string | undefined;
/** Whether the route's source is to be put in the tool when it is shown. */
let fillOnShow = false;

/**
 * Prepare a route that hosts a tool. "reload" when the page is being loaded
 * afresh (or the user chose to stay): show nothing now. `stay` undoes what led
 * here when the user stays (going back, by default).
 */
export function prepareHosting(route: Route, stay: () => void = () => history.back()): "reload" | "show" {
  problem = undefined;
  fillOnShow = false;
  const hosted = hostedBy(route);
  if (hosted === undefined) {
    return "show";
  }
  const view = viewOf(route);
  const decision = hostingDecision({
    ...(hosted.service !== undefined && { target: hosted.service }),
    ...(chosenService() !== undefined && { remembered: chosenService() }),
    connected: connectedServices(),
    ...(hostedHere.has(view) && { lastHere: hostedHere.get(view) }),
    hash: location.hash,
  });
  switch (decision.kind) {
    case "not-connected":
      problem = `${SERVICE_LABELS[decision.service]} is not connected, so this cannot open here.`;
      return "show";
    case "switch":
      void reloadHere(() => {
        rememberService(decision.to);
        if (chosenService() !== decision.to) {
          // This browser keeps no settings: switching could never stick.
          problem = `This browser does not let crosstune remember a music service, so it cannot switch to ${SERVICE_LABELS[decision.to]} here.`;
          showHosting(route);
          return false;
        }
        return true;
      }, stay);
      return "reload";
    case "fresh":
      void reloadHere(() => {}, stay);
      return "reload";
    case "show":
      hostedHere.set(view, location.hash);
      fillOnShow = decision.fill;
      return "show";
  }
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
  const section = document.getElementById(`view-${viewOf(route)}`);
  el("context-problem").hidden = problem === undefined;
  el("context-problem").textContent = problem ?? "";
  body.classList.remove("hosted-unconfirmed");
  if (section !== null) {
    // A tool that cannot open here is not offered at all.
    section.hidden = problem !== undefined;
  }
  if (problem !== undefined) {
    return;
  }
  el("context-title").textContent = hosted.title;
  if (
    fillOnShow &&
    hosted.source !== undefined &&
    (route.kind === "playlist" || route.kind === "favourites" || route.kind === "all") &&
    route.tool !== undefined
  ) {
    const fill = sourceToolFill(route.tool, hosted.source);
    if (fill !== undefined && section !== null) {
      storePrefill(fill);
      applyPrefill(fill.view);
      void confirmFill(fill, section, hosted.name);
    }
  }
}

/** How long a playlist picker may take to offer the route's playlist. */
const CONFIRM_MS = 20_000;

/**
 * The tool's source picker is hidden, so it must really hold the route's
 * source before the tool can be used: the tool stays inert until each filled
 * picker shows it. If one never does (not one of the user's playlists here),
 * the picker is shown again with a word on why, rather than letting the tool
 * act on whatever it fell back to.
 */
async function confirmFill(fill: Fill, section: HTMLElement, name: string): Promise<void> {
  const selects = Object.entries(fill.fields ?? {}).flatMap(([id, value]) => {
    const node = document.getElementById(id);
    return node instanceof HTMLSelectElement ? [{ node, value }] : [];
  });
  if (selects.length === 0) {
    return;
  }
  const hash = location.hash;
  section.inert = true;
  section.classList.add("hosting-pending");
  const started = Date.now();
  while (selects.some(({ node, value }) => node.value !== value) && Date.now() - started < CONFIRM_MS) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (location.hash !== hash) {
      break;
    }
  }
  section.inert = false;
  section.classList.remove("hosting-pending");
  if (location.hash !== hash) {
    return;
  }
  if (selects.some(({ node, value }) => node.value !== value)) {
    document.body.classList.add("hosted-unconfirmed");
    el("context-problem").hidden = false;
    el("context-problem").textContent = `"${name}" is not among the playlists this tool can work on here. Choose what it should work on below.`;
  }
}
