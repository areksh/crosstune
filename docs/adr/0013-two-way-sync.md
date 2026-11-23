# ADR-0013: Linked playlists and two-way sync

- Status: accepted
- Date: 2026-11-23

## Context

The user keeps the same playlist on several services and edits it in whichever
app is at hand, and asked for two-way sync: on a conflict nothing is written and
the user fixes it in the UI, which must make the issue obvious.

## Decision

- A **link** joins one playlist on each of two or more services (`links.json`,
  state in `links-state/<id>.json`). It runs with the managed playlists: the
  same schedule shape, lock and run log, apart from `jobs.json` so the jobs
  model is untouched.
- A sync is a **three-way merge** against how the copies last matched (ids only,
  and the name): additions are matched (ADR-0012) and put after the song they
  followed; removals are copied; one reorder or rename wins
  (`sync/plan.ts`). The same change on several copies is agreement.
- **Conflicts stop that link and write nothing**: removed on one copy and moved
  or duplicated on another; reordered or renamed differently; a copy gone or no
  longer the user's; a copy emptied or that lost 10 songs and a quarter; a cut
  off sync whose copy was changed meanwhile; a first link whose copies differ.
  The user settles one by taking a copy, merging, or unlinking -- after seeing
  what would be written.
- **What is not a removal**: a song the service withdrew (a gap; the others keep
  it); one the service cannot say about (it waits for the user's answer, the
  rest syncs); a failed read (no sync); a likely match (waits); a song the
  service lacks (a gap, looked for again weekly).
- **The intended writes are saved before the first one.** The next run explains
  a copy by them -- finishing what was begun -- or calls it a conflict; it never
  reads its own half-done writes as the user's. A copy is written by adding,
  then moving, then removing, each worked out from what is there, never adding
  more of a song or removing more than the change does.
- Each sync is one History entry; undoing it pauses the link, and resuming
  looks at the copies afresh.

## Consequences

- Randomised tests (random edits on every copy, a write failing at any point)
  check that no song is lost without a removal by the user and that a second
  sync writes nothing.
- On Spotify one copy of a repeated song cannot be removed alone; a sync asks
  instead of re-adding the others unseen.
