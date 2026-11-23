# Web UI redesign, step 1 (frame and look) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tool-list shell with the library-first frame (top bar, playlists sidebar, playlist page with an action row) in the "Cover glow" look, with every existing tool still reachable.

**Architecture:** DOM-free decisions (routes, generated covers, which playlists the sidebar shows) go in a new tested directory `src/ui/`, imported by the `src/web/` glue (which is excluded from coverage and from the server tsconfig, so it cannot hold tested code). The existing view sections stay; `main.ts` routes the new hashes onto them. Tools not yet moved into a playlist (step 2) open as today's views, reached from the playlist page's action row, "+ New", Jobs, History and Settings.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), vanilla DOM, esbuild, Vitest. No runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-ui-redesign-design.md` (read it first; this plan covers its "Steps" item 1).

## Global Constraints

- Zero runtime dependencies; no UI framework; self-hosted fonts only (keep Archivo, `src/web/fonts/`).
- Relative imports use the `.js` extension.
- Artwork stays off by default (ADR-0004): no `<img src>` to a service while it is off.
- The browser talks only to the local server; `api.ts` is the only caller.
- Every step ends with `npm test` and `npm run typecheck` green.
- Service colours (dots, tab marks): Qobuz `#8f98ff`, TIDAL `#4fe0e0`, Spotify `#4fe08a`. Not logos.
- Look tokens (from `look.html` option 3): ground `#0e0f14`, text `#f4f4f8`, muted `#8a8aa0`, surfaces `rgba(255,255,255,.03-.12)`, hi-res pill gold `#ffd778` on `rgba(255,215,120,.15)`, primary button white on dark, radii 8-10px, pills 999px, brand word gradient `#ff6b9a -> #8f7bff`.
- Commits: Conventional Commits, scope `web` (or `ui` for `src/ui/`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `ui-redesign-1`, merged fast-forward to `main` at the end. Not pushed.

## Review Focus

- **Only one service connected**: no "All" tab, no per-service duplication of Library rows; tabs show just that service. (Task 3 test.)
- **No service connected**: the page still lands on Settings (today it redirects `#/home` to `#/accounts`); the sidebar says nothing is connected instead of "Loading...". (Task 5 step.)
- **Old bookmarks**: `#/playlists/<id>`, `#/playlists`, `#/home`, `#/accounts` keep working. (Task 1 tests.)
- **Unsaved playlist edits**: clicking another playlist in the sidebar, a tab, or an action button while the editor has a draft still asks first (`guardUnsavedPlaylist` listens to `hashchange`; the sidebar must navigate by hash, never by calling `openEditor` directly). (Task 6 step.)
- **A tool opened from a playlist on another service than the remembered one** works on the playlist's service, not the remembered one, and the prefill survives the reload. (Task 6 step.)

---

## File Structure

- Create `src/ui/routes.ts` (+ test): the hash grammar, old-hash redirects.
- Create `src/ui/cover-art.ts` (+ test): the gradient cover for a name.
- Create `src/ui/library.ts` (+ test): tabs, sidebar rows, Library rows.
- Create `src/web/shell.ts`: top bar (tabs, + New menu, Jobs/History/Settings), tab state.
- Create `src/web/library.ts`: the sidebar (renders `src/ui/library.ts` rows).
- Create `src/web/playlist-page.ts`: header + action row over the editor; Favourites and All-playlists pages; `openTool`.
- Modify `src/web/index.html`: new shell markup; header slot in `#pl-editor`; Favourites page section; artwork toggle into the Accounts view (Settings).
- Modify `src/web/main.ts`: routing through `parseRoute`; banner wording.
- Modify `src/web/service.ts`: `chosenTab`/`rememberTab`.
- Modify `src/web/artwork.ts`: `coverSlot(url, seed?)` paints the generated cover.
- Modify `src/web/views/playlist-actions.ts`: `playlistHash` returns the new hash.
- Modify `src/web/views/playlists.ts`, `playlist-editor.ts`: route names, back link.
- Rewrite `src/web/styles.css` tokens and shell rules (Cover glow).
- Modify `CLAUDE.md` (architecture: `src/ui/`), `CHANGELOG.md`.

---

### Task 1: The route grammar

**Files:**
- Create: `src/ui/routes.ts`
- Test: `src/ui/routes.test.ts`

**Interfaces:**
- Consumes: `readId`, `shortId`, `type PlaylistId` from `src/services/ids.ts`; `isServiceName`, `type ServiceName` from `src/services/names.ts`.
- Produces:
  ```ts
  export type Route =
    | { kind: "home" }
    | { kind: "playlist"; id: PlaylistId }
    | { kind: "favourites"; service: ServiceName }
    | { kind: "all"; service: ServiceName }
    | { kind: "settings" }
    | { kind: "view"; view: string };   // a tool view not yet moved (step 2)
  export function parseRoute(hash: string): Route;
  export function routeHash(route: Route): string;
  /** The hash an old address now lives at, or undefined if it is current. */
  export function redirectFor(hash: string): string | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseRoute", () => {
  it("reads the library home", () => {
    expect(parseRoute("")).toEqual({ kind: "home" });
    expect(parseRoute("#/")).toEqual({ kind: "home" });
  });
  it("reads a playlist, Qobuz ids in their short form", () => {
    expect(parseRoute("#/p/12345")).toEqual({ kind: "playlist", id: "qobuz:12345" });
    expect(parseRoute("#/p/spotify%3A37i9dQ")).toEqual({ kind: "playlist", id: "spotify:37i9dQ" });
  });
  it("reads Favourites and All playlists per service", () => {
    expect(parseRoute("#/favourites/tidal")).toEqual({ kind: "favourites", service: "tidal" });
    expect(parseRoute("#/all/qobuz")).toEqual({ kind: "all", service: "qobuz" });
  });
  it("treats an unknown service or bad id as home", () => {
    expect(parseRoute("#/favourites/deezer")).toEqual({ kind: "home" });
    expect(parseRoute("#/p/")).toEqual({ kind: "home" });
  });
  it("passes tool views through", () => {
    expect(parseRoute("#/deduplicate")).toEqual({ kind: "view", view: "deduplicate" });
    expect(parseRoute("#/settings")).toEqual({ kind: "settings" });
  });
});
describe("routeHash", () => {
  it("round-trips every route", () => {
    for (const route of [
      { kind: "home" }, { kind: "playlist", id: "qobuz:12345" }, { kind: "playlist", id: "spotify:37i9dQ" },
      { kind: "favourites", service: "tidal" }, { kind: "all", service: "spotify" }, { kind: "settings" },
      { kind: "view", view: "upgrade" },
    ] as Route[]) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ kind: "playlist", id: "qobuz:12345" as PlaylistId })).toBe("#/p/12345");
  });
});
describe("redirectFor", () => {
  it("sends old addresses to their new homes", () => {
    expect(redirectFor("#/playlists/12345")).toBe("#/p/12345");
    expect(redirectFor("#/playlists")).toBe("#/");
    expect(redirectFor("#/home")).toBe("#/");
    expect(redirectFor("#/accounts")).toBe("#/settings");
  });
  it("leaves current addresses alone", () => {
    expect(redirectFor("#/p/12345")).toBeUndefined();
    expect(redirectFor("#/deduplicate")).toBeUndefined();
  });
});
```

`"#/all/<service>"` in step 1 shows the old Playlists list page filtered to that service (`view-playlists`, `#pl-list-page`).

- [ ] **Step 2: Run** `npx vitest run src/ui/routes.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `src/ui/routes.ts`. Playlist ids go through `encodeURIComponent(shortId(id))` and back through `readId(decodeURIComponent(...))` inside a try/catch (as `idInHash` in `views/playlists.ts` does). Known non-tool words: `p`, `favourites`, `all`, `settings`; anything else non-empty is `view`.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): the route grammar for the library-first page`.

---

### Task 2: Generated covers

**Files:**
- Create: `src/ui/cover-art.ts`
- Test: `src/ui/cover-art.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GeneratedCover { hue: number; colours: [string, string, string] } // CSS hsl() strings
  export function generatedCover(seed: string): GeneratedCover;
  /** A square cover's CSS background (a conic gradient over the three colours). */
  export function coverBackground(cover: GeneratedCover): string;
  /** The playlist header's tint: a radial gradient from the first two colours, fading to transparent. */
  export function glowBackground(cover: GeneratedCover): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("is stable for a name", () => {
  expect(generatedCover("Techno")).toEqual(generatedCover("Techno"));
});
it("ignores case and surrounding space, so a rename that only re-cases keeps its colour", () => {
  expect(generatedCover(" techno ")).toEqual(generatedCover("Techno"));
});
it("tells near names apart", () => {
  const a = generatedCover("rock/metal v3").hue, b = generatedCover("rock/metal v2").hue;
  expect(Math.min(Math.abs(a - b), 360 - Math.abs(a - b))).toBeGreaterThanOrEqual(20);
});
it("spreads names around the wheel", () => {
  const names = ["Techno", "uk rap", "rap", "race games", "rock/metal v3", "Download 2026 Headline", "Favourites", "Chill", "Gym", "Jazz"];
  const sextants = new Set(names.map((n) => Math.floor(generatedCover(n).hue / 60)));
  expect(sextants.size).toBeGreaterThanOrEqual(4);
});
it("yields CSS a page can use, light enough for dark text-free covers", () => {
  const cover = generatedCover("Techno");
  for (const colour of cover.colours) expect(colour).toMatch(/^hsl\(\d+(\.\d+)? \d+% \d+%\)$/);
  expect(coverBackground(cover)).toMatch(/^conic-gradient\(/);
  expect(glowBackground(cover)).toMatch(/^radial-gradient\(.*transparent/);
});
it("gives an empty name a cover too", () => {
  expect(generatedCover("").colours).toHaveLength(3);
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui/cover-art.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Hash the normalised seed (trim, lower-case) with FNV-1a 32-bit followed by a murmur3 `fmix32` avalanche; `hue = hash % 360`. Colours: `hsl(h 78% 64%)`, `hsl(h+35 80% 60%)`, `hsl(h+210 55% 45%)` (hues mod 360, integers). Glow uses the first two colours at alpha .55/.22 (`hsl(h 78% 64% / .55)` is fine; adjust the test's regex only for the colours tuple, not the glow).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): generated covers from a playlist's name`.

---

### Task 3: What the sidebar shows

**Files:**
- Create: `src/ui/library.ts`
- Test: `src/ui/library.test.ts`

**Interfaces:**
- Consumes: `type ManagerPlaylist` (`src/features/playlist-manager.ts`), `serviceOf`, `type PlaylistId`, `type ServiceName`.
- Produces:
  ```ts
  export type Tab = ServiceName | "all";
  export function tabsFor(connected: readonly ServiceName[]): Tab[];
  /** The tab to show: the remembered one if still valid, else the first. */
  export function validTab(remembered: string | undefined, connected: readonly ServiceName[]): Tab;
  export interface SidebarRow { id: PlaylistId; name: string; service: ServiceName; trackCount?: number; linked: boolean }
  export function sidebarRows(
    playlists: readonly ManagerPlaylist[],
    options: { tab: Tab; filter: string; linked: ReadonlySet<PlaylistId> },
  ): SidebarRow[];
  export type LibraryRow =
    | { kind: "favourites"; service: ServiceName }
    | { kind: "all"; service: ServiceName }
    | { kind: "new-releases" };
  export function libraryRows(connected: readonly ServiceName[], tab: Tab): LibraryRow[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const pl = (id: string, name: string, updatedAt?: string) => ({ id, name, updatedAt, owned: true, readBy: [] }) as ManagerPlaylist;
const list = [pl("qobuz:1", "Techno", "2026-11-01"), pl("spotify:a", "Techno", "2026-11-03"), pl("tidal:x", "uk rap", "2026-11-02")];

it("offers All only when more than one service is connected", () => {
  expect(tabsFor(["qobuz"])).toEqual(["qobuz"]);
  expect(tabsFor(["qobuz", "spotify"])).toEqual(["all", "qobuz", "spotify"]);
});
it("falls back from a tab that is no longer valid", () => {
  expect(validTab("tidal", ["qobuz"])).toBe("qobuz");
  expect(validTab("all", ["qobuz"])).toBe("qobuz");
  expect(validTab(undefined, ["qobuz", "tidal"])).toBe("all");
  expect(validTab("tidal", ["qobuz", "tidal"])).toBe("tidal");
});
it("lists every copy of a linked playlist under All, newest change first", () => {
  const rows = sidebarRows(list, { tab: "all", filter: "", linked: new Set(["qobuz:1", "spotify:a"] as PlaylistId[]) });
  expect(rows.map((r) => [r.id, r.linked])).toEqual([["spotify:a", true], ["tidal:x", false], ["qobuz:1", true]]);
});
it("shows one service's playlists under its tab", () => {
  expect(sidebarRows(list, { tab: "qobuz", filter: "", linked: new Set() }).map((r) => r.id)).toEqual(["qobuz:1"]);
});
it("filters by name, ignoring case", () => {
  expect(sidebarRows(list, { tab: "all", filter: "UK", linked: new Set() }).map((r) => r.id)).toEqual(["tidal:x"]);
});
it("gives Favourites and All playlists per service, New releases once", () => {
  expect(libraryRows(["qobuz", "spotify"], "all")).toEqual([
    { kind: "favourites", service: "qobuz" }, { kind: "favourites", service: "spotify" },
    { kind: "all", service: "qobuz" }, { kind: "all", service: "spotify" },
    { kind: "new-releases" },
  ]);
  expect(libraryRows(["qobuz", "spotify"], "spotify")).toEqual([
    { kind: "favourites", service: "spotify" }, { kind: "all", service: "spotify" }, { kind: "new-releases" },
  ]);
});
```

Playlists with no `updatedAt` sort after dated ones, then by name (numeric collation, as `views/playlists.ts` sorts names).

- [ ] **Step 2: Run** `npx vitest run src/ui/library.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `src/ui/library.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): which playlists and library rows the sidebar shows`.

---

### Task 4: The Cover glow look

**Files:**
- Modify: `src/web/styles.css` (header comment, `:root` tokens, button/pill/panel/quality-badge/cover rules)
- Modify: `src/web/artwork.ts` (`coverSlot(url, seed?)`), and its 8 callers to pass a seed (album name, else track title): `tracks.ts:160`, `views/playlist-editor.ts:443`, `views/albums.ts:285`, `views/new-releases.ts:241`, `views/word-play.ts:348`, `views/upgrade.ts:226`, `views/deduplicate.ts:318,419`; `setCover(slot, url, seed?)` likewise.

**Interfaces:**
- Consumes: `generatedCover`, `coverBackground` (Task 2).
- Produces: CSS custom properties later tasks use: `--ground`, `--surface-1` (.03), `--surface-2` (.07), `--surface-3` (.12), `--text`, `--muted`, `--radius` (10px), `--radius-s` (8px), `--svc-qobuz`, `--svc-tidal`, `--svc-spotify`, `--hires`, `--hires-bg`; classes `.svc-dot` (8px circle, colour from `data-service` attribute), `.pill`, `.gen-cover`.

- [ ] **Step 1: Replace the tokens.** Keep the token *names* the 283 existing `var(--...)` uses rely on (`--ground`, `--panel`, `--inset`, `--line`, `--text`, `--text-2`, `--muted`, `--accent`, `--on-accent`, ...) and give them Cover glow values (accent becomes the white primary: `--accent: #f4f4f8; --on-accent: #111`; lines become translucent white); add the new tokens above. Replace the "Console" header comment with a "Cover glow" one in the same spirit (what the one bold element is: the cover's colour).
- [ ] **Step 2: Shapes.** Buttons, `select`, step pills and quality badges to pill radius; panels and list rows to `--radius`; the LED glow on quality badges goes; hi-res badges use `--hires`/`--hires-bg`, CD/lossy muted. Fix the ~31 hard-coded colours (`grep -nE '#[0-9a-fA-F]{3,6}\b' src/web/styles.css`) to tokens.
- [ ] **Step 3: `coverSlot(url, seed?)`.** When a seed is given, the slot gets `style.background = coverBackground(generatedCover(seed))` and class `gen-cover`; a loaded `<img>` covers it (artwork on). No behaviour change for `data-src`.
- [ ] **Step 4: Verify** `npm run typecheck && npm test` — Expected: both green. Then `npm run build`, serve, and screenshot `#/deduplicate` and `#/playlists` with the run-crosstune driver; look at them for unreadable text or leftover amber.
- [ ] **Step 5: Commit** `feat(web): the Cover glow look`.

