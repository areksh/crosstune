# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Shift-click ticks a range**: tick a playlist or song, then Shift-click
  another to tick or untick everything between them, in the library sidebar,
  the Playlists list, Remove artists and the song lists of the tools.
- **The ask box** at the top of the web UI (Ctrl+K): paste links or a list of
  artists or albums, or type a playlist's name or a tool, and pick what to do.
  It replaces Home's paste box; Home shows the playlists changed most recently.
- **Playlist covers** from Qobuz, TIDAL and Spotify in the library, on a
  playlist's page and over its tools (with album covers on), and a playlist's
  header tinted by its real cover (ADR-0015).
- The web UI **asks once** whether to show album covers, saying what that tells
  the services' image servers; *Settings* keeps the switch (ticking it there
  answers the question too).
- The page asks before loading afresh while a change is still being saved, so
  you see how it ended. The ask box keeps what you typed if you stay where you
  are, finds playlists with a dash in their name, says when a link is of a kind
  no tool takes, leaves Ctrl+K to other fields, and goes back to one line when
  you leave it. A header's colour follows covers being turned on or off, without
  a flicker after each save; Home's recent playlists follow the tab.
- **TIDAL and Spotify**, beside Qobuz, through their official APIs. Connect
  each from the new **Accounts** page (or `login tidal|spotify`); each needs an
  app you register, and Spotify's must be owned by a Premium account. The UI now
  opens with nothing connected, and a service whose sign-in expires stops only
  what uses it. Choose the service in the sidebar, or **All services** where a
  view can show them together (Playlists, Library stats, Combine).
- **Copy to another service**: from a playlist's menu, or by choosing another
  service for a new playlist made from a selection. Songs are matched by ISRC,
  then by name; uncertain ones are shown for you to choose, and your choices are
  remembered. `copy` does the same from the command line.
- **Linked playlists**: the same playlist on several services, kept the same in
  both directions on a schedule (or `sync`). A conflict writes nothing and is
  shown on every page until you settle it, with each copy's changes side by
  side; a linked playlist is marked in Playlists and on its own page.
- Spotify's missing top tracks and similar artists are taken from Qobuz or TIDAL.
- Combine compares playlists across services (with *All services* shown): what
  one playlist has and the other lacks, and *Add these to ...* copies it over.
- Spotify and TIDAL links work wherever a list is typed, as Qobuz's do. A link
  to another service than the one a tool runs on is found again there: an
  artist by its exact name (never a guess between namesakes), an album by its
  barcode, else its title and artist.
- `accounts`, `forget <service>` (deletes what is kept about it, History
  included) and `sync` commands.
