# Web UI redesign, step 3 (and the deferred issues) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle step 2's deferred issues, then finish the redesign: real playlist covers from the three services, the header tinted by the real cover, the one-time artwork question, and the ask box in the top bar (Home's paste box moves there).

**Architecture:** Pure decisions in `src/ui/` (tested): what the ask box suggests, the tint from a colour, whether to ask about artwork, the hosting decision extended to "all". Adapters gain an optional `Playlist.image`, parsed like album covers. The tint reads the header cover's pixels in the page: all three image servers answer CORS (`Access-Control-Allow-Origin: *`, probed live 2026-11-23 on static.qobuz.com, resources.tidal.com, i.scdn.co), so the cover is loaded with `crossOrigin = "anonymous"`, drawn to a small canvas and averaged — no proxy, no server change (ADR-0015, superseding the spec's proxy route).

**Tech Stack:** TypeScript, vanilla DOM, esbuild, Vitest. No runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-ui-redesign-design.md` ("Steps" item 3; "Artwork"; "Calls made": ask box, cover tint). Steps 1-2 plans beside this one.

## Global Constraints

- Zero runtime dependencies; relative imports `.js`; `src/ui/` imports nothing from `src/web/`.
- ADR-0004 holds: no image request while artwork is off; covers are https only; `referrerpolicy="no-referrer"`. ADR-0015 adds: the one header cover is requested in CORS mode (it carries `Origin: http://127.0.0.1:<port>`), only while artwork is on.
- Every reload goes through `reloadHere` (asks about unsaved previews).
- Every step ends with `npm test` and `npm run typecheck` green.
- Commits: Conventional Commits, ending with the two attribution lines (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, `Claude-Session: https://claude.ai/code/session_01JFarzu2rNzRnSxUqYuMgcc`).
- Branch `ui-redesign-3`, fast-forwarded to `main` at the end. Not pushed.

## Review Focus

- **Multi-line paste into the ask box** (a list of artists): newlines survive (a `<textarea>`, not an `<input>`), and Enter picks a suggestion rather than adding a line (Shift+Enter adds one). (Task 6 live step.)
- **A cover that fails to load or to be read** (404, CORS dropped one day, a tainted canvas): the header keeps the generated tint; no error thrown. (Task 4 step.)
- **Artwork question with nothing connected, or answered in another tab**: not shown with no service; shown once, never again after either answer. (Task 5 test.)
- **Spotify playlists' `images` is `null` for an empty playlist** (Web API behaviour): parsed as no image. (Task 3 test.)
- **The ask box while a playlist has an unsaved draft**: choosing a suggestion navigates by hash, so the draft guard asks. (Task 6 live step.)

---

### Task 1: Deferred issues: hosting and previews

**Files:** `src/ui/hosting-decision.ts` (+ test), `src/web/hosting.ts`, `src/web/main.ts`

- [ ] **Step 1: Failing tests** in `hosting-decision.test.ts`:
```ts
it("can ask for the page to be on all services (Combine under All)", () => {
  expect(hostingDecision({ ...base, target: "all", remembered: "qobuz" })).toEqual({ kind: "switch", to: "all" });
  expect(hostingDecision({ ...base, target: "all", remembered: "all" })).toEqual({ kind: "show", fill: true });
});
it("does not switch to all with fewer than two services", () => {
  expect(hostingDecision({ connected: ["qobuz"], hash: "#/new/combine", target: "all", remembered: "qobuz" })).toEqual({ kind: "show", fill: true });
});
```
(`target` and `switch.to` become `ServiceName | "all"`.)
- [ ] **Step 2: Run** `npx vitest run src/ui/hosting-decision.test.ts` — FAIL; **implement**; PASS.
- [ ] **Step 3: Glue.** `hostedBy` for `new/combine` under the All tab targets `"all"` (other new tools: unchanged). The stand-alone `#/import-export` page is tracked in `hostedHere` too (a bare host: no context bar, no `body.hosted`), so its results are cleared before `#/p/A/export` and back. `reloadHere`: if the address changed while its dialog was open (browser Back closed it through the draft guard), do not run `stay`. `unsavedPreviews`: a review counts only while its `.commit-bar` is shown and holds an enabled button; also count `#managed-form-panel` while shown, and the import box (`#ie-import-content` non-empty or a file chosen) while its preview is not yet committed.
- [ ] **Step 4: Verify** typecheck + tests; live: Find repeats with "no duplicates" then open another playlist's tool -> no question; Jobs' new-managed form open -> asked. **Commit** `fix(web): hosting's loose ends`.

