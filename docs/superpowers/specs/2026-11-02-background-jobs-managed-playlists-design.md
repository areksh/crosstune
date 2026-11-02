# Background jobs and managed playlists -- design

- Date: 2026-11-02
- Status: approved in conversation, awaiting written-spec review
- Becomes: ADR-0007 "Background jobs and managed playlists" (written in phase 1)

## 1. Intent

qobuz-helper today runs only when the user runs it. This adds **jobs**: saved
definitions that qobuz-helper runs on a schedule, unattended. The headline job
is the **managed playlist** -- a playlist qobuz-helper owns and keeps current
from a saved *recipe* -- for example "releases since a date by these artists
and 3 similar artists each". Artists with nothing new contribute nothing.

Success: set up once, the playlist stays current for weeks with no attention;
the machinery is safe when unattended (a Qobuz outage, a bundle change or an
expired session never empties a playlist, and the user is told); every change
is in History and can be undone.

### What the user decided

- **Runs where:** both an always-on box (home server, NAS, Pi, Docker) and a
  desktop that sleeps. The design must work in either, chosen per install.
- **Runtime:** hybrid -- one engine, two drivers (OS scheduler or long-running
  `serve`).
- **Windows:** a per-playlist choice of last N days, since a fixed date, last N
  releases per artist, plus optional caps.
- **Hand edits:** a per-playlist option chosen at creation -- *respect edits*
  (default) or *strict mirror*.
- **Similar-artist expansion:** snapshotted, refreshed monthly.
- **Undoing a refresh** counts as a hand edit (undone additions are dismissed).
- **A deleted managed playlist** pauses its job (not recreated).
- **Scope:** this spec designs the engine and all job kinds below; delivery is
  phased (section 11).

### Constraints carried over

- Zero runtime dependencies (`node:fs`, `node:http`, `node:crypto`, built-in
  `fetch`, `node:child_process` for the optional desktop notification only).
- The Qobuz token never reaches the browser; the server stays on `127.0.0.1`
  with the Host / Origin / nonce checks of ADR-0002.
- Logic in pure, tested modules; drivers and socket/timer/`fetch` glue thin and
  untested.
- Every account write goes through `recordingClient` inside a `Journal.run`
  (ADR-0006).

## 2. Feature catalogue

| Id | Kind | Name | Built on |
|----|------|------|----------|
| A | managed playlist | New releases feed | `new-releases`, `similar-artists`, `playlist-shape` |
| B | managed playlist | Discovery radio | `similar-artists`, `song-picker` |
| C | managed playlist | Live combined playlist | `combine` |
| D | managed playlist | Smart playlist over the library | `stats`, `track-filter` |
| E | managed playlist | Follow / archive a playlist | `combine`, `qobuz-links`, `getPlaylist` |
| F | backup | Scheduled backup | `import-export` |
| G | upkeep | Auto-upkeep (dedupe / upgrade / repair) | `deduplicate`, `upgrade` |
| H | (engine) | Notifications | run results |

## 3. Data model and storage

All files live in `$XDG_CONFIG_HOME/qobuz-helper/`, owner-only (`0600`), beside
the session and `history.jsonl`.

| File | Written by | Contents |
|------|-----------|----------|
| `jobs.json` | CLI and UI only | Job definitions and the `notify` config. Atomic writes (temp file + rename). |
| `jobs-state/<jobId>.json` | runner only | `lastRunAt`, `nextRunAt`, `consecutiveFailures`, `paused` (reason), last result summary, recipe state (owned entries, dismissed tracks, snapshots, served history, ...). Atomic writes. |
| `jobs-runs.jsonl` | runner only | Run log: one line per job run. Append-only; compacted to the last 500 lines / 90 days on write. |
| `jobs.lock` | runner | Lock (section 6). |
| `jobs-global.json` | runner, `login` | Global flags: `needsSignIn`, `bundleBroken` (with since / message). |

Definitions and state are split so that editing a job never races a run that
writes state. Every file carries `version: 1`; unknown versions are refused
with a clear message, unreadable run-log lines are skipped (as in the journal).

### Definitions

