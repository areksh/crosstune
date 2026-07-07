# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Qobuz API requests now retry an HTTP 400 with exponential backoff (up to five
  times: 500ms, 1s, 2s, 4s, 8s) before failing, so a transient throttle no
  longer stops a run. The secret-probe step is exempt, as it uses a 400 to
  reject a candidate secret rather than as a throttle signal.

### Added

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