### Task 2: Deferred issues: the rest

**Files:** `src/ui/tools.ts` (+ test), `src/web/views/playlist-actions.ts`, `src/web/main.ts`, `src/web/styles.css`, `src/web/library.ts`, `CLAUDE.md`

- [ ] **Step 1: Failing test:** `expect(toolLabel("stats", "all")).toBe("Library stats")` (it reads favourites and all playlists). Implement.
- [ ] **Step 2:** `playlistLink` lives in `src/ui/tools.ts` (exported); `playlist-actions.ts` re-exports it. `main.ts` header comment cites `#/p/<id>/repeats`, `#/new/artists`.
- [ ] **Step 3:** Touch screens (`@media (hover: none)`): the sidebar tick is always visible in its own column, not over the cover.
- [ ] **Step 4:** Group Delete: if the page shows a deleted playlist (its page or a tool on it), go to its service's `#/all/<svc>`.
- [ ] **Step 5:** `CLAUDE.md`: architecture lines for `hosting.ts`, `route-state.ts`, `src/ui/tools.ts`, `hosting-decision.ts`; commit it (it was untracked).
- [ ] **Step 6: Verify; commit** `fix(web): the deferred loose ends` and `docs: CLAUDE.md for the redesigned web UI`.

### Task 3: Playlist covers from the services

**Files:** `src/services/model.ts` (`Playlist.image?: string`, https only), `src/services/qobuz/models.ts` (+ test), `src/services/tidal/service.ts` and `models.ts` (+ tests), `src/services/spotify/models.ts` (+ test), `src/web/library.ts`, `src/web/playlist-page.ts`, `src/web/hosting.ts`, `src/web/artwork.ts`

- [ ] **Step 1: Failing parser tests**, one per service, from the shapes probed live:
  - Qobuz `getUserPlaylists` item with `images300: ["https://static.qobuz.com/.../a_300.jpg", ...]` -> `image` is the first; with `image_rectangle` only -> its first; neither -> none; an `http://` URL -> none.
  - TIDAL playlist resource with `relationships.coverArt.data: [{type:"artworks", id:"x"}]` and `included` artwork `{attributes:{mediaType:"IMAGE", files:[{href:"https://resources.tidal.com/.../160x160.jpg", meta:{width:160}}, {href:".../320x320.jpg", meta:{width:320}}]}}` -> the album rule (`coverOf`) picks the same size it picks for albums.
  - Spotify simplified playlist `images: [{url:"https://i.scdn.co/image/x", width: 640}]` -> that URL; `images: null` -> none.
- [ ] **Step 2: Run** the three model test files — FAIL. **Implement**: Qobuz parser; TIDAL's playlist listing requests `include: "coverArt"` and parses with `coverOf(resource, index)`; Spotify with its `coverOf`. Run — PASS; run the contract tests (`npx vitest run src/services`).
- [ ] **Step 3: Page.** A shared `artworkInto(slot: HTMLElement, url: string | undefined)` in `artwork.ts` (adds the lazy `data-src` `<img>` exactly as `coverSlot` does) used for the sidebar's 26px covers, the playlist hero, and the context bar. Covers stay generated until artwork is on.
- [ ] **Step 4: Verify** typecheck + tests; live (artwork on, then off): Qobuz and TIDAL playlists show real covers; with it off, `document.querySelectorAll('img[src]').length === 0`. **Commit** `feat: playlist covers from Qobuz, TIDAL and Spotify`.