```ts
interface JobBase {
  id: string;            // short random id, stable
  name: string;          // also the managed playlist's name on creation
  enabled: boolean;      // false = paused by the user
  schedule: Schedule;
  notify?: "changes" | "failures-only" | "off";   // default: global setting
}

type Schedule =
  | { every: "hour" }
  | { every: "day"; at?: "HH:MM" }                 // local time, default 06:00
  | { every: "week"; weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6; at?: "HH:MM" };  // default Monday

type Job =
  | (JobBase & ManagedPlaylistJob)
  | (JobBase & BackupJob)
  | (JobBase & UpkeepJob);

interface ManagedPlaylistJob {
  kind: "managed-playlist";
  playlistId?: number;          // set by the first run, which creates the playlist
  isPublic: boolean;            // default false
  edits: "respect" | "mirror";  // default "respect"
  recipe: RecipeDef;            // section 5
  shape?: Shape;
}

interface Shape {
  maxReleases?: number;         // recipe A: keep the newest N releases
  maxTracks?: number;           // keep the first N tracks of the desired order
  maxMinutes?: number;          // fit to length (playlist-shape fitToLength)
}
```

Artist lists are stored **resolved** (`{ id, name }`), resolved and reviewed
once at creation; the live sources "favourites" and "a playlist's artists" are
re-read on each run.

`jobs.json` is validated on every load (`model.ts`); an invalid job is reported
and skipped, the others still run.

## 4. Reconciling a managed playlist

One refresh = **resolve, observe, diff, apply**. All but *apply* are pure.

1. **Resolve** -- the recipe produces the *desired* list: ordered
   `{ trackId, source }` (source = album id, artist id or source playlist id,
   for reports), plus `complete: boolean`. `Shape` is applied after the recipe.
2. **Observe** -- read the playlist's entries with their playlist-track ids.
   Against the state's **owned** entries (playlist-track id + track id, added by
   this job):
   - an owned entry that is gone was removed by the user (or by undo) --> in
     *respect* mode its track id is added to **dismissed**;
   - a present entry that is not owned is **hand-added**.
3. **Diff**

   | | respect edits | strict mirror |
   |---|---|---|
   | add | desired − present − dismissed | desired − present |
   | remove | owned entries no longer desired | every present entry not desired (including hand-added) |
   | order | new tracks placed by the recipe's order (e.g. newest release on top); hand-added entries keep their place | whole playlist reordered to the desired order |

   *Mirror* keeps no dismissed list.
4. **Apply** through `recordingClient` inside `Journal.run`, labelled
   "Managed: <job name>". Additions are recorded as owned (their new
   playlist-track ids are read back, as the journal already does); removals drop
   out of owned. Moves use `movePlaylistTracks` (`insert_before` = 1-based
   position, verified live).

### Safety rules

- **Incomplete resolve --> no removals.** If the recipe reports
  `complete: false` (any artist, album or source failed), the run adds what it
  can and removes nothing; the run log says why.
- **First run creates the playlist** (private unless `isPublic`). If the
  playlist later cannot be found (`getPlaylist` 404), the job is **paused** with
  reason `playlist-deleted` and a notification is sent; it is never recreated
  silently. Resuming asks: create a new playlist, or remove the job.
- **Undo of a refresh** is observed like a hand edit: undone additions become
  dismissed (respect mode); restored removals become hand-added. No special
  journal knowledge is needed in the reconciler.
- **Dry run** -- `run-due --dry-run`, `jobs run <id> --dry-run` and the UI's
  "Preview next refresh" compute steps 1-3 and show the diff without writing.
- Writes use the client's existing batching (`MAX_TRACK_IDS_PER_REQUEST`) and
  the rule that one request never repeats a track id.

## 5. Recipes

```ts
interface Recipe<R, S> {
  resolve(
    client: RecipeClient,
    def: R,
    ctx: { now: Date; jobId: string; state: S | undefined },
  ): Promise<{
    tracks: { trackId: number; source: string }[];  // desired, ordered
    complete: boolean;
    notes: string[];                                 // shown in run log / preview
    state: S;                                        // the recipe's new state
  }>;
}
```

Each recipe declares the minimal client interface it needs, as the features
do. A recipe must be **deterministic** for the same inputs and state: a
reconciler that gets different answers each run churns the playlist.

### A. New releases feed

