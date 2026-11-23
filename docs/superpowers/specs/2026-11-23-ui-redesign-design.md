# Web UI redesign: library first, "Cover glow"

- Date: 2026-11-23
- Status: draft, awaiting approval (builder check done)
- Mockups: `.superpowers/brainstorm/2337441-1795429205/content/` (`structure.html`,
  `look.html`, `flows.html`; gitignored, local only)

## Why

crosstune became a multi-service app (ADR-0010..0014), but the web UI is still
laid out like the single-service Qobuz toolbox it grew from:

- The service you are on is chosen in a `<select>` at the bottom of the sidebar,
  below the fold. Tools that work on one service show a banner telling the user
  to "choose it in the list of music services, at the bottom left".
- Fifteen tools sit in one flat sidebar, and Home repeats them as a directory.
- Services are told apart only by small grey text tags.

The user is not attached to the current "Console" look and chose a new one.

## Goals

- **Library first.** The home of the app is the user's playlists, from every
  connected service, in one list. Most tools become actions on a playlist.
- **The service is always visible**, as coloured tabs in a top bar and a
  coloured dot on every playlist.
- **One place to start anything**: an ask box in the top bar that takes what the
  Home paste box takes today (links, artist/album lists) and suggests a tool.
- **The "Cover glow" look** (mockup `look.html`, option 3): near-black,
  art-forward, rounded, the playlist header tinted by its cover.
- **Looks right with artwork off**, which stays the default (ADR-0004).

## Non-goals