### Task 4: The header tinted by the real cover (ADR-0015)

**Files:** `docs/adr/0015-cover-tint-in-the-page.md`, `docs/adr/0004-optional-artwork.md` (no edit: immutable; 0015 records the change), `src/ui/cover-art.ts` (+ test), `src/web/artwork.ts`, `src/web/playlist-page.ts`, `src/web/hosting.ts`

**Interfaces:** `export function coverFromColour(rgb: { r: number; g: number; b: number }): GeneratedCover` (hue from the colour; saturation and lightness clamped so the glow stays visible on near-black and white text stays readable; a grey colour gets a neutral hue).

- [ ] **Step 1: ADR-0015** (accepted, 2026-11-23): context (the spec's tint; probe results); decision (read the header cover in the page via CORS; only the header cover, only while artwork is on; average of an 8x8 draw; fall back to the name's colours on any failure); alternatives (the local proxy of ADR-0004's alternatives: more code, binary responses through the thin glue, same CDN contact; no tint from real covers); consequences (the header cover request carries `Origin`; if an image server drops CORS, the tint silently falls back).
- [ ] **Step 2: Failing tests:**
```ts
it("takes the hue of a cover's colour", () => {
  expect(coverFromColour({ r: 200, g: 40, b: 40 }).hue).toBe(0);
  expect(coverFromColour({ r: 40, g: 40, b: 200 }).hue).toBe(240);
});
it("keeps a dark or washed-out cover's glow visible", () => {
  const c = coverFromColour({ r: 10, g: 12, b: 30 });
  expect(c.colours[0]).toMatch(/^hsl\(\d+ (\d+)% (\d+)%\)$/);
  const [, s, l] = /^hsl\(\d+ (\d+)% (\d+)%\)$/.exec(c.colours[0])!.map(Number);
  expect(s).toBeGreaterThanOrEqual(45); expect(l).toBeGreaterThanOrEqual(50);
});
it("gives a grey cover a neutral, low-saturation glow", () => {
  const [, s] = /^hsl\(\d+ (\d+)%/.exec(coverFromColour({ r: 128, g: 128, b: 128 }).colours[0])!.map(Number);
  expect(s).toBeLessThanOrEqual(20);
});
```
- [ ] **Step 3: Run** — FAIL; **implement**; PASS.
- [ ] **Step 4: Glue.** `artwork.ts`: `readCoverColour(url): Promise<{r,g,b} | undefined>` (an `Image` with `crossOrigin="anonymous"`, `referrerPolicy="no-referrer"`, drawn to an 8x8 canvas, averaged; any error or taint -> undefined; only while artwork is on). The playlist hero and context bar repaint their glow from `coverFromColour` when it resolves, if still on the same playlist.
- [ ] **Step 5: Verify;** live: artwork on, a Qobuz playlist's header glow follows its cover (screenshot); artwork off: no request. **Commit** `feat(web): tint the header from the real cover (ADR-0015)`.

### Task 5: The one-time artwork question

**Files:** `src/ui/artwork-question.ts` (+ test), `src/web/artwork.ts`, `src/web/main.ts`, `src/web/index.html` (`#artwork-ask` banner at the top of `<main>`), CSS

**Interfaces:** `export function shouldAskArtwork(stored: string | null, asked: string | null, connected: number): boolean` — true only when no choice is stored (`"on"`/`"off"`), not asked before, and at least one service connected.

- [ ] **Step 1: Failing tests:** stored "on"/"off" -> false; asked "yes" -> false; connected 0 -> false; all clear -> true.
- [ ] **Step 2:** Run FAIL; implement; PASS.
- [ ] **Step 3: Banner:** "Show album covers? They load from Qobuz, TIDAL and Spotify's image servers, which tells them which albums you look at. Until then covers are drawn from names, and nothing leaves this computer." Buttons **Show covers** / **Not now**. Either stores the choice (`crosstune:show-artwork` on/off) and `crosstune:artwork-asked=yes`, applies it (the Settings checkbox follows), and hides the banner. Storage failures: the banner hides for this page.
- [ ] **Step 4: Verify;** live in a fresh profile: banner shown; Not now -> gone after reload; Settings checkbox still works. **Commit** `feat(web): ask once about album covers`.

### Task 6: The ask box

**Files:** `src/ui/ask.ts` (+ test), `src/web/ask.ts` (new glue), `src/web/index.html` (`<textarea id="ask" rows="1">` in the top bar after the tabs, with `#ask-menu` listbox; Home loses `.paste-hero`, gains `#home-recent`), `src/web/views/home.ts` (Home: last change + recently changed playlists), `src/web/main.ts`, CSS

**Interfaces:**
```ts
export interface AskContext {
  playlists: readonly { id: PlaylistId; name: string; owned: boolean }[];
  /** The playlist whose page is open, if any (tools on it come first). */
  open?: PlaylistId;
  /** The service Favourites tools go to. */
  service?: ServiceName;
}
export interface AskSuggestion { label: string; hash: string; fill?: Fill }
export function askSuggestions(text: string, context: AskContext): AskSuggestion[];
```
Rules, in order, at most 8: (1) pasted links/lists exactly as Home's paste box does today (`classifyPaste` from `features/music-links.ts`; move `suggestionsFor` out of `views/home.ts`), with the playlist tools only for the user's own; (2) one line of text: playlists whose name contains it (case-insensitive, up to 5) -> "Open <name>" `#/p/<id>`; (3) tools whose label contains it ("repeats", "upgrade", "stats", "export", "similar", "combine", "artists", "albums", "word play", "import", "jobs", "history", "settings"): a source tool on the open playlist if any, else on the service's Favourites; new tools `#/new/<tool>`; Jobs/History/Settings their routes; (4) a single line with no match -> "Build a playlist from artist “<text>”" (`#/new/artists` with the line filled).

- [ ] **Step 1: Failing tests** (`ask.test.ts`): a Spotify playlist link -> first "Similar artists from this playlist"; two artist lines -> first "Build a playlist from these artists" with `fill.fields.artists` both lines; "tech" with a playlist "Techno" -> "Open Techno" `#/p/<id>`; "repeats" with `open` set -> `#/p/<open>/repeats`, without -> `#/favourites/<service>/repeats`; "word" -> `#/new/word-play`; "history" -> `#/history`; "zzz" -> the artist fallback; empty text -> `[]`; never more than 8.
- [ ] **Step 2:** Run FAIL; implement; PASS.
- [ ] **Step 3: Glue.** The box grows to 4 lines while focused; suggestions in a listbox under it; ArrowUp/Down move, Enter picks the highlighted (first by default), Shift+Enter is a newline, Escape closes; picking stores `fill` (prefill) and sets the hash, then clears the box. `Ctrl+K` (and `/` when focus is not in a field) focuses it. Home: no paste hero; "Recently changed" (6 playlists, generated or real covers, linking to their pages) above the last change.
- [ ] **Step 4: Verify;** live: paste two artists (newlines kept), Enter -> `#/new/artists` with both lines; type "tech" -> Open Techno; with a draft in the editor, picking a suggestion asks first. **Commit** `feat(web): the ask box`.

### Task 7: Docs, review, merge

- [ ] README: Web UI section (ask box replaces "the page shows a paste box"; covers: the one-time question, real playlist covers, tint); CHANGELOG `[Unreleased]` (Added: the ask box, playlist covers, cover tint, the artwork question; Fixed/Changed: step 2's deferred issues by symptom). Spec: no edit (its proxy route is superseded by ADR-0015).
- [ ] Verify `npm test && npm run typecheck && npm run build`; whole-branch review (fresh reviewer); fix Critical/Important test-first (live for glue); merge `--ff-only`.