```ts
interface NewReleasesRecipe {
  type: "new-releases";
  artists: { type: "list"; artists: { id: number; name: string }[] }
         | { type: "favourites" }
         | { type: "playlist"; playlistId: number };
  similar?: { perArtist: number; refreshDays: number };  // refreshDays default 30
  window: { type: "last-days"; days: number }
        | { type: "since"; date: string }                 // YYYY-MM-DD
        | { type: "latest-per-artist"; count: number };
  include: ReleaseType[];          // default album + ep-single
  hideFavourites: boolean;         // default false (unlike the one-off tool)
  filter?: TrackFilter;
}
```

- `findNewReleases` is generalised to take a window instead of only `since`.
  For `latest-per-artist`, a release counts as a reissue by its label, or when
  the artist has an older release of the same kind and edition-free title
  (the "earlier" set becomes "older than this release", not "before the
  window").
- **Similar snapshot:** the set of similar artists is walked
  (`walkFromArtists`, existing bounds) at creation and whenever older than
  `refreshDays`; stored in recipe state with its date, shown in the UI. Between
  refreshes it is fixed. Snapshot walk failures keep the previous snapshot and
  mark the run incomplete.
- The desired list is each release's tracks in album order, releases newest
  first; `maxReleases` keeps the newest N.
- Releases' tracks are fetched with `fetchAlbumTracks`; a failed album makes the
  run incomplete.

### B. Discovery radio

```ts
interface DiscoveryRecipe {
  type: "discovery";
  seeds: NewReleasesRecipe["artists"];
  similar: { perArtist: number; refreshDays: number };
  artistsPerRotation: number;      // M
  tracksPerArtist: number;         // K
  rotation: "day" | "week";        // default week
  avoidRepeatsFor: number;         // rotations a served track stays out; default 8
  skipFavouriteTracks: boolean;    // default true (song-picker)
  filter?: TrackFilter;
}
```

- Each rotation picks M artists from the similar snapshot (excluding the seeds
  and excluded artists) and their top K tracks, skipping favourite tracks and
  tracks served in the last `avoidRepeatsFor` rotations.
- The rotation number is the count of whole rotation periods (calendar days, or ISO weeks starting Monday, local time) since the job's creation; the job's schedule only decides how often this is checked, so a daily schedule with a weekly rotation changes picks once a week.
- Randomness is **seeded** from `jobId` + rotation number, so a retry, or a run
  on another machine, within the same rotation resolves the same picks.
- A new rotation replaces the previous one's entries (they are no longer
  desired); hand-added entries stay in respect mode.
- State: similar snapshot, current rotation number and picks, served history.

### C. Live combined playlist

```ts
interface CombinedRecipe {
  type: "combined";
  sources: CombineSource[];        // playlists and/or favourites; managed playlists allowed
  mode: CombineMode;               // merge | only-first | common
  keep: CombineKeep;
  order: "sequential" | "interleave" | "shuffle";  // shuffle seeded per job (stable)
  filter?: TrackFilter;
}
```

Incomplete if any source fails to load. A source that is the job's own
playlist is rejected at validation.

### D. Smart playlist over the library

```ts
interface SmartRecipe {
  type: "smart";
  source: "favourites" | "playlists" | "library";
  rules: SmartRule[];              // AND
  order: "newest-added" | "release-date" | "by-artist" | "shuffle";
}
type SmartRule =
  | { type: "quality"; class: "hires" | "cd" }
  | { type: "decade"; decades: string[] }
  | { type: "artists"; include?: number[]; exclude?: number[] }
  | { type: "duration"; minSeconds?: number; maxSeconds?: number }
  | { type: "favourited-within"; days: number }     // only if phase 0 confirms the date
  | { type: "genre"; genres: string[] };            // only if phase 0 confirms the field
```

Reuses `collectLibrary`, `qualityOf`, `decadeOf`. Rules depending on unverified
fields are only offered once phase 0 has confirmed the API returns them.

### E. Follow / archive a playlist

```ts
interface FollowRecipe {
  type: "follow";
  source: { playlistId: number };  // any playlist link, via qobuz-links
  mode: "mirror" | "archive";
}
```

