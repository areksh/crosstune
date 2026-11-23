/**
 * The library sidebar: the playlists under the chosen tab, each linking to its
 * page, and the Library rows (Favourites and All playlists per service, New
 * releases). Rows navigate by hash, so the playlist editor's guard against
 * losing a draft stays in charge. DOM glue over src/ui/library.ts.
 */

import type { ManagerPlaylist } from "../features/playlist-manager.js";
import { serviceOf, type PlaylistId } from "../services/ids.js";
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { linkMark } from "../sync/wording.js";
import { coverBackground, generatedCover } from "../ui/cover-art.js";
import { groupActions, libraryRows, sidebarRows, type LibraryRow, type SidebarRow } from "../ui/library.js";
import { parseRoute, routeHash, type Route } from "../ui/routes.js";
import { api } from "./api.js";
import { artworkInto } from "./artwork.js";
import { el } from "./dom.js";
import { currentTab, TAB_CHANGED } from "./shell.js";
import { openDialog } from "./dialog.js";
import { rememberService, rememberTab } from "./service.js";
import { reloadHere } from "./hosting.js";
import { useSources } from "./views/combine.js";
import { startRemoveArtists } from "./views/playlists.js";
import { knownLinks, LINKS_CHANGED } from "./views/links.js";

/** Fired on `window` each time the playlists have been read. */
export const LIBRARY_LOADED = "crosstune:library-loaded";

let connected: readonly ServiceName[] = [];
let playlists: ManagerPlaylist[] = [];
let loaded = false;
/** Why the playlists could not be read, kept until they are. */
let failure: string | undefined;
/** Services that could not be read on the last reading. */
let unavailable: { service: ServiceName; error: string }[] = [];
let active: Route = { kind: "home" };
let request = 0;

/** Wire up the sidebar for the connected services, and read the playlists. */
export function initLibrary(services: readonly ServiceName[]): void {
  connected = services;
  el("lib-filter").addEventListener("input", render);
  window.addEventListener(TAB_CHANGED, render);
  window.addEventListener(LINKS_CHANGED, render);
  void refreshLibrary();
}

/** Read the playlists again (after a save, a delete, a new playlist). */
export async function refreshLibrary(): Promise<void> {
  if (connected.length === 0) {
    render();
    return;
  }
  const mine = ++request;
  try {
    const on = connected.length > 1 ? "all" : connected[0];
    const result = await api<{ playlists: ManagerPlaylist[]; unavailable?: { service: ServiceName; error: string }[] }>(
      "GET",
      "/api/manager/playlists",
      undefined,
      on,
    );
    if (mine === request) {
      playlists = result.playlists;
      unavailable = result.unavailable ?? [];
      loaded = true;
      failure = undefined;
      render();
      window.dispatchEvent(new Event(LIBRARY_LOADED));
    }
  } catch (error) {
    if (mine === request) {
      failure = `Could not read your playlists: ${(error as Error).message}`;
      render();
    }
  }
}

/** The playlists the sidebar knows (from every connected service). */
export function libraryPlaylists(): readonly ManagerPlaylist[] {
  return playlists;
}

/** A playlist the sidebar knows, so its page can show its name at once. */
export function knownPlaylist(id: PlaylistId): ManagerPlaylist | undefined {
  return playlists.find((playlist) => playlist.id === id);
}

