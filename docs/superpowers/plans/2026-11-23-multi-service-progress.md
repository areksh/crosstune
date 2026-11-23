# Multi-service: where it stands

Branch `multi-service` (not pushed, not merged). The user approved the design and
asked to proceed without further approvals, doing as much as possible before
stopping for TIDAL and Spotify details. Skip mockup approval; show the result.

| Phase | State |
|---|---|
| 1 Common layer | Done, reviewed, fixed; live read-only checks matched byte for byte |
| 2 Accounts | Done: sign-in from the UI and `login <service>`, Accounts view, jobs per service, forget (matches, links, jobs, History), ADR-0011 |
| 3 TIDAL | Adapter merged and registered. Left: probes with the user's app |
| 4 Crossing | Done: matching, matches file, transfer resolve/commit, routes, "All services" views, send-to-service in the editor, `copy`, ADR-0012. Destination choice in the other tools: agent branch, merge pending |
| 5 Spotify | Adapter merged and registered; top tracks and similar artists from another service. Left: probes |
| 6 Sync | Engine, links store, runner with the jobs, routes, `sync`, undo pauses, ADR-0013 done. Web UI (links, conflicts, notices): agent branch, merge pending |

Left before stopping: merge both web branches, whole-branch review and fixes.

Needs the user: TIDAL client id, Spotify client id (Premium owner), one real
sign-in to each, and leave to run probes with scratch playlists.