- With more than one music service connected, the playlists made by Playlist
  from artists, Playlist from albums, Similar artists, Word play, Combine,
  Library stats and New releases can go to any of them (the *On* choice beside
  the playlist's name). Songs bound for another service are looked up there and
  shown for review first; a new or existing playlist on the page's own service
  is written as before.
- **Playlists**: a playlist manager in the web UI. Lists your playlists (rename,
  describe, make public or private, duplicate, delete) and opens one as a draft
  with every song on one page: search, select with clicks, shift-click or the
  keyboard, drag one song or a whole selection, sort, shuffle, reverse, spread
  out artists, and quick selections (duplicates, other versions, live,
  unplayable, not hi-res, by date added, already in Favourites or another
  playlist). Selected songs can be removed, moved or copied to another playlist,
  split into a new one or favourited. Paste a list of artists to remove all
  their songs, or keep only theirs, with guest appearances counted separately.
  Edits have undo and redo and reach Qobuz only on *Save changes*, as one entry
  in the history; a playlist changed elsewhere meanwhile is never overwritten,
  and a song moved to another playlist is taken out only once it has arrived.
- Remove artists from several playlists at once: in *Playlists*, or with the new
  `remove-artists` command (a report unless `--apply` is given).
- The Deduplicator points out songs you have in **other versions** (live,
  acoustic, remixes) and keeps them, with an option -- *Also treat other versions
  as the same song*, or `--include-versions` -- to count them as duplicates.
- Undo now restores the order of reordered playlists, and changed playlist names,
  descriptions and visibility. Undoing a large removal takes a few requests
  instead of one per song.
- Managed playlists can now be filled by more sources: a live **combined**
  playlist kept in sync with the playlists it combines, a copy that **follows**
  (or **archives**) another playlist, a **smart** playlist of tracks meeting
  rules (quality, decades, genres, recently favourited, length), and a
  **discovery radio** of artists like yours, new each week. A source can also
  be given to one of your existing playlists (`--into`), respecting your edits.
- Scheduled **tidy-ups** -- remove duplicates, upgrade to better-quality
  copies, repair tracks that stopped playing -- on managed playlists, on your
  own playlists and on your favourites, each on its own cadence, applied or
  left as suggestions to accept or ignore (`jobs suggestions/accept/ignore`,
  and on the playlist's card in the web UI).
- The web UI's *Managed playlists* is organised by playlist: each card is a
  playlist, then its source, tidy-ups and schedule. *Combine playlists* gains
  *Keep this updated...*.

- Managed playlists: playlists qobuz-helper keeps up to date on a schedule --
  the new releases of chosen artists (or favourite artists, or a playlist's),
  optionally with their similar artists, in the last N days, since a date, or
  each artist's newest N. Tracks you remove stay out (or, per playlist, every
  refresh mirrors the recipe exactly); a refresh that could not read everything
  removes nothing; a deleted playlist pauses its job. New commands: `jobs`,
  `run-due` (for cron, systemd, launchd or Task Scheduler; `schedule print`
  writes the entry), `serve` (the web UI plus a one-minute ticker, for an
  always-on machine) and `login --print-url` (sign in without a browser). New
  web view *Managed playlists*, also opened from New releases and Similar
  artists with *Keep this updated...*.

- History & undo. Every change qobuz-helper makes to your account -- from the
  CLI or the web UI -- is recorded in `history.jsonl` beside the session
  (owner-only; the last 200 entries, up to 90 days), one entry per action:
  playlists created, tracks added, removed or moved, favourites added or
  removed. `qobuz-helper history [--limit N]` lists them; `qobuz-helper undo
  [<id>] [--apply]` shows how one would be reversed and, with `--apply`,
  reverses it: added tracks are taken out, removed tracks go back in their old
  places, a playlist the change created is deleted (if it holds nothing else),
  and favourites are re-added or removed. Undos are recorded too, and can be
  undone to redo. The web UI gains a History view (under *Your data*) with a
  confirm step before each undo, and a "Last change" strip on the home page.
  The Qobuz client gains `deletePlaylist`, `getPlaylist`,
  `removeFavoriteAlbums` and `removeFavoriteArtists`. See ADR-0006.
- Qobuz links wherever a list is typed. Artist links resolve by id (no name
  search) in playlist from artists, similar artists and a discography, and are
  marked "from a link"; album links resolve to that exact release in playlist
  from albums; and every playlist id (`--playlist`, `--add-to`, and a new
  "Or paste a Qobuz playlist link" field in Similar artists, which can then
  expand any playlist) also takes a playlist link. Player links
  (`play.qobuz.com`, `open.qobuz.com`) and store links (`www.qobuz.com/<locale>
  /album/...`, `.../interpreter/...`) are recognised; a link of the wrong kind,
  or to nothing, is reported as unresolved with the reason.
- The web UI's home page starts with a paste box ("Start with a link or a
  list"): it sorts pasted links, names and "Artist - Album" lines, says what it
  found, and opens the fitting tool with the list filled in.
- A global `--json` option: report commands print exactly one JSON document
  on stdout -- the plan or result (deduplicate, upgrade, import dry runs and
  applied results, export summaries with `--out`/`--out-dir`, similar-artists,
  new-releases, word-play, combine, stats, and the playlists created by the
  builders) -- and every log line goes to stderr, so `> report.json` captures
  only the JSON. `stats --json` keeps working and prints the same fields, now
  after a leading `"command"` key.
- Import a Spotify playlist: a CSV exported with Exportify is recognised from
  its header (any column order, extra columns, and the older "Artist Name"
  spelling), or chosen with `--format spotify` / "Spotify (Exportify CSV)", and
  imported into favourite tracks or a playlist. Each track is matched by its
  ISRC first -- only results with exactly that ISRC, preferring one Qobuz can
  stream, then the album named in the file, then the highest quality -- and
  otherwise by its first artist and title. The import report (CLI and web) now
  says how many entries matched by Qobuz id, by ISRC and by artist and title.
  Any import of tracks that carry an ISRC but no Qobuz id now uses the same
  ISRC search.
- Export every playlist at once: `export --all-playlists --out-dir <dir>
  [--format ...]` writes one file per playlist, named after it (unsafe
  characters replaced, duplicate names numbered); in the web UI, "Every
  playlist" downloads them as a single .zip.
- Plan options for the playlist builders (playlist from artists, similar
  artists, playlist from albums), on the CLI and in the web UI:
  - *Order*: by artist, take turns between the artists, or shuffle
    (`--order by-artist|take-turns|shuffle`; albums take `as-listed|shuffle`).
    The CLI keeps by-artist as its default; the web UI starts on take turns
    and previews the order ("Plays as ..., and so on.").
  - *Skip tracks already in my Favourites* (`--skip-favourites`): matched as
    songs (ISRC or artist and title), with your favourites fetched once per
    run. In the top-track tools the next most popular track takes the place;
    the skipped one is listed unticked as "Already in your Favourites".
  - *One copy of each song* (`--one-copy`): a later copy of a song already in
    the plan (a remaster, or the same recording under another artist) is left
    out as "Same song as ... above" and, in the top-track tools, replaced by
    the next most popular. Live takes and remixes stay separate songs.
  - *Fit to length* (`--fit <minutes>`): trims the plan to at most about that
    length, dropping from the end of each artist's tracks in turn so each keeps
    its most popular (albums: from the end of the list). Tracks of unknown
    length count as the average.
  - Similar artists can also skip your favourite artists
    (`--skip-favourite-artists`), treating them like a source playlist's own.
  - Every builder's save bar (including word play's) now shows the total
    length next to the track count, and track rows show each track's length.
- Library stats (`stats` on the CLI, and in the web UI under a new *Explore*
  group): for your favourites, a playlist, or everything (favourites and all
  playlists, each track once), the track and artist counts and hours of music,
  the hi-res / CD-quality split, tracks by release decade, and the most-saved
  artists (with the share of the library they make up) and albums. A decade --
  or, in the web UI, a top artist -- can be saved as a new playlist such as
  "Favourites: 1990s" (`--decade-playlist 1990s --apply`). `--json` prints the
  stats as JSON. Track lengths are now read from Qobuz, so the combine view's
  save bar also shows the selection's running time.
- Combine playlists (`combine` on the CLI, and in the web UI under *Tidy up*):
  merge two or more playlists, optionally with your favourites, into one with
  each song once; or keep only the songs of the first that the others lack, or
  only the songs all of them share. Remasters and the same song on another
  album count as one song (the deduplicator's matching) unless
  `--exact-ids-only` is given; of a song in several, the highest-quality copy is
  kept by default. The result can be in input order, take turns between the
  playlists, or be shuffled. The web UI shows the overlap as a bar above the
  reviewable track list, and saves to a new playlist ("A + B") or an existing
  one.
- Word play: make a playlist out of song titles, on the CLI (`word-play`) and
  in the web UI. Five modes: titles containing a word, titles that are exactly
  a word, a sentence told in consecutive titles (split into the fewest songs,
  one word per song, or any mix, with up to three alternative splits and
  unmatched words called out), and, from your favourites or a playlist, an
  acrostic or an A-to-Z. Matching ignores punctuation, case, accents and
  version labels by default, can accept close forms ("jumped" for "Jump"),
  avoids repeating an artist, and honours the exclude filters. Each song can be
  swapped for another match before saving.
- The deduplicator can scan all your playlists (`deduplicate --all-playlists`,
  or *All my playlists* in the web UI). Each playlist's own duplicates are
  handled as before, and songs saved in more than one playlist are listed with
  the playlists they are in. Nothing is removed across playlists by default:
  in the web UI every playlist starts ticked, and unticking one removes the
  song from it; the CLI only reports them.
- Keep strategies can be chained to break ties: `--keep highest-quality,oldest`
  keeps the oldest of the highest-quality copies (web UI: *then, if equal,
  the*). A single strategy behaves as before.
- Upgrade & repair, a new tool (CLI `upgrade`, and *Upgrade & repair* under
  *Tidy up* in the web UI). For your favourites, one playlist or all your
  playlists, it finds tracks with a better-quality release of the same
  recording (matched by ISRC via Qobuz's track search, checked against each
  result's ISRC) and tracks Qobuz no longer streams, proposing a streamable
  replacement for each. Matching by normalised artist and title can be allowed
  for upgrades (`--allow-signature-match`, or unticking *Only the same
  recording*) and is always tried for unplayable tracks with no same-recording
  release; such matches are flagged. The plan is reviewed (and, on the CLI,
  only reported unless `--apply`) before anything is written; an old track is
  removed only once its replacement was added, and in playlists the
  replacement is moved into the old track's place (via an undocumented call;
  if Qobuz refuses it, the replacement stays at the end and you are told).
  Tracks now carry Qobuz's `streamable` flag.

- New releases: a new tool (CLI `new-releases` and a web view under *Explore*)
  listing what your favourite artists, or a playlist's artists, have released
  since a date (default the last 30 days): albums and EPs/singles by default,
  live albums and compilations on request, newest first. Releases already in
  your favourite albums are hidden, as are reissues of older albums (a
  "Remastered", "Anniversary", "Expanded" or similar label, or an album the
  artist released before the window); editions of one new album are shown
  once. Pick the ones you want and put them in a new playlist or your
  favourite albums (the CLI reports only unless `--apply` is given with
  `--name` or `--favourite-albums`). Excluded artists are not checked; at most
  200 artists are checked per run. Uses the same
  `artist/getReleasesList` endpoint as the discography mode.

- Playlist from albums can start from an artist's discography instead of a
  list of albums: CLI `--discography "<artist>"` with `--include
  albums,eps,live,compilations` (default studio albums) and `--all-versions`,
  and in the web UI a *Start from: A list of albums / An artist's discography*
  choice with the artist, *Include* checkboxes and *One version of each album*.
  Albums come oldest first. By default an album's editions (remasters, deluxe,
  anniversary, hi-res) are grouped by their title without the edition label
  and the version preference picks one, which the web UI still lets you change;
  releases by other main artists are left out, and the usual filters apply.
  The artist's releases are read from `artist/getReleasesList`, the
  undocumented endpoint the Qobuz web player uses (the parser also accepts the
  older `artist/get?extra=albums` shape); releases are classified as albums,
  EPs and singles, live albums or compilations from Qobuz's type and the title.
  Qobuz labels live albums as plain albums, so a title or version saying
  "Live" (or a greatest-hits title) refines an "album" label; without a label
  the title decides.
- Optional album artwork in the web UI. A *Show artwork* checkbox in the sidebar
  (off by default, remembered in the browser) shows covers next to tracks in
  every review and the deduplicator, and next to each album in playlist from
  albums (following the chosen version). Covers load straight from Qobuz's
  image server; while the setting is off the page requests no images at all.
  Tracks and albums now carry a cover URL (`image`) parsed from the API, with
  album/get tracks taking their album's. See ADR-0004.

- Exclude artists, in every playlist tool. Alongside the track and album terms,
  *Filters* (web) and `--exclude-artist <name>` (CLI, repeatable) take artist
  names matched against each track's performer. A plain name matches the whole
  artist name, ignoring case, accents and extra spaces -- "Drake" excludes Drake
  but not Nick Drake, "bjork" excludes Björk -- and `/.../` is a regular
  expression on the name. Excluded tracks are reported and replaced like any
  other (e.g. a compilation track by an excluded artist starts unticked). In
  similar artists, a similar artist matching a name is skipped entirely -- it
  takes no place and is not walked from, the next most similar one is taken
  instead -- and the left-out artists are listed ("Left out: ..."). Seeds you
  typed are still walked from.

- Similar artists: a new tool (CLI `similar-artists` and a web view) that adds
  the top tracks of the artists Qobuz lists as similar. Start from a list of
  artists, optionally with some of their own top tracks, to create a playlist;
  or from one of your playlists, seeded from its most frequent artists, to
  expand it with artists it does not already have. Choose how many similar
  artists per artist (well beyond the five Qobuz shows on an artist page),
  how many levels deep to go (depth 2 also takes artists similar to the
  similar artists), how many tracks each contributes, and after how many
  similar artists to stop (default 100). None of these has an upper limit;
  instead the tool estimates the largest outcome as you choose and warns about
  a very large run (over about 1000 tracks or 1500 Qobuz requests), which the
  web UI asks you to confirm and the CLI only runs with `--yes`. Each artist
  keeps to its own top matches: a similar artist that already came up uses up
  a place and is listed under every artist it is similar to, but added once
  (in the web UI its copies' ticks stay in sync); `--replace-repeats` (or the
  web checkbox) substitutes the next most similar artist instead. The track
  filters apply.

- Playlist filters. Both playlist tools can exclude tracks whose title (or
  version label) matches a term, and tracks from albums whose title matches a
  term; the album tool can also keep only chosen discs (e.g. "1" or "1,3-4").
  Plain terms match whole words ignoring case, so "live" skips "Live at Leeds"
  but not "Alive"; `/.../` terms are regular expressions. On the CLI these are
  `--exclude-track`, `--exclude-album` and `--discs`. In the web UI they sit
  under *Filters*, and excluded tracks are listed unticked with the reason, in
  their place (popularity rank or album order), rather than hidden. Playlist from artists replaces an excluded track with the
  artist's next most popular one; playlist from albums never picks a release
  that matches an album term.

- Playlist from artists now reports artists that yield no usable tracks and those
  that come up short. Artists that match but return no tracks (commonly a
  regional restriction) are dropped from the preview and called out on their own
  -- an orange warning box in the web UI, a warning line on the CLI. Artists that
  return fewer tracks than requested are kept in the list but noted with their
  count -- a blue info box in the web UI, an info line on the CLI. Previously an
  empty artist rendered a heading with no tracks under it and no explanation.
- Import & export: export favourites (tracks, albums or artists) or a playlist
  as JSON, CSV, plain text or M3U; back up your whole account (favourites and
  playlists) to a lossless JSON file; and import a list back in, resolving each
  entry to a Qobuz item by its id when present (JSON, CSV and M3U can carry one)
  or otherwise by searching and best-matching, with unmatched entries reported.
  Available as the `export` and `import` CLI commands (import resolves and
  reports only unless `--apply` is given; `--account` writes or restores a full
  backup) and as an "Import & export" web view. Adds `searchTracks`,
  `getFavoriteAlbums`, `getFavoriteArtists` and `addFavoriteTracks`/`Albums`/
  `Artists` client methods and the `POST /api/export`, `/api/import/resolve`,
  `/api/import/commit` and `/api/restore` routes (see ADR-0003).
- Playlist from albums: build a playlist from a list of albums given as
  "Artist - Album" (one per line), using every track of each. When an album has
  several Qobuz releases, choose which version to use -- newest, oldest, or
  highest quality -- per album in the web UI (defaulting to a preference you set
  up front) or with a single `--prefer` on the CLI. Available as the
  `playlist-from-albums` command (album lines may also be piped on stdin) and as
  a web view. Adds `searchAlbums`/`getAlbumTracks` client methods and
  `POST /api/resolve-albums` and `/api/album-tracks`. An album whose tracks
  cannot be fetched (a stale id, or a transient Qobuz error) no longer fails the
  whole playlist: the CLI skips and reports it. The web UI fetches every album's
  tracks before writing anything, so failures never cause a partial, out-of-order
  write -- it locks the fetched albums, greys out the version that failed,
  pre-selects the next-best remaining version for each failed album (keeping it
  in place), and only creates or adds the playlist once every album has been
  fetched, in the order the albums were entered.
- Levelled logging with a global `--loglevel <silent|error|warn|info|debug>`
  option (default `info`), accepted anywhere in the arguments. Normal progress
  and results go to stdout, warnings and errors to stderr, and `debug` adds one
  line per Qobuz API request (method, path and status only -- never the signed
  query, so tokens stay out of the logs).
- Web UI deduplicator and multi-tool shell: the web UI now has a sidebar and a
  home page introducing each tool, and hosts the deduplicator alongside the
  playlist tool. The deduplicator lets you scan a playlist or your favourites,
  review each duplicate group (kept copies in green, the rest in red), tick one
  or more copies to keep per group (or "Keep all"), and remove the rest.
  Adds `POST /api/deduplicate/scan` and `/api/deduplicate/apply`.
- Web UI (`qobuz-helper ui`): a local web server plus browser frontend for the
  playlist-from-artists tool. Paste artists (one per line), choose top tracks
  per artist, preview the tracks grouped by artist and untick any you do not
  want, then create a new playlist or add to an existing one (skipping tracks
  already present). The server binds to `127.0.0.1`, keeps the Qobuz session
  server-side, and authorises each API request by Host, Origin and a per-run
  nonce. Adds a `getUserPlaylists` client method, a resolve/commit split of the
  playlist feature, and an esbuild-bundled frontend (see ADR-0002).
- Bundle-credential caching: the validated app id and app secret scraped from
  the Qobuz web player are cached locally (owner-only, at
  `$XDG_CONFIG_HOME/qobuz-helper/bundle.json`), so later runs skip the web-bundle
  download and secret probe and start almost instantly. The cache expires after a
  week and is discarded automatically when a run fails on stale credentials.

- Project scaffolding: TypeScript, Vitest, and the going-forward engineering
  conventions (see ADR-0001).
- Qobuz client vertical slice: bundle-token extraction, request signing,
  browser OAuth sign-in, and a first authenticated request.
- Playlist-from-artists tool: resolve a list of artist names to their top
  tracks and build a playlist from them (`qobuz-helper playlist-from-artists`).
  Adds client methods for artist search, artist top tracks, playlist create,
  and add-tracks.
- Deduplicator tool (`qobuz-helper deduplicate`): report duplicate tracks in a
  playlist or your favourites, matching by ISRC or a normalised artist+title
  signature that catches remasters and same-song-different-album while keeping
  live/acoustic/remix versions separate. Reports only; makes no changes. Adds
  paginated fetching of playlist and favourite tracks (with ISRC/artist/album).
- Deduplicator keep/remove plan: each duplicate group marks one copy to keep and
  the rest to remove, chosen by `--keep <strategy>` (default `first-added`). The
  plan is a structured resolution whose kept choice can be overridden before a
  removal step consumes it.
- Deduplicator keep strategies: `last-added`, `highest-quality` (bit depth then
  sample rate), and `oldest`/`newest` by release date (looked up per album when
  not inline). Enriches tracks with album id, quality, playlist-track id and
  release date.
- Deduplicator `--apply`: actually remove the tracks marked to drop, from a
  playlist (`playlist/deleteTracks`) or from favourites (`favorite/delete`).
  Without `--apply` the command still only reports.
- Session persistence: the session is saved locally after sign-in and resumed
  automatically on later runs (via a token re-login), falling back to the
  browser only when there is no saved session or it has expired. Adds `login`
  and `logout` commands and a `loginWithToken` client method. The token is
  stored owner-only at `$XDG_CONFIG_HOME/qobuz-helper/session.json`.

### Changed

- **A new web UI: your library first, in a new look.** The page opens on your
  playlists from every connected service, in a sidebar with a coloured dot for
  each service; tabs at the top (All, Qobuz, TIDAL, Spotify) filter it without
  reloading the page. A playlist's page has its tools as buttons (Find repeats,
  Upgrade, Copy to..., Link, Stats, Export), and each opens on that playlist's
  own service. Tools that work on one service say which ("This works on
  Qobuz"), with a link to switch; the service list at the bottom left is gone.
  Favourites and All playlists have pages of their own per service; tools that
  start from scratch are under **+ New**, managed playlists and links under
  **Jobs**, and Accounts and the artwork setting under **Settings**. The look
  is new too: near-black, rounded, with each page tinted by its cover. Album
  artwork is still off until you turn it on; until then covers are drawn from
  the album's or playlist's name, and nothing is fetched. Old addresses
  (`#/playlists/...`, `#/accounts`, `#/deduplicate`, `#/managed`, ...) still
  work.
- **Tools open inside the playlist they act on.** Find repeats, Upgrade, Stats,
  Export, Similar artists and Combine open on the playlist (or on Favourites or
  All playlists) under a bar naming it, with the tool's own source picker out
  of the way; *Link...* links the playlist from its page. **Favourites** lists
  its songs. **Tick playlists** in the sidebar to combine them (across services
  too), remove artists from them, or delete them together (an open page of one
  of them goes to its service's list). Home drops its list of tools, which are
  under *+ New* and on each playlist; its paste box became the ask box. When the page has to load afresh (a tool on another service, or on
  another playlist than it last showed), it asks first if a tool has a preview
  you have not saved. It no longer asks after a scan that found nothing to
  save, and does ask about a half-filled managed playlist or an import not yet
  previewed.
- On All playlists, *Stats* is now *Library stats*: it always counted your
  Favourites too. On touch screens, tapping a playlist's cover in the library
  opens it instead of ticking it.
- **The app is now called crosstune**, as it works with TIDAL and Spotify as
  well as Qobuz: the command is `crosstune`, and its settings live in
  `~/.config/crosstune`. Nothing of the old name is kept -- a scheduler that
  runs `qobuz-helper run-due` must be changed to `crosstune run-due`, and an
  old `~/.config/qobuz-helper` folder moved by hand (ADR-0014).
- Groundwork for other music services: every id now names its service. Nothing
  looks different: history, managed playlists and backups made before still work,
  and exports, `--json` and printed ids keep Qobuz's own form. Jobs files are
  rewritten in a newer form when next saved, which earlier versions refuse.
- A backup's entries without a usable id are left out of a restore; they used to
  be sent to Qobuz as id 0.
- Qobuz API requests now retry an HTTP 400 with exponential backoff (up to five
  times: 500ms, 1s, 2s, 4s, 8s) before failing, so a transient throttle no
  longer stops a run. The secret-probe step is exempt, as it uses a 400 to
  reject a candidate secret rather than as a throttle signal.
- Playlist from albums in the web UI now has a review step: after choosing
  versions, "Fetch tracks" lists each album's tracks for ticking and unticking,
  and a second click saves them. Previously the whole of each album was written
  without a track list. The destination is no longer locked once tracks have
  been fetched, since nothing is written until you save.
- The web UI has a new look ("Console"): warm charcoal with a single amber
  accent, set in Archivo (self-hosted, so the page still makes no third-party
  requests). The sidebar groups the tools (Build, Tidy up, Your data) and the
  home page lists them by group. Multi-step tools show which step you are on;
  while reviewing, the destination and save button stay docked at the bottom of
  the window with the number of selected tracks. Track rows show the album and
  year, and a quality badge ("24/96", lit up for hi-res). Buttons and controls
  are at least 44px tall, focus is always visible, motion respects the
  reduced-motion setting, and on a phone the sidebar stacks above the content.

### Fixed

- The Deduplicator (and Combine, and scheduled tidy-ups) could take a live or
  remixed version for a duplicate of the original and remove it: matching by
  artist and title ignored the version label Qobuz keeps apart from the title.
  The label now counts, edition wording ("2011 Remaster") aside.
- Songs with titles in other scripts (Cyrillic, Japanese, Greek...) could all
  count as one song: everything outside a-z and 0-9 was dropped before comparing,
  which left nothing. Letters of every script are kept now, and titles that are
  only punctuation ("?", "!!!") are compared as written.
- Undoing a change no longer leaves other songs at the end of the playlist when
  one of them can no longer be played, and says which could not be put back:
  Qobuz accepts such an add without an error and adds nothing.
- A deleted playlist that was public comes back public when the deletion is
  undone.
- A change could vanish from the history when two qobuz-helper processes
  wrote it at the same moment (say the CLI while the web UI was open): trimming
  the history rewrites the file from what it read, dropping a record the other
  process appended in between. Every history write now holds a lock file
  (waiting briefly while another process has it).

- The deduplicator now removes a track that was added to a playlist twice.
  Both entries carry the same track id, and the plan marked "the track to
  keep" by id, so every entry of the kept track was kept and nothing was
  removed; in the web UI, unticking the second entry would have removed the
  first. The first entry is now the one kept, and the web UI tracks each
  entry by its position.
- Playlist from artists no longer counts covers of an artist's songs by other
  performers towards that artist's top tracks. Qobuz's artist page mixes in
  covers (e.g. Johnny Cash's take on a Bob Dylan song surfaces on Dylan's page),
  which could crowd out the artist's own tracks under the requested limit. Tracks
  whose main artist differs from the requested one are now dropped before the
  limit is applied; tracks with no artist id are kept.
- Resolving a large list in the web UI no longer fails with a "NetworkError"
  while the work actually succeeds. Playlist-from-artists, playlist-from-albums
  and import all resolved their items strictly one at a time, holding a single
  request open long enough (100+ items) for the browser to abort the fetch. They
  now resolve through a small concurrency pool, so the request completes well
  within the browser's fetch timeout. Results are still returned in input order.
- Import: a line with a title but no artist ("Yesterday") was matched to
  whichever song the search ranked first with that title, since the artist
  check was skipped. Such a line is now matched only by its ISRC; otherwise it
  is listed as unmatched ("no artist given"), without a search.
- Import: an artist line was favourited as the first search result when no
  result had the same name, so an artist Qobuz does not have became somebody
  else. Only a result with the same name counts now (ignoring case, accents and
  spacing, or failing that punctuation); anything else is listed as unmatched.
- Import: one failed search (an HTTP 500 or a timeout) on any line rejected the
  whole resolve, so a 3,000-line import that failed on line 2,999 gave no plan
  and no list of what was not found. The line is now listed as unmatched ("could
  not be looked up") and the rest go on. An error every line would meet (signed
  out, out of quota, rate-limited) still ends the resolve.
- Import: newer Exportify exports join a song's artists with `;`, and a name can
  hold a comma ("Tyler, The Creator"), but the column was always split on `,`,
  so the search used the wrong artist. A field that contains `;` is now split
  on `;` only; older exports keep the comma split.
- Import and restore in the web UI: the success message sat inside the preview
  panel, which is hidden as soon as the import finishes, so it was never seen
  and you could import twice. The result and any error now stay visible, and are
  cleared when a new preview starts. A backup restore also committed the text
  box's current text rather than the text you previewed; it now commits the
  previewed text, and editing the box or choosing a file resets the preview.
- Restoring a backup no longer drops songs that repeat in a playlist on Qobuz,
  and no longer reports songs that never arrived: restore added a whole playlist
  in one request, and Qobuz adds a repeated song once per request. It now adds
  in order, reads the playlist back, and reports the real count and the missing
  songs (CLI and web).
- Exporting to M3U or text: a song title holding a line break added extra
  entries to the file. Control characters now become spaces.
- Find repeats: the same recording written `gb-aaa-91-00001` in one place and
  `GBAAA9100001` in another was not found by its ISRC, as the ISRC was compared
  as the service wrote it. It is now normalised first, as matching and upgrade
  already did.
- Find repeats: once a title held any edition word, every four-digit year and
  every "version", "edition", "mono" and "stereo" in it was dropped. So "1979"
  and "1979 (Remastered 2012)" were not found as duplicates, "Summer 1999
  Remastered" and "Summer 2001 Remastered" counted as one song (and one was
  offered for deletion), and "Stereo Love" was the same song as "Love". A year
  is now dropped only in the version part (in brackets or after a spaced dash)
  and beside an edition word; "mono" and "stereo" only in the version part.
- Find repeats on Qobuz could delete the only real copy of a song: when one item
  on a page of a playlist (or of favourites, playlists or an artist's releases)
  could not be read, the last item of that page was read twice with the same
  entry id, and the deduplicator offered to remove "the extra copy" by that id.
  Paging now moves on, and stops, by the number of items Qobuz returned rather
  than the number that could be read.
- Upgrade and repair: being signed out, out of quota or rate-limited turned up to
  600 searches into 600 "failed" checks and a plan that looked as if nothing
  could be upgraded. Those errors now end the run and say what is wrong, as in
  matching; any other failed search is still counted against its own song.
- Qobuz: when Qobuz revoked your token while crosstune was running (signed out
  elsewhere, password changed), every request failed with a bare "HTTP 401": the
  web UI showed a 502 instead of asking you to connect Qobuz again, and scheduled
  jobs did not flag the service. A 401 is now a sign-in error everywhere.
- Qobuz: when Qobuz could not be reached, the client threw a bare `fetch` error,
  so the server answered 500 "fetch failed", and a connection that stalled
  hung the run for good. Each try now has a 60 second limit, and a failed fetch
  is reported as a network error, as with TIDAL and Spotify.
- Qobuz: if Qobuz answered the check of the app secret with a 5xx or 429 while
  the credentials were being extracted, a wrong secret was chosen and cached; for
  up to 7 days every signed request then failed with HTTP 400 after 15 seconds
  of retries. The check now fails without choosing a secret, and a cached secret
  whose first request still fails with 400 after every retry is dropped, so the
  next start extracts it again.
- Spotify's missing top tracks and similar artists, taken from Qobuz or TIDAL,
  could come from another artist of the same name there, and a similar artist
  could be mapped back onto the wrong one of several same-named Spotify artists
  (written unseen by managed playlists). An artist is now taken only when
  exactly one has the name.
- Playlist from artists: a misspelt name, or an artist the service does not have,
  was quietly replaced by whoever the search ranked first, and that stranger's
  top tracks went into the playlist (and seeded similar-artists walks and
  discographies). An artist now counts only when spelled the same, ignoring case,
  accents and spacing ("Beyonce" finds "Beyoncé"), or differing only in
  punctuation or "&" for "and"; otherwise the line is listed as unmatched.
- Playlist from artists, Playlist from albums and Similar artists: one failed
  request (an HTTP 500 or a timeout) lost everything found so far. An artist or
  album line that fails is now listed ("could not be looked up", or "its songs
  could not be fetched"), an artist whose similar artists cannot be read is not
  expanded, and the rest carry on. An error every request would meet (signed out,
  rate-limited, out of quota) still ends the run.
- Playlist from albums: if the sign-in expired or the service rate-limited while
  the chosen versions' tracks were fetched, each album was quietly listed as
  "could not fetch tracks" and the playlist was still created, partial or empty.
  Those errors now stop the build before anything is written; one album that
  fails on its own (a stale id) is still reported and skipped.
- The artist and album builders created an empty playlist, and reported success,
  when no artist or album turned into a song. They now stop before creating
  anything and say why ("No tracks to add (not found: ...); nothing was created").
- Playlist from albums: "Band - Foo" matched "Foo (Live)" and "Foo (Instrumental)",
  so highest quality or newest could pick a live or instrumental release; titles
  made only of symbols ("+", "=", "÷") matched each other. The matcher dropped
  every bracketed part of a title; it now drops only edition labels such as
  Deluxe, Remaster or Reloaded, and compares a title with no letters as written.
- Word play: titles like "Sorry (Not Sorry)" and "Time (Clock of the Heart)" lost
  their bracketed part, so the one-word title search accepted the wrong song and
  A-to-Z and acrostic used the wrong first letter. Only brackets holding a
  version word or a year ("(Live)", "[Remastered 2009]", "(2011)") are dropped.
- Word play: an acrostic with a repeated letter and only one song for it reported
  two songs while writing one. The plan now shows the gap.
- A long list resolved with a failure early on still cost a request for every
  remaining item, and a concurrency limit of 0 resolved at once with nothing
  done. Resolving now stops claiming items after the first failure and always
  runs at least one at a time; results keep their input order.
- Undoing a change to a playlist that was deleted on TIDAL or Spotify stopped for
  good with "could not be read ... try again": a deleted playlist was told from
  an unreadable one by looking for "HTTP 404" in the error text, which only Qobuz
  holds. Both now count as gone, as elsewhere.
- Undoing an import, restore or other add to favourites no longer removes
  favourites you already had: History recorded every song sent as newly added,
  even ones already favourites. Only songs that were actually new are now added
  and recorded.
- Undoing a sync older than the link's last 20 now pauses the linked playlist:
  only the last 20 syncs were recognised, so the next sync read the undo as your
  own removals and deleted those songs from the other service. History entries
  now record which link they belong to (older entries still rely on the list).
- Scheduled jobs: two runners (cron's `run-due` and the `serve` ticker) could
  both judge a lock stale, and the slower one then deleted the lock the faster
  had just taken, so both ran. A stale lock is now taken over atomically. A lock
  whose process is alive on this host was also taken over after two hours,
  giving a long job a second runner; age now applies only to locks from another
  host. A lock taken before the machine last started is stale whatever process
  now has its pid, so one crashed run can no longer stop every job.
- The session token (`session.json`) was written in place, so a crash mid-write
  left it truncated and you appeared signed out. It is now written to a
  temporary file and renamed over.
- A `links.json` that is valid JSON but the wrong shape (`null`, `{"links":5}`)
  crashed with a TypeError. It now gets the same "cannot be read; fix or remove
  it" error as broken JSON, and is never overwritten.
- CLI: playlist-from-artists, playlist-from-albums and import took any
  unrecognised token as an artist, album line or file, so a mistyped `--publc`,
  or an `--apply` after the wrong command, became an artist name and
  playlist-from-artists wrote at once; `--name --public` took `--public` as the
  name. An unknown `--option` is now an error, an option that takes a value
  refuses a missing value or another option, and a bare `--` makes the rest
  names. `--json` and `--loglevel` are no longer stripped after a bare `--`.
- Web page: choosing another service in a second tab retargeted this tab's
  requests, as the choice was read from storage on every call. It is read once
  per page load.
- Web page: a fetch of an album's tracks started for an earlier preview could
  overwrite the picker state of a newer one. Old results are now ignored.
- Web page: *Delete...* in the sidebar group stayed clickable while the ticked
  playlists were being deleted, so a second run could start on the same ticks.
  The actions are now inert until the deletes and the refresh finish.
- Web page: a playlist with edits not yet saved made the page change its stored
  state (Combine's sources, the remembered tab and service, the address) before
  the browser's own prompt appeared, and cancelling it left stale state. The
  editor now counts as an unsaved preview, so the in-app dialog asks first.
- Web page: signing in, signing out or forgetting an account reloaded the page
  at once, losing unsaved previews in other tool views without asking. They now
  ask like any other reload; if you stay, the accounts list is refreshed.
- Web page: Combine could show the answer for other settings than the ones you
  had chosen, as the mode was read again after the request and overlapping
  requests raced. Each answer is now shown only for the settings it asked with,
  changing options while a combine is running starts a newer one, and the stale
  list cannot be saved meanwhile.
- Web page: the bar with Combine, Remove artists and Delete for ticked
  playlists was drawn under the tick boxes of the rows scrolled behind it, so
  they got in the way of its buttons: the boxes were stacked above the bar. The
  bar now sits above them.
- Web page: removing artists, and deleting several ticked playlists, gave no
  sign that anything was happening, so it looked stuck. The buttons now read
  "Removing N songs..." and "Deleting 2 of 5..." until they are done.

### Security

- The local server read a whole request body, of any size, before checking the
  request's Host, Origin and nonce; served the page and its nonce to any Host;
  and sent no protection headers. Requests are now authorised before their body
  is read, bodies over 32 MiB get a 413, the page needs an allowed Host, and every
  response carries `nosniff`, `X-Frame-Options: DENY` and a Content-Security-Policy
  (own scripts, styles and fonts only; the page cannot be framed).
- Any web page could fire a request such as
  `<img src="http://localhost:53683/?code_autorisation=junk">` and use up, or
  supply a code for, the Qobuz sign-in that was waiting: Qobuz's redirect carries
  no OAuth state, so the listener completed the sign-in on any GET with that
  query. It now refuses a request that is not a navigation to a document.
- Exported CSV: a title such as `=HYPERLINK(...)` ran as a formula when the file
  was opened in Excel or LibreOffice. A field starting with `=`, `+`, `-`, `@`,
  tab or carriage return now gets a leading apostrophe; crosstune's own import
  strips it again, so titles round-trip.
- The folders under crosstune's config folder (sign-ins, accounts, jobs, links,
  matches, History, locks) were created readable by other local users (0755).
  New ones are created 0700; folders that already exist are not changed.
- On Windows, a sign-in link containing `&` was cut there and the rest was run as
  a command, as the browser was opened through `cmd /c start`. The link is now
  handed to the system directly, without a shell.