- `mirror`: desired = the source playlist's tracks in its order.
- `archive`: desired = every track ever seen in the source (state keeps the
  seen list in first-seen order), so the playlist only grows.
- Phase 0 must confirm that editorial and other users' public playlists can be
  read with the signed client; if not, E is limited to the user's own
  playlists.

## 6. Runtime

### `runDue(deps, now)`

```ts
interface RunDueDeps {
  jobs: JobStore; state: JobStateStore; runs: RunLog; global: GlobalFlags;
  lock: Lock; client: () => Promise<RecordingClient>;  // restored without browser
  notifier: Notifier; dryRun?: boolean;
}
```

1. Take the lock; if held by a live process, return "busy".
2. If `needsSignIn` or `bundleBroken` is set, try a cheap client restore once;
   still failing --> return without running jobs (no repeat notification).
3. Due = enabled, not paused, `nextRunAt <= now` (no state = due now). Run them
   **sequentially**, oldest `nextRunAt` first. Qobuz throttles with 400s and the
   client's retry assumes one caller; fan-out inside a job still uses
   `mapWithConcurrency`.
4. After each job: write its state, append its run-log line.
5. Send one batched notification (section 7). Release the lock.

### Schedule

`nextRunAt` = the first slot of the schedule **strictly after `now`** (local
time, `at` and `weekday` honoured; DST gaps move to the next valid minute). This
gives anacron-style catch-up: a laptop asleep through several slots runs the
job **once** on wake. A newly created job runs on the next `runDue`.

### Failures

| Failure | Behaviour |
|---|---|
| Job throws (network, Qobuz 5xx, unexpected) | `consecutiveFailures++`; `nextRunAt = now + backoff` with backoff 15 min, 1 h, 6 h, then 6 h, never later than the next regular slot; notification on the 3rd consecutive failure, then not again until it recovers (recovery is notified) |
| Session rejected (`QobuzError` kind `authentication`) | Set `needsSignIn`; no job runs while it is set (per-job state, including `paused`, is untouched); one notification. Background restore uses `restoreOrLogin` with a `browserLogin` that throws -- never opens a browser. `login` (any form) clears the flag. |
| Bundle extraction / signing fails | Clear the credential cache, re-extract once; still failing --> set `bundleBroken` ("Qobuz changed; update qobuz-helper"); no job runs while it is set; one notification. Cleared by a later successful init. |
| Managed playlist gone | Pause the job with `playlist-deleted`; notify. |
| Invalid job definition | Skip it, log, notify once per distinct error. |

### Lock

`jobs.lock` is created with `fs.openSync(path, "wx")` and holds
`{ pid, startedAt, host }`. It is stale when its pid is not alive on this host
(`process.kill(pid, 0)`) or it is older than 2 hours; a stale lock is replaced.
The same helper (`file-lock.ts`) also wraps `history.jsonl` compaction, closing
the compaction race ADR-0006 accepted, which a long-lived writer would make
likely.

### Drivers

- **`qobuz-helper run-due [--dry-run]`** -- initialise the client (credential
  cache), restore the session without a browser, call `runDue`, print a
  summary (`--json` supported), exit non-zero only on an engine-level failure.
- **`qobuz-helper serve [--no-open] [--port]`** -- the existing UI server plus a
  ticker: every 60 s, and immediately on start, call `runDue` unless one is in
  progress. The ticker compares wall-clock time, so sleep and timer drift do
  not matter. `ui` remains as is (no ticker).
- **`qobuz-helper schedule print --cron | --systemd | --launchd | --windows`**
  -- print a ready-to-install snippet that calls `run-due` every 15 minutes
  with the current node and script paths. Nothing is installed automatically.

## 7. Notifications

Configured once in `jobs.json`:

```ts
interface NotifyConfig {
  channels: (
    | { type: "ntfy"; url: string; token?: string }
    | { type: "gotify"; url: string; token: string }
    | { type: "discord"; webhookUrl: string }
    | { type: "webhook"; url: string; headers?: Record<string, string> }   // JSON POST
    | { type: "desktop" }   // notify-send / osascript if found; else skipped
  )[];
  events: { changes: boolean; failures: boolean; needsSignIn: boolean };  // default all true
}
```

