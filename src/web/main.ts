/**
 * App shell: sidebar navigation, hash-based view routing, and session display.
 *
 * Each tool is a section in the page; the sidebar switches between them (and the
 * home view) by URL hash, so views are linkable and the back button works. Each
 * view module wires its own controls once on load. This is DOM glue; the logic
 * it drives lives in the tested server modules.
 */

// First: carries this browser's settings over from the old name.
import "./old-settings.js";
import type { AccountView } from "../accounts/accounts.js";
import { isServiceName } from "../services/names.js";
import { api } from "./api.js";
import { initArtworkToggle } from "./artwork.js";
import { el } from "./dom.js";
import { applyPrefill } from "./prefill.js";
import { attentionBadge, linkAttention } from "../sync/wording.js";
import { accountNotices, linkNotices, showNotices, type Notice } from "./notices.js";
import { chosenService, rememberService, setConnectedServices } from "./service.js";
import { initAccountsView } from "./views/accounts.js";
import { initAlbumsView } from "./views/albums.js";
import { initCombineView } from "./views/combine.js";
import { initDeduplicateView } from "./views/deduplicate.js";
import { initHistoryView, initLastChange } from "./views/history.js";
import { initHomeView } from "./views/home.js";
import { initImportExportView } from "./views/import-export.js";
import { fetchLinks, initLinksView, LINKS_CHANGED, servicesKnown as linksServicesKnown, type LinksList } from "./views/links.js";
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
  renderNotices();
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
  setConnectedServices(connected.map((account) => account.service));
  const all = chosenService() === "all" && connected.length > 1;
  const chosen = connected.find((account) => account.service === chosenService()) ?? connected[0];
  if (!all && chosen?.service !== chosenService()) {
    // The remembered service is not connected: say so by falling back visibly.
    rememberService(chosen?.service);
  }
  notices = accountNotices(accounts);
  renderNotices();
  el("session-label").hidden = chosen === undefined;
  target.textContent =
    all
      ? connected.map((account) => account.label).join(", ")
      : chosen === undefined
      ? "Not connected"
      : `${chosen.displayName ?? ""}${chosen.plan === undefined ? "" : ` (${chosen.plan})`}`;
  fillServicePicker(connected, all ? undefined : chosen);
  if (connected.length === 0 && (location.hash === "" || location.hash === "#/home")) {
    location.hash = "#/accounts";
  }
}

/** The views that can show every service at once; the others work on one. */
const ALL_VIEWS: readonly View[] = ["home", "playlists", "stats", "combine", "history", "accounts", "managed", "import-export"];
let notices: Notice[] = [];
/** What the linked playlists need, on every page until it is settled. */
let linksNeed: Notice[] = [];

function renderNotices(): void {
  const one: Notice[] =
    chosenService() === "all" && !ALL_VIEWS.includes(currentView())
      ? [{ text: "This works on one music service. Choose it in the list of music services, at the bottom left." }]
      : [];
  showNotices([...one, ...linksNeed, ...notices]);
}

/** The links' notices, and the count beside Managed playlists. */
function showLinks(list: LinksList | undefined): void {
  const attention = linkAttention(list?.links ?? []);
  linksNeed = linkNotices(attention);
  renderNotices();
  const nav = document.querySelector<HTMLAnchorElement>('.nav-link[data-view="managed"]');
  nav?.querySelector(".nav-badge")?.remove();
  const badge = attentionBadge(attention);
  if (nav !== null && badge !== undefined) {
    const node = document.createElement("span");
    node.className = badge.urgent ? "nav-badge urgent" : "nav-badge";
    node.title = badge.text;
    const count = document.createElement("span");
    count.setAttribute("aria-hidden", "true");
    count.textContent = String(badge.count);
    const words = document.createElement("span");
    words.className = "visually-hidden";
    words.textContent = `, ${badge.text}`;
    node.append(count, words);
    nav.appendChild(node);
  }
}

function fillServicePicker(connected: readonly AccountView[], chosen: AccountView | undefined): void {
  el("service-picker").hidden = connected.length < 2;
  const select = el<HTMLSelectElement>("service-select");
  select.textContent = "";
  for (const account of connected) {
    select.appendChild(new Option(account.label, account.service, false, account.service === chosen?.service));
  }
  select.appendChild(new Option("All services", "all", false, chosen === undefined));
  select.addEventListener("change", () => {
    rememberService(isServiceName(select.value) || select.value === "all" ? select.value : undefined);
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
initLinksView();
initHistoryView();
initAccountsView();
initLastChange();
window.addEventListener(LINKS_CHANGED, (event) => showLinks((event as CustomEvent<LinksList>).detail));
// Not available, or failing: no notices from links, and nothing else changes.
void fetchLinks().then(showLinks, () => undefined);
// The views load once the services are known, as they name them.
void loadAccounts().finally(() => {
  window.addEventListener("hashchange", route);
  route();
  linksServicesKnown();
});
