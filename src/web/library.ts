/**
 * The library sidebar: the playlists under the chosen tab, each linking to its
 * page, and the Library rows (Favourites and All playlists per service, New
 * releases). Rows navigate by hash, so the playlist editor's guard against
 * losing a draft stays in charge. DOM glue over src/ui/library.ts.
 */

import type { ManagerPlaylist } from "../features/playlist-manager.js";
import type { PlaylistId } from "../services/ids.js";
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { linkMark } from "../sync/wording.js";
import { coverBackground, generatedCover } from "../ui/cover-art.js";
import { libraryRows, sidebarRows, type LibraryRow, type SidebarRow } from "../ui/library.js";
import { routeHash, type Route } from "../ui/routes.js";
import { api } from "./api.js";
import { el } from "./dom.js";
import { currentTab, TAB_CHANGED } from "./shell.js";
import { knownLinks, LINKS_CHANGED } from "./views/links.js";

let connected: readonly ServiceName[] = [];
let playlists: ManagerPlaylist[] = [];
let loaded = false;
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
    const result = await api<{ playlists: ManagerPlaylist[] }>("GET", "/api/manager/playlists", undefined, on);
    if (mine === request) {
      playlists = result.playlists;
      loaded = true;
      render();
    }
  } catch (error) {
    if (mine === request) {
      el("lib-status").hidden = false;
      el("lib-status").textContent = `Could not read your playlists: ${(error as Error).message}`;
    }
  }
}

/** A playlist the sidebar knows, so its page can show its name at once. */
export function knownPlaylist(id: PlaylistId): ManagerPlaylist | undefined {
  return playlists.find((playlist) => playlist.id === id);
}

/** Highlight the row for what the page shows. */
export function markActive(route: Route): void {
  active = route;
  const here = routeHash(route);
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".sidebar .lib-row")) {
    const on = link.getAttribute("href") === here;
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
  if (connected.length === 0) {
    status.hidden = false;
    status.replaceChildren("No music service is connected yet. ", settingsLink());
  } else if (!loaded) {
    status.hidden = false;
    status.textContent = "Loading...";
  } else {
    status.hidden = rows.length > 0;
    status.textContent = playlists.length === 0 ? "You have no playlists yet." : "No playlist matches.";
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
  return item;
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
