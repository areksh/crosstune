# Several music services -- design

- Date: 2026-11-23
- Status: draft, awaiting the user's review
- Builds on: ADR-0001, 0002 (local server, resolve/commit), 0003 (import),
  0006 (history), 0007-0008 (jobs), 0009 (drafts).
- Becomes: ADR-0010 services and tagged ids; ADR-0011 accounts and sign-in;
  ADR-0012 matching across services; ADR-0013 two-way sync.

Items marked *(call)* are the author's proposals, not things the user asked for.

## 1. Intent

The user uses several music services and wants one easy place to manage their
music across them: Qobuz, TIDAL and Spotify now, others later.

### What the user asked for or agreed to

| Topic | Decision |
|---|---|
| Services | Qobuz, TIDAL and Spotify, with a structure that takes more |
| Sign-in | From the web UI |
| Viewing | Where it makes sense, show one, several or all services |
| Source / destination | Where it applies, choose the service (for example, the playlist editor's "new playlist from selection") |
| Reaching TIDAL and Spotify | Official APIs (option A). Later, an optional Spotify web-player reader for the gaps (option B): off by default, read-only |
| Common layer | Tagged ids everywhere (approach 1, section 4) |
| Sync | Two-way. On a conflict write nothing and wait for the user to fix it in the UI; make it obvious that there is an issue |
| Sync rules, matching, accounts, viewing | As played back to the user and accepted (sections 7-9) |

### Success

- A fresh install opens the UI signed in to nothing, and the user connects all
  three services without a terminal.
- A selection in a Qobuz playlist becomes a new Spotify playlist, with every
  uncertain or missing song shown before anything is written.
- A playlist linked on two services can be edited in either app. Changes cross
  at the next sync; a conflict writes nothing and is impossible to miss.
- A fourth service is one new folder that passes the shared contract tests,
  plus its registration and its Accounts text. No tool changes.
- A user with only Qobuz loses nothing.

### Non-goals

- Playing or downloading music. A playlist that mixes services. Public
  multi-user hosting. Syncing favourites two-way *(call)*. Syncing playlist
  descriptions, artwork or visibility *(call; names are synced)*. Phone or
  desktop notifications (already on the roadmap; sync conflicts will be the
  first event they carry). Renaming the project *(call: kept until the end)*.

### Anti-goals

- Losing a song, on any service, in any failure.
- Writing a wrong match without the user having seen it.
- Reading a failure, an expired sign-in or a withdrawn song as "the user
  removed this".
- Reducing Qobuz features to what every service supports.
- Building a database of service metadata (the terms restrict it, and it goes
  stale).

## 2. Constraints and facts

Project constraints stand: local-first, zero runtime dependencies, NodeNext,
strict, logic in tested pure modules, the browser never talks to a service, and
no token reaches the page.

### TIDAL (official API; spec 1.10.258, read 2026-11-23)

- JSON:API at `https://openapi.tidal.com/v2`; ids are opaque strings. Sign-in is
  authorization code with PKCE. Third-party scopes include `user.read`,
  `collection.read/write`, `playlists.read/write` and `search.read`.
- Playlist items have an `itemId`. Add 50 and remove 50 per request; move 20 per
  request before `positionBefore`. Adds report `skipped` items. Mutations take
  an `Idempotency-Key`.
- Tracks filter by ISRC (one track per ISRC when several are given). Similar
  artists, artist tracks and albums, favourites with `addedAt`: all present.
- Quality is `mediaTags` only. Playlists can contain videos.
- **Unconfirmed:** redirect URI rules (two open-source projects register
  `http://127.0.0.1:<port>/...`), whether a client secret is needed (both say
  no), rate limits, token lifetimes, which apps get collection access, whether
  the artist-tracks order is by popularity.
- tidal.com answers scripts with a captcha. We do not work around it.

### Spotify (official API, development mode)

- Each user registers an app. Its owner needs Premium; up to 5 users. Quota is
  per developer account; numbers unpublished. 429 carries `Retry-After`, or
  `reason: QUOTA_EXCEEDED`.
- PKCE; redirect `http://127.0.0.1` with any port (registered without a port);
  `localhost` is refused. Access token 1 hour. The refresh token ends 6 months
  after authorising, and refreshing does not extend it.
- Not available: artist top tracks, related artists, others' playlist items,
  multi-get, popularity, label, markets. Search is 10 per page. ISRC
  (`external_ids`) is returned.
- Library writes go through `/me/library`; playlist items through
  `/playlists/{id}/items`. There is no playlist delete: it is removed from the
  library instead.
- Playlist items have no entry id, and can be episodes or local files. Local
  files cannot be added through the API.
- **Unconfirmed:** removing one copy of a repeated song, undoing a library
  removal of an own playlist, whether an unplayable track can be recognised.

### Terms

- Spotify lets users transfer "their personal data, or the metadata of the
  user's playlists", and bars products "integrated with streams or content from
  another service" and analysing its content. It asks for attribution with a
  link, no indefinite storage, and deletion when the user disconnects.
- TIDAL allows non-commercial use and temporary metadata caching. Its
  guidelines reportedly (secondhand; not readable here) require approval to
  combine its content with other services.
- The user was told that combined views and Library stats do not clearly fit
  these terms, and that the likeliest consequence is thought to be a revoked app
  key. They are included; every item is labelled with, and links to, its
  service. The README says this plainly. Nothing beyond ids is kept.

## 3. Order of work

Each phase is planned and built on its own, and is usable when it ends.

| Phase | What | Depends on |
|---|---|---|
| 1 | Common layer: tagged ids, service interface, hub, contract tests. Qobuz only, no visible change | -- |
| 2 | Accounts, web sign-in, service filter in the shell (Qobuz only at first). Mockups first | 1 |
| 3 | TIDAL | 2, the user's TIDAL app, probes |
| 4 | Crossing services: matching, review, destinations, combined views, comparing. Mockups first | 3 |
| 5 | Spotify, with gaps filled from other services | 4, the user's Spotify app, probes |
| 6 | Two-way sync. Mockups first | 4 (5 for Spotify) |
| Later | Spotify web-player reader (option B): its own design | 5 |

TIDAL comes before Spotify because its API is the more complete, so it tests the
layer on a second service before Spotify's gaps complicate it. Crossing services
comes before Spotify so that the user gets value early.

**Probes.** Before 3 and 5, short scripts check the unconfirmed facts above on
the user's account with scratch playlists, which are deleted afterwards. Asking
the user first is required; a probe's answer goes into this document's successor
(the phase's plan) before code depends on it.

## 4. Approaches considered

**Reaching the services.** (A) Official APIs: stable, sign-in by button, but
Spotify lacks several reads. (B) A plus Spotify's web player for those reads:
needs a pasted cookie, generated codes and identifying as Spotify's client;
against its terms. (C) Web player only: no Premium needed, but Spotify stops
working when its site changes, and writes are unverified. **Chosen: A now, B
later.**

**The common layer.** (1) Tagged ids everywhere: a large mechanical change first,
after which services mix safely and tools stay service-agnostic. (2) Untagged
ids with the service alongside: smallest, but Qobuz track 123 equals TIDAL track
123 in every mixing tool, undetected. (3) A local song library: cleanest, but a
rewrite, goes stale, and the terms restrict it. **Chosen: 1**, plus from 3 a
small table of confirmed matches and last-synced states, ids only.

**Keeping playlists the same.** One-way following is nearly free; two-way needs
a three-way merge and conflict handling. **Chosen: two-way.** One-way following
across services also works, through the existing follow source.

## 5. Phase 1: the common layer

### Ids

- `"<service>:<native id>"`, split at the first colon; the native id is opaque.
- Branded string types: `TrackId`, `AlbumId`, `ArtistId`, `PlaylistId`,
  `EntryId`, `UserId`. A playlist id does not compile where a track id belongs.
  Ids are only made by a service adapter or a validating parser.
- Native ids appear only inside `src/services/<name>/`.
- Nothing compares or sorts ids numerically today (checked), so the change is
  one of type, parsing and storage.

### Structure

```
src/services/
  model.ts        Track, Album, Artist, Playlist, ids, ServiceError
  service.ts      MusicService, Capabilities
  hub.ts          ServiceHub: routes by tag
  contract.test-support.ts   tests every service must pass
  qobuz/          today's src/qobuz, adapted
```

Dependencies still point down only: features use `services/model` and their own
small client interfaces, never a service folder.

- **`MusicService`** has today's client methods with tagged ids. Methods outside
  its capabilities throw `ServiceError` of kind `unsupported`.
- **`Capabilities`** is data, sent to the page: each is `yes`, or `no` with the
  reason shown to the user. They name what differs: `topTracks`,
  `similarArtists`, `artistReleases`, `readOthersPlaylists`, `movePlaylistEntries`,
  `deletePlaylist`, `playlistVisibility`, `searchByIsrc`, `quality`
  (`exact | tier | none`), `playability`, `favouritedDates`, `entryIds`
  (`stable | positional`), `editorialPlaylists`. More than one source for a
  capability is allowed, so B can slot in later.
- **`ServiceHub`** implements the same methods. Those that take an id go to that
  id's service; a list is split by service; those without an id (search, create,
  favourites, list playlists) are reached through `hub.service(name)`. Adding a
  track to another service's playlist is refused: crossing services is always an
  explicit step (section 7).
- **History**: `recordingClient` wraps the hub. The test that classifies every
  method as a write or a read covers `MusicService`.
- **Errors**: `ServiceError` carries the service and kind; `QobuzError` becomes
  one. The router still answers 502, with the service's name.

### What is stored

| File | Change |
|---|---|
| `history.jsonl` | A bare number (or bare album id) reads as Qobuz; new records are tagged |
| `jobs.json`, `jobs-state/*` | Version 3; older versions read as Qobuz. Reading never rewrites |
| Backups, CSV, M3U, text | Files written before still import. In phase 1 the output is unchanged; phase 4 adds a `service` column/field and `tidal://`, `spotify:` URIs |
| `--json` output | Unchanged in phase 1; phase 4 adds tagged ids beside the existing fields |
| `session.json`, `bundle.json` | Unchanged (Qobuz's) |

CLI flags and the URL hash accept a bare number (Qobuz), a tagged id or a link.

### Done when

The suite passes with only id literals and imports changed in existing tests (a
changed expectation is a bug to explain), both type checks pass, old history,
jobs and backup fixtures read correctly, a live read-only check on the user's
account matches the output from before, and an undo of an entry recorded before
the change plans correctly.

## 6. Phase 2: accounts and the shell

- The server starts with no service connected. `qobuz-helper ui` and `serve` no
  longer require a sign-in first. The CLI still signs in for commands that need
  it, `login <service>` signs in to one, and `login` alone means Qobuz.
- **Accounts view**: per service -- connect, disconnect, who is signed in, the
  plan if known, when sign-in ends. For TIDAL and Spotify, steps to register an
  app and a field for its client id (kept in `services.json`, owner-only).
- **Sign-in**: the server makes `state` and the PKCE verifier, the browser opens
  the service's page, and a one-shot listener on a fixed loopback port *(call:
  53683, changeable)* receives the redirect. Fixed because TIDAL probably matches
  the whole URI; Spotify is given `127.0.0.1`, Qobuz `localhost` as now. `state`
  is single-use, bound to that sign-in, and expires after 10 minutes. Qobuz's
  flow carries no `state` today: the listener accepts only while a Qobuz sign-in
  is in progress. Pasting the address remains for browsers on another machine.
- The listener serves no API and returns a fixed page. Codes and tokens never
  reach the UI, logs or History.
- **Tokens**: `sessions/<service>.json`, owner-only. Refreshing holds a file
  lock, because `serve` and `run-due` can both refresh and refresh tokens may
  rotate.
- **Expiry**: a warning from 14 days before Spotify's six months end *(call)*.
  `jobs-global.json` flags become per service: one expired sign-in pauses only
  the jobs that use that service.
- **Disconnecting** deletes its tokens, matches, sync state and History entries,
  after saying so (Spotify's terms require deletion; done for all *(call)*).
  Links that include it pause.
- **Service filter** in the shell: one, several or all connected services,
  remembered. Hidden with one connected. Unsupported tools stay visible with the
  reason.
- Every song and playlist shows its service and links to it.
- **Partial failure**: if one service fails in a combined view, the others are
  shown with a notice. A tool that compares or removes treats the result as
  incomplete and never concludes that something is missing.

## 7. Phase 4: crossing services

- **Matching** (`features/match.ts`), from Import's resolver: ISRC, then artist
  and title, using the deduplicator's normalising and version rules.
  - *Exact*: same ISRC, and title and artist not contradicting. Accepted.
  - *Likely*: matched by name; a different version; several equally good; or an
    ISRC whose title or length (over 5 seconds *(call)*) disagrees. Shown to
    confirm or swap.
  - *Not found*: listed.
- **Choice between copies** on the destination: playable, then the same album,
  then best quality, then earliest release *(call)*.
- **Remembered**: confirmed, swapped and rejected matches go in `matches.json`,
  ids only, one record per pair of services. Exact ones are not stored. The user
  can forget a match. An unplayable remembered match is looked up again.
- **Destinations**: anything that creates or adds to a playlist, or favourites,
  asks which service, defaulting to the songs' service, or the last used when
  mixed. The review step shows matches whenever any song has to cross.
- **Mixed selections** are allowed. Moving (not copying) across services adds
  and confirms on the destination first, then removes; *Likely* unconfirmed and
  *Not found* songs stay where they are.
- **Artists and albums** match too, for lists and favourites: albums by UPC where
  known, else artist, title and track count; artists by a shared ISRC among their
  tracks, else exact normalised name. An ambiguous one is always *Likely*.
- **Combined views**: playlists, favourites, stats, History, new releases. Stats
  count a song once when its ISRC matches, with a per-service breakdown.
- **Comparing**: Combine's "in this but not that" works across services, and can
  copy what is missing.
- **Deduplicating** stays within one service.
- Non-song entries (Spotify episodes and local files, TIDAL videos) are shown,
  keep their place, can be moved or removed where the API allows, and never
  cross. Deleting a playlist that has them warns that undo cannot restore them.
- CLI: `--service`, `--to-service`, a `copy` command (dry run unless `--apply`;
  *Likely* matches are written only with `--accept-likely`).

### Tools by service

| Tool | Qobuz | TIDAL | Spotify |
|---|---|---|---|
| Playlist from artists | yes | yes | top tracks from Qobuz or TIDAL |
| Playlist from albums, discography | yes | yes | yes |
| Similar artists, discovery | yes | yes | from Qobuz or TIDAL |
| Word play | yes | yes | yes, slow (10 results a page) |
| Playlists, remove artists | yes | yes | yes; no entry ids |
| Deduplicator, Combine | yes | yes | yes |
| Upgrade | yes | by tier | no (quality unknown) |
| Repair | yes | yes | if a probe shows it is possible |
| Stats | yes | yes, tiers | yes, no quality |
| New releases | yes | yes | yes |
| Managed playlists | yes | yes | yes; follow only own or shared playlists |
| Import, export, backup | yes | yes | yes |
| History and undo | yes | yes | yes, with the limits above |

Filling a Spotify gap asks another connected service *(call: Qobuz, then TIDAL,
changeable)*, matches the results to Spotify, and says where they came from.
With none connected, the tool says what to connect.

### Spotify specifics (phase 5)

- Entry ids are positional: track id and which copy of it. Each write checks the
  playlist's `snapshot_id` first and stops if it changed.
- If one copy of a repeated song cannot be removed on its own, the review says
  that removing it re-adds the kept copies, which resets their added dates.
- Pacing per service, honouring `Retry-After`. `QUOTA_EXCEEDED` stops with a
  plain message and, for jobs, backs off.

## 8. Phase 6: two-way sync

A **link** joins playlists the user can edit on two or more services. It is a
new kind of job: same schedule, lock, run log and "run now". A playlist is in at
most one link, and cannot be both in a link and managed by another job *(call;
it may still be read by one)*.

**State**: the last matching state -- the ordered songs, each with its id on
every copy or a gap, and the name. Ids only, except the name.

**A sync**:
1. Read every copy completely. Any failure: no sync.
2. Identify songs by the state, then remembered and exact matches.
3. Work out each copy's changes against the state: added, removed, moved,
   renamed.
4. For each removal, check that the song is still available on that service.
   Withdrawn, or cannot tell: a gap there; the other copies keep it.
5. Conflicts: stop, record, write nothing anywhere.
6. Otherwise re-read and stop if a copy changed; then add, move, and lastly
   remove, confirming each add by reading back. Save the state of what is
   confirmed.

The same change on both sides is agreement. So a sync cut off halfway is safe:
the next run sees what was already done as agreed. Songs added on both sides are
all kept, each after the song it followed.

**Conflicts** (any one stops that playlist only):
- a song removed on one copy, and moved or duplicated on another
- the songs in common reordered differently on both
- renamed differently
- a linked playlist deleted, or no longer editable
- a copy emptied, or having lost at least 10 songs and a quarter of the playlist

**Not conflicts**: a gap (listed, looked for again weekly *(call)*); a *Likely*
match (that song waits for the user; the rest syncs); a withdrawn song; a failed
read; non-song entries (ignored, kept).

**Fixing it** in the UI shows the copies side by side with what changed on each,
and offers: use this copy; merge (keep every addition, remove only what was
removed and not otherwise touched, take one copy's order); or unlink. It shows
what will be written before writing.

**First link**: if the copies differ, the same screen; nothing is assumed.

**Being obvious**: a warning on every page until resolved, a count beside
Managed playlists, a mark on the playlist and on Home. The CLI reports it and
`run-due` and `sync` exit non-zero. Expired sign-ins and waiting matches show
less loudly, in the same place.

**Undo**: a sync is one History entry. Undoing pauses the link and the state is
kept, so nothing is redone; resuming goes through the first-link screen.

## 9. Testing

- The contract suite runs against every service with a fake account: paging,
  batching, adds that the service drops, moves, copies, unsupported methods,
  expired tokens, 429s.
- Crossing is tested with two fakes whose native ids deliberately collide.
- Sync: table tests for every rule, and randomised tests -- random edits on both
  copies, random interruption -- checking that no song is ever lost without a
  removal by the user, and that syncing twice writes nothing the second time.
- Sign-in: wrong, reused and late `state`; two refreshes at once; no token in any
  API response.
- No live calls in the suite.

## 10. Left to the builder

File and function names beyond those above, request batching, token refresh
timing, how phase 1 is cut into commits (each must pass), pacing numbers, UI
details after the mockups are agreed.
