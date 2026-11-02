# Managed playlists v2: more sources, scheduled tidy-ups -- design

- Date: 2026-11-02
- Status: approved in conversation (section 1 reviewed; the user delegated the
  rest: "proceed without showing me any more designs, do what you think is best")
- Builds on: `2026-11-02-background-jobs-managed-playlists-design.md` (phases 3
  and 4 of it, reshaped) and ADR-0007.
- Becomes: ADR-0008 "Playlists and what manages them".

## 1. Intent

Phase 1 shipped one kind of managed playlist (the new releases feed). This adds:

- more **sources** that keep a playlist current: a live **combined** playlist
  (kept in sync with the playlists it combines), **follow / archive** another
  playlist, a **smart** playlist (rules over favourites or playlists) and a
  **discovery radio**;
- **tidy-ups** that run on a schedule against a playlist -- **dedupe**,
  **upgrade** (hi-res copies) and **repair** (unplayable tracks) -- on managed
  playlists, on the user's own playlists and on favourites;
- a **Managed view organised by playlist**: each card is a playlist, then what
  manages it (its source, its tidy-ups, its schedule).

### What the user decided

| Question | Decision |
|---|---|
| Sources this round | Combined, Follow/archive, Smart, Discovery (all four) |
| Where tidy-ups can run | Any playlist (managed or hand-made) and favourites |
| What a tidy-up does with a finding | Per tidy-up: **apply** (default; undoable in History) or **suggest** (findings wait on the card for accept / ignore; ignored never return) |
| Scheduling | One schedule per playlist; each pass refreshes the source first, then the tidy-ups that are due; each tidy-up picks a cadence: every pass, weekly, monthly |
| Existing playlists | A source can be attached to an existing playlist ("adopted"), **respect-edits only**; strict mirror only for playlists the job created |
| Structure | Approach A: one job per playlist, holding its target, optional source and tidy-ups, sharing one state file |

### Success

Set once, a playlist stays current and tidy without attention; the source and
the tidy-ups never undo each other's work (in either edit mode); undoing a pass
from History is respected by the next pass; nothing unattended can empty a
playlist (incomplete reads remove nothing, as today).

## 2. Data model

```ts
interface PlaylistJob {
  id, name, createdAt, enabled, schedule;            // as in v1
  kind: "playlist";
  target:
    | { type: "created"; isPublic: boolean }          // runner creates it on the first pass
    | { type: "adopted"; playlistId: number }         // an existing playlist of the user's
    | { type: "favourites" };                         // tidy-ups only
  edits: "respect" | "mirror";                        // mirror only with target "created"
  source?: SourceDef;
  shape?: Shape;                                      // maxReleases (new-releases only), maxTracks, maxMinutes
  tidy: { dedupe?: DedupeTidy; upgrade?: UpgradeTidy; repair?: RepairTidy };
}

type SourceDef = NewReleasesSource | CombinedSource | FollowSource | SmartSource | DiscoverySource;

interface TidyBase { cadence: "every-pass" | "weekly" | "monthly"; mode: "apply" | "suggest" }
interface DedupeTidy  extends TidyBase { keep: KeepChain }                 // default ["highest-quality", "first-added"]
interface UpgradeTidy extends TidyBase { allowSignatureMatch: boolean; maxSearches: number } // false, 200
interface RepairTidy  extends TidyBase { action: "replace" | "remove" }   // default replace
```

Validation (`model.ts`, on every load, as in v1):

- a job has a source, at least one tidy-up, or both;
- `created` requires a source (an empty playlist nobody fills is pointless);
- `favourites` takes no source and no shape; `edits` is ignored for it;
- `mirror` requires `created`;
- a source must not read its own target (checked where the target id is known).

