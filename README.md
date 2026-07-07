# qobuz-helper

A collection of local-first utilities for [Qobuz](https://www.qobuz.com/).

`qobuz-helper` runs entirely on your own machine. You sign in with your Qobuz
account, use the tools, and nothing about you is stored on any server -- the
session lives only in the running process.

> **Status:** early development. The first milestone is a vertical slice that
> proves the Qobuz plumbing works end to end (extract API tokens, sign in, make
> one authenticated request).

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
- **Deduplicator** -- report and remove duplicate tracks in a playlist or your
  favourites, including remasters and the same song on different albums.
  Available on the CLI and in the web UI.
- **Import & export** -- export favourites or a playlist as JSON, CSV, plain
  text or M3U; back up your whole account (favourites and playlists) to a
  lossless JSON file; and import a list back in, matching each entry to Qobuz by
  its id or by search. Available on the CLI and in the web UI.

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
tracks per artist, default 10), `--public` (make the playlist public).

```sh
# Build a playlist from whole albums, given as "Artist - Album"
npm run dev -- playlist-from-albums --name "Classics" --prefer highest-quality \
  "Radiohead - OK Computer" "Daft Punk - Discovery"

# Album lines can also be piped in, one per line
cat albums.txt | npm run dev -- playlist-from-albums --name "Classics"
```

Options for `playlist-from-albums`: `--name` (required), `--prefer
<preference>` (which version to use when an album has several: `highest-quality`
(default), `newest`, or `oldest`), `--public` (make the playlist public). Each
entry is one line in `Artist - Album` form, split on the first ` - ` so album
titles keep any hyphens.

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
2. Preview the tracks grouped by artist, and untick any you do not want.
3. Choose a destination -- create a new playlist, or add to an existing one
   (tracks already in it are skipped) -- and commit.

**Playlist from albums:**

1. Paste one album per line as "Artist - Album", and pick a default version
   preference (highest quality, newest, or oldest).
2. Find the albums: each shows a dropdown to choose which version to use when
   several exist (defaulting to your preference), with the chosen release's
   quality and date shown alongside.
3. Choose a destination -- a new playlist, or an existing one (tracks already in
   it are skipped) -- and commit.

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
