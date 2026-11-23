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

Deferred minors, all since fixed: a failed sign-in is a SignInError (no
longer "expired", nor disconnecting the account); the listener serves sign-ins
started together and binds once; `login` reports the listener's reason; a
conflict shows each copy's changes side by side, and linked playlists are
marked in Playlists and on their page (Home has the notices above every view);
Combine's "only in the first" copies to the second playlist across services;
Spotify and TIDAL links are read everywhere, another service's artist or album
found again here (never a guess between namesakes).


Live (2026-11-23, after the user registered both apps and signed in): the
probes ran on scratch playlists, each deleted after; results are at the top of
the TIDAL and Spotify adapters. Fixed from them: Spotify removals named a read's
stale snapshot and removed nothing (one copy of a repeat became two); Spotify
ignores an empty description; TIDAL listed an ISRC's track twice and refuses
names over 250 characters. A live TIDAL<->Spotify two-way sync then worked:
each side's edit reached the other, a second run changed nothing, and renames
on both sides were a conflict that wrote nothing.

Then, with leave to use all three accounts: a Spotify playlist made private
stayed off the user's profile (reads say public regardless, so visibility is
no longer read); library and favourites writes behave on both; Spotify's
is_playable is read (removals on Spotify sync), with repairs gated on claimed
playability; a live three-way sync (add on Qobuz, reorder on TIDAL, removal on
Spotify, a repeated song) and the web UI (Accounts, Playlists across services,
the conflict marks and side-by-side, settling, Combine's "Add these to") ran
against the real services, driven in headless Chromium.

Still not probed: playlist size limits; unavailable or relinked tracks.
