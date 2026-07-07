# ADR-0003: Import, export and account backup

- Status: accepted
- Date: 2026-07-07

## Context

Users want their Qobuz library to be portable: to take favourites or a playlist
out in an editable form, to move lists between services or spreadsheets, and to
keep a full backup of their account (favourites and playlists) that can be
restored. This is a single capability with two directions -- read out (export)
and write in (import) -- plus a whole-account variant of each (backup and
restore).

Two forces shape the design:

1. Formats differ in fidelity. A JSON document can carry Qobuz ids and every
   collection at once; a spreadsheet-style CSV or a hand-written text list
   carries a single flat collection and often no ids at all.
2. Writing requires Qobuz ids. An imported entry that carries an id is exact; an
   entry with only "Artist - Title" must be resolved by searching Qobuz, which is
   fuzzy and can mismatch.

## Decision

- **One feature module.** All of it lives in `src/features/import-export.ts` as
  pure functions over small injected client interfaces, like the other tools. The
  CLI (`export`/`import` commands) and the web view (the "Import & export" view
  and its routes) both call it; no logic is duplicated into a command or route.
- **A portable model plus per-format (de)serialisers.** Domain objects are
  narrowed to portable `ExportTrack`/`ExportAlbum`/`ExportArtist` records. A
  `Collection` is a flat list of one kind -- the unit CSV, text and M3U carry --
  while a `LibraryBackup` holds every favourite collection and every playlist.
  Serialising and parsing are separate pure functions per format, so each is
  tested against fixtures with no network.
- **Four formats, by fidelity.** JSON is lossless and the only format that can
  hold a whole-account backup; CSV is a spreadsheet-friendly flat collection;
  plain text is "Artist - Title"/"Artist - Album" lines for hand-editing; M3U
  carries tracks only, pairing an `#EXTINF` display line with a
  `qobuz://track/<id>` URI so the id round-trips while the file still reads as a
  normal playlist.
- **Two-phase import.** Import reuses the project's resolve/commit split.
  *Resolve* turns parsed items into Qobuz ids -- taking an id when the input
  carried one, else searching and best-matching (an ISRC match wins; otherwise
  the title must match and the artist tokens must overlap, reusing the
  deduplicator's `normalise` and the album matcher) -- and reports whatever did
  not resolve. *Commit* writes the matched ids to favourites or a playlist. The
  web UI shows the plan between the two so the user reviews matches before
  writing; the CLI reports the plan and only writes with `--apply`.
- **Backup restore is id-based.** A backup was written by an export, so its ids
  are trusted: restoring re-favourites its tracks, albums and artists and
  recreates each playlist, with no searching. Restore always creates playlists
  anew rather than trying to reconcile with existing ones.

## Consequences

- New client surface: `searchTracks`, `getFavoriteAlbums`, `getFavoriteArtists`
  (paginated, reusing the favourites parsers) and `addFavoriteTracks`/`Albums`/
  `Artists` (via `favorite/create`, batched like the other bulk mutations).
- New API routes: `POST /api/export`, `/api/import/resolve`, `/api/import/commit`
  and `/api/restore`. Export returns the serialised text plus a suggested
  filename; the browser downloads it via a `Blob`, so the router stays pure and
  the token never leaves the server.
- Search-based matching can occasionally pick the wrong track; this is why import
  is two-phase and reviewable, and why id-carrying formats (JSON, and CSV/M3U
  with ids) are exact. Backups therefore round-trip losslessly; hand-written
  lists are best-effort.
- The `LibraryBackup` shape is versioned (`formatVersion`) so it can be extended
  without breaking older backups.