- One message per `runDue`, listing each job's outcome ("Fresh: +2 releases --
  Artist – Album, ...; Backup: unchanged"). Nothing to report --> no message.
- A job's `notify` overrides which of its events are included.
- Payload builders are pure and tested; sending is thin `fetch` glue with a
  10 s timeout. A failed send goes to the run log and never fails a job.
- `qobuz-helper notify test` sends a test message to every channel.
- Tokens and webhook URLs live only in the owner-only `jobs.json` and are never
  returned to the web page (the UI shows them masked; editing replaces them).

## 8. Other job kinds

### F. Scheduled backup

```ts
interface BackupJob {
  kind: "backup";
  directory: string;               // absolute path
  keep: number;                    // default 14
  extras?: { format: "m3u" | "csv" | "text"; scope: "every-playlist" }[];
  skipUnchanged: boolean;          // default true
}
```

Writes `qobuz-backup-YYYY-MM-DD.json` (the lossless `LibraryBackup`) atomically,
plus optional per-playlist exports in a dated subfolder. With `skipUnchanged`,
a backup whose content hash (ignoring its timestamp) equals the latest one is
not written. Retention deletes only files matching its own naming pattern. Never
writes to the Qobuz account; incomplete reads fail the job rather than writing a
partial backup.

### G. Auto-upkeep

```ts
interface UpkeepJob {
  kind: "upkeep";
  targets: ({ type: "favourites" } | { type: "playlist"; playlistId: number })[];
  tasks: {
    dedupe?: { keep: KeepChain; apply: boolean };
    upgrade?: { apply: boolean };
    repair?: { action: "replace" | "remove"; apply: boolean };
  };
  maxSearchesPerRun: number;       // default 200
}
```

- **Report-only by default** (`apply: false`): the notification summarises the
  findings and links to the corresponding tool view; nothing is changed.
- `apply: true` commits through the journal like any tool, with the existing
  safeguards of each tool.
- **Incremental upgrade/repair:** state records checked track ids with dates;
  each run checks new tracks first, then those checked more than 90 days ago,
  within `maxSearchesPerRun`.

## 9. CLI and web UI

### CLI

```
qobuz-helper jobs list [--json]
qobuz-helper jobs show <id> [--json]          # definition, state, recent runs
qobuz-helper jobs create new-releases --artists "A, B" [--similar N] \
    [--window last-days:N | since:YYYY-MM-DD | latest:N] [--include ...] \
    [--edits respect|mirror] [--every hour|day|week] [--at HH:MM] [--weekday mon] \
    [--max-releases N] [--max-tracks N] [--fit MIN] --name NAME [--apply]
qobuz-helper jobs create backup --dir PATH [--keep N] [--every ...] [--apply]
qobuz-helper jobs pause <id> | resume <id>
qobuz-helper jobs run <id> [--dry-run]
qobuz-helper jobs remove <id> [--delete-playlist]
qobuz-helper run-due [--dry-run] [--json]
qobuz-helper serve [--no-open] [--port N]
qobuz-helper schedule print --cron|--systemd|--launchd|--windows
qobuz-helper notify test
qobuz-helper login [--print-url]
```

`jobs create` resolves and previews (artists matched, similar snapshot, first
refresh diff) and writes only with `--apply`, like the existing tools. Recipes
B-E and upkeep get `jobs create` subcommands in their phases. Parsers go in
`args.ts` (pure, tested).

### Web UI

- New **Managed** view (`views/managed.ts`, a `VIEWS` entry, an `index.html`
  section): the jobs with status (last run, next run, last change, failures,
  pause reason), *Run now*, *Preview next refresh*, *Pause/Resume*, *Edit*,
  *Delete* (optionally deleting the playlist), and each job's run log. A banner
  shows `needsSignIn` / `bundleBroken`.
- **Creation from the existing tools:** after a resolve, New releases, Similar,
  Combine and Stats offer **"Keep this updated..."**, which turns the current
  form into a recipe and asks for name, schedule, edit mode and caps. Backup and
  upkeep are created in the Managed view.