- No change to features, plans, or what existing server routes do. Every tool
  keeps its resolve -> review -> commit flow and its current options. Additive,
  read-only data is allowed where the new pages need it (see "Data the new
  pages need").
- No change to the CLI.
- No new runtime dependency, no UI framework (CLAUDE.md, ADR-0002).
- Not a mobile app. It should not break on a narrow window, but layout A is
  designed for a desktop browser.

## Anti-goals (a failure even if it works)

- The browser contacting a service's image server before the user has said yes.
- A tool losing an option or a safety it has today (unsaved-playlist guard,
  confirm dialogs, History/undo, the review step before writing).
- A long-lived branch that cannot be merged until all fifteen tools are moved.

## Constraints

- Vanilla TypeScript bundled by esbuild; `src/web/**` is glue excluded from
  coverage, so logic that can be pure (routing tables, ask-box classification,
  the generated-cover colours) goes in tested modules.
- `api.ts` is the only thing that calls the server. `baseHeaders(on)` already
  takes a per-call service, which the playlist context needs (below).
- Self-hosted fonts only; the page makes no third-party requests for its own
  chrome.
- Both `npm test` and `npm run typecheck` must pass at every step.

## Approaches considered

1. **Frame first, then move the tools in one at a time** (chosen). Step 1 puts
   in the new shell and look with the existing views inside it; step 2 moves
   tools into the playlist context one by one; step 3 adds the ask box, the
   artwork question and the cover tint. The app works after every step.
2. **Everything at once on a branch.** Fewer temporary states, but nothing is
   usable until fifteen tools are done; a long-lived branch.
3. **A second UI beside the old one** (`/next`), the old removed later. Safe to
   try, but every tool lives twice until then, over a 2,300-line `index.html`.

The user chose 1: no long-lived branch, each step checked in the browser and on
the real accounts before the next, and a wrong turn is cheap to redo.

## What the user decided

### Layout ("A": library first)

```
┌ crosstune  [ paste a link, an artist, "find repeats"… ]  All ●Q ●T ●S  ⏱ ↺ ⚙ (+ New) ┐
│ PLAYLISTS          │ ░░▒▒▓ glow from the cover ▓▒▒░░                               │
│ ● Download 2026  ◀ │ [cover]  QOBUZ PLAYLIST                                       │
│ ● rock/metal v3    │          Download 2026 Headline · 439 songs · 30 h 20 min     │
│ ● Techno ⇄         │ (Edit songs) (Find repeats) (Upgrade) (Copy to…) (Link) (Stats)│
│ ● Techno ⇄         │ ▢ Bring Me The Horizon — Kingslayer          (Hi-Res 24/96)   │
│ ● uk rap           │ ▢ Sleep Token — Caramel                      (Hi-Res 24/48)   │
│ LIBRARY            │ ▢ Spiritbox — Holy Roller                    (CD 16/44)       │
│ ● ♥ Favourites     │                                                               │
│ ● ▤ All playlists  │                                                               │
│ ✨ New releases     │                                                               │
└────────────────────┴───────────────────────────────────────────────────────────────┘
```

(The two "Techno ⇄" rows are the Qobuz and Spotify copies of one linked
playlist, each with its own service's dot.)

- **Top bar**: brand, ask box, service tabs (All and each connected service,
  each with its colour), Jobs, History, Settings, and "+ New".
- **Sidebar**: a filter box; *Playlists* from the services the tab shows, each
  with its service dot; *Library*: Favourites, All playlists, New releases (see
  the calls below). Playlists can be ticked for group actions.
- **Linked playlists: one row per copy** (user's choice). Each copy of a link
  is its own row with its own service dot and a ⇄ badge, opens as that
  playlist, and its actions work on that copy's service. Under "All" a linked
  playlist therefore appears once per service. The ⇄ badge (and the playlist
  page's "Link" action) leads to the link's state: in sync, waiting, or a
  conflict, as Jobs shows it. The mockups' single "●● Techno ⇄" row is
  superseded.
- **Main area**: the selected playlist: cover, service, name, counts, the
  action row, and its songs with quality pills.

### Where every tool goes

| Today (`VIEWS`)              | New home                                                       |
|------------------------------|----------------------------------------------------------------|
| home                         | Replaced by the playlist home; its paste box becomes the ask box |
| playlists (+ editor)         | The sidebar and the playlist page; "Edit songs" is the editor   |
| deduplicate                  | Playlist action "Find repeats" (also on Favourites)            |
| upgrade                      | Playlist action "Upgrade" (also on Favourites)                 |
| stats                        | Playlist action "Stats"; whole-library stats = "All playlists" -> Stats |
| (transfer / copy)            | Playlist action "Copy to…"                                     |
| links                        | Playlist action "Link"; link states shown under Jobs           |
| import-export                | Playlist action "Export"; "Import a file" under + New; backup/export-all in Settings |
| combine                      | + New -> "Combine playlists", and a group action on ticked playlists |
| playlist (from artists)      | + New -> Artists                                               |
| albums                       | + New -> Albums                                                |
| similar                      | + New -> Similar artists                                       |
| word-play                    | + New -> Word play                                             |
| managed                      | Jobs (and + New -> Managed playlist)                           |
| new-releases                 | Sidebar *Library* -> New releases                              |
| history                      | Top bar History; plus a short toast with Undo after each Save  |
| accounts                     | Settings -> Accounts (with Show artwork and backup)            |

Group actions on ticked playlists: Combine, Remove artists from all (today's
Playlists bulk removal), Export, Delete.

### A tool opens inside the playlist (`flows.html`, screen 1)

The song list gives way to the tool's review: "← <playlist name>" to go back,
the tool's steps (e.g. 1 Find, 2 Choose, 3 Save) at the top right, and the
commit button labelled with what it will do ("Save — remove 31"). Nothing is
written before that button, as today.

### "+ New" (`flows.html`, screen 2)

A menu over the page: *New playlist from…* Artists, Albums, Similar artists,
Word play, Combine playlists, Import a file; *Keep it fresh*: Managed playlist.
Each opens its tool in the main area with its steps.

### Look: "Cover glow" (`look.html`, option 3)

- Near-black ground (about `#0e0f14`), light text, muted secondary text
  (about `#8a8aa0`), translucent white surfaces instead of borders.
- Rounded: 8-10px on panels and rows, pill-shaped buttons, tabs and quality
  labels. Primary button white on dark.
- The playlist header is tinted by a radial gradient taken from its cover.
- Quality pills: hi-res in warm gold ("Hi-Res 24/96"), CD and lossy muted
  ("CD 16/44").
- Service colours: Qobuz indigo, TIDAL teal, Spotify green, as dots and tab
  marks. Not the services' logos or brand marks.
- The brand word may carry a pink-to-violet gradient.

### Artwork

- Stays **off by default** (ADR-0004).
- **Asked once**: on first load with at least one service connected, a small
  prompt asks "Show album covers? They load from Qobuz, TIDAL and Spotify's
  image servers." Yes/No is remembered; the setting then lives in Settings.
- **Generated covers when off**: each playlist (and album/track placeholder)
  gets a gradient derived from its name, so the page has colour and the glow
  works without any request leaving the machine. Real covers replace them when
  artwork is on.

## Calls made for the builder (not decided by the user; may be revisited)

- **Service tabs filter; the playlist decides.** The tab filters the sidebar
  list. A tool opened on a playlist works on *that playlist's* service, sent
  per request via `baseHeaders(on)`, so the "choose a service at the bottom
  left" banner disappears. Tools under + New that build on one service ask for
  the target service in their first step when the tab is "All" (defaulting to
  the last one used). Switching tabs should no longer reload the page.
- **Favourites are per service**, like playlists: under "All" the *Library*
  section shows one Favourites row per connected service, each with its dot;
  under a service tab, that service's one. Tools on Favourites work on that
  service (Find repeats and Upgrade are one-service routes today).
- **"All playlists" is a row under *Library*.** Find repeats and Upgrade today
  also scan all of the user's playlists at once (repeats *across* playlists),
  which per-playlist actions cannot replace. An "All playlists" row per service
  (next to Favourites) offers Find repeats, Upgrade and Stats on the whole set;
  its Stats is today's Library stats, so *Library* reads: Favourites, All
  playlists, New releases. No tool loses a source.
- **Routes** keep hash routing: `#/` (library home), `#/p/<playlistId>` (a
  playlist), `#/p/<playlistId>/<tool>` (a tool on it),
  `#/favourites/<service>[/<tool>]`, `#/all/<service>[/<tool>]`,
  `#/new/<tool>`, `#/jobs`, `#/history`, `#/settings`. Old hashes
  (`#/deduplicate`, `#/playlists/<id>`, ...) redirect to the new ones, so
  bookmarks and the README still work. The route table is a pure, tested module.
- **Existing view modules are reused**: they move into the main area and take
  their playlist from the route instead of their own picker. Rewrites only
  where the module cannot be hosted.
- **Fonts**: keep a self-hosted variable sans (Archivo is already shipped and
  can carry the new look at normal width); no new font unless the look needs
  it.
- **Cover tint from real covers (step 3)**: reading an image's colours needs it
  served from the page's own origin, i.e. a local `/api/cover` proxy with a host
  allow-list. That supersedes part of ADR-0004 and needs a new ADR before it is
  built. Until then (and whenever artwork is off) the tint comes from the
  generated cover's colours. If the ADR is not accepted, the tint stays
  name-derived.
- **Ask box** classifies input with the existing Home paste-box logic (links,
  artist/album lists), and additionally matches playlist names (jump to it) and
  tool names (open it on the current playlist). No free-text "commands" beyond
  that.

## Data the new pages need

Read-only additions, each through the adapters, their fakes and the shared
contract tests, as any new read is:

- **Playlist covers.** The neutral `Playlist` (`src/services/model.ts`) has no
  `image`; the three services' playlist responses do carry one. Add an optional
  https `image`, pass it through `GET /api/manager/playlists`, and treat it like
  album covers under ADR-0004 (loaded only with artwork on; otherwise the
  generated cover).
- **Favourites' songs.** Today only `POST /api/manager/compare` lists favourite
  tracks, with identity fields only. The Favourites page needs a read that
  returns them as full `Track`s (album, quality, image, duration), like a
  playlist's songs.
- **Links in the sidebar.** The sidebar joins `/api/manager/playlists` with
  `/api/links` on the client to mark linked copies; no server change.

## Steps

Each step ends with tests and typecheck green, a check in the browser (the
`run-crosstune` skill: screenshots of each changed view, on all services), a
CHANGELOG entry, and a merge to `main`.

1. **Frame and look.** Top bar with tabs (no reload on switch), sidebar with
   playlists across services and *Library*, the playlist page with its action
   row, the Cover glow styles across the whole app, generated covers. Tools not
   yet moved still open (as today's views) inside the main area, reached from
   the action row, + New, Jobs, History and Settings.
2. **Tools into context**, one commit each: Find repeats, Upgrade, Copy to…,
   Link, Stats, Export, Edit songs; then + New's tools, Jobs, Settings, the
   group actions, and the old-hash redirects. Home's tool directory goes away.
3. **Ask box, artwork question, cover tint**: the ask box in the top bar, the
   one-time artwork prompt, and (after its ADR) the cover proxy and the tint
   from real covers.

The README's screenshots and its description of the web UI are updated at the
end of step 2, when the structure has settled.

## Left to the builder

Exact spacing, type scale, motion, focus styles and empty/loading states,
within the look above; how each existing view module is adapted to take its
playlist from the route; the generated-cover algorithm (stable for a name,
readable text on top, distinct between neighbours).
