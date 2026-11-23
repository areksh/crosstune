# Multi-service: where it stands

Branch `multi-service` (not pushed, not merged). The user approved the design and
asked to proceed without further approvals, doing as much as possible before
stopping for TIDAL and Spotify details. Skip mockup approval; show the result.

| Phase | State |
|---|---|
| 1 Common layer | Done, reviewed, fixed; live read-only checks matched byte for byte |
| 2 Accounts | Core, routes, listener, CLI wiring, Accounts view, jobs per service done. Left: `login <service>`, register TIDAL/Spotify connectors, forget (data), capability reasons in tools, README, ADR-0011, review |
| 3 TIDAL | Adapter being built by an agent in a worktree (branch from multi-service). Left: merge, register, probes with the user's app |
| 4 Crossing | `features/match.ts` done. Left: matches file, transfer (resolve/commit), routes, destinations in the editor and tools, combined views, compare, CLI, ADR-0012 |
| 5 Spotify | Adapter being built by an agent in a worktree. Left: merge, register, gap filling, probes |
| 6 Sync | Not started: pure engine first (three-way merge, conflicts, write-ahead record), then job kind, UI, ADR-0013 |

Needs the user: TIDAL client id, Spotify client id (Premium owner), one real
sign-in to each, and leave to run probes with scratch playlists.
