/**
 * App shell: sidebar navigation, hash-based view routing, and session display.
 *
 * Each tool is a section in the page; the sidebar switches between them (and the
 * home view) by URL hash, so views are linkable and the back button works. Each
 * view module wires its own controls once on load. This is DOM glue; the logic
 * it drives lives in the tested server modules.
 */

import type { AccountView } from "../accounts/accounts.js";
import { isServiceName } from "../services/names.js";
import { api } from "./api.js";
import { initArtworkToggle } from "./artwork.js";
import { el } from "./dom.js";
import { applyPrefill } from "./prefill.js";
import { accountNotices, showNotices } from "./notices.js";
import { chosenService, rememberService } from "./service.js";
import { initAccountsView } from "./views/accounts.js";
import { initAlbumsView } from "./views/albums.js";
import { initCombineView } from "./views/combine.js";
import { initDeduplicateView } from "./views/deduplicate.js";
import { initHistoryView, initLastChange } from "./views/history.js";
import { initHomeView } from "./views/home.js";
import { initImportExportView } from "./views/import-export.js";
import { initManagedView } from "./views/managed.js";
import { initNewReleasesView } from "./views/new-releases.js";
import { guardUnsavedPlaylist } from "./views/playlist-editor.js";
import { initPlaylistsView } from "./views/playlists.js";
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
  "playlists",
  "deduplicate",
  "combine",
  "upgrade",
  "stats",
  "new-releases",
  "managed",
  "import-export",
  "history",
  "accounts",
] as const;
type View = (typeof VIEWS)[number];

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

/** The view named by the current URL hash ("#/playlists/12" is playlists), defaulting to home. */
function currentView(): View {
  const name = location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
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

/** Show the accounts: whose session this is, the service picker, and what needs attention. */
async function loadAccounts(): Promise<void> {
  const target = el("session");
  let accounts: AccountView[];
  try {
    ({ accounts } = await api<{ accounts: AccountView[] }>("GET", "/api/accounts"));
  } catch {
    target.textContent = "Session unavailable";
    return;
  }
  const connected = accounts.filter((account) => account.status === "connected");
  const chosen = connected.find((account) => account.service === chosenService()) ?? connected[0];
  if (chosen?.service !== chosenService()) {
    // The remembered service is not connected: say so by falling back visibly.
    rememberService(chosen?.service);
  }
  showNotices(accountNotices(accounts));
  el("session-label").hidden = chosen === undefined;
  target.textContent =
    chosen === undefined
      ? "Not connected"
      : `${chosen.displayName ?? ""}${chosen.plan === undefined ? "" : ` (${chosen.plan})`}`;
  fillServicePicker(connected, chosen);
  if (connected.length === 0 && (location.hash === "" || location.hash === "#/home")) {
    location.hash = "#/accounts";
  }
}

function fillServicePicker(connected: readonly AccountView[], chosen: AccountView | undefined): void {
  el("service-picker").hidden = connected.length < 2;
  const select = el<HTMLSelectElement>("service-select");
  select.textContent = "";
  for (const account of connected) {
    select.appendChild(new Option(account.label, account.service, false, account.service === chosen?.service));
  }
  select.addEventListener("change", () => {
    rememberService(isServiceName(select.value) ? select.value : undefined);
    location.reload();
  });
}

// First, so that it can keep the user on an unsaved playlist before any view reacts.
guardUnsavedPlaylist();
initArtworkToggle();
initHomeView();
initPlaylistView();
initAlbumsView();
initSimilarView();
initWordPlayView();
initPlaylistsView();
initDeduplicateView();
initCombineView();
initStatsView();
initUpgradeView();
initImportExportView();
initNewReleasesView();
initManagedView();
initHistoryView();
initAccountsView();
initLastChange();
window.addEventListener("hashchange", route);
route();
void loadAccounts();