The service additionally enforces (it can see every job's state):

- **one job per playlist** -- adopted ids and created playlists' state ids are
  unique across jobs; at most one favourites job;
- **no cycles** -- a source that reads a playlist (combined, smart, follow,
  new-releases from a playlist's artists) must not, through other jobs' sources,
  read back this job's own target.

### State (`jobs-state/<id>.json`, version 2)

```ts
interface JobState {
  version: 2;
  playlistId?: number;              // created targets only (adopted: in the definition)
  lastRunAt?, nextRunAt?, consecutiveFailures, paused?, lastResult?;   // as v1
  owned: OwnedEntry[]; dismissed: number[]; pending?;                   // as v1
  /** Desired track `from` is satisfied by present track `to` (absent: left out). */
  substitutions: { from: number; to?: number; key: string }[];
  tidy: {
    dedupe?:  { lastRunAt: string };
    upgrade?: { lastRunAt: string; checked: { trackId: number; at: string }[] };
    repair?:  { lastRunAt: string };
  };
  /** Finding keys applied without a substitution (an exact duplicate removed, a favourite replaced). */
  applied: string[];
  suggestions: Suggestion[];
  ignored: string[];                // finding keys never to apply or suggest again
  source?: SourceState;             // similar snapshot, discovery rotation, archive seen-list
}
```

All lists are capped (substitutions, applied, ignored: 2,000, oldest first
out; upgrade `checked`: 5,000).

### Migration

`jobs.json` version 1 is read into the new shape (`managed-playlist` +
`recipe` + `isPublic` --> `playlist` + `target: created` + `source` + `tidy: {}`);
saves write version 2. A version 1 state is read as version 2 (`similar` moves
to `source.similar`; new lists empty). Reading never rewrites a file.

## 3. One pass

`runPass(client, job, state, { now, dryRun })` replaces `refreshManagedPlaylist`.
It runs inside one history entry (`Managed: <name>`), as v1.

1. **Locate.** Paused --> nothing. The playlist id is `target.playlistId ??
   state.playlistId`; a 404 pauses the job (`playlist-deleted`, as v1; resuming
   an adopted job just retries, resuming a created one makes a new playlist).
   Favourites need no lookup.
2. **Observe reverts.** Read the entries once. A substitution whose `from` is
   present again was put back by the user or by undo: drop the substitution and
   add its key to `ignored`. (While a substitution stands, the source never adds
   `from`, so its presence can only be the user's.)
3. **Source step** (when there is a source). Resolve the recipe; apply the
   shape; map the desired list through the substitutions (chains followed, a
   cycle stops the walk; `to` absent drops the track; duplicates after mapping
   keep their first place); reconcile and write exactly as v1 (owned, dismissed,
   pending, reorder). An incomplete resolve removes nothing.
4. **Tidy steps** due by cadence (`every-pass`; `weekly` = 7 days since its
   `lastRunAt`; `monthly` = 30 days), in the order **repair, upgrade, dedupe**
   (repairs first spend the search budget where it matters; dedupe last sees the
   replacements). They work on the entries as they are after the source step
   (re-read once if the source step wrote anything). Each produces **findings**
   with a stable key:

   | Tidy-up | Finding | Key |
   |---|---|---|
   | repair | unplayable track A --> replace with B, or remove | `repair:A` |
   | upgrade | A has a better copy B | `upgrade:A>B` |
   | dedupe | a group of copies of one song; keep K, remove the rest | `dedupe:<sorted track ids>` |

   Findings whose key is in `ignored` or `applied` are dropped (a re-found
   applied key means the user put it back: it moves to `ignored`). In **apply**
   mode the rest are written now; in **suggest** mode they replace that tidy-up's
   suggestions.
5. **Book-keeping for applied changes** (playlists with or without a source):
   - replace A --> B: substitution `A -> B`; if A's entry was owned, B's new
     entry becomes owned in its place;
   - remove A (repair): substitution `A -> (none)`; A's entry leaves `owned`;
   - dedupe: each removed copy leaves `owned` (it is not a dismissal); a removed
     copy with another id than K gets substitution `id -> K`; an exact duplicate
     (same id) records its key in `applied`;
   - favourites: keys go to `applied` (there is no source to map).

   Ownership is never moved onto an entry the user added, so respect mode still
   never removes the user's tracks.

Why both edit modes stay stable: the reconciler compares the playlist with the
*mapped* desired list, so an upgraded or de-duplicated track already satisfies
its desire -- respect mode adds nothing and dismisses nothing, mirror mode
removes nothing and re-adds nothing.

### Writes

Upgrade and repair reuse `commitUpgrades` (adds, confirms by re-reading, removes
only confirmed, moves the replacement into place; favourites too). Dedupe
removes playlist entries by playlist-track id (or favourite track ids). A tidy
write that fails part-way is reported in the pass's notes and the pass still
succeeds with what was written (each tidy-up re-reads next time; nothing is
pending for it), except an authentication error, which stops everything as v1.

### Results

`RunResultSummary` gains `replaced`, `tidyRemoved` and `suggested` counts
(optional, default 0). The preview (dry run) shows the source diff and, per
tidy-up, the findings it would apply or suggest.

## 4. Sources

All take `RecipeContext { now, jobId, state }` and return `{ tracks, complete,
notes, state }` as the v1 recipe does; all are deterministic for the same inputs
and state. Shared helpers move to `src/jobs/recipes/common.ts`: the similar
snapshot (from the new-releases recipe), `applyShape` (maxTracks, maxMinutes),
and `stableShuffle(jobId, items, idOf)` -- ordering by a hash of job id and
track id, so a new track does not reshuffle the others (a seeded Fisher-Yates
would, churning a mirrored playlist).

### Combined

```ts
interface CombinedSource {
  type: "combined";
  inputs: CombineSource[];            // 2-10, favourites and/or playlists (any readable id)
  mode: CombineMode;                  // merge | only-first | common
  keep: CombineKeep;                  // highest-quality | first
  order: CombineOrder;                // sequential | interleave | shuffle (stable)
  matchSongs: boolean;                // default true
  exclude?: TrackFilterSpec;
}
```

Inputs are read one by one. With `merge`, a failed input makes the result
incomplete (add what was read, remove nothing). With `only-first` and `common`
a missing input would change which songs qualify, so a failed input fails the
pass (retried with backoff). Uses `combineTracks` unchanged, with its shuffle
replaced by `stableShuffle` for `shuffle`.

### Follow / archive

```ts
interface FollowSource { type: "follow"; playlistId: number; keepRemoved: boolean }
```

`keepRemoved: false` follows the playlist (its tracks, in its order).
`keepRemoved: true` archives it: `source.seen` keeps every track id ever read
(first-seen order, newest appended), and the desired list is the whole seen
list, so tracks dropped upstream stay. A failed read: follow --> incomplete;
archive --> the seen list as it was, incomplete. Any playlist id or link the
signed client can read (editorial playlists verified readable).

### Smart

```ts
interface SmartSource {
  type: "smart";
  from: CombineSource[];              // 1-10: favourites and/or playlists
  rules: SmartRule[];                 // all must hold (AND); at least one
  order: "as-listed" | "newest-favourited" | "newest-release" | "by-artist" | "shuffle";
}
type SmartRule =
  | { type: "quality"; quality: "hires" | "cd" }
  | { type: "decades"; decades: string[] }                // "1990s"
  | { type: "genres"; genres: string[] }                  // album genre name, case-insensitive
  | { type: "favourited-within"; days: number }           // favourites only
  | { type: "artists"; include?: ArtistRef[]; exclude?: ArtistRef[] }
  | { type: "duration"; minSeconds?: number; maxSeconds?: number };
```

The track model gains `genre?: string` (from `album.genre.name`) and
`favouritedAt?: string` (ISO, from `favorited_at`), both verified live. Tracks
from several inputs are unique by id (first copy). A failed input -->
incomplete. `favourited-within` makes the playlist age tracks out: the window
is evaluated at `now`.

### Discovery radio

```ts
interface DiscoverySource {
  type: "discovery";
  seeds: FeedArtists;                 // list | favourites | a playlist's artists (as new-releases)
  similarPerArtist: number;           // snapshot size per seed (default 10), refreshed every 30 days
  artistsPerRotation: number;         // default 10
  tracksPerArtist: number;            // default 3
  rotation: "day" | "week";           // default week
  avoidRepeatsFor: number;            // rotations; default 8
  skipFavouriteTracks: boolean;       // default true
  exclude?: TrackFilterSpec;
}
```

- The rotation number counts whole local calendar days, or ISO weeks starting
  Monday, since the job's `createdAt`.
- At the first pass of a rotation: refresh the similar snapshot if due; pick
  `artistsPerRotation` artists from it (not seeds, not excluded, not picked in
  the previous rotation when enough others remain) with a PRNG seeded from
  `jobId` + rotation; take each one's top tracks (`fetchArtistTracks`, skipping
  favourite songs via `SongPicker`, tracks served in the last `avoidRepeatsFor`
  rotations, and the filter). Store the picks (`source.rotation`) and append
  them to `source.served`.
- Within a rotation the stored picks are the desired list (no Qobuz reads), so
  every pass of a rotation resolves the same. A rotation whose fetches partly
  failed keeps what it got and is incomplete for that pass only.
- A new rotation's picks replace the old ones (the old entries are no longer
  desired and leave in either mode).

### New releases

Unchanged, but its snapshot logic moves to `common.ts` and its state to
`source.similar`; its `maxTracks`/`maxMinutes` go through `applyShape`.

## 5. Tidy-ups

| Tidy-up | Built on | Notes |
|---|---|---|
| dedupe | `findDuplicateGroups`, `resolveDuplicateGroups`, `KeepChain` | `oldest`/`newest` need release dates (`enrichReleaseDates`) |
| upgrade | `resolveUpgrades` over the target's entries | incremental: tracks checked in the last 90 days are skipped; `maxSearches` per pass; unchecked tracks wait for the next one |
| repair | the unplayable items of the same resolve | replacing needs a search per track; removal does not |

`resolveUpgrades` gains an entry point that takes already-read tracks (and
their location) plus a `skip` predicate, and reports which tracks it checked,
so the job can keep `checked` and avoid reading the target twice. When upgrade
and repair are both due they share one resolve.

## 6. Suggestions

```ts
interface Suggestion {
  key: string;                        // as in section 3
  tidy: "dedupe" | "upgrade" | "repair";
  summary: string;                    // "Song – Artist: 16-bit/44.1 -> 24/96"
  change: SuggestedChange;            // what accepting writes, revalidated then
  foundAt: string;
}
```

- **Accept** (some or all): under the jobs lock, in one history entry
  (`Managed: <name> (accepted)`), re-read the target, drop changes that no longer
  apply (their entries are gone), write the rest with the same code and
  book-keeping as apply mode.
- **Ignore**: the keys go to `ignored`; they are not suggested again.
- A tidy-up in suggest mode replaces its own suggestions on each of its runs, so
  fixed-by-hand findings disappear.

## 7. Running

- `runDue` sorts the due jobs so that a job reading a playlist runs after the
  job that manages that playlist (when both are due); otherwise by `nextRunAt`
  as v1. The dependency is not forced to run.
- `runNow`, `preview` and the new `acceptSuggestions` take the lock (409 when
  busy) as v1.

## 8. CLI

```
jobs create new-releases ...                          # as v1, plus the shared flags
jobs create combined <playlist|favourites>... [--mode merge|only-first|common] \
    [--keep highest-quality|first] [--order sequential|interleave|shuffle] [--no-match-songs]
jobs create follow <playlist> [--archive]
jobs create smart <playlist|favourites>... [--hires|--cd] [--decades 1990s,2000s] \
    [--genres jazz,soul] [--favourited-within DAYS] [--min-length M:SS] [--max-length M:SS] \
    [--order as-listed|newest-favourited|newest-release|by-artist|shuffle]
jobs create discovery <artists...>|--favourites|--from-playlist P [--similar N] \
    [--artists-per-rotation M] [--tracks-per-artist K] [--rotation day|week] [--avoid-repeats N]
jobs create tidy <playlist|favourites>                 # tidy-ups only, on an existing playlist

shared: --name NAME --every hour|day|week [--at HH:MM] [--weekday mon] \
        [--into <playlist>] (adopt; respect only) [--public] [--edits respect|mirror] \
        [--dedupe[=CADENCE]] [--upgrade[=CADENCE]] [--repair[=CADENCE]] [--suggest] \
        [--max-tracks N] [--fit MIN] [--apply]
jobs suggestions <id> [--json]
jobs accept <id> <key...>|--all
jobs ignore <id> <key...>|--all
```

`jobs create` previews and writes only with `--apply`, as v1.

## 9. Server

New and changed routes (all under the v1 checks; validation 400, unknown 404,
lock busy 409, Qobuz 502):

- `GET /api/jobs` -- the views now include `targetName` (the playlist's name,
  from the user's playlists; "Favourites") when known.
- `POST /api/jobs/:id/suggestions` `{ accept?: string[] | "all", ignore?: string[] | "all" }`.
- The v1 job routes take v2 definitions.

## 10. Web UI

The Managed view becomes a list of **playlist cards**:

```
┌ Road trip (combined) ───────────────────── created by qobuz-helper ┐
│ Source   Combined: Summer + Late night + Favourites · merge         │
│ Tidy-ups Dedupe · every pass · apply    Upgrade · monthly · suggest │
│ Daily at 06:00 · last pass 06:00 +3 −1 · next tomorrow 06:00        │
│ 2 suggestions ▸   [Run now] [Preview] [Pause] [Edit] [Delete]       │
└─────────────────────────────────────────────────────────────────────┘
```

- Card title: the playlist's name, with a badge: *created by qobuz-helper*,
  *your playlist*, or *favourites*.
- Suggestions expand in the card with Accept / Ignore per item and for all.
- **Manage a playlist** opens the form, in three parts: **Playlist** (a new
  one, one of mine, or favourites), **Source** (none, new releases, combined,
  follow, smart, discovery; each with its own fields), **Tidy-ups** (three
  rows: on/off, cadence, apply/suggest, options), then schedule, edit mode
  (mirror offered only for a new playlist) and caps.
- The Combine view's result offers **Keep this updated...**, opening the form
  prefilled as a combined source (as New releases and Similar do today).

## 11. Code layout

```
src/jobs/model.ts              v2 types, validation, v1 migration
src/jobs/pass.ts               runPass (was refresh.ts): locate, reverts, source, tidy, book-keeping
src/jobs/substitutions.ts      mapping, reverts, caps (pure)
src/jobs/tidy.ts               findings per tidy-up, cadence, apply/suggest (pure planning + writes)
src/jobs/suggestions.ts        accept / ignore
src/jobs/dependencies.ts       playlists a job reads/writes, run order, cycle check
src/jobs/recipes/common.ts     similar snapshot, applyShape, stableShuffle
src/jobs/recipes/{new-releases,combined,follow,smart,discovery}.ts
src/jobs/recipes/index.ts      resolveSource dispatch
```

Tests (co-located, stubbed clients / `fake-account.test-support.ts`, no
network): model validation and migration; substitution mapping and reverts;
each source's determinism and incompleteness; stable shuffle; discovery
rotation numbering and repeat avoidance; each tidy-up's findings, cadence,
ignored/applied filtering; multi-pass scenarios on the fake account
(upgrade-then-refresh in both edit modes; dedupe-then-refresh; undo then pass;
suggest then accept); dependency order and cycle rejection; service
one-job-per-playlist; args parsers; router suggestions route.

## 12. Out of scope

- Notifications and scheduled backup (still phase 2 of the jobs roadmap).
- More than one source per playlist (use a combined source over managed
  playlists instead).
- Strict mirror on adopted playlists.
- Smart rules over "the whole library" (it would include the job's own
  playlist and other managed ones; choose inputs explicitly).
