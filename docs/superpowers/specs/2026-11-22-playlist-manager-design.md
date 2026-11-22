# Playlist manager -- design

- Date: 2026-11-22
- Status: approved to build once reviewed (the user: "go ahead and build it once
  the review is done"); the review's questions are settled in section 8
- Builds on: ADR-0002 (resolve/commit, local server), ADR-0006 (history and
  undo), ADR-0008 (managed playlists).
- Becomes: ADR-0009 "Editing playlists as a draft; undoing a reorder".

## 1. Intent

The user has repeatedly wanted to remove several songs from a playlist, and
Qobuz's mobile and desktop apps have no multi-select: songs go one at a time.
They want one page that lists their playlists, opens one, shows every song, and
lets them act on many at once.

Two workflows matter equally: **filter and bulk-select** (clearing out many
songs, above all by artist) and **dragging** (getting the order right).

### What the user asked for or agreed to

| Topic | Decision |
|---|---|
| Core (asked) | List playlists; open one; see all songs; reorder; select several and act on them; paste a list of artists and remove all their songs |
| Extras (agreed) | Sort and shuffle; search; duplicate and unplayable markers; copy / move songs to another playlist; favourite songs; rename, duplicate and delete playlists; open the playlist in existing tools |
| Extras (agreed) | Artist breakdown with counts; "keep only these artists"; remove artists from several playlists at once; select songs already in favourites or another playlist; split a selection into a new playlist; shift-click and keyboard; a CLI command for artist removal |
| When edits are written | **Draft, then Save** (approach B, section 4) |
| Testing | Scratch playlists on the user's account are allowed |

Anything else in this document is the author's call, marked *(call)* where it
changes what the user sees.

### Success

- Removing 40 songs scattered through a 1,400-song playlist takes one selection
  and one Save.
- "Remove everything by these 12 artists" is one paste, one look at what
  matched, one Save.
- A drag is instant on screen at 1,400 songs.
- Any Save -- including a sort or shuffle of the whole playlist -- can be
  reversed from History, order included.

### Non-goals

- Playing music. Editing Favourites as a list (Favourites appear only as a place
  to add to or compare with). Other people's playlists. Adding songs by search
  (the Build tools do that). A CLI editor beyond artist removal.

### Anti-goals

- Losing a song: a move between playlists must never remove before it has added.
- Writing anything to the open playlist before Save.
- Clearing and re-adding a playlist to reorder it (it would reset added dates
  and make managed playlists treat their songs as removed by hand).
- Overwriting changes made elsewhere since the playlist was opened.

## 2. Constraints and verified facts

Project: zero runtime dependencies; vanilla TypeScript UI in the existing
Console style; logic in tested pure modules, thin views; the browser never talks
to Qobuz. The user's 15 playlists hold 10 to 1,393 songs; one is collaborative.

Verified live on 2026-11-22 with a scratch playlist (since deleted):

- `playlist/updateTracksPosition` places the ids **in the order sent**, 220 in
  one request in about 0.5 s. `insert_before` is 1-based in the list as it is
  before the move; length + 1 moves to the end. Entry ids and added dates
  survive a move.
- `playlist/update` takes `playlist_id` plus any one of `name`, `description`,
  `is_public`, and leaves the others alone.
- Playlist tracks carry `created_at` (date added, unix seconds) and
  `performers`, a credits string: `Name, Role, Role - Name, Role`, with stray
  `\r`. Relevant roles: `MainArtist`, `Main Artist`, `FeaturedArtist`,
  `Featured Artist`. Guests are often credited there with no "feat." in the title.
- `getUserPlaylists` items carry `owner`, `is_public`, `is_collaborative`,
  `duration`, `description`, `created_at`, `updated_at`, and cover images.
- Reading 500 playlist songs takes 2-6 s, so a 1,400-song playlist takes several
  seconds: the page must show progress, not look stuck.
- Known before: one add request adds a repeated track id once only.
- **Adding an unplayable (or unknown) track answers 200 and adds nothing**; the
  rest of the batch is added. So an add is only confirmed by reading back, and a
  removed unplayable song cannot be put back by anything.
- A move whose anchor is itself moved lands after the unmoved entries that were
  ahead of the anchor position. Unknown entry ids in a move are ignored.
- All 15 of the user's playlists, the collaborative one included, are their own.

Gaps in today's code that this design must close: no client method for
`playlist/update`; `Playlist` keeps only id, name and count; `Track` has no
added date or guests; History records moves but undo does not restore order.

## 3. What the user sees

A new **Playlists** link, first in the *Tidy up* group (*call*), at
`#/playlists`.

### 3.1 The list

```
Playlists                                     [filter...]   Sort: Recently changed v
--------------------------------------------------------------------------------
[ ] Road Trip          942 songs   64 h   Public          changed 3 Nov
[ ] Late Night         112 songs    8 h   Managed: weekly changed 20 Nov
[ ] Gym                439 songs   29 h   Collaborative   changed 1 Oct
--------------------------------------------------------------------------------
2 ticked   [Remove artists...]
```

- Clicking a name opens it. The row menu has Rename, Duplicate, Delete, and
  Open in (3.5). Sorts: recently changed (default), name, songs.
- Delete asks for confirmation, naming the playlist and its song count, and
  warns if a managed playlist fills it or reads from it. Deleting is undoable
  from History (as today: recreated with its songs, under a new id).
- Ticking playlists enables **Remove artists** across them (3.4).

### 3.2 One playlist

```
< Playlists     Road Trip  (rename)          942 songs, 64 h   [Open in v] [...]
--------------------------------------------------------------------------------
[search title, artist, album]  [Quick select v]  [Sort v]  [Artists]  [By artist...]
--------------------------------------------------------------------------------
   [ ]  #  Title                     Artist         Album       Added  Quality
::  [x]  1  Roads                     Portishead     Dummy       3 Nov  16/44.1  5:02
::  [x]  2  Teardrop        duplicate Massive Attack Mezzanine   3 Nov  24/96    5:29
::  [ ]  3  Glory Box     unplayable  Portishead     Dummy       3 Nov  16/44.1  5:06
--------------------------------------------------------------------------------
2 selected  [Remove] [Copy to...] [Move to...] [Favourite] [New playlist] [Top] [Bottom]
--------------------------------------------------------------------------------
Draft: remove 42, move 8                     [Undo] [Redo] [Discard] [Save changes]
```

- **Every song is listed** in play order, all rows on one page.
- **Search** narrows what is shown. "Select all" and shift-click ranges act on
  the shown rows only. Selected songs that a search hides stay selected, and
  the bar says so: "12 selected (3 hidden by the search)".
- **Dragging**: a handle on each row; dragging any selected row drags the whole
  selection, keeping its order. The page scrolls near its edges. Dragging is off
  while a search narrows the list (the gaps would be misleading); the handle
  says why, and Top, Bottom and "Move to position..." still work. *(call)*
- **Removing** takes songs out of the list at once; the draft bar counts them,
  and a "Show removed" toggle lists them, each with Put back.
- **Sort** reorders the draft, it is not just a view: title, artist, album (then
  disc and track number), date added, release date, length, quality, reverse,
  shuffle, and "Spread out artists" (no artist twice in a row where possible).
  With two or more songs selected, Sort offers "just the selected songs", which
  rearranges them among the places they occupy. *(call)*
- **Quick select**: duplicates (every copy but the first), unplayable,
  not hi-res, live versions (by title/version, with the matching rules of the
  existing exclude filter), added before/after a date, already in Favourites,
  already in another playlist (pick one), invert, none. Favourites and the other
  playlist are read only when asked for.
- **Artists** panel: every main artist with their song count, biggest first;
  clicking one selects their songs; a tick list allows several.
- **Keyboard**: Up/Down move the focused row; Space selects; Shift+Up/Down and
  shift-click extend; Ctrl/Cmd+A selects the shown rows; Delete removes;
  Alt+Up/Down moves the selection; Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and
  redo; Escape clears the selection. None act while typing in a field. Moves
  and removals are announced to screen readers.

### 3.3 By artist

A box for artists, one per line: a name, a Qobuz artist link, or a `/regex/`
(the same forms the exclude filters take; whole-name match ignoring case and
accents).

```
Portishead        11 songs
Chris Stapleton    4 songs, and 1 as a guest
Radiohed           not in this playlist.  Did you mean Radiohead (6)?
[x] Include songs where they are only a guest (1)
(o) Remove these artists' songs   ( ) Keep only these artists' songs
[Select them]  [Remove 15 songs]
```

- A song is an artist's when they are its main artist or credited as a joint
  main artist. Guest appearances (credits, or "feat." in the title) are counted
  separately and left out unless ticked; off by default. *(call)*
- "Keep only" removes every song that matches none of the listed artists.
  Names that match nothing are listed; in "keep only" mode the button is
  disabled if nothing matches at all, so it cannot empty the playlist.
- The result is a draft removal (or a selection), like any other.

### 3.4 Remove artists across playlists

From the list, for the ticked playlists: the same box, then a review per
playlist with each matching song ticked, then **Remove**. There is no draft
here; the review is the check (resolve/commit, as in the other tools). One
History entry. A playlist that cannot be read or written is reported and the
others carry on. Only "remove" is offered, not "keep only". *(call)*

### 3.5 What is written when

| Action | When |
|---|---|
| Remove, reorder, sort, shuffle | On Save |
| Move to another playlist | On Save: added there first, and removed here only if that succeeded |
| Copy to another / new playlist, favourite | At once |
| Rename, make public/private, duplicate, delete | At once |

- **New playlist** from a selection (the split) asks whether to keep the songs
  here (at once) or take them out (joins the draft as a move; the new playlist
  is created on Save). *(call)*
- Copy and move skip songs already in the destination (the same track id: a
  different release is a different song here) and say how many. A moved song
  already there is still removed here.
- A moved song is removed here only when a re-read of the destination shows it
  there. One that did not arrive (Qobuz silently drops unplayable songs) stays
  here and is reported; it does not stop the Save.
- A playlist kept in *mirror* mode cannot be picked as a destination: its next
  refresh would take the songs out again.
- Duplicate copies the saved playlist, not the draft; if there is a draft it
  says so.
- **Open in**: Deduplicator, Upgrade & repair, Similar artists, Library stats,
  Combine, Export -- each opens with this playlist chosen. With an unsaved
  draft, it asks first.

### 3.6 Save

Save shows a summary: songs removed, moved to each playlist, and reordered, plus
warnings (managed playlist; unplayable songs, which undo cannot put back; more than half the songs, or all of them, going).
Confirming writes it as **one History entry** and reloads the playlist. Progress
is shown while it runs.

**Changed elsewhere.** The server re-reads the playlist first. If its entries or
order differ from what the draft started from, nothing is written and the user
is told what changed ("2 added, 1 removed since you opened it") with **Bring in
the changes**: entries that have gone drop out of the draft, new ones are put
after the entry they follow on Qobuz, and the draft's removals and order
otherwise stand. The user then saves again.

**Failing part-way.** Steps run in an order that never loses a song: add to
other playlists, remove here, then reorder. The first failure stops the rest;
the result says what was done and what was not, the page reloads what Qobuz now
has, and the steps that did not happen are kept as the draft.

**Leaving.** With an unsaved draft, leaving the view, opening another playlist
or closing the tab asks first. Drafts are not kept across a reload. *(call)*

### 3.7 Managed playlists

Opening a playlist that a job manages shows a notice with the job's name:

- *respect* edits: "Songs it added stay removed if you remove them. Songs you
  added yourself may come back if its source wants them, and it may move songs."
- no source (tidy-ups only): "Its tidy-ups carry on; your edits are kept."
- *mirror*: "The next refresh will undo edits made here" with a link to Managed
  playlists.

Nothing is blocked. The multi-playlist review and delete show the same.

## 4. Approaches considered

- **A. Write straight away.** Every drag or removal is a request. No Save, like
  the apps; but every edit waits on Qobuz (and two reads for History), bulk
  sessions hit throttling, and ten edits are ten History entries.
- **B. Draft, then Save.** *Picked by the user.* Instant editing with undo and
  redo, one summary, one History entry; matches the resolve/commit tools. Costs:
  Save must be pressed, and the playlist may have changed meanwhile (3.6).
- **C. Mixed** (removals now, order on Save). Rejected: the user would have to
  remember which edits are live.

## 5. How it is built

Decided because the rest depends on it; names and file splits are the builder's.

### 5.1 The draft (pure, shared by server and page)

`src/features/` module(s) with no Node imports, so the page imports them (as it
does `playlist-shape.ts`). A draft is the opened entries plus the list of kept
entry ids in order and, per removed entry, whether it was removed or moved (and
where to). Operations are pure functions over it; undo/redo is a stack of
drafts. Entries are keyed by **playlist-track id**, never track id, so copies of
one song are separate.

Pure functions: selection helpers (range, invert, matching), sorts, spread-out,
matching artists, quick-select predicates, rebase ("bring in the changes"), and
**planning the moves**: from the current to the wanted order, find the longest
run of entries already in relative order, move only the rest, grouping
neighbours; when that needs more requests than re-sending the changed stretch in
blocks, do that instead (blocks of up to 200 ids, first block first, each in
front of the entry after the stretch, so no move anchors on a moved entry). So one drag is one request and a shuffle of 1,400 songs
is seven. A property test checks the plan against a model of Qobuz's move.

### 5.2 Server

- Opening a playlist returns its details, its songs (with guests, added date,
  duplicate group) and the managing job, if any.
- Saving takes the entry ids the draft started from (in order), the removals,
  the moves-out with their destinations, and the final order. The server checks
  the draft against a fresh read, and checks the request is consistent (final
  order plus removals is exactly the starting set), before writing anything.
- Routes for: list, open, save, artist review and commit across playlists,
  rename/visibility, duplicate, delete, copy/new playlist from entries. Every
  write route is in `WRITE_ROUTES` under a new tool name, "Playlist manager".
- Every write of the playlist manager (and the CLI's `--apply`) holds the jobs
  lock, waiting a few seconds for it; if it stays busy the answer is that a
  managed refresh, or another save, is running and to try again.
- Saving is one request, so progress is "Saving..." with what is being written;
  opening says how many songs it is reading.
- What counts as a duplicate is decided in one place (`deduplicate.ts`) for the
  Deduplicator, this page, Combine, "already in..." and scheduled tidy-ups: the
  same track, ISRC, or artist and title *with version*. Copies that differ only
  by version label (live, acoustic, remix) are "other versions": pointed out, by
  a badge here and a section in the Deduplicator, kept by default, and never
  touched automatically. (Asked for by the user during the build.)
- Artist links match the main artist by id, and joint or guest credits by the
  artist's name (credits carry no ids); links are looked up by the server, the
  rest of the matching is pure.

### 5.3 Client and models

`updatePlaylist` (`playlist/update`), added to `MUTATING_METHODS`. `Playlist`
gains description, public, collaborative, duration, updated date; `Track` gains
added date and guests (other main artists, featured artists) from `performers`.
All optional, so existing callers are unaffected.

Unverified: whether removing another person's songs from a *collaborative*
playlist works. Treat failures there like any partial failure.

### 5.4 History

- `move-tracks` gains where each moved entry came from (0-based positions just
  before the move). Older records without it still parse, and undo reports their
  order as not restored, as now.
- Undo works out the order to return to by replaying the entry's operations
  backwards over the playlist as it is now (un-add, un-remove, un-move), then:
  re-adds what was removed, takes out what was added, and makes one planned
  reorder. This is exact for every tool's entries, and cheap for scattered ones.
- A song that could not be put back is never taken out of where the same change
  put it: the undo says so and leaves it there (this covers undoing a move).
- Songs that did not come back (unplayable) are reported, and do not stop the
  others returning to their places.
- The undo is itself recorded, so it can be undone.
- A new `update-playlist` operation records the old and new name, description
  and visibility, and is undoable.
- Because every tool's moves go through the recorder, undoing other tools'
  reorders improves too.

### 5.5 CLI

`qobuz-helper remove-artists --playlist <id or link>` (repeatable, or
`--all-playlists`), artists as arguments or on stdin, `--include-guests`,
`--apply` to write (otherwise a report), `--json`. Same resolve and commit as
3.4. Unmatched names are reported. `--all-playlists` with `--apply` covers the
user's own playlists only, and skips nothing silently.

## 6. Testing

- Vitest for every pure part, the client method, recorder, undo, routes and
  argument parsing, with stubbed clients; property tests for move planning and
  for save-then-undo returning the original list (a model playlist).
- Live, on scratch playlists that are deleted afterwards: a save with removals
  and reorder, a whole shuffle of a 300+ song copy, undo of both, rename and
  undo, move between two scratch playlists, the changed-elsewhere refusal.
- The page in headless Chromium: drag, shift-select, keyboard, 1,400 rows,
  narrow width.

## 7. Left to the builder

File names and module splits, route paths, exact wording, row rendering
technique (rows must stay smooth at 1,400), icons, the drag implementation
(native or pointer-based, no library), menu and dialog markup, and details of
the Console styling.

Docs to update: README, CHANGELOG (including undo now restoring order),
ADR-0009.

## 8. Settled after the builder's review

The review's questions were settled by the author under the go-ahead to build:

| Question | Settled as |
|---|---|
| Unplayable songs | Moves confirmed per song by reading back; Save warns that removing them cannot be undone |
| Undo of a move failing part-way | Restores run first; a song not restored is not removed from where it went |
| Undo exactness and cost | Backwards replay and one reorder, for every tool |
| Mirror-managed destinations | Not offered for copy or move |
| "Same song" | One shared, version-aware matching for markers and tools; track id for copy / move |
| Non-Latin titles all counting as one song (existing `normalise` bug, which also affects the Deduplicator) | Fixed first, as its own change |
| Playlists owned by others | None today; if any appear they open read-only (copy out, no edits) and `--all-playlists` reports them as skipped |
| Jobs lock | Around every playlist-manager write |
| Progress | Indeterminate, with counts |
| Moves anchored on a moved entry | Never planned; the test account models them as Qobuz does |
| Artist links | Id for the main artist, name for credits |
| Managed notice | Reworded to what actually happens |
