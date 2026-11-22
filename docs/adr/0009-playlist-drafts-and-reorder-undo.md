# ADR-0009: Editing playlists as a draft; undoing a reorder

- Status: accepted
- Date: 2026-11-22

## Context

The user wanted to edit playlists in bulk: select many songs at once (Qobuz's
apps have no multi-select), drag them into order, and remove whole artists.
ADR-0006's undo could put removed songs back in place, but only reported moves
of entries it had not added -- so one sort would have scrambled a playlist for
good. It also restored scattered removals with a request each.

Checked live in November 2026, on scratch playlists: `updateTracksPosition`
places ids in the order sent (220 in one request), entry ids and added dates
survive a move, and a move anchored on a moved entry lands after the unmoved
entries ahead of it. **Adding a track Qobuz cannot play answers 200 and adds
nothing**, and one request adds a repeated track id once.

The design is in
`docs/superpowers/specs/2026-11-22-playlist-manager-design.md`.

## Decision

- **A playlist is edited as a draft in the page** and saved in one request, as
  one history entry. The draft is pure (`playlist-draft.ts`) and keyed by
  playlist-track id; the page runs it directly, as it does `playlist-shape.ts`.
  Actions on other places (copy, favourite, rename, delete) are immediate.
- **Saving never overwrites a change made elsewhere.** The request carries the
  order the draft started from; if a fresh read differs, nothing is written and
  the page can carry the draft over (`rebase`).
- **Saving never loses a song.** It adds to other playlists first, reads them
  back, removes here only what arrived, then reorders, and stops at the first
  failure. Reordering moves entries; it never clears and re-adds.
- **Moves are planned** (`planOrder`): only what must move, grouped, or the
  changed stretch re-sent in blocks of 200 when that is fewer requests.
- **Undo replays an entry backwards.** Moves record where their entries came
  from. From the playlist as it is now, undo un-adds, un-removes and un-moves
  in memory to get the order to return to; then re-adds, makes one planned
  reorder, and removes what the change added -- last, and never a song that
  could not be put back (including when the playlist it came from is gone; one
  that cannot be read for now blocks the undo). This replaces ADR-0006's "latest removal first, each
  moved into place", and covers every tool's moves. Records made before this
  still undo, reporting their moves as not restored.
- **Playlist-manager writes hold the jobs lock**, so a managed playlist's
  refresh cannot interleave with a save.
- **One place decides what is the same song** (`deduplicate.ts`), and the
  version label counts: a live take, an acoustic version or a remix is not a
  duplicate. They are pointed out as *other versions*, and the user can choose
  to count them as duplicates.

## Consequences

- A save costs a read of the playlist more than the writes themselves, plus the
  recorder's; on a 440-song playlist it takes about six seconds.
- Songs that no longer play cannot be put back by anything; save and undo say
  so instead of appearing to succeed.
- Drafts live in the page and are lost on reload (the page asks first).
- Undo is exact when nothing else touched the playlist since; otherwise
  positions are the recorded ones, clamped, as before.
- Combine, and scheduled dedupe, now keep different versions of a song apart.
