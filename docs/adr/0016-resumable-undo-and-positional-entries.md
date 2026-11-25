# ADR-0016: Undo can be finished, follows songs put back, and goes by place where entries have no ids

- Status: accepted
- Date: 2026-11-25

## Context

ADR-0006 made History an append-only record of what each change wrote, with
undo planned from it against the playlists as they are now; ADR-0009 added
reorders. Both took a playlist entry id as the identity of an entry: undo
looks for "the entries this change added" by id, and puts removed tracks back
by where their ids used to be.

An audit (2026-11-23) showed where that breaks, each confirmed by a test:

- **A partly failed undo could not be finished.** An entry was marked undone as
  soon as one step went through, so a transient error in another playlist
  left those songs only in the History file. Not marking it is no answer
  either: a retry would put back again what the first try already had, since
  a song put back gets a new entry id.
- **Stepping back through History lost track of songs.** Undoing a later entry
  puts its songs back under new ids, so an earlier entry's ids no longer exist
  and its moves and adds were silently skipped.
- **Spotify has no entry ids.** Its adapter names an entry `<track>#<n>`,
  counted afresh on every read (`capabilities.entryIds: "positional"`,
  ADR-0010). Kept in History, such an id names a different copy once the
  playlist changes, so undo could do nothing or remove the user's own copy;
  the recorder could also record a surviving copy as one it added.
- **Compaction dropped lines it could not read**, so a newer crosstune's
  entries were lost to an older one.

## Decision

- **Undo is resumable by replaying its earlier tries.** Each undo already runs
  through the recording client, so its own "Undid: ..." entry records exactly
  which writes went through. A new try of the same entry collects the earlier
  tries that were not themselves undone and replays their operations with the
  entry's own: a song a try put back stands for the one removed, an entry a
  try took out is not looked for again, favourites and details a try set back
  are skipped, and a playlist a try began to make again (`recreated`) is
  filled rather than made twice. The original is marked undone only when
  nothing failed that another try could do.
- **Undos keep the ids they gave.** An undo entry carries `renamed`: per
  playlist, `[old id, new id]` for each entry it put back. Planning an earlier
  entry translates its ids through every later undo, oldest first.
- **Where entry ids are positional, History goes by song and place.** For a
  playlist whose service declares `entryIds: "positional"` (looked up per
  playlist through the hub), undo ignores entry ids: what was removed goes back
  at its recorded place; what was added or moved is found by track where the
  change left it, taking the nearest copy only while the playlist still holds
  as many copies as the record counted, and otherwise touching nothing. The
  recorder tells what an add put in by counting tracks, keeps up with re-reads
  within a change, and records `trackIds` on moves.
- **Compaction keeps lines as written**, readable or not; unreadable lines go
  only once older than the age limit, and do not count towards the entry limit.
- The History format gains only optional fields (`renamed`, `recreated` on
  undo entries; `trackIds` on moves); `FORMAT_VERSION` stays 1 and older lines
  read and undo as before.

## Alternatives considered

- **A list of finished steps kept on the original entry.** It duplicates what
  the try's own entry already records, and must be kept in step with it.
- **Re-reading which copy is ours on Spotify by snapshot.** Spotify's snapshot
  ids do not track item changes (live-probed 2026-11-23), so there is nothing to
  read it by.

## Consequences

- An entry undone in several tries has several "Undid: ..." entries; redoing it
  means undoing each.
- If a try's add could not be read back at all, the next try cannot know what
  arrived and warns to check for duplicates instead.
- Spotify entries written before this change may hold a wrong "added" record,
  which cannot be corrected.
- Managed playlists (`src/jobs/reconcile.ts`) still keep the positional ids they
  own across runs, so on Spotify, in the mode that respects the user's edits, a
  job can take out the user's copy of a song it no longer wants. Fixing that
  needs a per-track count in job state; it is left open.
- Supersedes ADR-0006 and ADR-0009 where they take an entry id to identify an
  entry over time.
