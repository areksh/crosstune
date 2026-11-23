# Web UI redesign, step 2 (tools into context) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tools open inside the playlist, Favourites or All-playlists page they act on (`#/p/<id>/<tool>`), build-from-scratch tools live at `#/new/<tool>`, Favourites lists its songs, playlists can be ticked in the sidebar for group actions, Jobs has its own address, Home loses its tool directory, and step 1's deferred minors are settled.

**Architecture:** *Hosting, not rewriting.* A tool route shows the existing tool section under a context bar ("← uk rap · Find repeats"), with the tool's own title and source picker hidden by CSS (`body.hosted`). Its source is filled from the route (the step-1 prefill mechanism, now derived from the route, not stored). The route also names the service: if the page is on another, the page remembers that service and reloads (the URL is already the tool route, so the reload lands back on it). Entering a hosted view for a different source than last time also reloads, so a tool never shows another source's results. DOM-free decisions (route grammar, which tools a source has, each tool's view and fill, group actions) live in tested `src/ui/` modules.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), vanilla DOM, esbuild, Vitest. No runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-ui-redesign-design.md` ("Steps" item 2; the tool table and routes under "Calls made for the builder"). Step 1's plan: `docs/superpowers/plans/2026-11-23-ui-redesign-step-1.md`.

## Global Constraints

- Zero runtime dependencies; no UI framework; self-hosted fonts only.
- Relative imports use `.js`. `src/ui/` must not import from `src/web/` (it is type-checked by the server tsconfig, without DOM).
- Artwork off by default (ADR-0004): the Favourites song list uses `coverSlot(url, seed)`.
- Every tool keeps every source and option it has today (spec anti-goal).
- The playlist editor's unsaved-draft guard stays in charge: every navigation is by hash.
- Every step ends with `npm test` and `npm run typecheck` green.
- Commits: Conventional Commits (`ui`, `web`, `server`, `docs`), ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch `ui-redesign-2`, fast-forwarded to `main` at the end. Not pushed.

## Review Focus

- **A view that decides "am I shown?" from the hash** (managed, links, stats, upgrade, history did; accounts broke this way in step 1): after this step none compares `location.hash` to a literal. (Task 2 grep step.)
- **Re-entering a tool for another source** (Find repeats on playlist A, then on B): B's page shows no results of A. (Task 2 live step.)
- **A tool route for a playlist on another service than the remembered one, opened from a bookmark** (fresh page load): it lands on the tool with the playlist selected, after at most one reload, never a loop. (Task 2 live step.)
- **Group actions with playlists ticked on two services**: Remove artists is offered only for one service's playlists; Combine works across. (Task 5 test.)
- **The old tool addresses** (`#/deduplicate`, `#/playlist`, `#/managed`, ...) and in-app hand-offs that still set them (managed.ts `#/managed`, home paste box) land on the new routes with their fill intact. (Task 1 tests, Task 2 live step.)

---

## File Structure

- Modify `src/ui/routes.ts` (+ test): tool routes, `new`, `jobs`, `viewOf`, redirects for old tool hashes.
- Create `src/ui/tools.ts` (+ test): tool names, labels, which source has which, each tool's view and fill.
- Modify `src/ui/library.ts` (+ test): `groupActions`.
- Create `src/web/route-state.ts`: `currentRoute()`, `isViewShown(view)` for the view modules.
- Modify `src/web/main.ts`: hosting (context bar, `body.hosted`, fill from route, service switch, fresh-source reload).
- Modify `src/web/index.html`: context bar; `data-source-controls` on source pickers; `data-part` on import/export panels; Home without the directory; Jobs title.
- Modify `src/web/styles.css`: hosting rules, sidebar ticks and group bar, narrow top bar.
- Modify `src/web/playlist-page.ts`: actions become links to tool routes; `openTool` goes; Favourites songs.
- Modify `src/web/views/playlist-editor.ts`: action row to tool routes; Link opens the link dialog here.
- Modify `src/web/views/links.ts`: export `createLink(preset?: PlaylistId)`.
- Modify `src/web/views/{managed,links,stats,upgrade,history}.ts`: shown-checks through `isViewShown`.
- Modify `src/web/views/home.ts`: suggestions navigate to new routes.
- Modify `src/web/library.ts`, `src/web/shell.ts`: ticks, group bar, single tab, error state, unavailable note, menu closing, active top links.
- Modify `src/server/playlist-routes.ts` (+ test): `GET /api/manager/favourites`.
- Modify `README.md`, `CHANGELOG.md`.

---

### Task 1: Tool routes and the tool table

**Files:**
- Modify: `src/ui/routes.ts`, `src/ui/routes.test.ts`
- Create: `src/ui/tools.ts`, `src/ui/tools.test.ts`

**Interfaces:**
- Produces (routes.ts):
  ```ts
  export type Route =
    | { kind: "home" }
    | { kind: "playlist"; id: PlaylistId; tool?: SourceTool }
    | { kind: "favourites"; service: ServiceName; tool?: SourceTool }
    | { kind: "all"; service: ServiceName; tool?: SourceTool }
    | { kind: "new"; tool: NewTool }
    | { kind: "jobs" }
    | { kind: "settings" }
    | { kind: "view"; view: string };
  /** The page section (`view-<name>`) a route shows. */
  export function viewOf(route: Route): string;
  /** Old address -> current one; `service` is where source-less old tool addresses go (their Favourites). */
  export function redirectFor(hash: string, service?: ServiceName): string | undefined;
  ```
- Produces (tools.ts):
  ```ts
  export const SOURCE_TOOLS = ["repeats", "upgrade", "stats", "export", "similar", "combine"] as const;
  export type SourceTool = (typeof SOURCE_TOOLS)[number];
  export const NEW_TOOLS = ["artists", "albums", "similar", "word-play", "combine", "import"] as const;
  export type NewTool = (typeof NEW_TOOLS)[number];
  export type Source = { kind: "playlist"; id: PlaylistId } | { kind: "favourites" } | { kind: "all" };
  export interface Fill { view: string; fields?: Record<string, string>; radios?: Record<string, string> } // same shape as web Prefill
  export function toolsFor(source: Source["kind"]): SourceTool[];
  export function toolLabel(tool: SourceTool | NewTool, source?: Source["kind"]): string;
  export function sourceToolFill(tool: SourceTool, source: Source): Fill | undefined; // undefined: not offered for that source
  export function newToolView(tool: NewTool): string;
  ```

Values (copy from today's `renderOpenIn`, `showFavourites`, `showAllActions`; views: repeats `deduplicate`, upgrade `upgrade`, stats `stats`, export `import-export`, similar `similar`, combine `combine`; new: artists `playlist`, albums `albums`, similar `similar`, word-play `word-play`, combine `combine`, import `import-export`):
- playlist: repeats `{radios:{"dedup-source":"playlist"}, fields:{"dedup-playlist-select":id}}`, upgrade `{fields:{"upgrade-source":"playlist:"+id}}`, stats `{fields:{"stats-source":id}}`, export `{radios:{"ie-source":"playlist"}, fields:{"ie-export-playlist-select":id}}`, similar `{radios:{"similar-source":"playlist"}, fields:{"similar-source-link": link}}` where link is `https://play.qobuz.com/playlist/<short>` for Qobuz else the tagged id (as `playlistLink`), combine `{fields:{"combine-source-first":id}}`.
- favourites: repeats `dedup-source=favourites`, upgrade `upgrade-source=favourites`, stats `stats-source=favourites`, export `ie-source=favourite-tracks`.
- all: repeats `dedup-source=all-playlists`, upgrade `upgrade-source=all-playlists`, stats `stats-source=everything`, export `ie-source=all-playlists`.
- Labels: repeats "Find repeats" ("Find repeats across them" for all), upgrade "Upgrade" ("Upgrade all"), stats "Stats", export "Export" ("Export all"), similar "Similar artists", combine "Combine"; new: "Playlist from artists", "Playlist from albums", "Similar artists", "Word play", "Combine playlists", "Import a file".

Hashes: `#/p/<id>/<tool>`, `#/favourites/<svc>/<tool>`, `#/all/<svc>/<tool>`, `#/new/<tool>`, `#/jobs`. An unknown tool word after a valid source is the source without a tool. `viewOf`: home `home`; playlist/all without tool `playlists`; favourites without tool `favourites`; with a tool, the tool's view; new: its view; jobs `managed`; settings `accounts`; view: itself if it is one of `new-releases`, `history`, `import-export`, else `home`.

- [ ] **Step 1: Write the failing tests** (routes.test.ts additions; keep step 1's tests, updating `redirectFor` calls that need a service):

```ts
it("reads tools on a source", () => {
  expect(parseRoute("#/p/12345/repeats")).toEqual({ kind: "playlist", id: "qobuz:12345", tool: "repeats" });
  expect(parseRoute("#/favourites/tidal/stats")).toEqual({ kind: "favourites", service: "tidal", tool: "stats" });
  expect(parseRoute("#/all/qobuz/upgrade")).toEqual({ kind: "all", service: "qobuz", tool: "upgrade" });
  expect(parseRoute("#/p/12345/nonsense")).toEqual({ kind: "playlist", id: "qobuz:12345" });
});
it("reads new-playlist tools and Jobs", () => {
  expect(parseRoute("#/new/artists")).toEqual({ kind: "new", tool: "artists" });
  expect(parseRoute("#/new/nonsense")).toEqual({ kind: "home" });
  expect(parseRoute("#/jobs")).toEqual({ kind: "jobs" });
});
it("round-trips tool routes", () => { /* playlist+tool, favourites+tool, all+tool, new, jobs through routeHash/parseRoute */ });
it("names the section each route shows", () => {
  expect(viewOf({ kind: "playlist", id: "qobuz:1" as PlaylistId })).toBe("playlists");
  expect(viewOf({ kind: "playlist", id: "qobuz:1" as PlaylistId, tool: "repeats" })).toBe("deduplicate");
  expect(viewOf({ kind: "favourites", service: "qobuz" })).toBe("favourites");
  expect(viewOf({ kind: "all", service: "qobuz", tool: "export" })).toBe("import-export");
  expect(viewOf({ kind: "new", tool: "artists" })).toBe("playlist");
  expect(viewOf({ kind: "jobs" })).toBe("managed");
  expect(viewOf({ kind: "view", view: "history" })).toBe("history");
  expect(viewOf({ kind: "view", view: "deduplicate" })).toBe("home");
});
it("sends old tool addresses to their new homes", () => {
  expect(redirectFor("#/playlist")).toBe("#/new/artists");
  expect(redirectFor("#/word-play")).toBe("#/new/word-play");
  expect(redirectFor("#/combine")).toBe("#/new/combine");
  expect(redirectFor("#/managed")).toBe("#/jobs");
  expect(redirectFor("#/deduplicate", "tidal")).toBe("#/favourites/tidal/repeats");
  expect(redirectFor("#/upgrade", "qobuz")).toBe("#/favourites/qobuz/upgrade");
  expect(redirectFor("#/stats")).toBe("#/");
  expect(redirectFor("#/import-export")).toBeUndefined();
  expect(redirectFor("#/new-releases")).toBeUndefined();
});
```

tools.test.ts:

```ts
it("offers each source its tools", () => {
  expect(toolsFor("playlist")).toEqual(["repeats", "upgrade", "stats", "export", "similar", "combine"]);
  expect(toolsFor("favourites")).toEqual(["repeats", "upgrade", "stats", "export"]);
  expect(toolsFor("all")).toEqual(["repeats", "upgrade", "stats", "export"]);
});
it("fills a tool for a playlist", () => {
  expect(sourceToolFill("repeats", { kind: "playlist", id: "tidal:x" as PlaylistId })).toEqual({
    view: "deduplicate", radios: { "dedup-source": "playlist" }, fields: { "dedup-playlist-select": "tidal:x" },
  });
  expect(sourceToolFill("similar", { kind: "playlist", id: "qobuz:12" as PlaylistId })?.fields).toEqual({
    "similar-source-link": "https://play.qobuz.com/playlist/12",
  });
});
it("fills Favourites and All playlists", () => {
  expect(sourceToolFill("stats", { kind: "all" })).toEqual({ view: "stats", fields: { "stats-source": "everything" } });
  expect(sourceToolFill("export", { kind: "favourites" })).toEqual({ view: "import-export", radios: { "ie-source": "favourite-tracks" } });
});
it("offers nothing a source cannot do", () => {
  expect(sourceToolFill("combine", { kind: "favourites" })).toBeUndefined();
});
it("labels tools for their source", () => {
  expect(toolLabel("repeats", "all")).toBe("Find repeats across them");
  expect(toolLabel("artists")).toBe("Playlist from artists");
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui` — Expected: FAIL (new exports missing).
- [ ] **Step 3: Implement** `tools.ts` and the routes changes. `routes.ts` imports the tool types from `tools.ts`; `tools.ts` imports nothing from routes.
- [ ] **Step 4: Run** `npx vitest run src/ui` — Expected: PASS. Then `npm run typecheck`: `main.ts`'s own `viewOf` and the `redirectFor` call still compile (replace main's `viewOf` with the imported one now; pass `chosenService()` resolved to a connected service as `redirectFor`'s second argument).
- [ ] **Step 5: Commit** `feat(ui): routes for tools on a source, new playlists and Jobs`.

---

### Task 2: Hosting tools in context

**Files:**
- Create: `src/web/route-state.ts`
- Modify: `src/web/main.ts`, `src/web/index.html`, `src/web/styles.css`, `src/web/playlist-page.ts`, `src/web/views/playlist-editor.ts`, `src/web/views/playlists.ts`, `src/web/views/{managed,links,stats,upgrade,history,home}.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `route-state.ts`: `currentRoute(): Route` (`parseRoute(location.hash)`), `isViewShown(view: string): boolean` (`viewOf(currentRoute()) === view`).
  - `playlist-page.ts`: `openTool` removed; action rows render `<a class="action" href=…>` links built from `toolsFor` / `toolLabel` / `routeHash`.

Markup: at the top of `<main>`, after `#notices`:
```
<nav id="context-bar" class="context-bar" hidden>
  <a id="context-back" href="#/">← <span id="context-name"></span></a>
  <span id="context-cover" class="gen-cover context-cover" aria-hidden="true"></span>
  <h1 id="context-title"></h1>
</nav>
```
`data-source-controls` on: the dedup source radios' container and `#dedup-playlist-fields`; upgrade's "Check" `label.field`; stats' `label.stats-source`; the import/export `ie-source` radios' container and `#ie-export-playlist-fields`; similar's source radios and link/playlist fields; combine's `#combine-source-list` first row is left visible (combine needs more sources added) — only its heading text changes. `data-part="export"` / `data-part="import"` on the two import/export panels.

CSS: `body.hosted .view:not([hidden]) > .view-header .view-title, body.hosted [data-source-controls] { display: none; }` (keep `.steps`); `body.hosted[data-hosted-part="export"] [data-part="import"], body.hosted[data-hosted-part="import"] [data-part="export"] { display: none; }`; `.context-bar` a compact row (32px cover, back link, 28px title), tinted with the source's `glowBackground`.

- [ ] **Step 1: `route-state.ts`** and switch every hash-literal shown-check to `isViewShown`: `managed.ts:125` and `links.ts:87` (`"managed"`), `stats.ts:59` (`"stats"`), `upgrade.ts:69` (`"upgrade"`), `history.ts:66-69` (`isShown(view)` -> `isViewShown(view)`), and `accounts.ts`'s `onSettings` (-> `isViewShown("accounts")`).
- [ ] **Step 2: Verify** `grep -n 'location.hash' src/web/views/*.ts | grep -v 'location.hash = '` — Expected: only `playlist-editor.ts`'s guard (it compares whole hashes, not view names).
- [ ] **Step 3: Hosting in `main.ts` `route()`**, after redirects: for a route with a tool (`playlist|favourites|all` with `tool`, or `new`):
  1. The service it works on: playlist -> `serviceOf(id)`; favourites/all -> `service`; new -> the current tab if it is one service, else `chosenService()` resolved to a connected one.
  2. If that differs from `chosenService()` resolved: `rememberService(service)`; `location.reload()`; return.
  3. If `hostedLast.get(view)` is set and differs from `location.hash`: `hostedLast.set(view, location.hash)` in sessionStorage (key `crosstune:hosted`), `location.reload()`; return. (Read `hostedLast` from sessionStorage on load; storage failures mean no fresh-source reload.)
  4. `hostedLast.set(view, location.hash)`; `storePrefill(fill)` then `applyPrefill(view)` (for source tools `sourceToolFill`; new tools have no fill, but a fill stored by the home paste box for that view still applies).
  5. `document.body.classList.add("hosted")`; `dataset.hostedPart` = `"export"` for the export tool, `"import"` for new/import, else removed; fill the context bar: back link to the source's own route (`#/p/<id>`, `#/favourites/<svc>`, `#/all/<svc>`; `#/` for new), name (playlist name from `knownPlaylist`, else "Favourites"/"All playlists"/"New playlist"), cover/glow from `generatedCover(name)`, title `toolLabel(tool, source)`.
  For any other route: remove `hosted`, hide the context bar.
- [ ] **Step 4: Navigations to the new routes.** Editor action row (`renderActions`) and More items: Find repeats, Upgrade, Stats, Export, Similar artists, Combine become `leaveFor(routeHash({ kind: "playlist", id, tool }))` (the draft check stays; `leaveFor` takes a hash and sets it after `closeEditor`); Link calls `createLink(id)` (Task 3). Favourites and All pages: links to `#/favourites|all/<svc>/<tool>`. `views/home.ts` suggestions: `storePrefill(prefill)` then `location.hash` = the new route for that view (artists -> `#/new/artists`, albums -> `#/new/albums`, similar -> `#/new/similar`; the playlist ones -> `#/p/<id>/<tool>` with no stored fill). `views/playlists.ts` `route()`: open the editor only for a playlist route **without** a tool.
- [ ] **Step 5: Home and Jobs.** Remove `.tool-groups` from Home (and its CSS); Home keeps the paste box and the last change. `view-managed`'s title becomes "Jobs" with a lede naming managed playlists, tidy-ups and linked playlists. Top bar Jobs link `#/jobs`; + New items `#/new/<tool>`, and "Managed playlist" `#/jobs`.
- [ ] **Step 6: Verify** `npm run typecheck && npm test` green; build; serve; drive (writes nothing):
  - remembered Qobuz; open a TIDAL playlist; click Find repeats -> one reload, `#/p/tidal…/repeats`, `#dedup-playlist-select` is that playlist, context bar shows its name, the source radios are hidden;
  - back; open a Qobuz playlist; Find repeats -> reload (service), select is the Qobuz playlist; then Find repeats on another Qobuz playlist -> reload (fresh source), the old scan results (if any) gone;
  - load `#/p/<tidal id>/stats` directly in a fresh page with Qobuz remembered -> lands on Stats for it after one reload (count `performance.getEntriesByType("navigation")` / reloads; must not loop);
  - `#/deduplicate` -> `#/favourites/<svc>/repeats`; `#/managed` -> `#/jobs` and Jobs shows its lists; Home has no directory.
  Screenshot each hosted tool and look.
- [ ] **Step 7: Commit** `feat(web): tools open inside the page they act on`.

---

### Task 3: Linking from the playlist

**Files:**
- Modify: `src/web/views/links.ts` (`createLink(preset?: PlaylistId)` exported; preset selects that playlist in its service's select and fills the name with its name), `src/web/views/playlist-editor.ts` (Link action), `src/web/library.ts` (refresh after a link: listen to `LINKS_CHANGED`, already does).

- [ ] **Step 1: Implement**; the dialog's existing validation (two services at least) is unchanged. After a link is made from the editor, `renderHead()` runs again (the eyebrow shows "⇄ <services>").
- [ ] **Step 2: Verify** typecheck + tests; live: click Link on a playlist, the dialog opens with it selected and named; **cancel** (writes nothing).
- [ ] **Step 3: Commit** `feat(web): link a playlist from its page`.

---

### Task 4: Favourites lists its songs

**Files:**
- Modify: `src/server/playlist-routes.ts`, `src/server/playlist-routes.test.ts`, `src/web/playlist-page.ts`, `src/web/index.html` (`#fav-songs` list, `#fav-status`)

**Interfaces:**
- Produces: `GET /api/manager/favourites` -> `{ tracks: Track[] }` (the service's `getFavoriteTracks()`, unchanged, full tracks).

- [ ] **Step 1: Write the failing test** in `playlist-routes.test.ts` `describe("reading")`:

```ts
it("lists the favourite tracks in full", async () => {
  const world = setup();
  world.account.favourites.tracks = [qid(7)];
  const res = await world.call("GET", "favourites");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ tracks: [{ id: qid(7), title: "Track 7", duration: 3 }] });
  expect(world.acquireWriteLock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `npx vitest run src/server/playlist-routes.test.ts -t "favourite tracks in full"` — Expected: FAIL (404/unknown route).
- [ ] **Step 3: Implement** `case "GET favourites"` in `read()`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: The page.** `showFavourites(service)` fetches it with `api(..., service)`, and lists rows: `coverSlot(track.image, track.album ?? track.title)`, title (+version), artist · album, quality pill (reuse the `quality` badge helper the editor rows use, from `tracks.ts` if exported, else the same markup), duration. "Reading your favourites..." while loading; errors shown in `#fav-status`. Re-read on each visit to the page.
- [ ] **Step 6: Verify** typecheck + tests; live: `#/favourites/qobuz` lists songs; screenshot.
- [ ] **Step 7: Commit** `feat(web): Favourites lists its songs`.

---

### Task 5: Ticking playlists in the sidebar

**Files:**
- Modify: `src/ui/library.ts`, `src/ui/library.test.ts`, `src/web/library.ts`, `src/web/index.html` (`#lib-group` bar at the sidebar's foot), `src/web/styles.css`, `src/web/views/playlists.ts` (export `startRemoveArtists(ids: readonly PlaylistId[])`: ticks them on the `#/all/<svc>` list and opens its Remove artists panel), `src/web/views/combine.ts` (export `setSources(ids: readonly PlaylistId[])`)

**Interfaces:**
- Produces:
  ```ts
  export interface GroupActions { combine: boolean; removeArtists?: ServiceName; delete: boolean }
  /** What can be done with the ticked playlists: Combine with two or more; Remove artists when all are one service's and owned; Delete when all are owned. */
  export function groupActions(ticked: readonly { id: PlaylistId; owned: boolean }[]): GroupActions;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const own = (id: string, owned = true) => ({ id: id as PlaylistId, owned });
it("offers Combine for two or more, across services", () => {
  expect(groupActions([own("qobuz:1"), own("tidal:x")]).combine).toBe(true);
  expect(groupActions([own("qobuz:1")]).combine).toBe(false);
});
it("offers Remove artists only for one service's own playlists", () => {
  expect(groupActions([own("qobuz:1"), own("qobuz:2")]).removeArtists).toBe("qobuz");
  expect(groupActions([own("qobuz:1"), own("tidal:x")]).removeArtists).toBeUndefined();
  expect(groupActions([own("qobuz:1"), own("qobuz:2", false)]).removeArtists).toBeUndefined();
});
it("offers Delete only when every ticked playlist is the user's", () => {
  expect(groupActions([own("qobuz:1"), own("tidal:x")]).delete).toBe(true);
  expect(groupActions([own("qobuz:1", false)]).delete).toBe(false);
  expect(groupActions([]).delete).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui/library.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `groupActions`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: The sidebar.** Each playlist row gets a checkbox (shown on hover, focus, or while any is ticked; `aria-label="Tick <name>"`; clicking it does not navigate). Ticks survive tab switches and filtering and drop playlists that disappear on refresh. `#lib-group` shows "N ticked" and the offered actions: **Combine** (`setSources(ids)` then `#/new/combine`), **Remove artists** (`#/all/<svc>` then `startRemoveArtists(ids)`), **Delete** (one `confirmDelete`-style dialog listing the names, then `/api/manager/delete` per playlist with its own service, then refresh; failures listed), **Clear**.
- [ ] **Step 6: Verify** typecheck + tests; live: tick two playlists on different services -> Combine and Delete offered, Remove artists not; tick two Qobuz ones -> Remove artists opens the panel with both ticked; **close it**; Combine opens with both sources. Delete is not clicked. Screenshot.
- [ ] **Step 7: Commit** `feat(web): tick playlists in the sidebar to act on them together`.

---

### Task 6: Settle step 1's deferred minors

**Files:** `src/web/main.ts`, `src/web/shell.ts`, `src/web/library.ts`, `src/web/views/playlist-editor.ts`, `src/web/views/playlists.ts`, `src/web/views/managed.ts`, `src/web/index.html`, `src/web/styles.css`

- [ ] **Step 1:** No service connected: the Settings redirect checks `redirectFor(hash) ?? hash` (so `#/home` goes too).
- [ ] **Step 2:** Deleting from a playlist page navigates to `#/all/<svc>` (where "Deleted X. You can undo this in History." is shown), not `#/`.
- [ ] **Step 3:** One service connected: its single tab is shown (not hidden); `tabsFor` unchanged.
- [ ] **Step 4:** The sidebar keeps a read error ("Could not read your playlists: …") across re-renders, and names services listed in `unavailable` ("TIDAL could not be read just now.").
- [ ] **Step 5:** "+ New" closes on any item click (also when it is the current view).
- [ ] **Step 6:** Top bar: Jobs, History, Settings get `aria-current="page"` and an active style on their routes; below 760px the top bar wraps (tabs on a second row) and the sidebar becomes a collapsible block above the content (`<details>` "Your library", open by default on wide screens via CSS only).
- [ ] **Step 7:** "Accounts" -> "Settings" in `playlist-editor.ts` ("Connect another music service in Settings first."), `index.html` (links-need-two hint), `managed.ts`; remove unused imports (`storePrefill` in the editor if unused after Task 2, `readId` in `playlists.ts`).
- [ ] **Step 8: Verify** typecheck + tests; live screenshots at 1400px and 420px wide.
- [ ] **Step 9: Commit** `fix(web): the frame's loose ends`.

---

### Task 7: Docs, review, merge

**Files:** `README.md` (the web UI paragraph at "There is also a **local web UI**": describe the library-first page, tool pages inside a playlist, + New, Jobs, Settings; "Accounts page" mentions -> "Settings page"; History's location "under *Your data*" -> "in the top bar"), `CHANGELOG.md` (extend the step-1 `### Changed` entry: tools open inside their playlist, Favourites lists songs, tick playlists to combine/remove artists/delete, old addresses still work).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Verify** `npm test && npm run typecheck && npm run build`.
- [ ] **Step 3:** Whole-branch review (fresh reviewer); fix Critical/Important test-first (live check for glue); minors to the ledger.
- [ ] **Step 4:** Commit; `git checkout main && git merge --ff-only ui-redesign-2`.

---

## Deferred to step 3 (spec)

The ask box in the top bar (Home's paste box moves there), the one-time artwork question, playlist cover images in the three adapters, and (after its ADR) the cover proxy and tint from real covers.
