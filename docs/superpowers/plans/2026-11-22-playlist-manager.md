# Playlist manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Playlists view that opens a playlist as an editable draft (bulk select, drag, sort, remove by artist), saves it in one undoable step, plus artist removal across playlists and on the CLI.

**Architecture:** Pure modules shared by page and server (`playlist-order`, `playlist-draft`, `artist-match`); `playlist-manager` composes them with the client (resolve/commit); routes in a new `src/server/playlist-routes.ts`; a thin view. History gains exact reorder undo by backwards replay.

**Tech Stack:** TypeScript (NodeNext, strict), Vitest, esbuild; no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-playlist-manager-design.md`

**Execution:** native, in this session (the user said to go ahead and build).

## Global Constraints

- No runtime dependency; `.js` import extensions; `noUncheckedIndexedAccess`.
- `npm test`, `npm run typecheck`, `npm run build` pass before a task is done.
- Nothing is written to the open playlist before Save; a move adds (confirmed by reading back) before it removes; reordering never re-adds.
- Entries are keyed by playlist-track id. Reorder blocks hold at most 200 ids.
- Modules imported by the page must not import Node modules.
- Conventional Commits; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A playlist holding the same track twice: selecting, moving, removing and undoing one copy leaves the other alone (Tasks 4, 6, 7).
- Unplayable songs: a move keeps them here; undo reports them and still restores the rest in place (Tasks 4, 7).
- A playlist changed on the phone between open and Save: nothing is written, and the draft can be rebased (Tasks 6, 7).
- Removing every song / "keep only" with a typo in every name: not a silent wipe (Tasks 5, 6).
- Names with accents, non-Latin scripts, punctuation-only titles ("!!!"), and credits holding " - " or stray `\r` (Tasks 1, 2, 5).

---

### Task 1: Non-Latin titles are not all the same song

**Files:** Modify `src/features/deduplicate.ts` (`normalise`, `trackSignature`); test `src/features/deduplicate.test.ts`.

- [ ] Failing tests: `findDuplicateGroups` on a Cyrillic and a Japanese song with different ISRCs returns `[]`; same for titles `"?"` and `"!!!"` by one artist; `normalise("がんばれ") === "がんばれ"`; `normalise("Beyoncé") === "beyonce"` still.
- [ ] Implement: keep `\p{L}\p{M}\p{N}`, strip U+0300-036F only, recompose with NFC; `trackSignature` falls back to the trimmed lower-cased text when a side normalises to nothing.
- [ ] Tests pass; commit `fix(deduplicate): tell songs with non-Latin titles apart`.

### Task 2: Client and models

**Files:** Modify `src/qobuz/{models,client,endpoints,index}.ts` and tests; `src/features/journal.ts` (`MUTATING_METHODS`, wrapper in Task 4).

**Produces:**
- `Playlist` + `description?, isPublic?, isCollaborative?, duration?, updatedAt?` (ISO) `, ownerId?`
- `Track` + `addedAt?` (ISO, from `created_at` when `playlist_track_id` is present), `joint?: string[]`, `guests?: string[]`
- `parseCredits(performers: string, main?: string): { joint: string[]; guests: string[] }`
- `QobuzClient.updatePlaylist(playlistId: number, changes: { name?: string; description?: string; isPublic?: boolean }): Promise<Playlist>`

- [ ] Failing tests: `parseCredits("Portishead, MainArtist - Guest, FeaturedArtist\r - X, Composer", "Portishead")` is `{joint: [], guests: ["Guest"]}`; `"Main Artist"`/`"Featured Artist"` spellings; a name holding a comma-free role-less part is ignored; playlist fields parsed; `updatePlaylist` sends only the given fields, throws on non-OK.
- [ ] Implement, pass, commit `feat(qobuz): update playlists; read credits, added dates and playlist details`.

### Task 3: Planning an order

**Files:** Create `src/features/playlist-order.ts` + test; modify `fake-account.test-support.ts` to use `applyMove`.

**Produces:**
- `interface OrderMove { playlistTrackIds: number[]; insertBefore: number }`
- `applyMove(ids: readonly number[], moved: readonly number[], insertBefore: number): number[]` -- Qobuz's semantics: sent order, after the unmoved entries ahead of `insertBefore`.
- `planOrder(current: readonly number[], wanted: readonly number[], blockSize = 200): OrderMove[]` -- throws unless both hold the same ids.

- [ ] Failing tests: the three live observations as fixtures; one drag is 1 move; a block of 5 scattered to the top is 1 move; a reversal of 1,400 is 7 moves; property test over 300 random permutations (seeded): applying the moves gives `wanted`, no move anchors on a moved id, and the count is at most `ceil(n / 200)`.
- [ ] Implement (LIS; group movers sharing a successor; else window blocks, first to last, each before the entry after the window). Pass, commit `feat(playlists): plan the moves that reorder a playlist`.

### Task 4: History records enough to undo a reorder exactly

**Files:** Modify `src/features/{history,journal,undo}.ts` and tests.

**Consumes:** `applyMove`, `planOrder`. **Produces:**
- `move-tracks` op gains `from?: number[]` (parallel to `playlistTrackIds`); new op `{ kind: "update-playlist"; playlistId; playlistName?; before: PlaylistDetails; after: PlaylistDetails }` with `PlaylistDetails = { name?, description?, isPublic? }`; tool name `"playlist-manager": "Playlist manager"`.
- The recorder reads before a move when it has no snapshot, records `from`, and keeps the snapshot by `applyMove`; a failed move drops it.
- Undo steps `restore-tracks` (append only), `remove-tracks` (with `trackIds`), `reorder-playlist`, `update-playlist`; restores run first; a song not restored is not removed from where the entry put it.

- [ ] Failing tests: save-shaped entry (remove, move, move) undone to the exact original track order, and redone; a random property test (remove/add/move sequences through the recorder, then undo equals the start, with repeated tracks); undo of a 300-scattered removal makes at most 2 reorder requests; unplayable track (fake `unplayable` set that add ignores) reported, the rest in place; undoing a move between playlists where the restore fails keeps the destination copy; old `move-tracks` records without `from` still say "order ... not restored"; rename undone.
- [ ] Update existing undo tests whose step shapes changed, keeping their end-state assertions.
- [ ] Implement, pass, commit `feat(history): undo reorders exactly, and renames`.

### Task 5: Matching artists

**Files:** Create `src/features/artist-match.ts` + test (no Node imports).

**Produces:**
- `interface ArtistTerm { line: string; name?: string; id?: number; pattern?: RegExp }`
- `parseArtistTerms(lines, links?: ReadonlyMap<string, Artist>): { terms: ArtistTerm[]; problems: string[] }`
- `matchArtists(tracks, terms): { perTerm: { line; main: number[]; guest: number[]; suggestion?: { name; count } }[] }` -- numbers are indexes into `tracks`
- `artistCounts(tracks): { name; id?; count }[]`; `resolveArtistLinks(client, lines)` is in Task 7.

- [ ] Failing tests: accents and case; `/regex/`; invalid regex is a problem; joint main counts as main; guest by credit and by "feat. X" / "ft. X" / "(with X)" is not counted twice; link matches by id, credits by name; suggestion "Radiohed" -> Radiohead, none for something unlike everything; blank and repeated lines ignored.
- [ ] Implement, pass, commit `feat(playlists): match a list of artists against songs`.

### Task 6: The draft

**Files:** Create `src/features/playlist-draft.ts` + test (no Node imports).

**Produces:** `Entry` (Track with `playlistTrackId`), `Draft { base: number[]; order: number[]; removed: ReadonlyMap<number, Destination | undefined> }`; `Destination = { type: "existing"; playlistId; name } | { type: "new"; name; isPublic }`; `startDraft(entries)`, `removeEntries`, `moveOut`, `putBack` (to its place by base neighbours), `moveTo(draft, ids, index)` (index counted in the current order), `moveBy(draft, ids, delta)`, `setOrder(draft, ids)` (whole order, or rearranged within the places a subset occupies), `sortIds(entries, key, direction)`, `shuffleIds`, `spreadArtists`, `quickSelect(entries, kind, options)`, `rangeBetween(shown, a, b)`, `summarise(draft)` -> `{ removed; moved: [{destination, count}]; reordered; isChanged }`, `rebase(draft, fresh: number[])` -> `{ draft, added, gone, reordered }`, `History<T>` class with `push/undo/redo`.

- [ ] Failing tests for each, including: duplicates of one track id move independently; `moveTo` of a scattered selection keeps its order and lands where dropped; `putBack` after neighbours moved; sort is stable and puts missing values last; `spreadArtists` has no adjacent repeats when possible and keeps every entry; `rebase` drops gone ids, places new ones after their predecessor, keeps removals; `reordered` counts only moved entries (minimum), not everything after a removal.
- [ ] Implement, pass, commit `feat(playlists): edit a playlist as a draft`.

### Task 7: Opening, saving, and the immediate actions

**Files:** Create `src/features/playlist-manager.ts` + test.

**Produces:**
- `listPlaylists(client, ownerId?)`; `openPlaylist(client, id, ownerId?)` -> `{ playlist, tracks, duplicates: number[] }` (entry ids after the first of each song)
- `SaveRequest { playlistId; base: number[]; order: number[]; remove: number[]; moves: { destination; entries: number[] }[] }`; `saveProblem(request): string | undefined`; `savePlaylist(client, request)` -> `{ status: "changed"; fresh: number[] } | { status: "saved"; removed; reordered; moved: MovedReport[]; kept: {trackId, title}[]; failed?: { step, reason } }`
- `copyEntries(client, playlistId, entryIds, destination)`, `duplicatePlaylist(client, id, name)`, `resolveRemoveArtists(client, playlistIds, lines, {includeGuests})`, `commitRemoveArtists(client, items)`, `resolveArtistLinks(client, lines)`
- All adds go through one helper that never repeats a track id within a request and confirms by reading back.

- [ ] Failing tests with `FakeAccount`: save removes and reorders to exactly the wanted order; stale base writes nothing; inconsistent requests refused; move adds before removing, keeps an unplayable song, skips one already there but removes it here, keeps all when the add fails, and creates a new playlist; a failing reorder reports removals done; duplicates kept separate; duplicate playlist keeps repeated songs; one unreadable playlist in artist removal is reported and the rest go.
- [ ] Implement, pass, commit `feat(playlists): open, save, copy, duplicate, and remove artists`.

### Task 8: Routes

**Files:** Create `src/server/playlist-routes.ts` + test; modify `router.ts` (dispatch, `WRITE_ROUTES`, `QobuzApiService.updatePlaylist/getPlaylist`, `SessionInfo`-side `ownerId?`, `ApiDeps.exclusive?`), `src/cli.ts` (wire `ownerId`, `exclusive` around `jobs.lock`).

Routes: `GET /api/manager/playlists`; `POST /api/manager/{open,artist-links,remove-artists/resolve}` (reads); `POST /api/manager/{save,copy,favourite,update,duplicate,delete,remove-artists/commit}` (writes, tool `playlist-manager`, under `exclusive`, 409 when busy). Playlists carry `managed?: { jobName; mode: "respect" | "mirror" | "tidy" }` and `readBy: string[]`.

- [ ] Failing tests: each route's happy path, validation (400), stale save (409 with `fresh`), busy (409), not-owned (403 for writes), mirror destination refused (400), one history entry per save, no lock taken on reads.
- [ ] Implement, pass, commit `feat(server): playlist manager routes`.

### Task 9: CLI

**Files:** Modify `src/cli/args.ts` + test, `src/cli.ts`.

**Produces:** `parseRemoveArtistsArgs(argv): { playlists: number[]; allPlaylists: boolean; artists: string[]; includeGuests: boolean; apply: boolean }`; `formatRemoveArtists(plan)` in `playlist-manager.ts`.

- [ ] Failing tests for parsing (both and neither of `--playlist` / `--all-playlists` refused; links accepted) and the report; implement; commit `feat(cli): remove artists from playlists`.

### Task 10: The view

**Files:** Create `src/web/views/playlists.ts`, `src/web/views/playlist-editor.ts`, `src/web/drag-list.ts`; modify `index.html`, `main.ts` (route `#/playlists` and `#/playlists/<id>`, unsaved guard), `styles.css`, `api.ts`, `prefill.ts` users.

- [ ] Build per spec sections 3.1-3.7; typecheck and build pass.
- [ ] Check in headless Chromium against a stub API with 1,400 rows: drag, shift-select, keyboard, search + select all, undo/redo, save, stale save, narrow width, console errors. Commit `feat(web): playlists view`.

### Task 11: Live check, docs, review

- [ ] Live, scratch playlists only: the list in spec section 6; delete them; confirm the playlist count is unchanged.
- [ ] README, CHANGELOG (Added; Fixed: non-Latin matching, undo order), `docs/adr/0009-playlist-drafts-and-reorder-undo.md`. Commit `docs: playlist manager; ADR-0009`.
- [ ] One independent whole-branch review; fix what it finds; full suite, typecheck, build.
