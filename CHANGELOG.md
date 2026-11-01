# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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

### Changed

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

### Added

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
