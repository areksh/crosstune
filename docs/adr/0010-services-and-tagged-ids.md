# ADR-0010: Services, and ids that carry theirs

- Status: accepted
- Date: 2026-11-23

## Context

qobuz-helper is to work with TIDAL and Spotify as well as Qobuz, and with more
services later (docs/superpowers/specs/2026-11-23-multi-service-design.md).
Every tool knew one client and bare numeric ids. TIDAL and Spotify use text ids,
and once tools mix services, Qobuz track 123 and TIDAL track 123 must not be the
same song.

## Decision

- **Ids carry their service**: `"<service>:<native id>"`, split at the first
  colon, the native part opaque. They are distinct (branded) string types per
  kind of thing, made only by a service's adapter or a validating reader
  (`src/services/ids.ts`). Rejected: passing the service alongside bare ids
  (mixing tools would confuse equal numbers, undetected), and a local library of
  merged songs (a rewrite, stale, and restricted by the services' terms).
- **A service is one folder** under `src/services/` implementing `MusicService`,
  declaring its `Capabilities` (each `no` with the reason the user is shown), and
  passing the shared contract tests. Qobuz's client keeps its own ids and tests;
  `QobuzService` adapts it.
- **`ServiceHub`** routes by id. `scoped(name)` is the hub as one service: calls
  that name no id go to it. Putting a track into another service's playlist is
  refused: crossing services is always an explicit step.
- **Recording** (ADR-0006) wraps each service; every write in `MUSIC_WRITES` is
  recorded, and a test classifies every method.
- **Older data is Qobuz's.** A bare id in a history line, a jobs or state file
  (now version 3), a backup, a link or a command reads as Qobuz's. Reading never
  rewrites. Exports, backups, `--json`, printed ids and stored keys keep Qobuz's
  own form (`shortId`).

## Consequences

- An older qobuz-helper refuses version 3 job files and skips new history lines;
  downgrading loses sight of both, not the data.
- `--json` tells Qobuz's numbers from album ids by length (`output.ts`): an album
  id is text or a barcode of 12 digits or more. A shorter all-digit album id
  under a plain `id` would come out as a number.
- Supersedes ADR-0002 and ADR-0003 where they speak of numeric ids.
