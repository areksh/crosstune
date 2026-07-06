# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