- A notifications settings panel in the Managed view (channels, events, test).
- Routes in `router.ts` (pure, validated; Qobuz errors --> 502 as today):
  `GET /api/jobs`, `POST /api/jobs`, `PUT /api/jobs/:id`,
  `DELETE /api/jobs/:id`, `POST /api/jobs/:id/run`,
  `POST /api/jobs/:id/preview`, `GET /api/jobs/:id/runs`,
  `GET/PUT /api/notify`, `POST /api/notify/test`. Writes go through the same
  journal wrapping as other write routes. A *Run now* takes the jobs lock; if
  it is busy the route answers 409.
- `serve` binds to `127.0.0.1` only. A headless box's UI is reached through an
  SSH tunnel (documented). Listening on other interfaces is out of scope: it
  would break ADR-0002's Host/nonce model.

### Headless sign-in

`login --print-url` prints the OAuth URL; the user opens it on any device and
pastes back the redirect URL, from which the code is taken. Phase 0 verifies
this works with the current OAuth flow (`oauth-login.ts`). If it does not, the
documented fallback is signing in on a desktop and copying the session file.

## 10. Code layout and testing

```
src/jobs/
  model.ts            types, defaults, validation of jobs.json / state
  schedule.ts         nextRunAt, backoff
  reconcile.ts        observe + diff (pure)
  run-due.ts          orchestration
  notify.ts           payload builders (pure)
  recipes/new-releases.ts, discovery.ts, combined.ts, smart.ts, follow.ts
  backup.ts, upkeep.ts
src/cli/job-store.ts, job-state-store.ts, run-log.ts, file-lock.ts
src/cli/notify-send.ts           (glue: fetch / child_process)
```

Dependencies point down: `cli`/`server` --> `jobs` --> `features` --> `qobuz`.
Existing features are generalised in place rather than copied
(`findNewReleases` window; the similar-artist walk reused for snapshots).

Tests (co-located, Vitest, stubbed clients, no network):

- `schedule`: every kind, `at`/`weekday`, catch-up after long gaps, DST
  transitions (fixed `TZ`), backoff caps.
- `reconcile`: every cell of the respect/mirror table; duplicates told apart by
  playlist-track id; incomplete resolve removes nothing.
- Multi-run scenarios on `fake-account.test-support.ts`: run --> hand-remove
  --> run (dismissed, not re-added) --> undo --> run; window ageing out; deleted
  playlist pauses.
- Each recipe: determinism (same inputs and state --> same output), seeded
  shuffles, snapshot refresh timing, incomplete flags.
- `runDue`: fake clock, stores, notifier; lock busy; needs-sign-in and
  bundle-broken paths; one batched notification.
- `file-lock`, stores and run-log compaction in a temp directory.
- `args.ts` parsers; router job routes.
- Untested glue: the ticker, `fetch`/`child_process` sends, `schedule print`
  path discovery.

Docs: ADR-0007; README sections (managed playlists, scheduling per OS,
notifications, SSH tunnel, headless sign-in); CHANGELOG under `[Unreleased]`.

## 11. Phasing

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0 | Live probes (scratch data only): headless OAuth paste-back; favourite-added date and genre fields; reading editorial / other users' playlists | Findings recorded; D and E rule sets and the sign-in path fixed accordingly |
| 1 | Engine (model, stores, schedule, lock, reconcile, `runDue`, `run-due`, `serve`, `schedule print`, `jobs` commands), recipe **A**, Managed view, "Keep this updated" on New releases and Similar, ADR-0007 | A feed refreshes on schedule from both drivers; tests and typecheck pass |
| 2 | **H** notifications, **F** backup | A change, a 3rd failure and needs-sign-in each produce one batched message on every channel type; backups rotate and skip unchanged |
| 3 | **B**, **C**, **D**, **E** (each independently mergeable) | Each recipe passes the determinism and multi-run scenario tests and has a `jobs create` subcommand and a "Keep this updated" entry point |
| 4 | **G** auto-upkeep | Report-only runs change nothing; `apply` runs appear in History; the search budget is respected across runs |

Each phase gets its own implementation plan.

## 12. Out of scope

- Remote access to the web UI beyond an SSH tunnel; multi-user use.
- Installing OS scheduler entries automatically (only printed).
- Shipping a Dockerfile (a documented example may be added in the README).
- Listening-history-based features (no verified API for it).
- Reversing hand edits made outside qobuz-helper beyond what section 4 defines.
