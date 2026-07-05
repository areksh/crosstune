# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