/** Highlight the row for what the page shows. */
export function markActive(route: Route): void {
  active = route;
  const here = routeHash(route);
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".sidebar .lib-row, .topbar .top-link")) {
    // A playlist's row stays lit while one of its tools is open ("#/p/<id>/repeats").
    const href = link.getAttribute("href") ?? "";
    const on = here === href || here.startsWith(`${href}/`);
    link.classList.toggle("active", on);
    if (on) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function render(): void {
  const status = el("lib-status");
  const linked = new Set<PlaylistId>(
    (knownLinks()?.links ?? []).flatMap(({ link }) => Object.values(link.copies) as PlaylistId[]),
  );
  const rows = sidebarRows(playlists, {
    tab: currentTab(),
    filter: el<HTMLInputElement>("lib-filter").value,
    linked,
  });
  el("lib-playlists").replaceChildren(...rows.map(playlistRow));
  el("lib-library").replaceChildren(...libraryRows(connected, currentTab()).map(libraryRow));
  renderGroup();
  if (connected.length === 0) {
    status.hidden = false;
    status.replaceChildren("No music service is connected yet. ", settingsLink());
  } else if (failure !== undefined) {
    status.hidden = false;
    status.textContent = failure;
  } else if (!loaded) {
    status.hidden = false;
    status.textContent = "Loading...";
  } else {
    const missing = unavailable.map(({ service }) => `${SERVICE_LABELS[service]} could not be read just now.`).join(" ");
    const empty = rows.length > 0 ? "" : playlists.length === 0 ? "You have no playlists yet." : "No playlist matches.";
    status.textContent = [missing, empty].filter((part) => part !== "").join(" ");
    status.hidden = status.textContent === "";
  }
  markActive(active);
}

function settingsLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = "#/settings";
  link.textContent = "Open Settings";
  return link;
}

function dot(service: ServiceName): HTMLElement {
  const node = document.createElement("span");
  node.className = "svc-dot";
  node.dataset["service"] = service;
  node.title = SERVICE_LABELS[service];
  return node;
}

function row(href: string, label: string, ...lead: Node[]): { item: HTMLLIElement; link: HTMLAnchorElement } {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.className = "lib-row";
  link.href = href;
  const name = document.createElement("span");
  name.className = "lib-name";
  name.textContent = label;
  link.append(...lead, name);
  item.append(link);
  return { item, link };
}

function playlistRow(playlist: SidebarRow): HTMLLIElement {
  const cover = document.createElement("span");
  cover.className = "lib-cover gen-cover";
  cover.setAttribute("aria-hidden", "true");
  cover.style.background = coverBackground(generatedCover(playlist.name));
  artworkInto(cover, playlist.image);
  const { item, link } = row(routeHash({ kind: "playlist", id: playlist.id }), playlist.name, cover, dot(playlist.service));
  if (playlist.linked) {
    const mark = document.createElement("span");
    mark.className = "lib-linked";
    mark.textContent = "⇄";
    const words = linkMark(playlist.id, knownLinks()?.links ?? []);
    mark.title = words?.text ?? "Linked";
    mark.classList.toggle("conflict", words?.conflict === true);
    link.append(mark);
  }
  if (playlist.trackCount !== undefined) {
    const count = document.createElement("span");
    count.className = "lib-count";
    count.textContent = playlist.trackCount.toLocaleString();
    link.append(count);
  }
  // A tick beside the row (not in its link), to act on several at once.
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "lib-tick";
  box.checked = ticked.has(playlist.id);
  box.setAttribute("aria-label", `Tick ${playlist.name}`);
  box.addEventListener("change", () => {
    if (box.checked) {
      ticked.add(playlist.id);
    } else {
      ticked.delete(playlist.id);
    }
    renderGroup();
  });
  item.classList.add("lib-item");
  item.prepend(box);
  return item;
}

// ---- Ticked playlists ---------------------------------------------------------

const ticked = new Set<PlaylistId>();

function tickedPlaylists(): ManagerPlaylist[] {
  return playlists.filter((playlist) => ticked.has(playlist.id));
}

