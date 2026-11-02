/**
 * App shell: sidebar navigation, hash-based view routing, and session display.
 *
 * Each tool is a section in the page; the sidebar switches between them (and the
 * home view) by URL hash, so views are linkable and the back button works. Each
 * view module wires its own controls once on load. This is DOM glue; the logic
 * it drives lives in the tested server modules.
 */

import { api } from "./api.js";
import { initArtworkToggle } from "./artwork.js";
import { el } from "./dom.js";
import { applyPrefill } from "./prefill.js";
import { initAlbumsView } from "./views/albums.js";
import { initCombineView } from "./views/combine.js";
import { initDeduplicateView } from "./views/deduplicate.js";
import { initHistoryView, initLastChange } from "./views/history.js";
import { initHomeView } from "./views/home.js";
import { initImportExportView } from "./views/import-export.js";
import { initManagedView } from "./views/managed.js";
import { initNewReleasesView } from "./views/new-releases.js";
import { initPlaylistView } from "./views/playlist.js";
import { initSimilarView } from "./views/similar.js";
import { initStatsView } from "./views/stats.js";
import { initWordPlayView } from "./views/word-play.js";
import { initUpgradeView } from "./views/upgrade.js";

const VIEWS = [
  "home",
  "playlist",
  "albums",
  "similar",
  "word-play",
  "deduplicate",
  "combine",
  "upgrade",
  "stats",
  "new-releases",
  "managed",
  "import-export",
  "history",
] as const;
type View = (typeof VIEWS)[number];

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

/** The view named by the current URL hash, defaulting to home. */
function currentView(): View {
  const name = location.hash.replace(/^#\/?/, "");
  return isView(name) ? name : "home";
}

function route(): void {
  const active = currentView();
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== active;
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
    link.classList.toggle("active", link.dataset["view"] === active);
  }
  // Fill in what the home paste box handed over, if it was for this view.
  applyPrefill(active);
}

/** Show who is signed in, or that the session could not be read. */
async function loadSession(): Promise<void> {
  const target = el("session");
  try {
    const session = await api<{ displayName: string; subscriptionLabel: string }>(
      "GET",
      "/api/session",
    );
    target.textContent = `${session.displayName} (${session.subscriptionLabel})`;
  } catch {
    target.textContent = "Session unavailable";
  }
}

initArtworkToggle();
initHomeView();
initPlaylistView();
initAlbumsView();
initSimilarView();
initWordPlayView();
initDeduplicateView();
initCombineView();
initStatsView();
initUpgradeView();
initImportExportView();
initNewReleasesView();
initManagedView();
initHistoryView();
initLastChange();
window.addEventListener("hashchange", route);
route();
void loadSession();
