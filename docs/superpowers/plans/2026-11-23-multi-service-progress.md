# Multi-service: where it stands

Branch `multi-service` (not pushed, not merged). The user approved the design and
asked to proceed without further approvals, doing as much as possible before
stopping for TIDAL and Spotify details. Skip mockup approval; show the result.

| Phase | State |
|---|---|
| 1 Common layer | Done, reviewed, fixed; live read-only checks matched byte for byte |
| 2 Accounts | Done: sign-in from the UI and `login <service>`, Accounts view, jobs per service, forget (matches, links, jobs, History), ADR-0011 |
| 3 TIDAL | Adapter merged and registered. Left: probes with the user's app |
| 4 Crossing | Done: matching, matches file, transfer resolve/commit, routes, "All services" views, send-to-service in the editor and every Build/Explore tool ("On"), `copy`, ADR-0012 |
| 5 Spotify | Adapter merged and registered; top tracks and similar artists from another service. Left: probes |
| 6 Sync | Done: engine, links store, runner with the jobs, routes, `sync`, undo pauses, Linked playlists UI with conflict resolver, notices on every page and nav badge, ADR-0013 |

Final review (2026-11-23, three reviewers: sign-in, sync, matching/adapters).
Fixed, each with a failing test first: a Spotify repeat put back after the
user removed it; quiet runs pushing real syncs out of a link's undo list;
undoing a settled conflict not pausing the link; undo racing a sync (now
paused first, under the lock; a paused link never runs); an interrupted sync
undoing edits on finished copies; top tracks from another service letting
likely matches and namesakes through; forget dropping unreadable History
lines; the CLI's Qobuz sign-in ignoring the one-account rule. Also: forget
order, token request timeout, 403 stops matching, `copy --json` ids, exit 3
only while a conflict stands, `accounts` showing a not-yet-recorded sign-in.

Deferred (minor): a mistyped pasted sign-in code answers 502 and shows
"expired" for a service that was not connected; the loopback listener's
lifetime (closes on the first success, two at once clash on the port);
`login tidal|spotify` reports a generic failure where the browser tab had the
reason; no conflict mark on the playlist page or Home, and no side-by-side of
a conflict's changes (counts only); Combine has no compare-across-services
view; pasted Spotify/TIDAL links are not parsed (ids and names only).


Needs the user: TIDAL client id, Spotify client id (Premium owner), one real
sign-in to each, and leave to run probes with scratch playlists.
