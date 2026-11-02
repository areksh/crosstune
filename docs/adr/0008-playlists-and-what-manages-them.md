# ADR-0008: Playlists and what manages them

- Status: accepted
- Date: 2026-11-02

## Context

ADR-0007 introduced jobs with one kind: a managed playlist the job creates and
fills from a new-releases recipe. The user asked for more of the tools to run
on a schedule -- a combined playlist kept in sync with its inputs, and the
tidy-ups (dedupe, upgrade, repair) on playlists -- and for the Managed view to
show *a playlist, then what manages it*.

Tidy-ups and a source on the same playlist conflict if they are separate jobs:
when an upgrade swaps track A for its hi-res copy B, the source's reconciler
sees "A removed by the user, B added by hand" (respect mode: A dismissed,
misleading) or simply puts A back and removes B (mirror mode: a fight every
pass). The design is in
`docs/superpowers/specs/2026-11-02-managed-playlists-v2-design.md`.

## Decision

- **One job per playlist.** A job is a *target* (a playlist it created, one
  of the user's -- "adopted" -- or the favourites), an optional *source* and a
  set of *tidy-ups*, sharing one schedule and one state file. The service
  refuses a second job on the same playlist and source chains that lead back
  to their own playlist; `runDue` runs a job after the job managing a playlist
  it reads.
- **Substitutions.** An applied tidy-up records "desired A is satisfied by B"
  (or "A is left out"). The source's desired list is mapped through them
  before reconciling, so neither edit mode undoes a tidy-up. While a
  substitution stands the source never adds A, so A reappearing is the user's
  (or an undo's) doing: the substitution is dropped and the finding ignored
  from then on.
- **Findings, applied or suggested.** Each tidy-up produces findings with
  stable keys (`repair:A`, `upgrade:A>B`, `dedupe:<ids>`); per tidy-up the user
  chooses to apply them (one history entry with the pass) or keep them as
  suggestions to accept (under the jobs lock, one history entry) or ignore.
- **Respect only on adopted playlists.** Strict mirror would remove the user's
  own tracks; it is offered only on playlists the job created. Removing an
  adopted job never deletes the playlist.
- **Deterministic sources.** Combined and smart re-read their inputs each pass;
  follow/archive keeps a seen list; discovery stores each rotation's picks,
  drawn with a PRNG seeded by job id and rotation. Shuffles order by a hash of
  job id and track id, so a new track does not reshuffle the rest.
- **Favourite dates carried over.** Qobuz re-dates a favourite that is
  replaced; the favourites job keeps the original dates and passes them to
  sources and dedupe that order or filter by them.
- **Versioned files.** `jobs.json` and job states move to version 2; version
  1 files are read into the new shape, and nothing is rewritten by reading.

## Consequences

- A playlist's behaviour is one definition and one state file, and the UI
  maps onto it one-to-one; the price is that two sources cannot fill one
  playlist (a combined source over two managed playlists does that instead).
- Substitutions and ignored keys grow with use; they are capped (oldest out).
- Tidy-ups on the favourites still show upgraded songs as recently added in
  the Qobuz apps; only qobuz-helper sees the original dates.
- Upgrade checks are incremental (a search budget per pass, re-checks after 90
  days), so a large playlist is upgraded over several passes.
