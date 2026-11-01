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
  "Artist - Album", or from an artist's whole discography (studio albums, and
  optionally EPs and singles, live albums and compilations, oldest first),
  using every track of each. When an album has several versions, choose which
  to use (newest, oldest, or highest quality). Available on the CLI and in the
  web UI.
- **Similar artists** -- discover music through Qobuz's similar artists. Start
  from a list of artists (a new playlist with their tracks and those of artists
  like them) or from one of your playlists (expand it with artists it does not
  have yet), walking one to three levels deep. Available on the CLI and in the
  web UI.
- **Word play** -- make a playlist out of song titles: songs whose title
  contains or is a word, titles that read as a sentence in order ("a quick
  brown fox / jumped / over / ..."), or titles from your favourites or a
  playlist whose first letters spell a word or run from A to Z. Available on
  the CLI and in the web UI.
- **Deduplicator** -- report and remove duplicate tracks in a playlist or your
  favourites, including remasters and the same song on different albums.
  Available on the CLI and in the web UI.
- **Combine playlists** -- merge two or more playlists (or a playlist and your
  favourites) into one, each song once; or keep only what the first has and
  the others lack, or only what they all share. Shows how they overlap before
  saving. Available on the CLI and in the web UI.
- **Library stats** -- what your favourites, a playlist or your whole library
  is made of: tracks, artists and hours of music, the hi-res / CD-quality
  split, tracks by decade, and your most-saved artists and albums. Any decade
  (or top artist, in the web UI) becomes a playlist in one step. Available on
  the CLI and in the web UI.
- **New releases** -- what your favourite artists (or a playlist's artists)
  have released lately: albums, EPs and singles, and optionally live albums
  and compilations, without what you already have or reissues of older
  albums. Put the ones you pick in a new playlist or your favourite albums.
  Available on the CLI and in the web UI.
- **Upgrade & repair** -- swap tracks in your favourites or playlists for a
  better-quality (hi-res) release of the same recording, and replace or remove
  tracks Qobuz no longer plays. Available on the CLI and in the web UI.
- **Import & export** -- export favourites or a playlist as JSON, CSV, plain
  text or M3U; back up your whole account (favourites and playlists) to a
  lossless JSON file; and import a list back in, matching each entry to Qobuz by
  its id or by search. Available on the CLI and in the web UI.

The playlist tools can **exclude** tracks whose title, album's title or artist
matches a term (see [Filters](#filters)), and the album tool can keep only
chosen discs. Similar artists also never suggests an excluded artist.

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
`--exclude-track <term>`, `--exclude-album <term>` and `--exclude-artist <name>`
(see [Filters](#filters)). An excluded track is replaced by the artist's next most popular one; Qobuz
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
`--exclude-track <term>`, `--exclude-album <term>` and `--exclude-artist <name>`
(see [Filters](#filters)). Tracks performed by an excluded artist (say, on a
compilation) are left out. A release whose title or version matches `--exclude-album` is never picked; if
every release of an album matches, the album is skipped and reported. Each
entry is one line in `Artist - Album` form, split on the first ` - ` so album
titles keep any hyphens.

```sh
# Every Portishead studio album, oldest first, one version of each
npm run dev -- playlist-from-albums --name "All of Portishead" --discography "Portishead"

# Studio albums plus EPs, singles and live albums, every edition
npm run dev -- playlist-from-albums --name "Portishead, all of it" \
  --discography "Portishead" --include albums,eps,live --all-versions
```

`--discography <artist>` takes the artist's releases instead of album lines
(the name resolves as in `playlist-from-artists`). `--include` picks the kinds
of release, comma-separated: `albums` (studio albums; the default), `eps` (EPs
and singles), `live` and `compilations`; releases credited to another main
artist (e.g. various-artists compilations) are left out. By default the
editions of an album -- remasters, deluxe and anniversary editions, hi-res
releases -- count as one album, grouped by their title without the edition
label, and `--prefer` picks one; `--all-versions` keeps every release instead.
The filters apply as with album lines. The artist's releases come from an
endpoint inferred from the Qobuz web player (`artist/getReleasesList`) that has
not been verified against the live API; at most 500 releases are read per
artist.

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

# A compilation without one of its artists
npm run dev -- playlist-from-albums --name "Trip Hop" \
  --exclude-artist "Bjork" "Various Artists - Trip Hop Classics"
```

A plain term matches as a whole word or phrase, ignoring case: `live` excludes
"Live at Leeds" and "Karma Police (Live)" but not "Alive". Track terms are
checked against the title and its version label ("Remastered 2011", "Demo"),
album terms against the album's title (and version, for album releases). A term
wrapped in slashes, such as `/remix|edit$/`, is a regular expression, also
case-insensitive. Repeat a flag to add more terms.

Artist terms (`--exclude-artist`) are matched against each track's performer
and differ in one way: a plain artist term matches the **whole** name, ignoring
case, accents and extra spaces, so `Drake` excludes Drake but not Nick Drake,
and `bjork` excludes Björk. A slashed artist term is a regular expression tested
against the name as Qobuz spells it (`/^the /` catches every "The ..." band).
In `similar-artists`, a similar artist matching an artist term is left out
entirely: it takes no place, is not walked from, and the next most similar
artist takes its place; the left-out artists are listed at the end. The seeds
themselves -- artists you typed, or a source playlist's artists -- are always
walked from, though their own tracks are still filtered.

```sh
# Metallica's top tracks, plus 3 tracks from each of 3 similar artists, plus
# 3 similar to each of those (depth 2), in a new playlist
npm run dev -- similar-artists --name "Metal Family" --depth 2 "Metallica"

# Only the similar artists, 5 per artist, no live recordings, never Massive Attack
npm run dev -- similar-artists --name "Like Portishead" --seed-tracks 0 \
  --similar 5 --exclude-track live --exclude-artist "Massive Attack" "Portishead"

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
`--exclude-track`/`--exclude-album`/`--exclude-artist`. With `--name`: `--seed-tracks K` (the given
artists' own top tracks, 0-100, default 5; 0 for none) and `--public`. With
`--playlist`: `--seeds S` (start from its S most frequent artists, 1-50,
default 10). `--similar`, `--depth` and `--max-artists` have no upper limit.
Each artist keeps to its own top `N`: a similar artist that already came up --
one of yours, one already in a source playlist, or one found from another artist
-- uses up a place and is listed again, but added once. `--replace-repeats`
takes the next most similar artist instead, giving more artists but less
similar ones (with many seeds, the later ones would otherwise mostly get
substitutes).
Before signing in, the command prints an estimate of the largest outcome, and
refuses a very large run (over about 1000 tracks or 1500 Qobuz requests) unless
`--yes` is given. Each similar artist is fetched and added once, artists already in a
source playlist are never added, and the command says when the walk stopped at
`--max-artists`.

```sh
# A sentence told in song titles (report only; add --apply to create it)
npm run dev -- word-play --sentence "a quick brown fox jumped over the lazy dog"

# One word per song, letting "jumped" match "Jump"
npm run dev -- word-play --sentence "a quick brown fox jumped over the lazy dog" \
  --split words --close-forms --apply

# 25 songs with "night" in the title, or 10 called exactly "Home"
npm run dev -- word-play --contains night --apply
npm run dev -- word-play --exact home --count 10 --name "Home x10" --apply

# Spell QOBUZ, or run A to Z, from your favourites or a playlist
npm run dev -- word-play --acrostic QOBUZ --favourites --apply
npm run dev -- word-play --a-to-z --playlist 12345678 --add-to 87654321 --apply
```

`word-play` makes a playlist out of song titles. Pick one mode:
`--contains <word>` (titles containing the word or phrase as whole words) or
`--exact <word>` (titles that *are* it), each taking up to `--count N` songs
(1-100, default 25) from a catalogue search; `--sentence "<text>"`, which splits
the sentence into consecutive phrases that are each a song title, in order; or
`--acrostic <word>` / `--a-to-z`, whose titles' first letters spell the word or
run through the alphabet, picked from `--favourites` or `--playlist <id>`.
Matching ignores punctuation, case and accents ("Dog." counts as "dog") and
version labels ("(Live)", "[Remastered 2011]", "- 2011 Remaster") unless
`--keep-punctuation` / `--keep-versions` is given; `--close-forms` lets a light
English stemmer match "jumped" with "Jump" or "dogs" with "Dog". Each song comes
from a different artist where another one could fill its place
(`--allow-repeat-artists` turns this off), `--prefer-hires` breaks ties towards
hi-res, and the [filters](#filters) leave tracks out of the candidates.

`--split` chooses how a sentence is split: `fewest` (default; the fewest songs,
i.e. the longest phrases), `words` (one word per song) or `any` (any mix,
preferring exact matches over close forms, then fewer songs). All three first
leave as few words unmatched as they can; words no title matches are reported
and left out. The command also lists up to three other ways to split it. Each
run of up to `--max-span K` words (1-8, default 6) is searched once, shorter
runs first, with at most 120 searches per sentence (of up to 30 words).

The playlist is named after the text (title-cased) unless `--name` is given;
`--public` makes it public, or `--add-to <id>` appends to an existing playlist
instead. Without `--apply` the command only reports what it would add.

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
# Merge two playlists into a new one, each song once (dry run, then --apply)
npm run dev -- combine --playlist 12345678 --playlist 87654321
npm run dev -- combine --playlist 12345678 --playlist 87654321 --name "Road Trip + Late Night" --apply

# What a playlist has that your favourites do not
npm run dev -- combine --playlist 12345678 --favourites --mode only-first

# The songs three playlists share, taking turns between them
npm run dev -- combine --playlist 1 --playlist 2 --playlist 3 --mode common --order interleave
```

`combine` takes two or more inputs, in order: `--playlist <id>` (repeatable)
and `--favourites`. It reports how they overlap and lists the result; with
`--apply` it saves the result as a new playlist, named after the inputs ("A +
B") unless `--name` is given (`--public` makes it public).

| Option                 | Values                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `--mode`               | `merge` (every song once, default), `only-first` (in the first input but none of the others), `common` (in all of them) |
| `--order`              | `sequential` (input 1, then 2, ...; default), `interleave` (take turns), `shuffle`   |
| `--keep`               | which copy of a song in several inputs: `highest-quality` (default) or `first`      |
| `--exact-ids-only`     | count tracks as the same song only when their Qobuz ids match                       |

By default "the same song" uses the deduplicator's matching (a shared ISRC, or
the same normalised artist and title), so a remaster in one playlist and the
original in another count once; live, acoustic and remixed versions stay
separate.

```sh
# Stats for your favourites, a playlist, or everything (favourites + playlists)
npm run dev -- stats --favourites
npm run dev -- stats --playlist 12345678
npm run dev -- --loglevel warn stats --everything --json > stats.json

# Make a playlist of your favourites from the 1990s (dry run, then --apply)
npm run dev -- stats --favourites --decade-playlist 1990s
npm run dev -- stats --favourites --decade-playlist 1990s --name "Nineties" --apply
```

`stats` takes one source: `--favourites`, `--playlist <id>`, or `--everything`
(your favourites and all of your playlists, each track counted once). It
prints a headline ("1,240 favourite tracks by 312 artists. 86 hours of
music."), the quality split (hi-res above 16 bits or 48 kHz, CD quality, or
unknown), tracks by release decade, and the ten artists and albums with the most
tracks; `--json` prints the same as JSON instead. `--decade-playlist <decade>`
(e.g. `1990s`, or `unknown` for tracks without a release date) makes a playlist
of that decade's tracks, named like "Favourites: 1990s" unless `--name` is
given; as elsewhere, it is only created with `--apply` (`--public` makes it
public).

```sh
# Report better-quality releases and unplayable tracks in your favourites
npm run dev -- upgrade --favourites

# Check one playlist, or every playlist, and make the changes
npm run dev -- upgrade --playlist 12345678 --apply
npm run dev -- upgrade --all-playlists --remove-unplayable --apply
```

`upgrade` looks at each track below the best quality Qobuz streams (24-bit /
192 kHz) and searches Qobuz by its ISRC for another release of the *same
recording* that is streamable and of strictly higher quality (bit depth, then
sampling rate), proposing the best. Search results count only if their ISRC
really matches; tracks without an ISRC, or of unknown quality, are skipped and
counted. `--allow-signature-match` also accepts a release with the same
normalised artist and title (as the deduplicator matches), flagged as "same
song, maybe a different recording".

Tracks Qobuz marks as no longer streamable get a streamable replacement too:
the same recording first, else the same song (flagged). With no replacement
they are left alone, or removed with `--remove-unplayable`.

Like `deduplicate`, `upgrade` only **reports** unless `--apply` is given. In
favourites the replacement is added and the old track removed; in a playlist the
replacement is added, and only once it is confirmed in the playlist is the old
entry deleted and the replacement moved into its place. The move uses an
undocumented Qobuz call; if it is refused, the replacement stays at the end of
the playlist and the command says so. A run makes at most 600 searches
(unplayable tracks are checked first); tracks beyond that are reported as not
checked.

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

```sh
# What your favourite artists released in the last 30 days (report only)
npm run dev -- new-releases

# Since a date, from a playlist's artists, live albums too
npm run dev -- new-releases --since 2026-10-01 --playlist 123456 --include albums,eps,live

# Put the last two weeks' releases in a new playlist, or in your favourite albums
npm run dev -- new-releases --days 14 --name "Fresh" --apply
npm run dev -- new-releases --days 14 --favourite-albums --apply
```

Options for `new-releases`: `--since <YYYY-MM-DD>` or `--days N` (the window,
up to today; default the last 30 days), `--playlist <id>` (that playlist's
artists, most frequent first, instead of your favourite artists), `--include`
(comma-separated `albums`, `eps`, `live`, `compilations`; default
`albums,eps`), `--exclude-artist <name>` (that artist is not checked),
`--exclude-album <term>` (matching releases are not listed) and
`--exclude-track <term>` (left out of a new playlist), and a destination:
`--name <name>` (a new playlist, with `--public` to make it public) or
`--favourite-albums`. It lists the releases newest first and, like `import`,
only **reports** unless `--apply` is given with a destination. A new playlist
takes each release's tracks in album order, release after release as listed.
Hidden from the list: releases already among your favourite albums (any
edition), and reissues of older albums -- a release whose version or title
says "Remastered", "Anniversary", "Expanded", "Reissue" or "Legacy Edition", or
an album the artist first released before the window. Editions of one new album
(standard and deluxe, CD and hi-res) are listed once, the best quality. At most
200 artists are checked per run (the rest are reported as skipped). The
releases come from `artist/getReleasesList`, an endpoint inferred from the Qobuz
web player that has not been verified against the live API.

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
tools, grouped as *Build*, *Tidy up*, *Explore* and *Your data*; a home page introduces
each. Multi-step tools show the step you are on at the top, and while you review
a selection the destination and save button stay docked at the bottom of the
window. Track rows show a quality badge such as "24/96" (bit depth / sampling
rate in kHz), lit up for hi-res.

Album covers are off by default. Tick *Show artwork* at the bottom of the
sidebar to show them next to tracks and albums; your browser then loads them
straight from Qobuz's image server (no sign-in details are involved). While it
is off, no image is requested at all. The setting is remembered in this
browser.

**Playlist from artists:**

1. Paste one artist per line and choose how many top tracks to take from each.
   Optionally open *Filters* to exclude tracks, albums or artists by term (one
   per line).
2. Preview the tracks grouped by artist, and untick any you do not want. Tracks
   the filters excluded are replaced by the next most popular, and listed
   unticked with the reason where they rank, so you can tick one back on in
   its place. Names that matched
   nothing, artists Qobuz returned no tracks for (skipped from the list), and
   artists that yielded fewer tracks than requested are each called out above
   the preview.
3. Choose a destination -- create a new playlist, or add to an existing one
   (tracks already in it are skipped) -- and commit.

**Playlist from albums:**

1. Start from *A list of albums* -- paste one per line as "Artist - Album" --
   or from *An artist's discography*: type the artist, tick the kinds of
   release to include (studio albums, EPs and singles, live albums,
   compilations), and keep *One version of each album* ticked to group each
   album's editions into one entry (untick it to list every release). Pick a
   default version preference (highest quality, newest, or oldest).
   Optionally open *Filters* to exclude releases, tracks or artists by term,
   or to include only some discs.
2. Find the albums: each shows a dropdown to choose which version to use when
   several exist (defaulting to your preference), with the chosen release's
   quality and date shown alongside. Releases matching a release filter are not
   offered; albums with no release left are called out. A discography is
   listed oldest album first.
3. Fetch the tracks: each album lists its tracks (by disc, when it has more
   than one). Tracks on a disc you did not include, or matching a track or
   artist filter, start unticked with the reason; tick or untick any. If a version cannot be
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
   turning orange for a very large run, which you are asked to confirm. Tick
   *Replace artists that already came up* to substitute the next most similar
   artist for repeats (see the CLI's `--replace-repeats`). Optionally open
   *Filters*; similar artists matching an excluded artist are skipped in
   favour of the next most similar.
2. Find similar artists: the artists are found first, then their tracks are
   fetched in batches, with progress shown on the button.
3. Preview: each starting artist is listed with the similar artists that came
   up for it nested underneath, each labelled with every artist it is similar
   to. An artist shared between several is listed under each but added once,
   and ticking or unticking one of its tracks updates every copy. Untick any
   tracks you do not want; tracks the filters excluded are listed unticked
   where they rank. Similar artists the filters left out are named above the
   preview.
4. Choose a destination -- a new playlist, or an existing one (tracks already in
   it are skipped; when starting from a playlist, that playlist is preselected)
   -- and commit.

**Word play:**

1. Pick a mode (contains a word, is exactly a word, sentence, acrostic, or A to
   Z) and type the word or sentence. For a sentence, choose how to split it (as
   few songs as possible, one word per song, or any mix that works); for an
   acrostic or A to Z, choose whether to pick from your favourites or a
   playlist. Adjust the matching (punctuation and capitals, version labels,
   close forms, a different artist per song, hi-res first) and, optionally,
   the *Filters*.
2. Find songs: the reading is shown as cards in order, each with its phrase or
   letter, the chosen song and a list to swap it for another match. Badges mark
   a song matched as a close form or only by ignoring punctuation; phrases and
   letters nothing matched are called out and left out. For a sentence, the
   other ways to split it are offered underneath.
3. Choose a destination -- a new playlist (named after your text by default)
   or an existing one (songs already in it are skipped) -- and save. Songs are
   added in sentence or letter order.

**Deduplicator:**

1. Choose a source (your favourites or a playlist) and which copy to keep
   (first added, highest quality, oldest release, and so on).
2. Scan: each duplicate group shows its copies, the kept ones in green and the
   rest in red. Tick the copies you want to keep (you can keep more than one),
   or use "Keep all" to keep the whole group.
3. Apply to remove the unticked copies.

**Combine playlists:**

1. Choose two or more playlists (*Add a playlist* for more; your favourite
   tracks can be one of them) and what to keep: everything (each song once),
   only what the first has and the others lack, or only what all of them
   share. Untick *Treat remasters ... as the same song* to match by Qobuz id
   alone.
2. Combine: a bar shows how the playlists overlap (only in the first, shared,
   only in the others), above the resulting tracks. Choose the order (playlist
   1 then 2, taking turns, or shuffled) and, for a song in more than one,
   whether to keep its highest-quality or its first copy. Untick any track you
   do not want.
3. Save to a new playlist (named "A + B" until you change it) or add to an
   existing one (tracks already in it are skipped). The save bar shows the
   selection's track count and running time.

**Library stats:**

1. Choose what to show: your favourites (the default, loaded when you first
   open the tool), everything, or one playlist.
2. Read the headline, the quality bar (the hi-res share lit up), tracks by
   decade (the largest decade highlighted) and your most-saved artists, with
   the share of the tracks they make up.
3. Press *Playlist* next to a decade or an artist, check the suggested name
   (e.g. "Favourites: 1990s"), and create the playlist.

**New releases:**

1. Choose whose releases to look at (your favourite artists, or the artists in
   one of your playlists), the date to look back to (30 days ago by default)
   and which kinds to include (albums and EPs/singles by default; live albums
   and compilations too if you tick them). Optionally open *Filters* to leave
   out artists, releases or tracks by term.
2. Find new releases: a sentence sums up what was found and what was hidden
   (releases already in your favourite albums, and reissues or remasters of
   older albums), then each release is a card -- cover, artist, title, kind,
   track count, date and quality badge -- newest first, all ticked. Untick any
   you do not want.
3. In the bar at the bottom, choose *Add to* a new playlist (named, optionally
   public) or your favourite albums, and save.

**Upgrade & repair:**

1. Choose what to check (your favourites, all your playlists, or one
   playlist). Untick *Only the same recording* to also accept the same song by
   artist and title; tick *Remove unplayable tracks with no replacement* to
   default those to removal.
2. Check, then review two lists. *Better quality available* shows each track's
   quality next to the replacement's ("16/44.1 -> 24/96"); untick any you want
   to keep, and pick another release when several were found. *No longer
   playable* offers, per track, a replacement (when one was found), "Remove
   it" or "Leave it". Matches by artist and title only are flagged.
3. Apply: the bar at the bottom counts the upgrades, replacements and removals.

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
The one exception is *Show artwork*, which, once you turn it on, has the
browser load cover images from Qobuz's public image server; see
[ADR-0004](docs/adr/0004-optional-artwork.md).

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