---

### Task 5: The frame: top bar, sidebar, routing

**Files:**
- Modify: `src/web/index.html` (replace `<aside class="sidebar">`'s brand+nav+footer with the new top bar and library sidebar; move the "Show artwork" checkbox and its hint into `#view-accounts`; keep every `<section id="view-...">`)
- Create: `src/web/shell.ts`, `src/web/library.ts`
- Modify: `src/web/main.ts`, `src/web/service.ts`, `src/web/views/playlist-actions.ts`, `src/web/views/playlists.ts`, `src/web/views/playlist-editor.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces:
  - `service.ts`: `chosenTab(): string | undefined`, `rememberTab(tab: Tab): void` (key `crosstune:tab`, storage failures ignored like `rememberService`).
  - `shell.ts`: `initShell(connected: readonly ServiceName[]): void`; dispatches `TAB_CHANGED = "crosstune:tab-changed"` (`CustomEvent<Tab>`) on `window`.
  - `library.ts`: `initLibrary(): void`, `refreshLibrary(): Promise<void>` (re-reads playlists), `markActive(route: Route): void`.
  - `playlist-actions.ts`: `playlistHash(id)` returns `routeHash({ kind: "playlist", id })`.

Markup (ids are the contract with the glue):

```
<header class="topbar">  a.brand "crosstune" -> "#/"
  nav#tabs.tabs (role=tablist; buttons filled by shell.ts, each with .svc-dot)
  a#nav-jobs "Jobs" -> "#/managed" (carries the links attention badge that main.ts put on the Managed nav link)
  a#nav-history "History" -> "#/history"
  a#nav-settings "Settings" -> "#/settings"
  details#new-menu.menu > summary "+ New" > .menu-items:
    New playlist from…: Artists #/playlist, Albums #/albums, Similar artists #/similar,
    Word play #/word-play, Combine playlists #/combine, Import a file #/import-export;
    Keep it fresh: Managed playlist #/managed   (each item: name + one-line description, wording from flows.html)
<div class="layout"> <aside class="sidebar">
  input#lib-filter (placeholder "Filter playlists")
  h2 "Playlists" + ul#lib-playlists     (rows: .svc-dot, name, ⇄ when linked, count)
  h2 "Library"   + ul#lib-library       (Favourites / All playlists with .svc-dot; New releases -> #/new-releases)
  p#lib-status (Loading... / No music service is connected yet. / No playlist matches.)
</aside> <main class="content"> (unchanged: #notices + every view section)
```

- [ ] **Step 1: Routing in `main.ts`.** On `hashchange` and on load: if `redirectFor(location.hash)` gives a hash, `location.replace` to it and stop. Otherwise `parseRoute`: `home` shows `view-home`; `playlist` shows `view-playlists` with the editor (the editor's own router in `views/playlists.ts` must read the id via `parseRoute`, replacing its `split("/")` on line 55); `all` shows `view-playlists` with `#pl-list-page`, filtered to that service (pass it to the list via a new exported `showListFor(service: ServiceName)` in `views/playlists.ts`, which pre-filters `playlists` by `serviceOf`); `favourites` shows the new `view-favourites` (Task 6); `settings` shows `view-accounts`; `view` shows `view-<name>` when it is in `VIEWS`, else home. `VIEWS` drops `"accounts"`'s nav dependency but keeps the section. Remove the `.nav-link` active-class loop; call `markActive(route)` instead.
- [ ] **Step 2: Tabs (`shell.ts`).** Render `tabsFor(connected)`; the selected one is `validTab(chosenTab(), connected)`; clicking calls `rememberTab` and dispatches `TAB_CHANGED`. **No reload**, and it does not change `chosenService()`. The old `<select id="service-select">` and its reload go away.
- [ ] **Step 3: Sidebar (`library.ts`).** Fetch `GET /api/manager/playlists` with the header `X-Music-Service: all` when more than one service is connected (extend `api()` with an optional `on?: Choice` argument passed to `baseHeaders(on)`); join with `knownLinks()` from `views/links.ts` for `linked` (re-render on `LINKS_CHANGED`); re-render on `TAB_CHANGED` and `#lib-filter` input. Each playlist row is an `<a href={playlistHash(id)}>` (hash navigation keeps `guardUnsavedPlaylist` in charge). Each row shows a 20px `.gen-cover` from `generatedCover(name)`. Refresh after any save the editor reports (re-use the editor's existing deleted/saved callbacks: `onDeleted` in `playlist-editor.ts`; add `onSaved` alongside if none exists).
- [ ] **Step 4: The banner.** Replace "This works on one music service. Choose it in the list of music services, at the bottom left." with a notice "This works on one music service at a time." followed by one link per connected service ("Use Qobuz", ...) that calls `rememberService(service)` and reloads. (`Notice` takes one `link`; add `links?: { href: string; text: string; onClick?: () => void }[]`, rendered after `link`.)
- [ ] **Step 5: Nothing connected.** `loadAccounts`'s redirect from home goes to `#/settings`; the sidebar shows "No music service is connected yet." with a link to Settings.
- [ ] **Step 6: Old names.** `playlist-editor.ts:1467` and the editor's back link (`index.html:1107`) go to `#/` ("← Library"); `main.ts`'s comment on line 60 updated.
- [ ] **Step 7: Verify** `npm run typecheck && npm test` green; build, serve, drive: `{"nav":"#/"}`, click a sidebar playlist, `{"nav":"#/playlists/<a real Qobuz id>"}` lands on `#/p/<id>`, switch tabs (no reload: `performance.getEntriesByType("navigation").length` unchanged and the sidebar count changes), `{"nav":"#/all/qobuz"}`, `{"nav":"#/accounts"}` lands on Settings with the artwork checkbox. Screenshot each and look.
- [ ] **Step 8: Commit** `feat(web): the library-first frame`.

---

### Task 6: The playlist page and the Library pages

**Files:**
- Create: `src/web/playlist-page.ts`
- Modify: `src/web/index.html` (`#pl-editor` header; new `<section id="view-favourites">`; an action row above `#pl-list-page`'s list for `#/all/<service>`)
- Modify: `src/web/views/playlist-editor.ts` (`renderOpenIn` replaced by the action row; "Copy to another service..." becomes an action button; the rest of `renderMore` stays as the "More" menu)

**Interfaces:**
- Consumes: Tasks 1-5; `storePrefill`, `type Prefill` (`prefill.ts`); `chosenService`, `rememberService` (`service.ts`).
- Produces:
  ```ts
  /** Open a tool view filled for this source, on its service: switches the remembered service (reloading, the prefill kept in sessionStorage) when it differs. */
  export function openTool(prefill: Prefill, service: ServiceName): void;
  export function renderPlaylistHeader(playlist: ManagerPlaylist): void; // called by the editor when it opens a playlist
  export function showFavourites(service: ServiceName): void;
  export function showAllActions(service: ServiceName): void;
  ```

- [ ] **Step 1: Header markup.** In `#pl-editor` replace `.pl-editor-head`'s title row with: `.pl-hero` (radial `glowBackground` of the playlist's generated cover as its background) holding a 104px `.gen-cover#pl-cover`, an eyebrow `#pl-eyebrow` ("QOBUZ PLAYLIST", with ⇄ "Linked with Spotify" when linked), `h1#pl-name`, `p#pl-meta` (songs · length · public/private, as today), and `div#pl-actions.pl-actions`. Keep `#pl-notice`, the "Open in" menu removed, the "Playlist" menu renamed "More".
- [ ] **Step 2: The action row** (buttons, primary first; same prefills as today's `renderOpenIn`, each through `openTool(prefill, serviceOf(id))`, behind the editor's existing `isDirty() && confirmLeaving()` check):
  - Find repeats -> `deduplicate` (`dedup-source=playlist`, `dedup-playlist-select=id`)
  - Upgrade -> `upgrade` (`upgrade-source=playlist:<id>`)
  - Copy to… -> the editor's existing `copyToService()`
  - Link -> `#/managed` (the links panel; in-context linking is step 2)
  - Stats -> `stats` (`stats-source=id`)
  - Export -> `import-export` (`ie-source=playlist`, `ie-export-playlist-select=id`)
  - More ▾: Similar artists, Combine playlists (their prefills from `renderOpenIn`), then today's `renderMore` items.
- [ ] **Step 3: `openTool`.** If `chosenService() !== service`: `storePrefill(prefill)`, `rememberService(service)`, set `location.hash = "#/" + prefill.view`, then `location.reload()`. Otherwise `storePrefill` and set the hash. (`applyPrefill` already re-reads sessionStorage after a reload.)
- [ ] **Step 4: Favourites page** (`#view-favourites`): hero with a generated cover from "Favourites", eyebrow "<SERVICE> FAVOURITES", and actions Find repeats (`dedup-source=favourites`), Upgrade (`upgrade-source=favourites`), Stats (`stats-source=favourites`), Export (`ie-source=favourite-tracks`), all through `openTool(…, service)`. Below: a hint "Your favourite songs will be listed here." (the song list needs a new read; spec step 2).
- [ ] **Step 5: All playlists page** (`#/all/<service>`): the same hero ("All playlists", eyebrow "<SERVICE>") over the existing list page, with actions Find repeats across them (`dedup-source=all-playlists`), Upgrade all (`upgrade-source=all-playlists`), Stats (`stats-source=everything`), Export all (`ie-source=all-playlists`). The list's tick/remove-artists flow stays as it is.
- [ ] **Step 6: Verify** typecheck + tests green; build, serve, drive with the remembered service set to Qobuz: open a Spotify playlist, click "Find repeats" -> lands on `#/deduplicate` with the Spotify playlist selected and no "one music service" banner; open a playlist, remove a song (draft), click a different sidebar playlist -> the unsaved-changes dialog appears (cancel it; do not save). Favourites (Qobuz) and All playlists (TIDAL) pages render with their actions. Screenshot each and look. Writes nothing.
- [ ] **Step 7: Commit** `feat(web): the playlist page and its actions`.

---

### Task 7: Docs, review, merge

**Files:**
- Modify: `CLAUDE.md` (Architecture: a `src/ui/` bullet: DOM-free, tested logic for the web page: routes, generated covers, sidebar rows; `src/web/` imports it), `CHANGELOG.md` (`[Unreleased]` -> `### Changed`: the web UI's new frame and look, what moved where, artwork still off with generated covers; old addresses still work)

- [ ] **Step 1: Write the docs** as above. README stays until step 2 (spec).
- [ ] **Step 2: Verify** `npm test && npm run typecheck && npm run build` — all green; one final screenshot pass of `#/`, a playlist, `#/deduplicate`, `#/settings` on "All".
- [ ] **Step 3: Whole-branch review** (a fresh reviewer on `main..ui-redesign-1`); fix what it finds; re-verify.
- [ ] **Step 4: Commit and merge** `docs: the library-first UI`; `git checkout main && git merge --ff-only ui-redesign-1`.

---

## Deferred to the step 2 and 3 plans (from the spec)

Step 2: tools hosted inside the playlist (`#/p/<id>/<tool>`, `#/favourites/<service>/<tool>`, `#/all/<service>/<tool>`, `#/new/<tool>`), the Favourites song list read, ticking in the sidebar with group actions, Jobs and Settings pages of their own, redirects for the old tool hashes, Home's tool directory removed, README. Step 3: the ask box, the one-time artwork question, playlist cover images in the adapters, and (after its ADR) the cover proxy and tint.
