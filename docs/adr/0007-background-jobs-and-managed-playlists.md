# ADR-0007: Background jobs and managed playlists

- Status: accepted
- Date: 2026-11-02

## Context

Every tool so far ran only while the user ran it. Some things are only useful
when they keep happening: a playlist of what a set of artists released lately
should change as they release, without the user rebuilding it. That needs
*jobs* -- saved definitions qobuz-helper runs on a schedule, unattended -- and
a first job kind, the *managed playlist*, which qobuz-helper owns and keeps
current from a saved recipe (the new releases of chosen artists, optionally
with a snapshot of their similar artists).

It has to work both on an always-on machine (a home server, a NAS, a
container) and on a desktop that sleeps, with zero runtime dependencies, and
unattended: a Qobuz outage, a bundle change or an expired session must never
empty a playlist, and must be visible. The design is in
`docs/superpowers/specs/2026-11-02-background-jobs-managed-playlists-design.md`.

## Decision

- **One engine, two drivers.** `runDue(deps, now)` (`src/jobs/run-due.ts`) runs
  whatever is due, then returns. `qobuz-helper run-due` calls it once, from an
  OS scheduler (`schedule print` prints a cron, systemd, launchd or Task
  Scheduler snippet; nothing is installed for the user). `qobuz-helper serve`
  is the web UI plus a one-minute ticker that calls it. Unattended paths never
  open a browser; `login --print-url` signs in without one.
- **Catch up once.** A job's next run is the first slot of its schedule after
  *now*, not after the previous slot, so a machine that slept through several
  runs a job once on waking. Timers are not trusted across sleep; each tick
  compares wall-clock time.
- **Files, split by writer** (all owner-only, under the config directory):
  `jobs.json` (definitions; written by the CLI and the UI, validated on load,
  an invalid job skipped and reported, an unreadable file never overwritten),
  `jobs-state/<id>.json` (state; written by the runner -- including the managed
  playlist's id, which the runner creates), `jobs-runs.jsonl` (the run log,
  compacted to 500 lines / 90 days), `jobs-global.json` (flags that stop every
  job: session rejected, bundle broken).
- **A lock** (`jobs.lock`, created exclusively, taken over when its process is
  gone or it is over two hours old) keeps a scheduled `run-due` and a running
  `serve` from refreshing at once. Jobs run one after another. The same lock
  helper now guards history compaction, which could drop a record another
  process appended meanwhile (accepted in ADR-0006, likelier with a long-lived
  writer).
- **Reconcile, don't rebuild.** A refresh resolves the recipe into the desired
  tracks, reads the playlist, and adds and removes the difference
  (`src/jobs/reconcile.ts`). The job remembers the entries it added (*owned*,
  by playlist-track id). Each managed playlist chooses how hand edits are
  treated: *respect* (the default -- an owned entry the user removed is
  *dismissed* and never added again; entries the user added are never
  removed) or *mirror* (the playlist is reset to the desired list). New tracks
  are moved into the recipe's order with the fewest moves (a longest
  increasing run stays put), and never past the end of the playlist.
- **Safety.** A recipe reports whether it read everything; an incomplete
  resolve adds but never removes. A deleted managed playlist pauses its job
  instead of being recreated. A rejected session pauses every job (no failure
  is counted) until the next sign-in; other failures back off 15 minutes, 1
  hour, then 6 hours, never past the next regular run.
- **History.** Each refresh is one history entry ("Managed: <name>") through
  the recording client, so it can be undone; an undone refresh then looks to
  the next one exactly like the user removing those tracks, and they are
  dismissed -- the reconciler needs no knowledge of the journal.
- **Determinism.** The similar artists of a feed are a snapshot, refreshed
  every 30 days (by default), so changes in Qobuz's similar lists do not churn
  the playlist between refreshes.

## Consequences

- New commands: `jobs` (list, show, create, pause, resume, run, remove),
  `run-due`, `serve`, `schedule print`, `login --print-url`. New web view:
  *Managed playlists*, also reached from New releases and Similar artists
  ("Keep this updated...").
- `findNewReleases` gained windows (last N days, since a date, each artist's
  newest N), an explicit artist list, and a switch to keep favourited
  releases.
- Reordering relies on `playlist/updateTracksPosition`; when a move fails the
  new tracks stay at the end and the run says so.
- A headless machine's UI is reached through an SSH tunnel; the server still
  only listens on `127.0.0.1` (ADR-0002).
- Later job kinds (discovery radio, combined, smart and followed playlists,
  backups, upkeep) and notifications plug into the same engine; they are
  designed in the spec and phased in separately.
