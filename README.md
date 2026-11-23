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

## Several services

qobuz-helper also works with **TIDAL** and **Spotify**, through their official
APIs. Connect each on the **Accounts** page of the web UI, or with
`qobuz-helper login tidal` / `login spotify`:

- TIDAL and Spotify each ask you to register a free app of your own and paste
  its **client id**; the Accounts page shows the steps and the redirect address
  to register (`http://127.0.0.1:53683/callback/<service>`). The client secret
  is not needed.
- Spotify's app must be owned by an account with **Premium**, and Spotify ends
  the sign-in six months after you authorise it (the UI warns you in time).
  Spotify gives no top tracks or similar artists to such apps; with Qobuz or
  TIDAL connected, they are taken from there and matched back.
- Choose the service in the sidebar. Playlists, Library stats and Combine can
  show **all services** at once; every song and playlist names its service.
  With all of them shown, Combine compares playlists across services: *Only in
  the first* lists what a Qobuz playlist has that a Spotify one lacks (matched
  by ISRC, then artist and title), and *Add these to ...* copies them over.
- **Copy to another service** (a playlist's menu, or "On" when making a new
  playlist) matches songs by ISRC, then by name. Uncertain matches are shown for
  you to choose; your choices are remembered (`matches.json`).
- **Linked playlists** (Managed playlists) keep one playlist the same on several
  services, both ways. On a conflict nothing is written, and every page says so
  until you settle it. `qobuz-helper sync` syncs them now; `run-due` exits with
  3 while any is in conflict.
- **Disconnect and forget** (or `forget <service>`) deletes what qobuz-helper
  keeps about a service, its History entries included.

Spotify's and TIDAL's terms limit combining their content with other services';
showing them side by side and comparing them is done here for your own use,
each item labelled with its service.

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
- **Playlists** -- open any of your playlists to select many songs at once and
  remove, move, copy, reorder or favourite them, drag them into order, sort or
  shuffle, and remove every song by a list of artists -- in one playlist or
  several. Edits are a draft until you save, and every save can be undone. In
  the web UI; removing artists is on the CLI too.
- **Deduplicator** -- report and remove duplicate tracks in a playlist or your
  favourites, including remasters and the same song on different albums, or
  scan all your playlists to also find songs saved in more than one of them.
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
- **Import & export** -- export favourites, a playlist, or every playlist
  (a file each) as JSON, CSV, plain text or M3U; back up your whole account
  (favourites and playlists) to a lossless JSON file; and import a list back in
  -- including a Spotify playlist exported with Exportify -- matching each entry
  to Qobuz by its id, its ISRC, or by search. Available on the CLI and in the
  web UI.
