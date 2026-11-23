# ADR-0012: Matching songs across services

- Status: accepted
- Date: 2026-11-23

## Context

Copying, comparing and syncing need a song's counterpart on another service.
Search ranking cannot be trusted, and a wrong match written unseen is a wrong
song in someone's playlist.

## Decision

- `features/match.ts` grades each song: **exact** (the same ISRC, with title,
  artist and length -- within 5 seconds -- not contradicting it), **likely**
  (matched by name, another version, or an ISRC whose details disagree; shown
  to the user with the other options) or **missing**. Among copies: the same
  album, then quality, then the earliest release. Songs already on the service
  are taken as they are; non-songs never match.
- Only exact matches, and those the user chose, are written. What the user
  chooses or rules out is remembered in `matches.json`, ids only, per
  destination service and in that direction only. A remembered match that no
  longer plays is looked up again.
- Copying is two-phase like every tool: `/api/transfer/resolve` writes nothing;
  `/api/transfer/commit` writes what was reviewed, as one History entry.
- What a service cannot say (Spotify's top tracks and similar artists) is asked
  of another connected service and matched back (`services/gap-filler.ts`).
- A view can show every service at once; the routes that work on one service
  refuse that with a request to choose one.

## Consequences

- Matching costs one ISRC lookup per song (TIDAL, Spotify: one request each)
  plus a search for those without one.
- `--json` and files keep Qobuz's own ids; others' are written whole.
