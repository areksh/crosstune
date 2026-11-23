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
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { api } from "./api.js";
import { initArtworkToggle } from "./artwork.js";
import { el } from "./dom.js";
import { applyPrefill } from "./prefill.js";
import { parseRoute, redirectFor, type Route } from "../ui/routes.js";
import { initLibrary, markActive } from "./library.js";
import { initShell } from "./shell.js";
import { initFavouritesView } from "./playlist-page.js";
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
  "favourites",
] as const;
type View = (typeof VIEWS)[number];

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

/** The section that shows a route. */
function viewOf(route: Route): View {
  switch (route.kind) {
    case "home":
      return "home";
    case "playlist":
    case "all":
      return "playlists";
    case "favourites":
      return "favourites";
    case "settings":
      return "accounts";
    case "view":
      return isView(route.view) && route.view !== "playlists" && route.view !== "accounts" ? route.view : "home";
  }
}

/** The view the current URL hash shows. */
function currentView(): View {
  return viewOf(parseRoute(location.hash));
}

function route(): void {
  const redirect = redirectFor(location.hash);
  if (redirect !== undefined) {
    // Fires hashchange again, which shows the new address.
    location.replace(redirect);
    return;
  }
  const where = parseRoute(location.hash);
  const active = viewOf(where);
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== active;
  }
  markActive(where);
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
  oneService = all ? connected.map((account) => account.service) : [];
  renderNotices();
  if (connected.length === 0 && parseRoute(location.hash).kind === "home") {
    location.hash = "#/settings";
  }
}

/** The views that can show every service at once; the others work on one. */
const ALL_VIEWS: readonly View[] = ["home", "playlists", "favourites", "stats", "combine", "history", "accounts", "managed", "import-export"];
let notices: Notice[] = [];
/** The connected services, when the page is on all of them (for the banner's choices). */
let oneService: ServiceName[] = [];
/** What the linked playlists need, on every page until it is settled. */
let linksNeed: Notice[] = [];

function renderNotices(): void {
  const one: Notice[] =
    chosenService() === "all" && !ALL_VIEWS.includes(currentView())
      ? [
          {
            text: "This works on one music service at a time.",
            links: oneService.map((service) => ({
              href: location.hash,
              text: `Use ${SERVICE_LABELS[service]}`,
              onClick: () => {
                rememberService(service);
                location.reload();
              },
            })),
          },
        ]
      : [];
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
window.addEventListener(LINKS_CHANGED, (event) => showLinks((event as CustomEvent<LinksList>).detail));
// Not available, or failing: no notices from links, and nothing else changes.
void fetchLinks().then(showLinks, () => undefined);
// The views load once the services are known, as they name them.
void loadAccounts().finally(() => {
  window.addEventListener("hashchange", route);
  route();
  linksServicesKnown();
});