function renderGroup(): void {
  // Playlists gone since (deleted, or a service signed out) drop out.
  const known = new Set(playlists.map((playlist) => playlist.id));
  [...ticked].filter((id) => !known.has(id)).forEach((id) => ticked.delete(id));
  const chosen = tickedPlaylists();
  el("lib-group").hidden = chosen.length === 0;
  document.querySelector(".sidebar")?.classList.toggle("ticking", chosen.length > 0);
  el("lib-group-count").textContent = `${chosen.length} ticked`;
  const actions = groupActions(chosen);
  const buttons: HTMLButtonElement[] = [];
  if (actions.combine) {
    buttons.push(groupButton("Combine", () => combineTicked(chosen)));
  }
  const removeFrom = actions.removeArtists;
  if (removeFrom !== undefined) {
    buttons.push(
      groupButton("Remove artists", () => {
        const target = routeHash({ kind: "all", service: removeFrom });
        startRemoveArtists(
          chosen.map((playlist) => playlist.id),
          target,
        );
        location.hash = target;
      }),
    );
  }
  if (actions.delete) {
    buttons.push(groupButton("Delete...", () => void deleteTicked(chosen), "secondary small danger-text"));
  }
  buttons.push(
    groupButton("Clear", () => {
      ticked.clear();
      render();
    }),
  );
  el("lib-group-actions").replaceChildren(...buttons);
}

function groupButton(text: string, act: () => void, className = "secondary small"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", act);
  return button;
}

/**
 * Combine the ticked playlists: on their service, or on all of them when they
 * span several. Always one fresh page (asking first about unsaved previews):
 * the tab, the page's service and the address are set just before it, and
 * Combine applies the hand-over only on the page that stays.
 */
function combineTicked(chosen: readonly ManagerPlaylist[]): void {
  const services = new Set(chosen.map((playlist) => serviceOf(playlist.id)));
  const [only] = services;
  const on = services.size === 1 && only !== undefined ? only : "all";
  void reloadHere(() => {
    useSources(chosen.map((playlist) => playlist.id));
    rememberTab(on);
    rememberService(on);
    history.pushState(null, "", routeHash({ kind: "new", tool: "combine" }));
  });
}

async function deleteTicked(chosen: readonly ManagerPlaylist[]): Promise<void> {
  const list = document.createElement("ul");
  for (const playlist of chosen) {
    const item = document.createElement("li");
    item.textContent = `${playlist.name} (${SERVICE_LABELS[serviceOf(playlist.id)]})`;
    list.append(item);
  }
  const ok = await openDialog({
    title: `Delete ${chosen.length} playlist${chosen.length === 1 ? "" : "s"}?`,
    body: [list, "Each can be made again from History, with the songs it had, except any the service no longer plays."],
    confirm: "Delete",
    danger: true,
  });
  if (!ok) {
    return;
  }
  const failed: string[] = [];
  for (const playlist of chosen) {
    try {
      await api("POST", "/api/manager/delete", { playlistId: playlist.id }, serviceOf(playlist.id));
      ticked.delete(playlist.id);
    } catch (error) {
      failed.push(`${playlist.name}: ${(error as Error).message}`);
    }
  }
  await refreshLibrary();
  // The page showed one of them (its page, or a tool on it): go to its service's list.
  const here = parseRoute(location.hash);
  const gone = here.kind === "playlist" ? chosen.find((playlist) => playlist.id === here.id && !ticked.has(playlist.id)) : undefined;
  if (gone !== undefined) {
    location.hash = routeHash({ kind: "all", service: serviceOf(gone.id) });
  }
  if (failed.length > 0) {
    await openDialog({ title: "Some were not deleted", body: failed, confirm: "Close", cancel: null });
  }
}

function libraryRow(entry: LibraryRow): HTMLLIElement {
  switch (entry.kind) {
    case "favourites":
      return row(routeHash(entry), "Favourites", dot(entry.service), glyph("♥")).item;
    case "all":
      return row(routeHash(entry), "All playlists", dot(entry.service), glyph("▤")).item;
    case "new-releases":
      return row(routeHash({ kind: "view", view: "new-releases" }), "New releases", glyph("✦")).item;
  }
}

function glyph(text: string): HTMLElement {
  const node = document.createElement("span");
  node.className = "lib-glyph";
  node.setAttribute("aria-hidden", "true");
  node.textContent = text;
  return node;
}
