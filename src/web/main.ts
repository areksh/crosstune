/**
 * App shell: the frame (top bar and library sidebar), and hash-based routing.
 *
 * Each view is a section in the page, shown by the URL hash (src/ui/routes.ts:
 * "#/" is the library, "#/p/<id>" a playlist, "#/upgrade" a tool), so views are
 * linkable and the back button works; old addresses are sent to their new
 * homes. Each view module wires its own controls once on load. This is DOM
 * glue; the logic it drives lives in tested modules.
 */

import type { AccountView } from "../accounts/accounts.js";
import { SERVICE_LABELS } from "../services/names.js";
import { api } from "./api.js";
import { initArtworkToggle } from "./artwork.js";
import { el } from "./dom.js";
import { applyPrefill } from "./prefill.js";
import { parseRoute, redirectFor, viewOf, type Route } from "../ui/routes.js";
import { initLibrary, markActive, refreshLibrary } from "./library.js";
import { currentTab, initShell, TAB_CHANGED } from "./shell.js";
import { prepareHosting, showHosting } from "./hosting.js";
import { initFavouritesView } from "./playlist-page.js";
import { attentionBadge, linkAttention } from "../sync/wording.js";
import { accountNotices, linkNotices, showNotices, type Notice } from "./notices.js";
import { chosenService, connectedServices, rememberService, setConnectedServices, workingService } from "./service.js";
import { workingNotice } from "../ui/working-service.js";
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
  "favourites",
] as const;
type View = (typeof VIEWS)[number];

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

/** The views that only read the library, so leaving them changes nothing in it. */
const LIBRARY_VIEWS: readonly View[] = ["home", "playlists", "favourites", "accounts"];
let shown: View | undefined;

/** The section that shows a route, when the page has it. */
function viewFor(route: Route): View {
  const view = viewOf(route);
  return isView(view) ? view : "home";
}

/** The view the current URL hash shows. */
function currentView(): View {
  return viewFor(parseRoute(location.hash));
}

function route(): void {
  const redirect = redirectFor(location.hash, workingService());
  if (redirect !== undefined) {
    // Fires hashchange again, which shows the new address.
    location.replace(redirect);
    return;
  }
  const where = parseRoute(location.hash);
  if (prepareHosting(where) === "reload") {
    return;
  }
  const active = viewFor(where);
  // A tool (or History's undo) may have written: read the library again on leaving it.
  if (shown !== undefined && shown !== active && !LIBRARY_VIEWS.includes(shown)) {
    void refreshLibrary();
  }
  shown = active;
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== active;
  }
  markActive(where);
  showHosting(where);
  // Fill in what another view handed over, if it was for this one.
  applyPrefill(active);
  renderNotices();
}

/** Read the accounts: which services the frame offers, and what needs attention. */
async function loadAccounts(): Promise<void> {
  let accounts: AccountView[];
  try {
    ({ accounts } = await api<{ accounts: AccountView[] }>("GET", "/api/accounts"));
  } catch {
    el("lib-status").textContent = "The accounts could not be read; is crosstune still running?";
    return;
  }
  const connected = accounts.filter((account) => account.status === "connected");
  setConnectedServices(connected.map((account) => account.service));
  initShell(connected.map((account) => account.service));
  initLibrary(connected.map((account) => account.service));
  const all = chosenService() === "all" && connected.length > 1;
  const chosen = connected.find((account) => account.service === chosenService()) ?? connected[0];
  if (!all && chosen?.service !== chosenService()) {
    // The remembered service is not connected: say so by falling back visibly.
    rememberService(chosen?.service);
  }
  notices = accountNotices(accounts);
  renderNotices();
  if (connected.length === 0 && parseRoute(redirectFor(location.hash) ?? location.hash).kind === "home") {
    location.hash = "#/settings";
  }
}

/** The views that can show every service at once; the others work on one. */
const ALL_VIEWS: readonly View[] = ["home", "playlists", "favourites", "stats", "combine", "history", "accounts", "managed", "import-export"];
let notices: Notice[] = [];
/** What the linked playlists need, on every page until it is settled. */
let linksNeed: Notice[] = [];

function renderNotices(): void {
  // A tool on a source works on the source's service, and a new playlist on the tab's when it is one.
  const where = parseRoute(location.hash);
  const decided =
    ((where.kind === "playlist" || where.kind === "favourites" || where.kind === "all") && where.tool !== undefined) ||
    (where.kind === "new" && currentTab() !== "all");
  const working = workingNotice(chosenService(), connectedServices(), decided || ALL_VIEWS.includes(currentView()));
  const one: Notice[] =
    working === undefined
      ? []
      : [
          {
            text: working.text,
            links: working.switchTo.map((service) => ({
              href: location.hash,
              text: `Use ${SERVICE_LABELS[service]}`,
              onClick: () => {
                rememberService(service);
                location.reload();
              },
            })),
          },
        ];
  showNotices([...one, ...linksNeed, ...notices]);
}

/** The links' notices, and the count beside Managed playlists. */
function showLinks(list: LinksList | undefined): void {
  const attention = linkAttention(list?.links ?? []);
  linksNeed = linkNotices(attention);
  renderNotices();
  const nav = document.querySelector<HTMLAnchorElement>("#nav-jobs");
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


// First, so that it can keep the user on an unsaved playlist before any view reacts.
guardUnsavedPlaylist();
initArtworkToggle();
initFavouritesView();
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
// A new playlist is made on the tab's service: a tab change moves the tool there.
window.addEventListener(TAB_CHANGED, () => {
  if (parseRoute(location.hash).kind === "new") {
    route();
  } else {
    renderNotices();
  }
});
window.addEventListener(LINKS_CHANGED, (event) => showLinks((event as CustomEvent<LinksList>).detail));
// Not available, or failing: no notices from links, and nothing else changes.
void fetchLinks().then(showLinks, () => undefined);
// The views load once the services are known, as they name them.
void loadAccounts().finally(() => {
  window.addEventListener("hashchange", route);
  route();
  linksServicesKnown();
});