- **History & undo** -- every change qobuz-helper makes to your account is
  recorded on your machine, one entry per action, and any entry can be undone:
  what it added is taken out, what it removed is put back in its old place, and
  a playlist it created is deleted. Available on the CLI and in the web UI (see
  [History and undo](#history-and-undo)).
- **Managed playlists** -- playlists qobuz-helper looks after on a schedule.
  A *source* keeps one filled: the new releases of artists you choose (with
  their similar artists if you like), a live **combination** of other
  playlists, a copy that **follows or archives** another playlist, a **smart**
  playlist of tracks meeting rules (hi-res, decades, genres, recently
  favourited...), or a weekly **discovery radio**. **Tidy-ups** keep it clean:
  remove duplicates, upgrade to better-quality copies, repair tracks that stopped
  playing -- on managed playlists, on your own playlists and on your favourites,
  either applied or left as suggestions. Tracks you take out stay out. Runs from
  your system's scheduler or an always-on `serve` (see
  [Managed playlists](#managed-playlists)).

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
The filters apply as with album lines. The artist's releases come from
`artist/getReleasesList`, the undocumented endpoint the Qobuz web player uses;
at most 500 releases are read per artist. Qobuz labels live albums as plain
albums, so a title or version saying "Live" makes a release a live album (and
a greatest-hits title a compilation).

#### Links

Wherever a list is typed, a link works too: an artist link in place of an
artist's name (looked up by its id, so no name search can pick the wrong
artist), an album link in place of an "Artist - Album" line (that exact
release, as the only version), and a playlist link wherever `--playlist` (or
word-play's `--add-to`) takes an id. Recognised, with or without `https://`,
query strings or a trailing slash:

- Qobuz: the player links (`https://play.qobuz.com/artist/41259`,
  `https://open.qobuz.com/album/<id>`, `.../playlist/<id>`, `.../track/<id>`)
  and the store's (`https://www.qobuz.com/gb-en/album/<slug>/<id>`,
  `https://www.qobuz.com/us-en/interpreter/<slug>/<id>`);
- Spotify: `https://open.spotify.com/artist/<id>` (also album, playlist and
  track, with or without `intl-xx/`) and `spotify:artist:<id>`;
- TIDAL: `https://tidal.com/browse/artist/<id>`, `https://tidal.com/album/<id>`,
  `https://listen.tidal.com/playlist/<id>` and the like.

A link to another service than the one a tool runs on is read there (so that
service must be connected) and found again: an artist by its exact name (if
several artists there share it, none is picked and the line says so), an album
by its barcode, else by its exact title and artist (when several editions share
those and the barcode cannot tell them apart, none is picked and the line says so). What is not found is
reported with the reason, as is a link of the wrong kind -- an album link
among artists.

```sh
# Artists by link and by name, mixed
npm run dev -- playlist-from-artists --name "Mix" \
  "https://play.qobuz.com/artist/41259" "Massive Attack"

# An exact release by link, alongside an "Artist - Album" line
npm run dev -- playlist-from-albums --name "Albums" \
  "https://www.qobuz.com/gb-en/album/mezzanine-massive-attack/pvsb64n704d0b" \
  "Portishead - Dummy"

# Expand any playlist (yours or not) by its link (dry run)
npm run dev -- similar-artists --playlist "https://play.qobuz.com/playlist/12345678"
```

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

#### Order, favourites, repeats and length

The playlist builders share four plan options:

```sh
# Take turns between the artists, skip songs you already have in your
# favourites, one copy of each song, and stop at about an hour
npm run dev -- playlist-from-artists --name "Trip Hop Hour" --order take-turns \
  --skip-favourites --one-copy --fit 60 "Portishead" "Massive Attack" "Tricky"

# Albums shuffled together, trimmed to about 80 minutes
npm run dev -- playlist-from-albums --name "Shuffled" --order shuffle --fit 80 \
  "Portishead - Dummy" "Massive Attack - Mezzanine"
```

| Option | Artists | Similar artists | Albums |
| --- | --- | --- | --- |
| `--order` | `by-artist` (default), `take-turns` (round-robin between the artists), `shuffle` | the same, artists in plan order (each seed, then its similar artists) | `as-listed` (default) or `shuffle` |
| `--skip-favourites` | a track already in your favourite tracks is left out and the next most popular takes its place | the same | the track is left out of its album |
| `--one-copy` | a later copy of a song already in the playlist (same ISRC, or the same artist and title, remasters included; live takes and remixes stay apart) is left out and replaced | the same, across seeds and similar artists | a song an earlier album already has is left out |
| `--fit <minutes>` | trims to at most about that length, dropping from the end of each artist's tracks in turn so each keeps its most popular | the same | trims from the end of the list, keeping whole albums from the top |

Favourites are fetched once per run and matched the way the deduplicator
matches songs, so a remaster of a favourite counts too. A track of unknown
length counts as the average. `similar-artists` also takes
`--skip-favourite-artists`, which treats your favourite artists like a source
playlist's own: never suggested.

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
default 3), `--yes`, `--skip-favourite-artists`, the
[plan options](#order-favourites-repeats-and-length) and the [filters](#filters)
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
runs first, with at most 120 searches per sentence (of up to 30 words). Qobuz
ranks an exact one-word title deep in its results (a search for "brown" lists
the song "Brown" around position 300), so a word that found no exact title is
searched further, up to about 550 results, within 40 extra searches per
sentence. Very common words such as "a" and "the" find nothing on their own
(Qobuz's search seems to ignore them); a longer phrase containing them can
still match.

The playlist is named after the text (title-cased) unless `--name` is given;
`--public` makes it public, or `--add-to <id>` appends to an existing playlist
instead. Without `--apply` the command only reports what it would add.

```sh
# Report duplicate tracks in a playlist, or across your favourites
npm run dev -- deduplicate --playlist 12345678
npm run dev -- deduplicate --favourites

# Choose which copy to keep, then actually remove the rest
npm run dev -- deduplicate --playlist 12345678 --keep highest-quality --apply

# Highest quality, and of equally good copies the oldest release
npm run dev -- deduplicate --favourites --keep highest-quality,oldest

# Every playlist: its own duplicates, plus songs saved in several playlists
npm run dev -- deduplicate --all-playlists
```

The deduplicator matches tracks by ISRC or by a normalised artist+title
signature: it treats remasters and the same song on different albums as
duplicates, while keeping genuinely different versions (live, acoustic, remix)
separate. Songs you have in several versions are listed after the duplicates
and kept; `--include-versions` counts them as duplicates instead. For each
duplicate group it marks one copy to keep and the rest to remove:

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

Give several strategies separated by commas to break ties: each later one only
decides between the copies the earlier ones rank equal
(`--keep highest-quality,oldest` keeps the oldest of the highest-quality
copies). Remaining ties keep the first-added copy, as before.

`--all-playlists` deduplicates each of your playlists on its own, as
`--playlist` would, and also lists the songs (matched the same way) saved in
more than one playlist, with the playlists each is in. Those are only reported
-- nothing is removed from other playlists; choose where each song stays in the
web UI.

By default the command only **reports** the plan. Add `--apply` to actually
remove the tracks marked `drop` (from the playlist, or from your favourites).

```sh
# What removing these artists from a playlist would remove, then do it
npm run dev -- remove-artists --playlist 12345678 "Portishead" "Massive Attack"
npm run dev -- remove-artists --playlist 12345678 "Portishead" "Massive Attack" --apply

# From all your playlists, a list of artists from a file, guest spots too
cat artists.txt | npm run dev -- remove-artists --all-playlists --include-guests
```

`remove-artists` takes names (the whole name, ignoring case and accents), Qobuz
artist links and `/patterns/`, as arguments or on stdin, and `--playlist` (an id
or link, repeatable) or `--all-playlists` (your own playlists). A song is an
artist's when they are its main artist or a joint one; songs where they are only
a guest are listed and kept unless `--include-guests` is given. An artist found
nowhere is reported, with a suggestion when one is spelled like it. Without
`--apply` it only reports.

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
npm run dev -- stats --everything --json > stats.json

# Make a playlist of your favourites from the 1990s (dry run, then --apply)
npm run dev -- stats --favourites --decade-playlist 1990s
npm run dev -- stats --favourites --decade-playlist 1990s --name "Nineties" --apply
```

`stats` takes one source: `--favourites`, `--playlist <id>`, or `--everything`
(your favourites and all of your playlists, each track counted once). It
prints a headline ("1,240 favourite tracks by 312 artists. 86 hours of
music."), the quality split (hi-res above 16 bits or 48 kHz, CD quality, or
unknown), tracks by release decade, and the ten artists and albums with the most
tracks; `--json` prints the same as JSON instead (see [Output](#output)).
`--decade-playlist <decade>`
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

# Every playlist to its own CSV file in ./playlists
npm run dev -- export --all-playlists --out-dir playlists --format csv

# Without --out the content goes to stdout; pair it with --loglevel warn so
# sign-in progress does not end up in the piped file
npm run dev -- --loglevel warn export --playlist 12345678 --format m3u > mix.m3u
```

`export` sources are `--favourites`, `--favourite-albums`, `--favourite-artists`,
`--playlist <id>`, `--all-playlists`, or `--account` (a full backup). `--format`
is one of `json`, `csv`, `text` or `m3u` (inferred from `--out`'s extension when
omitted, else `json`); a backup is always JSON. CSV and plain text carry a single
collection; M3U carries tracks only; JSON is lossless and the only format for a
whole-account backup. `--all-playlists` needs `--out-dir <dir>` (created if
missing) and writes one file per playlist, named after it: characters that are
not allowed in file names become `_`, and playlists with the same name get
" (2)", " (3)", ...

```sh
# Preview importing a hand-written track list into favourites (dry run)
npm run dev -- import --favourites tracks.txt

# Actually add them, matching each "Artist - Title" line to Qobuz
npm run dev -- import --favourites tracks.txt --apply

# Import a CSV into a new playlist
npm run dev -- import --new-playlist "From CSV" songs.csv --apply

# Import a Spotify playlist exported with Exportify (recognised from its header)
npm run dev -- import --new-playlist "From Spotify" "My Spotify Playlist.csv"

# Restore a whole-account backup
npm run dev -- import --account qobuz-backup.json --apply
```

`import` targets are `--favourites`, `--favourite-albums`, `--favourite-artists`,
`--playlist <id>` (an existing playlist), `--new-playlist <name>`, or `--account`
(restore a backup). The format is inferred from the filename unless `--format` is
given (`json`, `csv`, `text`, `m3u`, or `spotify`). Each entry is resolved to a
Qobuz item by its id when the file carries one (JSON always does; CSV and M3U
can); else, for a track with an ISRC, by searching Qobuz for that ISRC (the same
recording); otherwise by searching for the artist and title and best-matching.
The report says how many matched each way; entries that match nothing are
listed. Like `deduplicate`, `import` only resolves and **reports** unless
`--apply` is given.

**From Spotify:** export the playlist with [Exportify](https://exportify.net)
and import the CSV into favourite tracks or a playlist. Its header ("Track
Name", "Artist Name(s)", "Album Name", "ISRC", ...) is recognised whatever the
column order, so `--format spotify` is only needed when the file does not end in
`.csv`. Each track is matched by its ISRC first -- preferring a release Qobuz
can stream, then the album named in the file, then the highest quality -- and,
when the ISRC is missing or not on Qobuz, by its first artist and title (a
"feat." credit in the title is ignored, and "Song - Live" matches Qobuz's
"Song" in its Live version).

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
releases come from `artist/getReleasesList`, the undocumented endpoint the Qobuz
web player uses.

#### History and undo

```sh
# The latest changes, newest first (id, time, what, +added/-removed)
npm run dev -- history
npm run dev -- history --limit 50

# What undoing the latest change would do (report only), then do it
npm run dev -- undo
npm run dev -- undo --apply

# Undo a particular entry, by the id `history` shows
npm run dev -- undo 9f0dce48 --apply
```

**What is recorded.** Every change any tool makes to your account, from the
CLI or the web UI: playlists created (and deleted, by undo), tracks added to
and removed from playlists, entries moved, and tracks, albums and artists added
to or removed from your favourites. Recording sits underneath the tools, in the
Qobuz client itself, so no tool can skip it. Each command, or each save in the
web UI, is one entry with a label ("Created Road Trip with 15 tracks",
"Removed 12 duplicates from Favourites", "Upgraded 4 tracks in Late Night"),
the tool, where it ran and when. An action that fails part-way still records
what it did change. Dry runs change nothing and record nothing.

To be able to reverse a change, recording reads a little more: a playlist is
read back after tracks are added to it (to learn the new entries), and read
before tracks are removed from it (to keep each removed track and its
position). A removal or deletion whose playlist cannot be read first is not
made.

**Where, and for how long.** In `$XDG_CONFIG_HOME/qobuz-helper/history.jsonl`
(usually `~/.config/qobuz-helper/`), beside the session, readable by you only.
It is a JSON Lines file, one record per line, only ever appended to; undoing
appends a marker rather than editing the entry. The last 200 entries, up to 90
days old, are kept; older ones are dropped the next time something is written.

**What undo does.** For each playlist an entry touched, undo removes the
entries it added (by their entry ids, so copies of the same track you added
yourself are left alone), puts the tracks it removed back in their old
positions and the ones it moved back where they were, and deletes a playlist the
entry created if it still holds only what the entry put there (otherwise it
removes just those tracks and keeps the playlist). A song is never taken out of
where a change put it if it could not be put back where it was. Changed playlist
names, descriptions and visibility are set back. Favourites it added are removed and favourites
it removed are added back. `undo` without an id picks the latest change that is
neither undone nor itself an undo, so running it again walks back through your
history. The undo is recorded as an entry of its own ("Undid: ..."), which can
in turn be undone to redo the change; an entry cannot be undone twice. A step
that fails is reported and the others still run.

Undoing an entry that is not the latest is allowed; you are warned when later
entries touched the same playlist or favourites, since undo then cannot always
restore exactly what it found.

**What undo cannot restore.**

- Anything done outside qobuz-helper: edits in the Qobuz apps are not recorded,
  and a playlist's name or description changed elsewhere stays changed.
- Tracks already gone: added tracks you have since removed are skipped (and
  listed), and a playlist deleted since cannot have its changes undone.
- Tracks Qobuz no longer streams cannot go back into a playlist (Qobuz ignores
  the request); undo says how many did not.
- Favourites come back as newly added, so their "date added" order is not the
  original one.
- Old positions assume the rest of the playlist is as the entry left it; after
  other changes, tracks go back at the same index, which may now be a different
  spot. If a move fails, the tracks stay at the end of the playlist (and undo
  says so).
- Reorderings recorded before qobuz-helper kept what reversing them needs are
  reported, not reversed.
- A deleted playlist (undoing an undo) comes back as a new playlist, with a new
  id and link.

In the web UI, **History** (under *Your data*) lists the entries by day with
their `+`/`-` counts; **Undo** first shows exactly what will be reversed, with
any notes and warnings, and only acts on confirmation. Undone entries are
dimmed. The home page shows the latest change with links to undo it or open
the history. With `--json`, `history` prints `entries` and `undo` prints
`entry`, `plan` (`steps`, `notes`, `warnings`), `applied` and `result`.

If the browser does not open automatically, the CLI prints the URL to visit.

#### Managed playlists

A managed playlist is a *job*: a saved recipe qobuz-helper refreshes on a
schedule. Its recipe is the new releases of some artists -- listed by name or
link, your favourite artists, or a playlist's artists -- optionally with each
one's top similar artists (a list kept for 30 days, then looked up again), and
a window:

- `--window last-days:30` -- released in the last 30 days (the default); older
  releases drop out of the playlist as they age;
- `--window since:2026-01-01` -- everything since a date; the playlist only grows;
- `--window latest:2` -- each artist's 2 newest releases, whenever they came out.

Reissues and remasters are left out as in [New releases](#commands); releases
already in your favourite albums are kept unless `--hide-favourites`.
`--max-releases`, `--max-tracks` and `--fit <minutes>` cap the playlist.

```sh
# Preview, then save: creates the playlist and fills it straight away
npm run dev -- jobs create new-releases "Air" "Bonobo" --similar 3 --name "New from my artists"
npm run dev -- jobs create new-releases "Air" "Bonobo" --similar 3 --name "New from my artists" --apply

# Your favourite artists, refreshed every Friday at 07:30
npm run dev -- jobs create new-releases --favourites --every week --weekday fri --at 07:30 --name "Fresh" --apply

npm run dev -- jobs                      # list them, with the last and next run
npm run dev -- jobs run <id> --dry-run   # what the next refresh would change
npm run dev -- jobs run <id>             # refresh now
npm run dev -- jobs pause <id>           # and: resume, show, remove [--delete-playlist]
```

**Your edits.** By default (`--edits respect`) a refresh only touches the tracks
it added: a track you remove from the playlist is remembered and never added
again, and a track you add yourself is never removed. With `--edits mirror`
every refresh resets the playlist to exactly the recipe. Each refresh is one
[history](#history-and-undo) entry; undoing one counts as removing its tracks.

**Running on a schedule.** Refreshes happen whenever qobuz-helper runs the jobs
that are due -- either from your system's scheduler, every 15 minutes:

```sh
npm run build
node dist/cli.js schedule print --systemd   # or --cron, --launchd, --windows
```

prints a ready-to-install snippet that calls `qobuz-helper run-due` (which only
does something when a job is due); or from `qobuz-helper serve`, the web UI
plus a ticker, for a machine that stays on (`serve --no-open --port 8080` on a
server). A refresh missed while the computer was off or asleep runs once when
it is back. `run-due` never opens a browser: if the session has expired, jobs
stop until you run `qobuz-helper login` again (on a machine without a browser,
`login --print-url` prints a link to open on any device; paste back the address
you end up on). On a headless server, reach the web UI through an SSH tunnel:
`ssh -L 8080:127.0.0.1:8080 server`, then open `http://127.0.0.1:8080`.

**Safety.** If anything cannot be read during a refresh (an artist, an album),
the refresh adds what it can and removes nothing. If you delete a managed
playlist in Qobuz, its job pauses; `jobs resume <id>` makes a new playlist.
Failures retry after 15 minutes, 1 hour, then 6 hours. The jobs live in
`jobs.json` beside the session (with `jobs-state/` and the run log
`jobs-runs.jsonl`); an invalid hand edit to one job is reported (and kept as
written, for you to fix) while the others keep running, and a job whose state
file cannot be read is skipped rather than started over. A refresh that fails
part-way picks up where it stopped on the next run. Feeds check at most 1,000
artists (with similar ones); past that, nothing is removed.

**Other sources.** Besides new releases, a managed playlist can be filled by:

```sh
# Combined: kept in sync with two playlists and your favourites
npm run dev -- jobs create combined 1234 5678 favourites --name "Road trip mix" --order shuffle --apply
# Follow a playlist (any you can open, e.g. a Qobuz editorial one) -- or archive it, keeping what it drops
npm run dev -- jobs create follow https://play.qobuz.com/playlist/9876 --archive --name "Editors' picks, kept" --apply
# Smart: hi-res favourites added in the last 30 days, newest first
npm run dev -- jobs create smart favourites --hires --favourited-within 30 --order newest-favourited --name "New in hi-res" --apply
# Discovery radio: each week 10 artists like these you do not follow, 3 tracks each
npm run dev -- jobs create discovery "Air" "Bonobo" --artists-per-rotation 10 --tracks-per-artist 3 --name "Radio" --apply
```

Combined takes `--mode merge|only-first|common`, `--order
sequential|interleave|shuffle` (a shuffle that stays put as tracks come and
go), `--keep highest-quality|first` and `--exact-ids-only`, like
[Combine](#commands); with `only-first` or `common`, a pass that cannot read
every input fails and retries rather than guessing. Smart rules (all must hold):
`--hires`/`--cd`, `--decades 1990s,2000s`, `--genres jazz,soul`,
`--favourited-within DAYS`, `--min-length`/`--max-length M:SS`. Discovery
keeps the same picks all week (or day, `--rotation day`), skips songs in your
favourites (`--keep-favourite-tracks` to include them) and does not repeat a
track for 8 rotations (`--avoid-repeats N`). A source may read other managed
playlists (a combination of two feeds, say): they run first. A source cannot,
through others, read back its own playlist.

**Your own playlists.** `--into <playlist>` gives a source to one of your
playlists instead of making a new one. Tracks already in it count as yours, so
nothing you put there is ever removed; strict mirror is only for playlists
qobuz-helper made. Removing such a job never deletes the playlist.

**Tidy-ups.** Any managed playlist -- and any of your playlists, and your
favourites -- can be tidied on a schedule:

```sh
npm run dev -- jobs create tidy 1234 --dedupe --repair --apply           # one of your playlists
npm run dev -- jobs create tidy favourites --upgrade=weekly --suggest --apply
npm run dev -- jobs create combined 1234 5678 --name "Mix" --dedupe --upgrade --apply
```

| Tidy-up | Does | Default cadence |
| ------- | ---- | --------------- |
| `--repair` | replaces tracks that stopped playing with another copy (`--repair-remove`: removes them when there is none) | weekly |
| `--upgrade` | swaps tracks for a better-quality copy of the same recording, a few hundred searches a pass, each track re-checked after 90 days | monthly |
| `--dedupe` | removes extra copies of a song (`--dedupe-keep`, as in [Deduplicate](#commands); default best quality, then first added) | every pass |

Give a cadence as `--upgrade=weekly` (`every-pass`, `weekly`, `monthly`). Each
pass refreshes the source first, then runs the tidy-ups that are due. A tidy-up
and the source never undo each other: the source treats an upgraded or
de-duplicated track as the one it wanted. Tidy-up changes are in the
[history](#history-and-undo) with the rest of the pass; one you put back by
hand (or by undo) is left alone from then on.

**Suggestions.** With `--suggest` a tidy-up changes nothing; what it finds waits
for you:

```sh
npm run dev -- jobs suggestions <id>             # list them, with their keys
npm run dev -- jobs accept <id> upgrade:123>456  # or --all
npm run dev -- jobs ignore <id> --all            # never suggested again
```

Qobuz cannot swap a favourite in place: an upgraded or repaired favourite is
added anew and the old one removed, so the Qobuz app lists it as recently
added. qobuz-helper keeps the original date, and its smart playlists and
first/last-added duplicate checks use that one.

In the web UI, *Managed playlists* shows a card per playlist -- made by
qobuz-helper, yours, or your favourites -- then what manages it: its source,
its tidy-ups, its schedule, its last and next pass, and any suggestions to
accept or ignore (Run now, Preview, Pause, Edit, Delete -- optionally with a
playlist qobuz-helper made). *Manage a playlist* sets one up with a preview;
*New releases*, *Similar artists* and *Combine playlists* have a *Keep this
updated...* button that opens the form filled in.

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

#### Output

A global `--json` option (like `--loglevel`, it may appear anywhere) makes a
command print **exactly one JSON document** on stdout -- its plan or result --
and send every log line, progress included, to stderr. Redirecting stdout
therefore captures only the JSON:

```sh
npm run dev -- --json deduplicate --favourites > duplicates.json
npm run dev -- import --json --new-playlist "From Spotify" playlist.csv | jq .counts
```

The document is an object whose first key is `"command"`; the other keys follow
in a fixed order per command. Commands that only report until `--apply` record
the plan and `"applied": false`; with `--apply` they add `"applied": true` and
the write's `"result"`.

| Command | Keys |
| ------- | ---- |
| `deduplicate` | `source`, `keep`, `groups`, `versions` (or, with `--all-playlists`, `playlistCount`, `within`, `across`), `toRemove`, `applied`, `removed` |
| `remove-artists` | `artists`, `problems`, `playlists` (each with its `hits`), `includeGuests`, `toRemove`, `applied`, `removed`, `reports` |
| `upgrade` | `source`, `plan`, `changes`, `applied`, `result` |
| `import` | `file`, `target`, `format` (as read: a CSV may be `spotify`), `plan` (each matched item has `via`: `id`, `isrc` or `search`), `counts`, `applied`, `result`; restoring a backup: `file`, `target`, `backup`, `applied`, `result` |
| `export` (needs `--out` or `--out-dir`) | `source`, `format`, then `kind`, `count` and `out`; or a backup's `favourites` and `playlists` counts; or, for `--all-playlists`, `outDir` and `files` |
| `similar-artists` | `source`, `plan`, `trackIds`, `applied`, `result` |
| `new-releases` | `plan`, `applied`, `result` |
| `word-play`, `combine` | `plan`, `name`, `trackIds`, `applied`, `result` |
| `stats` | the stats themselves (`label`, `trackCount`, `artistCount`, `totalDuration`, `quality`, `decades`, `topArtists`, `topArtistsShare`, `topAlbums`, `headline`), then `decadePlaylist` with `--decade-playlist` |
| `playlist-from-artists`, `playlist-from-albums` | `applied`, `result` (the created playlist and per-artist or per-album details) |
| `history` | `entries` (each `id`, `at`, `tool`, `toolName`, `source`, `label`, `added`, `removed`, and `undoes`, `undoneAt`, `error` when set) |
| `undo` | `entry`, `plan` (`steps`, `notes`, `warnings`, `blocked`), `applied`, `result` (`done`, `failed`, `notes`, `undone`, `entryId`) |
| `check`, `logout` | `favouriteTracks`; `cleared` |

`stats --json` keeps printing the same fields as before (now with `"command"`
first). `export --json` without `--out`/`--out-dir` is refused, since the
export itself would be written to stdout. When a command fails, stdout stays
empty, the error goes to stderr, and the exit status is non-zero.

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

The home page opens with a paste box, *Start with a link or a list*: paste
links (Qobuz, Spotify or TIDAL), artist names or "Artist - Album" lines, one per line. It says what
it found ("Found 1 playlist, 1 album and 1 artist.") and offers the tools that
fit -- build a playlist from the artists or the albums, find similar artists,
and for a playlist link: similar artists from it, upgrade & repair, library
stats or the deduplicator (the last three when the playlist is yours). A
button opens the tool with the list filled in. Nothing is looked up until the
tool runs. The artists, albums and similar-artists lists take links as well as
names (see [Links](#links)), and *Similar artists* can start from a
pasted playlist link, not only from one of your playlists.

Album covers are off by default. Tick *Show artwork* at the bottom of the
sidebar to show them next to tracks and albums; your browser then loads them
straight from Qobuz's image server (no sign-in details are involved). While it
is off, no image is requested at all. The setting is remembered in this
browser.

**Playlist from artists:**

1. Paste one artist per line and choose how many top tracks to take from each.
   Optionally open *Filters* to exclude tracks, albums or artists by term (one
   per line). Under *Leave out*, tick *Skip tracks already in my Favourites*
   and *One copy of each song* (on by default).
2. Preview the tracks grouped by artist, and untick any you do not want. Tracks
   the filters excluded -- or already in your favourites ("Already in your
   Favourites"), or another copy of a song listed above ("Same song as ...
   above") -- are replaced by the next most popular, and listed
   unticked with the reason where they rank, so you can tick one back on in
   its place. Above the list, choose the *Order* (by artist, take turns -- the
   default -- or shuffle; "Plays as ..." previews the first few tracks) and
   *Fit to length* (any length, or about 30 to 120 minutes), which unticks
   tracks from the end of each artist's list in turn. The save bar shows the
   ticked tracks' count and total length. Names that matched
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
   or to include only some discs, and choose what to *Leave out* (favourites,
   repeated songs).
2. Find the albums: each shows a dropdown to choose which version to use when
   several exist (defaulting to your preference), with the chosen release's
   quality and date shown alongside. Releases matching a release filter are not
   offered; albums with no release left are called out. A discography is
   listed oldest album first.
3. Fetch the tracks: each album lists its tracks (by disc, when it has more
   than one). Tracks on a disc you did not include, or matching a track or
   artist filter, start unticked with the reason; tick or untick any. If a version cannot be
   fetched, the next-best one is selected for you to retry. Once every album
   is in, choose the *Order* (as listed or shuffle) and *Fit to length*, which
   unticks tracks from the end of the list.
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
   artist for repeats (see the CLI's `--replace-repeats`), and *Skip artists
   already in my favourite artists* to never suggest those. Under *Leave out*,
   skip tracks already in your favourites and keep one copy of each song.
   Optionally open *Filters*; similar artists matching an excluded artist are
   skipped in favour of the next most similar.
2. Find similar artists: the artists are found first, then their tracks are
   fetched in batches, with progress shown on the button.
3. Preview: each starting artist is listed with the similar artists that came
   up for it nested underneath, each labelled with every artist it is similar
   to. An artist shared between several is listed under each but added once,
   and ticking or unticking one of its tracks updates every copy. Untick any
   tracks you do not want; tracks the filters excluded (or left out as
   favourites or repeats) are listed unticked where they rank. Similar artists
   the filters left out are named above the preview. Choose the *Order* and
   *Fit to length* as for playlist from artists.
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

**Playlists:**

1. Open a playlist from the list (or tick several and choose *Remove artists* to
   take artists out of all of them). Every song is on one page, with markers for
   duplicates, other versions of a song, and songs Qobuz no longer plays.
2. Select: click rows, shift-click for a range, *Select* for duplicates, other
   versions, live recordings, unplayable songs, dates and so on, *Artists* for
   the artists in it with their counts, or *By artist* to paste a list -- to
   remove those artists' songs or keep only theirs. A search narrows the list,
   and "all" then means what is shown.
3. Edit: remove; move or copy to another playlist; make a new playlist of them;
   favourite; drag by the handle (a selection moves together); top, bottom or a
   given place; *Sort* for sorting, shuffling or spreading out artists -- the
   whole playlist or just the selected songs. *Taken out* lists what you removed,
   to put any of it back.
   Keys: arrows move, Space selects, Shift+arrows extend, Ctrl+A selects all
   shown, Delete removes, Alt+Up/Down moves, Ctrl+Z and Ctrl+Shift+Z undo and
   redo, Escape clears the selection.
4. *Save changes* sums up what will happen and then writes it, as one entry in
   the History. Until then nothing in the playlist has changed on Qobuz, and you
   are asked before leaving with unsaved edits. Copying, favouriting, renaming,
   duplicating and deleting happen at once.

If the playlist changed on Qobuz since you opened it, nothing is written: the
page says what changed and can bring it into your draft. Songs you move are
taken out only once they are seen in the other playlist. Removing a song Qobuz
no longer plays cannot be undone, and the save dialog says so. Opening a managed
playlist tells you what its next refresh will do to your edits.

**Deduplicator:**

1. Choose a source (your favourites, a playlist, or all your playlists) and
   which copy to keep (first added, highest quality, oldest release, and so
   on), optionally with a second choice for when copies are equal.
2. Scan: each duplicate group shows its copies, the kept ones in green and the
   rest in red. Tick the copies you want to keep (you can keep more than one),
   or use "Keep all" to keep the whole group. Scanning all playlists first
   lists the songs saved in more than one playlist, one row per playlist, all
   ticked; untick a playlist to remove the song from it. Below that, each
   playlist's own duplicates are grouped under its name. Songs you have in
   *other versions* (live, acoustic, remixes) are listed after the duplicates,
   all kept; untick any you do not want, or tick *Also treat other versions as
   the same song* before scanning to count them as duplicates.
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
   selection's track count and running time. With exactly two playlists and
   *only what the first has*, *Add these to ...* adds the ticked songs to the
   second playlist instead, on its own service (found there and reviewed
   first, when that is another service).

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
   every playlist, or your whole account) and a format, then download the file.
   A whole-account backup is always JSON; every playlist downloads as one .zip
   with a file per playlist, built by the local server (see
   [ADR-0005](docs/adr/0005-file-download-responses.md)).
2. *Import:* choose a destination (favourites or a playlist, or restore a
   backup), paste or upload the content (a Spotify CSV from Exportify too), and
   preview: the matched entries are counted, with how they were matched (by
   Qobuz id, ISRC, or artist and title), and any that could not be resolved
   are listed.
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
