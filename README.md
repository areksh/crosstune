# qobuz-helper

A collection of local-first utilities for [Qobuz](https://www.qobuz.com/).

`qobuz-helper` runs entirely on your own machine. You sign in with your Qobuz
account, use the tools, and nothing about you is stored on any server -- the
session is saved locally and never leaves your machine.

## Why this exists

Qobuz has no official public API, so these tools talk to the same private JSON
API that the Qobuz web player uses. That makes the integration inherently
unofficial and subject to breakage when Qobuz changes their web bundle. See
[docs/adr/](docs/adr/) for the architectural decisions behind the project.

## Tools

- **Playlist from artists** -- build a playlist from just a list of artists,
  using each artist's top tracks. Available on the CLI and in the web UI.
- **Playlist from albums** -- build a playlist from a list of albums given as
  "Artist - Album", using every track of each. When an album has several
  versions, choose which to use (newest, oldest, or highest quality). Available
  on the CLI and in the web UI.
- **Similar artists** -- discover music through Qobuz's similar artists. Start
  from a list of artists (a new playlist with their tracks and those of artists
  like them) or from one of your playlists (expand it with artists it does not
  have yet), walking one to three levels deep. Available on the CLI and in the
  web UI.
- **Deduplicator** -- report and remove duplicate tracks in a playlist or your
  favourites, including remasters and the same song on different albums.
  Available on the CLI and in the web UI.
- **Import & export** -- export favourites or a playlist as JSON, CSV, plain
  text or M3U; back up your whole account (favourites and playlists) to a
  lossless JSON file; and import a list back in, matching each entry to Qobuz by
  its id or by search. Available on the CLI and in the web UI.

The playlist tools can **exclude** tracks whose title, or whose album's title,
matches a term (see [Filters](#filters)), and the album tool can keep only
chosen discs.

There is also a **local web UI** (`qobuz-helper ui`) hosting these tools, each
with a preview-and-edit step before anything is changed. More to follow.

## Requirements

- Node.js `>=18`
- A paying Qobuz subscription (the streaming API rejects accounts without one).

## Quick start (development)

```sh
npm install
npm test          # run the test suite
npm run dev       # run the CLI entry point
```

Sign-in uses Qobuz's browser OAuth flow -- the same one the official web player
uses. Running the CLI opens your browser on Qobuz's own sign-in page; after you
authenticate there, Qobuz redirects back to a temporary local address and the
session is established. Your password is entered only on Qobuz's site and is
never handled by this program (email/password sign-in against the API is no
longer supported by Qobuz).

The session is then saved locally and resumed automatically on later runs, so
you only sign in through the browser once (until the session expires). Manage it
with:

```sh
npm run dev -- login    # sign in (or resume) and save the session
npm run dev -- logout   # discard the saved session
```

The token is stored at `$XDG_CONFIG_HOME/qobuz-helper/session.json` (falling back
to `~/.config`), written owner-only. It stays on your machine -- nothing is sent
to any server other than Qobuz itself.

To start up quickly, the API credentials scraped from the Qobuz web player (the
app id and app secret) are also cached next to the session, at
`$XDG_CONFIG_HOME/qobuz-helper/bundle.json`. This lets later runs skip
re-downloading and re-validating the web bundle. The cache expires after a week,
and is discarded automatically if Qobuz rotates its credentials and a run fails
because of it, so it heals on the next run.

### Commands

```sh
# Vertical-slice smoke test (sign in and make one API call)
npm run dev -- check

# Build a playlist from a list of artists' top tracks
npm run dev -- playlist-from-artists --name "Road Trip" --tracks 5 \
  "Portishead" "Massive Attack" "Tricky"

# Artist names can also be piped in, one per line
cat artists.txt | npm run dev -- playlist-from-artists --name "Road Trip"
```

Options for `playlist-from-artists`: `--name` (required), `--tracks N` (top
tracks per artist, default 10), `--public` (make the playlist public),
`--exclude-track <term>` and `--exclude-album <term>` (see [Filters](#filters)).
An excluded track is replaced by the artist's next most popular one; Qobuz
lists at most 30 top tracks per artist, so a strict filter can still leave an
artist short.

```sh
# Build a playlist from whole albums, given as "Artist - Album"
npm run dev -- playlist-from-albums --name "Classics" --prefer highest-quality \
  "Radiohead - OK Computer" "Daft Punk - Discovery"

# Album lines can also be piped in, one per line
cat albums.txt | npm run dev -- playlist-from-albums --name "Classics"
```

Options for `playlist-from-albums`: `--name` (required), `--prefer
<preference>` (which version to use when an album has several: `highest-quality`
(default), `newest`, or `oldest`), `--public` (make the playlist public),
`--discs <list>` (keep only these discs of each album, e.g. `1` or `1,3-4`), and
`--exclude-track <term>` and `--exclude-album <term>` (see [Filters](#filters)).
A release whose title or version matches `--exclude-album` is never picked; if
every release of an album matches, the album is skipped and reported. Each
entry is one line in `Artist - Album` form, split on the first ` - ` so album
titles keep any hyphens.

#### Filters

```sh
# Top tracks, but no live recordings and nothing from compilations
npm run dev -- playlist-from-artists --name "Studio Only" \
  --exclude-track live --exclude-album live --exclude-album "greatest hits" \
  "Nirvana" "Pixies"

# Only the first disc of each album, without demos or instrumental versions
npm run dev -- playlist-from-albums --name "Disc One" --discs 1 \
  --exclude-track demo --exclude-track "/instrumental|karaoke/" \
  "Pink Floyd - The Wall"
```

A plain term matches as a whole word or phrase, ignoring case: `live` excludes
"Live at Leeds" and "Karma Police (Live)" but not "Alive". Track terms are
checked against the title and its version label ("Remastered 2011", "Demo"),
album terms against the album's title (and version, for album releases). A term
wrapped in slashes, such as `/remix|edit$/`, is a regular expression, also
case-insensitive. Repeat a flag to add more terms.

```sh
# Metallica's top tracks, plus 3 tracks from each of 3 similar artists, plus
# 3 similar to each of those (depth 2), in a new playlist
npm run dev -- similar-artists --name "Metal Family" --depth 2 "Metallica"

# Only the similar artists, 5 per artist, no live recordings
npm run dev -- similar-artists --name "Like Portishead" --seed-tracks 0 \
  --similar 5 --exclude-track live "Portishead"

# A big, deep walk: 10 per artist, 3 levels, stopping after 500 artists
# (refused as very large unless --yes is given)
npm run dev -- similar-artists --name "Deep Metal" --similar 10 --depth 3 \
  --max-artists 500 --yes "Metallica"

# Expand a playlist from its 10 most frequent artists (dry run, then --apply)
npm run dev -- similar-artists --playlist 12345678
npm run dev -- similar-artists --playlist 12345678 --apply
```

Options for `similar-artists`: either `--name <name>` with artist names (or
piped names, one per line), which creates a new playlist, or `--playlist <id>`,
which adds to that playlist and only reports unless `--apply` is given. Both
take `--similar N` (similar artists per artist, default 3; Qobuz lists about 70
for a well-known artist), `--depth D` (default 1: depth 2 also takes artists
similar to the similar artists), `--max-artists A` (stop after A similar
artists, default 100), `--tracks M` (top tracks per similar artist, 1-30,
default 3), `--yes`, and the [filters](#filters)
`--exclude-track`/`--exclude-album`. With `--name`: `--seed-tracks K` (the given
artists' own top tracks, 0-100, default 5; 0 for none) and `--public`. With
`--playlist`: `--seeds S` (start from its S most frequent artists, 1-50,
default 10). `--similar`, `--depth` and `--max-artists` have no upper limit.
Before signing in, the command prints an estimate of the largest outcome, and
refuses a very large run (over about 1000 tracks or 1500 Qobuz requests) unless
`--yes` is given. Each artist is used once, artists already in a source playlist
are never suggested, and the command says when the walk stopped at
`--max-artists`.

```sh
# Report duplicate tracks in a playlist, or across your favourites
npm run dev -- deduplicate --playlist 12345678
npm run dev -- deduplicate --favourites

# Choose which copy to keep, then actually remove the rest
npm run dev -- deduplicate --playlist 12345678 --keep highest-quality --apply
```

The deduplicator matches tracks by ISRC or by a normalised artist+title
signature: it treats remasters and the same song on different albums as
duplicates, while keeping genuinely different versions (live, acoustic, remix)
separate. For each duplicate group it marks one copy to keep and the rest to
remove:

```
1. Black Sabbath - Paranoid
   keep  id 8816871    Paranoid  [Greatest Hits]
   drop  id 386614187  Paranoid  [Paranoid]
```

Which copy is kept is chosen by `--keep <strategy>`:

| Strategy          | Keeps                                             |
| ----------------- | ------------------------------------------------- |
| `first-added`     | the first copy in the source (default)            |
| `last-added`      | the last copy in the source                       |
| `highest-quality` | the highest bit-depth / sample-rate copy          |
| `oldest`          | the earliest release (looks up album dates)       |
| `newest`          | the latest release (looks up album dates)         |

By default the command only **reports** the plan. Add `--apply` to actually
remove the tracks marked `drop` (from the playlist, or from your favourites).

```sh
# Export favourite tracks as CSV to a file
npm run dev -- export --favourites --out favourites.csv

# Export a playlist as M3U
npm run dev -- export --playlist 12345678 --out mix.m3u

# Back up your whole account (favourites and playlists) to a JSON file
npm run dev -- export --account --out qobuz-backup.json

# Without --out the content goes to stdout; pair it with --loglevel warn so
# sign-in progress does not end up in the piped file
npm run dev -- --loglevel warn export --playlist 12345678 --format m3u > mix.m3u
```

`export` sources are `--favourites`, `--favourite-albums`, `--favourite-artists`,
`--playlist <id>`, or `--account` (a full backup). `--format` is one of `json`,
`csv`, `text` or `m3u` (inferred from `--out`'s extension when omitted, else
`json`); a backup is always JSON. CSV and plain text carry a single collection;
M3U carries tracks only; JSON is lossless and the only format for a whole-account
backup.

```sh
# Preview importing a hand-written track list into favourites (dry run)
npm run dev -- import --favourites tracks.txt

# Actually add them, matching each "Artist - Title" line to Qobuz
npm run dev -- import --favourites tracks.txt --apply

# Import a CSV into a new playlist
npm run dev -- import --new-playlist "From CSV" songs.csv --apply

# Restore a whole-account backup
npm run dev -- import --account qobuz-backup.json --apply
```

`import` targets are `--favourites`, `--favourite-albums`, `--favourite-artists`,
`--playlist <id>` (an existing playlist), `--new-playlist <name>`, or `--account`
(restore a backup). The format is inferred from the filename unless `--format` is
given. Each entry is resolved to a Qobuz item by its id when the file carries one
(JSON always does; CSV and M3U can), otherwise by searching and best-matching;
entries that match nothing are reported. Like `deduplicate`, `import` only
resolves and **reports** unless `--apply` is given.

If the browser does not open automatically, the CLI prints the URL to visit.

#### Logging

A global `--loglevel <level>` option controls how much any command logs. It may
appear anywhere in the arguments and defaults to `info`:

```sh
npm run dev -- --loglevel debug deduplicate --favourites
```

| Level    | Shows                                                |
| -------- | ---------------------------------------------------- |
| `silent` | nothing                                              |
| `error`  | errors only                                          |
| `warn`   | errors and warnings                                  |
| `info`   | the above plus normal progress and results (default) |
| `debug`  | the above plus one line per Qobuz API request        |

Progress and results go to stdout; warnings and errors go to stderr. Debug lines
log only the request method, API path and response status -- never the query, so
signed tokens never reach the logs.

### Web UI

```sh
npm run ui            # build the frontend, then serve it and open the browser
```

`qobuz-helper ui` starts a small web server on `127.0.0.1`, opens your browser
at it, and runs until you stop it with Ctrl-C. A sidebar switches between the
tools; a home page introduces each.

**Playlist from artists:**

1. Paste one artist per line and choose how many top tracks to take from each.
   Optionally open *Filters* to exclude tracks or albums by term (one per line).
2. Preview the tracks grouped by artist, and untick any you do not want. Tracks
   the filters excluded are replaced by the next most popular, and listed
   unticked with the reason, so you can tick one back on. Names that matched
   nothing, artists Qobuz returned no tracks for (skipped from the list), and
   artists that yielded fewer tracks than requested are each called out above
   the preview.
3. Choose a destination -- create a new playlist, or add to an existing one
   (tracks already in it are skipped) -- and commit.

**Playlist from albums:**

1. Paste one album per line as "Artist - Album", and pick a default version
   preference (highest quality, newest, or oldest). Optionally open *Filters* to
   exclude releases or tracks by term, or to include only some discs.
2. Find the albums: each shows a dropdown to choose which version to use when
   several exist (defaulting to your preference), with the chosen release's
   quality and date shown alongside. Releases matching a release filter are not
   offered; albums with no release left are called out.
3. Fetch the tracks: each album lists its tracks (by disc, when it has more
   than one). Tracks on a disc you did not include, or matching a track filter,
   start unticked with the reason; tick or untick any. If a version cannot be
   fetched, the next-best one is selected for you to retry.
4. Choose a destination -- a new playlist, or an existing one (tracks already in
   it are skipped) -- and save the ticked tracks.

**Similar artists:**

1. Start from artists (one per line, with how many of their own top tracks to
   include) or from one of your playlists (with how many of its most frequent
   artists to start from). Choose how many similar artists to take per artist,
   how many levels deep to go, after how many similar artists to stop, and how
   many top tracks each similar artist contributes. None of these has an upper
   limit: an estimate under the settings shows the largest possible outcome,
   turning orange for a very large run, which you are asked to confirm.
   Optionally open *Filters*.
2. Find similar artists: the artists are found first, then their tracks are
   fetched in batches, with progress shown on the button.
3. Preview: each starting artist is listed with the similar artists found from
   it nested underneath, labelled with who they are similar to. Untick any
   tracks you do not want; tracks the filters excluded are listed unticked.
4. Choose a destination -- a new playlist, or an existing one (tracks already in
   it are skipped; when starting from a playlist, that playlist is preselected)
   -- and commit.

**Deduplicator:**

1. Choose a source (your favourites or a playlist) and which copy to keep
   (first added, highest quality, oldest release, and so on).
2. Scan: each duplicate group shows its copies, the kept ones in green and the
   rest in red. Tick the copies you want to keep (you can keep more than one),
   or use "Keep all" to keep the whole group.
3. Apply to remove the unticked copies.

**Import & export:**

1. *Export:* choose a source (favourite tracks, albums or artists, a playlist,
   or your whole account) and a format, then download the file. A whole-account
   backup is always JSON.
2. *Import:* choose a destination (favourites or a playlist, or restore a
   backup), paste or upload the content, and preview: the matched entries are
   counted and any that could not be resolved are listed.
3. Commit to add the matched items (or restore the backup).

The browser only ever talks to the local server, which owns the Qobuz session;
your Qobuz token is never sent to the page. The server is reachable only from
your own machine, and every request must carry a per-run secret that only the
served page can read (guarding against other local pages acting on your
account). See [ADR-0002](docs/adr/0002-web-ui-architecture.md) for the design.

## Development

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `npm test`          | Run the Vitest suite once             |
| `npm run test:watch`| Run tests in watch mode               |
| `npm run typecheck` | Type-check the server/CLI and the web UI |
| `npm run build`     | Compile TypeScript and bundle the web UI into `dist/` |
| `npm run ui`        | Build, then serve the web UI          |

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Legal

This project is not affiliated with or endorsed by Qobuz. It is intended for
personal use with your own account. Use it in accordance with Qobuz's terms of
service.

## Licence

MIT
