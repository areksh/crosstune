# ADR-0006: History and undo

- Status: accepted
- Date: 2026-11-02

## Context

The tools change the user's account in bulk: a playlist of 200 tracks, a
dozen duplicates removed from favourites, replacements swapped into a
playlist. The resolve/commit split (ADR-0002) lets the user review a plan
before it is written, but a mistake noticed afterwards had no way back, and
nothing told the user what qobuz-helper had changed. The Qobuz API itself
keeps no usable change log: once entries are removed, their positions are
gone, and a removed track can only be identified by what we kept.

Undo needs more than the tools' own results report: the playlist-track ids
of added entries (copies of the same track can be told apart only by those),
and each removed track with its position.

## Decision

- **Record in the client, not in the tools.** `recordingClient`
  (`src/features/journal.ts`) wraps the Qobuz client in a `Proxy` that
  intercepts every mutating method (`MUTATING_METHODS`) and records what it
  did; reads pass through. A test classifies every `QobuzClient` method as a
  write or not, so a new write method cannot bypass the history. Recording
  reads what reversal needs: the playlist around an add (new entries by
  diffing playlist-track ids) and before a removal (track and position). A
  removal or deletion whose playlist cannot be read first is refused rather
  than made unrecorded. A partial failure records what did happen.
- **One entry per user action.** A `Journal` groups operations: the CLI wraps
  each command, and the router wraps each write route (a table of them, in
  `dispatch`), in `Journal.run`. Grouping uses `AsyncLocalStorage`, so
  concurrent web requests stay apart without threading a context through every
  feature. Operations made outside a run get an entry of their own. Labels are
  built from the operations (and tool), so no route or command has to word
  one.
- **Storage: append-only JSON Lines** in `history.jsonl` beside the session,
  owner-only. Undoing appends an `undone` marker; entries are never edited.
  Compaction (the last 200 entries, 90 days) happens on write, through a
  temporary file and a rename. Records are versioned; unreadable lines are
  skipped.
- **Undo is a tool like the others.** `planUndo` (resolve) reads the touched
  playlists and builds steps, notes and warnings; `commitUndo` (commit) runs
  them, reporting failures per step. Per playlist: remove the entries the
  change added, then restore removed tracks latest removal first (append, then
  `updateTracksPosition` into place), then delete a playlist the change
  created if it holds nothing else. The undo runs through the recording
  client as its own entry, so it can be undone (redo).

## Consequences

- Every write costs one or two extra playlist reads, and naming a playlist in
  a label costs one `playlist/get` per action. Acceptable for the action sizes
  the tools make.
- New client methods: `deletePlaylist`, `getPlaylist`, `removeFavoriteAlbums`,
  `removeFavoriteArtists`.
- Undo restores positions assuming the playlist is otherwise as the entry left
  it (and that a change's own additions were appended after its removals were
  counted, which holds for every tool today). It cannot reverse changes made
  outside qobuz-helper, reordering of entries it did not add, or favourites'
  original "date added".
- Re-adding is split so no request repeats a track id: Qobuz adds a repeated
  id once per request (checked live, November 2026).
- The CLI and a running web UI may write the file at the same time; appends
  are line-sized, but a compaction can drop a concurrent append. Accepted for
  a single-user local tool.
