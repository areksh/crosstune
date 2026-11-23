/**
 * Home: the library with no playlist open -- the playlists changed most
 * recently, as cards, above the last recorded change (views/history.ts).
 * What the home paste box did is now the ask box in the top bar (../ask.ts).
 */

import { serviceOf } from "../../services/ids.js";
import { SERVICE_LABELS } from "../../services/names.js";
import { coverBackground, generatedCover } from "../../ui/cover-art.js";
import { routeHash } from "../../ui/routes.js";
import { artworkInto } from "../artwork.js";
import { el } from "../dom.js";
import { libraryPlaylists, LIBRARY_LOADED } from "../library.js";
import { currentTab, TAB_CHANGED } from "../shell.js";
import { songCount } from "./playlist-actions.js";

/** How many playlists Home shows. */
const RECENT = 6;

/** Wire up the home view. Call once on load. */
export function initHomeView(): void {
  window.addEventListener(LIBRARY_LOADED, render);
  window.addEventListener(TAB_CHANGED, render);
  render();
}

function render(): void {
  const tab = currentTab();
  const recent = [...libraryPlaylists()]
    // As the sidebar: the chosen service's, or all of them.
    .filter((playlist) => tab === "all" || serviceOf(playlist.id) === tab)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, RECENT);
  const box = el("home-recent");
  box.replaceChildren(...recent.map(card));
  box.hidden = recent.length === 0;
  el("view-home").querySelector(".home-sub")?.toggleAttribute("hidden", recent.length === 0);
}

function card(playlist: ReturnType<typeof libraryPlaylists>[number]): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "home-card";
  link.href = routeHash({ kind: "playlist", id: playlist.id });
  const cover = document.createElement("span");
  cover.className = "home-card-cover gen-cover";
  cover.setAttribute("aria-hidden", "true");
  cover.style.background = coverBackground(generatedCover(playlist.name));
  artworkInto(cover, playlist.image);
  const name = document.createElement("span");
  name.className = "home-card-name";
  name.textContent = playlist.name;
  const meta = document.createElement("span");
  meta.className = "home-card-meta";
  meta.textContent = [SERVICE_LABELS[serviceOf(playlist.id)], playlist.trackCount === undefined ? undefined : songCount(playlist.trackCount)]
    .filter((part) => part !== undefined)
    .join(" · ");
  link.append(cover, name, meta);
  return link;
}
