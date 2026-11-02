# Background jobs, phases 0-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the background-jobs engine and the first job kind -- a managed "new releases feed" playlist -- runnable from an OS scheduler (`run-due`) or the long-running `serve`.

**Architecture:** A new `src/jobs/` layer (pure: model, schedule, reconcile, recipe, refresh, runDue, jobs service) sits between `src/features/` and the drivers. File stores and the lock live in `src/cli/` beside the history store. The drivers (`cli.ts` commands, the `serve` ticker, the web Managed view) stay thin glue.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), Node >= 18, Vitest, esbuild for the web bundle. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-background-jobs-managed-playlists-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:*` modules and built-in `fetch`.
- Relative imports end in `.js`.
- Files under `$XDG_CONFIG_HOME/qobuz-helper/` (default `~/.config/qobuz-helper/`), written with mode `0o600`, atomically (temp file + rename) except append-only logs.
- Every account write goes through `recordingClient` inside `Journal.run`; managed refreshes use tool id `managed` and label `Managed: <job name>`.
- No live Qobuz calls in tests; stub clients or `FakeAccount`.
- Background paths never open a browser.
- `serve` binds `127.0.0.1` only.
- Before calling a task done: `npm test` and `npm run typecheck` pass (`PATH` needs the nvm node bin, see memory).
- Commits: Conventional Commits, scopes `jobs`, `cli`, `server`, `web`, `history`, `new-releases`; end with the `Co-Authored-By` line.

### Spec refinements decided while planning

1. **`playlistId` lives in the job's state, not its definition.** The spec puts it in `ManagedPlaylistJob`, but it also says only the CLI and UI write `jobs.json`. The runner creates the playlist, so the runner records it in `jobs-state/<id>.json`.
2. **DST gaps:** a scheduled local time that doesn't exist (inside a spring-forward gap) runs at whatever JavaScript's `Date` normalises it to, shifted forward by the gap (e.g. 01:30 becomes 02:30). This replaces "next valid minute"; the job still runs once that day.
3. **Phase 1 has no notifier.** `runDue` returns a `RunSummary`, which phase 2 will send. The `needsSignIn` and `bundleBroken` flags are stored and shown in the UI and CLI now.

## Review Focus

1. **Hand-removing every entry, then a refresh.** All of them must become dismissed (respect mode) and nothing is re-added. Test in Task 7.
2. **The playlist deleted in the Qobuz app.** The next run pauses the job, doesn't throw, doesn't create a new playlist, and other due jobs still run. Tests in Tasks 7 and 8.
3. **`jobs.json` edited by hand into invalid JSON or an invalid job.** Valid jobs still run; the invalid one is reported. A wholly unparsable file means no jobs run and nothing is overwritten. Tests in Tasks 2 and 5.
4. **Two runners at once** (a cron `run-due` while `serve` ticks). The second gets "busy" and does nothing; a lock left by a crashed pid is taken over. Tests in Tasks 1 and 8.
5. **A laptop waking after 10 days.** A daily job runs exactly once and its next run is tomorrow's slot. Test in Task 3.

---

### Task 0: Phase 0 live probes (read-only)

**Files:**
- Create (scratch, not committed): `$SCRATCHPAD/probe.mts`
- Modify: `~/.claude/.../memory/qobuz-live-api-facts.md` (findings)

- [ ] **Step 1:** Write `probe.mts`, using `initClientWithCache` and `restoreOrLogin` (browser login replaced by a throw), that only reads:
  - (a) the raw JSON of `favorite/getUserFavorites?type=tracks&limit=5`: is there a date-added field (`favorited_at`, `created_at`...)? Does each track carry `genre`?
  - (b) `getPlaylistTracks` on a Qobuz editorial playlist found via `playlist/getFeatured` or a known public id: readable or not.
- [ ] **Step 2:** Run it with `npx tsx`; record the findings in the memory file. Headless OAuth paste-back can't be verified without the user; the implementation (Task 10) uses `parseRedirectCode` on a pasted URL, and the user is asked to try it.

### Task 1: File lock, and history compaction under it

**Files:**
- Create: `src/cli/file-lock.ts`, `src/cli/file-lock.test.ts`
- Modify: `src/features/journal.ts` (`HistoryStore`, `Journal.#append`), `src/features/journal.test.ts`, `src/cli/history-store.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LockInfo { pid: number; startedAt: string; host: string }
  export interface LockOptions { staleMs?: number /* default 2h */; now?: () => Date;
    isAlive?: (pid: number) => boolean; host?: string; pid?: number }
  export interface FileLock { readonly path: string; release(): void }
  export function tryAcquireLock(path: string, options?: LockOptions): FileLock | undefined
  export function readLock(path: string): LockInfo | undefined
  // journal.ts
  interface HistoryStore { ...; exclusive?<T>(fn: () => T): T | undefined }  // undefined = busy
  ```
- `tryAcquireLock` creates the lock with `openSync(path, "wx", 0o600)`. On `EEXIST` it reads the lock; when that lock is stale (pid not alive on the same host, or older than `staleMs`, or unreadable) it removes it and tries once more. `release()` deletes the lock only if it still holds our pid and `startedAt`.
- `fileHistoryStore` gains `exclusive`, backed by `tryAcquireLock(historyPath + ".lock", { staleMs: 60_000 })`.
- `Journal.#append`: when compaction is due and `store.exclusive` exists, it re-reads, prunes and replaces *inside* `exclusive`. If `exclusive` returns `undefined` (busy), it appends instead.

- [ ] **Step 1: Failing tests** (temp dir via `mkdtempSync`):
  - `acquires when free and writes pid/host/startedAt`
  - `refuses while a live holder has it` (`isAlive: () => true`)
  - `takes over a lock whose pid is dead` (`isAlive: () => false`, same host)
  - `takes over a lock older than staleMs`
  - `does not judge a pid from another host` (other host, recent: refused)
  - `release removes only its own lock`
  - journal: `appends instead of compacting while the store is busy` (a store whose `exclusive` returns `undefined`; the record is appended and `replace` is not called)
- [ ] **Step 2:** Run `npx vitest run src/cli/file-lock.test.ts src/features/journal.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again; expect PASS.
- [ ] **Step 5:** Commit `feat(history): compact the history file under a lock`.

### Task 2: Job model and validation

**Files:** Create `src/jobs/model.ts`, `src/jobs/model.test.ts`

**Interfaces (produces):**
```ts
export type Schedule = { every: "hour" } | { every: "day"; at: string }
  | { every: "week"; weekday: number; at: string };     // defaults filled: at "06:00", weekday 1
export type ReleaseWindow = { type: "last-days"; days: number } | { type: "since"; date: string }
  | { type: "latest-per-artist"; count: number };
export type FeedArtists = { type: "list"; artists: { id: number; name: string }[] }
  | { type: "favourites" } | { type: "playlist"; playlistId: number };
export interface NewReleasesRecipeDef { type: "new-releases"; artists: FeedArtists;
  similar?: { perArtist: number; refreshDays: number }; window: ReleaseWindow;
  include: ReleaseType[]; hideFavourites: boolean; exclude?: FilterTerms /* the same exclude terms the tools accept */ }
export interface Shape { maxReleases?: number; maxTracks?: number; maxMinutes?: number }
export interface ManagedPlaylistJob { id: string; name: string; enabled: boolean; schedule: Schedule;
  kind: "managed-playlist"; isPublic: boolean; edits: "respect" | "mirror";
  recipe: NewReleasesRecipeDef; shape?: Shape; createdAt: string }
export type Job = ManagedPlaylistJob;
export interface JobsFile { version: 1; jobs: Job[] }
export interface InvalidJob { index: number; id?: string; error: string }
export function parseJobsFile(raw: unknown): { file: JobsFile; invalid: InvalidJob[] }  // throws on wrong version / not an object
export function validateJob(raw: unknown): Job        // throws Error with a readable message
export function newJobId(random?: () => string): string // 8 hex chars, from randomUUID
export interface OwnedEntry { playlistTrackId: number; trackId: number }
export interface JobState { version: 1; playlistId?: number; lastRunAt?: string; nextRunAt?: string;
  consecutiveFailures: number; paused?: { reason: "playlist-deleted"; since: string };
  owned: OwnedEntry[]; dismissed: number[];
  similar?: { takenAt: string; artists: { id: number; name: string }[] };
  lastResult?: RunResultSummary }
export interface RunResultSummary { at: string; status: "ok" | "partial" | "failed" | "paused";
  added: number; removed: number; dismissed: number; notes: string[]; error?: string }
export function emptyJobState(): JobState
export function parseJobState(raw: unknown): JobState   // unknown/invalid -> throws
```
`FilterTerms` is whatever `compileTrackFilter` takes; reuse that type, don't define a new one.

Validation bounds:
- `days` 1-3650; `count` 1-50; `perArtist` 1-20; `refreshDays` 1-365.
- `date` passes `isIsoDate`; `at` matches `^([01]\d|2[0-3]):[0-5]\d$`; `weekday` 0-6.
- `include` is non-empty and every entry is in `RELEASE_TYPES`.
- A `list` source has 1-500 artists.
- Shape limits are positive integers.
- `name` is 1-200 chars after trimming.

- [ ] **Step 1: Failing tests:**
  - `fills schedule defaults`
  - `rejects a bad window/at/weekday with a readable message` (several cases)
  - `parseJobsFile keeps valid jobs and reports invalid ones by index`
  - `parseJobsFile rejects version 2`
  - `duplicate ids are invalid after the first`
  - `parseJobState round-trips emptyJobState()`
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(jobs): job definitions, state and validation`.

### Task 3: Schedule

**Files:** Create `src/jobs/schedule.ts`, `src/jobs/schedule.test.ts`

**Interfaces (produces):**
```ts
export function nextRunAt(schedule: Schedule, after: Date): Date   // first slot strictly after `after`, local time
export const BACKOFF_MS: readonly number[]  // [15 min, 1 h, 6 h]; later failures use the last
export function retryAt(schedule: Schedule, now: Date, consecutiveFailures: number): Date
  // min(now + backoff(failures), nextRunAt(schedule, now)); failures >= 1
```
- Hourly slots are on the hour.
- Tests set `process.env.TZ = "Europe/London"` in `beforeAll` and restore it in `afterAll`.

- [ ] **Step 1: Failing tests:**
  - hourly: 10:15 → 11:00; 11:00 → 12:00
  - daily 06:00: 05:59 → today 06:00; 06:00 → tomorrow 06:00
  - weekly Mon 06:00 from Wed → next Mon
  - `a daily job asleep for 10 days runs once`: `nextRunAt(daily, wake)` is the next slot after wake, not a past one
  - DST: daily 01:30 on 2026-03-29 (gap) → `2026-03-29T01:30:00Z`, i.e. 02:30 BST; daily 06:00 across 2026-10-25 lands at 06:00 local both days
  - `retryAt` gives 15 min, then 1 h, then 6 h, and never a time after the next regular slot
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): schedule slots and failure backoff`.

### Task 4: Reconcile and move planning (pure)

**Files:** Create `src/jobs/reconcile.ts`, `src/jobs/reconcile.test.ts`

**Interfaces (produces):**
```ts
export interface DesiredTrack { trackId: number; source: string; durationSeconds?: number }
export interface PresentEntry { playlistTrackId: number; trackId: number }
export interface ReconcileInput { mode: "respect" | "mirror"; desired: readonly DesiredTrack[];
  complete: boolean; present: readonly PresentEntry[]; owned: readonly OwnedEntry[]; dismissed: readonly number[] }
export interface ReconcilePlan {
  add: number[];              // track ids, desired order, unique
  remove: number[];           // playlist-track ids
  keptOwned: OwnedEntry[];    // owned entries still present and not removed
  dismissed: number[];        // full new dismissed list (respect); [] in mirror
  newlyDismissed: number[];
  withheldRemovals: number;   // removals skipped because !complete
}
export function reconcile(input: ReconcileInput): ReconcilePlan
export interface Move { playlistTrackIds: number[]; insertBefore: number }  // 1-based, against the list as it is then
export function planMoves(entries: readonly { playlistTrackId: number; rank?: number }[]): Move[]
```

Rules (spec section 4):
- An owned entry that is missing from `present` is dismissed (respect mode).
- A desired track counts as present if any present entry has its track id.
- Mirror mode removes every present entry whose track isn't desired, plus repeat entries of a desired track beyond the first.
- When `!complete`, `remove` is `[]` and `withheldRemovals` holds the count.

`planMoves`:
- Entries without `rank` (hand-added) are never moved and ignored when comparing order.
- Keep a longest increasing subsequence of the ranked entries in place.
- Move the others one at a time, in ascending rank. Each goes in front of the first entry, in the simulated current list, whose rank is higher than its own (hand-added entries skipped).
- If no such entry exists, it goes in front of the entry right after the last entry ranked below it. If that is past the end, the entry is left in place: the API's past-the-end behaviour is unverified.
- Simulate every move so each `insertBefore` is computed against the list as it then stands.

- [ ] **Step 1: Failing tests** (one per cell of the spec table, plus):
  - `respect: hand-removed owned entry is dismissed and not re-added`
  - `respect: hand-added entries are never removed`
  - `respect: aged-out owned entries are removed`
  - `mirror: hand-added entries are removed`
  - `mirror: dismissed list is emptied`
  - `incomplete: nothing removed, withheld count reported`
  - `all owned entries removed by hand: all dismissed, nothing added` (Review Focus 1)
  - `duplicate copies are told apart by playlist-track id`
  - planMoves: `new entries appended at the end move to the top when newest`; `already ordered: no moves`; `hand-added entries stay where they are`; plus a property-style test applying the moves to an array: the ranked entries end in rank order whenever every moved entry had an anchor
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): reconcile a managed playlist against its recipe`.

### Task 5: Job stores and run log

**Files:**
- Create: `src/cli/config-dir.ts`, `src/cli/job-store.ts`, `src/cli/job-store.test.ts`
- Test: `src/cli/job-store.test.ts` (covers all three stores)

**Interfaces (produces):**
```ts
// config-dir.ts
export function configDir(env?: NodeJS.ProcessEnv): string   // $XDG_CONFIG_HOME/qobuz-helper
// job-store.ts
export interface JobStore { load(): { file: JobsFile; invalid: InvalidJob[] }; save(file: JobsFile): void }
  // missing file -> empty; unparsable -> throws JobsFileError (load) and save() refuses to overwrite it
export class JobsFileError extends Error {}
export interface JobStateStore { load(id: string): JobState; save(id: string, state: JobState): void; remove(id: string): void }
  // missing or invalid state -> emptyJobState()
export interface RunRecord { at: string; jobId: string; jobName: string; result: RunResultSummary; durationMs: number }
export interface RunLog { append(record: RunRecord, now?: Date): void; read(jobId?: string, limit?: number): RunRecord[] /* newest first */ }
export interface GlobalFlags { needsSignIn?: { since: string; message: string }; bundleBroken?: { since: string; message: string } }
export interface GlobalStore { load(): GlobalFlags; save(flags: GlobalFlags): void }
export function fileJobStore(dir?: string): JobStore            // jobs.json
export function fileJobStateStore(dir?: string): JobStateStore  // jobs-state/<id>.json
export function fileRunLog(dir?: string): RunLog                // jobs-runs.jsonl, compacted to 500 lines / 90 days on append
export function fileGlobalStore(dir?: string): GlobalStore      // jobs-global.json
export const RUN_LOG_LIMITS = { lines: 500, days: 90 } as const
```

- [ ] **Step 1: Failing tests** (temp dir):
  - `round-trips jobs.json with mode 0600`
  - `missing jobs.json loads empty`
  - `unparsable jobs.json throws and save refuses to overwrite it` (Review Focus 3)
  - `job state round-trips and missing loads empty`
  - `run log keeps the last 500 and drops records older than 90 days`
  - `run log skips unreadable lines`
  - `run log read filters by job, newest first`
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): file stores for jobs, state and the run log`.

### Task 6: Generalise new releases and the feed recipe

**Files:**
- Modify: `src/features/new-releases.ts`, `src/features/new-releases.test.ts`
- Create: `src/jobs/recipes/new-releases.ts`, `src/jobs/recipes/new-releases.test.ts`

**Interfaces:**
- Modifies `findNewReleases` options (backwards compatible):
  ```ts
  window?: ReleaseWindow             // overrides `since` when given
  hideFavourites?: boolean           // default true (the tool's current behaviour)
  // ArtistSource gains { type: "artists"; artists: Artist[] }
  ```
- `latest-per-artist`: an artist's own releases of included kinds, filtered and with reissues dropped, newest first, up to `count`. A release counts as a reissue if it has a reissue label, or if the artist has an *older* own release with the same `releaseKey`. `NewReleasesPlan.since` is then the oldest kept date, or `until` when nothing was kept.
- Produces:
  ```ts
  export interface RecipeContext<S> { now: Date; jobId: string; state: S }
  export interface RecipeResult { tracks: DesiredTrack[]; complete: boolean; notes: string[];
    similar?: JobState["similar"] }
  export type FeedClient = NewReleasesClient & AlbumTracksClient & Pick<SimilarArtistsClient, "getSimilarArtists">
  export async function resolveNewReleasesFeed(client: FeedClient, def: NewReleasesRecipeDef,
    shape: Shape | undefined, ctx: RecipeContext<Pick<JobState, "similar">>): Promise<RecipeResult>
  ```
- Behaviour:
  - Seeds: `list` artists as stored; `favourites` / `playlist` read live (via `findNewReleases`'s own source handling).
  - Similar snapshot: when `def.similar` is set and the snapshot is missing or older than `refreshDays`, `walkSimilarArtists(client, { seeds, similarPerArtist: perArtist, depth: 1, filter })` replaces it (`takenAt = now`). If the walk throws, the old snapshot is kept, a note is added and `complete = false`.
  - The checked artists are the seeds plus the snapshot, as `{ type: "artists" }`.
  - `failedArtists.length > 0` makes the result incomplete.
  - `maxReleases` keeps the newest N.
  - Tracks come from `fetchAlbumTracks` in release order (album track order inside each); excluded tracks are dropped, track ids de-duplicated, `source = "album:<id>"`, and `durationSeconds` comes from the track.
  - A failed album makes the result incomplete.
  - Then `maxTracks`, then `maxMinutes` via `fitToLength([tracks], maxMinutes * 60, t => t.durationSeconds)`.

- [ ] **Step 1: Failing tests:**
  - new-releases: `last-days window equals since N days before now`; `latest-per-artist keeps each artist's newest N and skips reissues of older titles`; `hideFavourites false keeps favourited releases`; `artists source checks exactly the given artists`
  - recipe: `artists with nothing in the window add nothing`; `similar snapshot is taken on first run and reused within refreshDays`; `snapshot is refreshed after refreshDays`; `a failed similar walk keeps the old snapshot and marks incomplete`; `failed artist marks incomplete`; `maxReleases keeps newest`; `maxMinutes trims from the end`; `same inputs and state give the same tracks`
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(new-releases): windows, artist lists and a managed-feed recipe`.

### Task 7: Refresh one managed playlist

**Files:**
- Create: `src/jobs/refresh.ts`, `src/jobs/refresh.test.ts`
- Modify: `src/features/history.ts` (`TOOL_NAMES.managed = "Managed playlist"`)

**Interfaces (produces):**
```ts
export type RefreshClient = FeedClient & { getPlaylist(id: number): Promise<Playlist>;
  getPlaylistTracks(id: number): Promise<Track[]>; createPlaylist(...): Promise<Playlist>;
  addTracksToPlaylist(...): Promise<void>; removeTracksFromPlaylist(...): Promise<void>;
  movePlaylistTracks(...): Promise<void> }
export interface RefreshPreview { createsPlaylist: boolean; add: { trackId: number; source: string }[];
  remove: PresentEntry[]; newlyDismissed: number[]; withheldRemovals: number; complete: boolean; notes: string[] }
export interface RefreshOutcome { state: JobState; result: RunResultSummary; preview: RefreshPreview }
export async function refreshManagedPlaylist(client: RefreshClient, job: ManagedPlaylistJob,
  state: JobState, options: { now: Date; dryRun?: boolean }): Promise<RefreshOutcome>
export function isNotFound(error: unknown): boolean   // QobuzError api-response with "HTTP 404"
```
Steps in order:
1. If `state.paused`, return status `paused` without doing anything.
2. If `state.playlistId` is set, call `getPlaylist`; if that fails with `isNotFound`, set `paused = { reason: "playlist-deleted" }`, status `paused`, and return.
3. Resolve the recipe.
4. Read the present entries (none when no playlist yet).
5. `reconcile`.
6. Dry run: return the preview with an unchanged state.
7. Otherwise:
   - Create the playlist if needed (`description: "Managed by qobuz-helper"`), store its `playlistId`.
   - Remove, then add.
   - Re-read the playlist; the new owned entries are the entries whose playlist-track id wasn't present before and whose track id was in `add`.
   - Apply `planMoves`, ranking owned entries by desired index; a move failure adds a note and doesn't fail the run.
8. Return the state with `owned`, `dismissed`, `similar`, `lastRunAt` and `lastResult` updated. Status is `partial` when the recipe was incomplete.

The function makes no journal calls itself; the caller wraps it.

- [ ] **Step 1: Failing tests** on `FakeAccount`, extended with `getArtistReleases`, `getAlbumTracks`, `getFavoriteAlbums`, `getFavoriteArtists`, `getSimilarArtists` stubs via a small wrapper in the test:
  - `first run creates the playlist with the feed, newest release first`
  - `second run with nothing new changes nothing`
  - `a new release lands at the top`
  - `hand-removed track is dismissed and stays out` (Review Focus 1: remove all)
  - `hand-added track survives in respect mode and goes in mirror mode`
  - `release ageing out of last-days is removed`
  - `an artist failing withholds removals`
  - `deleted playlist pauses without creating one` (Review Focus 2)
  - `dry run writes nothing`
  - `undoing a refresh through the journal dismisses its additions`: run through `recordingClient` + `Journal.run`, then `planUndo` / `applyUndo`, then refresh again
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): refresh a managed playlist`.

### Task 8: runDue

**Files:** Create `src/jobs/run-due.ts`, `src/jobs/run-due.test.ts`

**Interfaces (produces):**
```ts
export type Connect = () => Promise<{ ok: true; client: RefreshClient }
  | { ok: false; reason: "needs-sign-in" | "bundle-broken"; message: string }>
export interface RunDueDeps { jobs: JobStore; state: JobStateStore; runs: RunLog; global: GlobalStore;
  lockPath: string; lockOptions?: LockOptions; connect: Connect;
  journalRun: <T>(label: string, fn: () => Promise<T>) => Promise<T> }
export interface JobRunReport { jobId: string; name: string; result: RunResultSummary }
export interface RunSummary { status: "ran" | "busy" | "nothing-due" | "needs-sign-in" | "bundle-broken" | "jobs-file-error";
  reports: JobRunReport[]; invalid: InvalidJob[]; message?: string }
export async function runDue(deps: RunDueDeps, now: Date,
  options?: { dryRun?: boolean; onlyJobId?: string /* run this one now, due or not */ }): Promise<RunSummary>
```
Behaviour:
- Take the lock; if busy, return `busy`.
- Load the jobs; a `JobsFileError` returns `jobs-file-error`.
- Due jobs: enabled, not paused, `!state.nextRunAt || nextRunAt <= now`, ordered by `nextRunAt` with missing first. With `onlyJobId`, just that job (even if disabled), and its schedule is advanced as usual.
- No due jobs: return `nothing-due` without calling `connect`.
- `connect`:
  - On a failure, save the flag, return the reason, and run no jobs.
  - On success, clear both flags.
- For each job:
  - `journalRun("Managed: " + name, () => refreshManagedPlaylist(...))`.
  - Success: `consecutiveFailures = 0`, `nextRunAt = nextRunAt(schedule, now)`.
  - Thrown `QobuzError` of kind `authentication`: set `needsSignIn` and stop the remaining jobs.
  - Any other throw: `consecutiveFailures++`, `nextRunAt = retryAt(...)`, status `failed` with `error`.
  - Either way, save the state and append the run record.
  - Dry run saves and appends nothing.
- Release the lock in `finally`.

- [ ] **Step 1: Failing tests** (in-memory stores, fake connect):
  - `nothing due: does not connect`
  - `busy lock: returns busy` (Review Focus 4)
  - `runs due jobs in nextRunAt order and schedules the next slot`
  - `failure backs off and counts`
  - `success resets failures`
  - `authentication error sets needsSignIn and stops`
  - `connect failure sets the flag and runs nothing`
  - `deleted playlist pauses one job while others still run` (Review Focus 2)
  - `invalid jobs are reported and valid ones run` (Review Focus 3)
  - `onlyJobId runs a job that is not due`
  - `dry run saves nothing`
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): run the jobs that are due`.

### Task 9: Jobs service (create / edit / pause / remove / preview)

**Files:** Create `src/jobs/service.ts`, `src/jobs/service.test.ts`

**Interfaces (produces), used by both the CLI and the router:**
```ts
export interface JobView { job: Job; state: JobState; recentRuns: RunRecord[] }
export interface JobsService {
  list(): { jobs: JobView[]; invalid: InvalidJob[]; flags: GlobalFlags };
  get(id: string): JobView | undefined;
  create(input: unknown, now: Date): Job;                 // validateJob over input + new id/createdAt
  update(id: string, input: unknown): Job;                // id/createdAt kept; recipe/edits/schedule replaced
  setEnabled(id: string, enabled: boolean): Job;
  resume(id: string): JobState;                           // clears paused + playlistId (next run creates a new playlist)
  remove(id: string): { job: Job; playlistId?: number };  // deletes definition + state; caller may delete the playlist
}
export function jobsService(deps: { jobs: JobStore; state: JobStateStore; runs: RunLog; global: GlobalStore;
  newId?: () => string }): JobsService
```
- Updating the window or artists keeps `owned` and `dismissed`, so the next refresh reconciles.
- Changing `edits` to `mirror` clears `dismissed`.

- [ ] **Step 1: Failing tests:**
  - create validates and assigns an id
  - update keeps state
  - setEnabled
  - resume clears `paused` and `playlistId`
  - remove deletes state
  - unknown id throws `No job <id>`
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(jobs): a service to manage job definitions`.

### Task 10: CLI: `jobs`, `run-due`, `serve`, `schedule print`, `login --print-url`

**Files:**
- Modify: `src/cli/args.ts`, `src/cli/args.test.ts`, `src/cli.ts`, `src/cli/oauth-login.ts`
- Create: `src/jobs/schedule-print.ts`, `src/jobs/schedule-print.test.ts`

**Interfaces (produces):**
```ts
// args.ts
export type JobsArgs =
  | { action: "list" } | { action: "show" | "pause" | "resume" | "run"; id: string; dryRun: boolean }
  | { action: "remove"; id: string; deletePlaylist: boolean }
  | { action: "create"; kind: "new-releases"; apply: boolean; name: string; artists: string[];
      source: "list" | "favourites" | "playlist"; playlist?: string; similar?: number;
      window: ReleaseWindow; include: ReleaseType[]; edits: "respect" | "mirror";
      schedule: Schedule; shape: Shape; isPublic: boolean; hideFavourites: boolean; exclude: string[] }
export function parseJobsArgs(argv: readonly string[]): JobsArgs
export function parseWindow(raw: string): ReleaseWindow     // "last-days:30" | "since:2026-01-01" | "latest:3"
export function parseRunDueArgs(argv: readonly string[]): { dryRun: boolean }
export function parseServeArgs(argv: readonly string[]): { open: boolean; port?: number }
export function parseScheduleArgs(argv: readonly string[]): { target: "cron" | "systemd" | "launchd" | "windows" }
export function parseLoginArgs(argv: readonly string[]): { printUrl: boolean }
// schedule-print.ts
export function scheduleSnippet(target: "cron" | "systemd" | "launchd" | "windows",
  paths: { node: string; script: string; logFile: string }): string   // every 15 minutes, runs `run-due`
// oauth-login.ts (glue)
export async function authenticateByPaste(client: QobuzClient, io: { print(s: string): void; readLine(): Promise<string> }): Promise<UserSession>
```
`create` flags:
- `--artists "A, B"` (repeatable; links allowed), or `--favourites`, or `--playlist <id|link>`.
- `--similar N`, `--window`, `--include album,ep-single`, `--edits`.
- `--every hour|day|week`, `--at HH:MM`, `--weekday mon..sun`.
- `--max-releases`, `--max-tracks`, `--fit MIN`, `--public`, `--hide-favourites`, `--exclude`.
- `--name` (required), `--apply`.

The defaults come from the spec.

Glue in `cli.ts`:
- `jobs create`: resolves the artists with `lookUpArtist`, then previews with `refreshManagedPlaylist(..., { dryRun: true })` on a temporary job and empty state, then saves via the service only with `--apply`.
- `jobs run <id>` calls `runDue(..., { onlyJobId, dryRun })`.
- `run-due` and `serve` connect through `initClientWithCache` and `restoreOrLogin` with a `browserLogin` that throws `QobuzError("authentication", "Not signed in; run qobuz-helper login")`. A bundle failure clears the credential cache, retries once, and otherwise returns `bundle-broken`.
- `login --print-url` uses `authenticateByPaste`: print `buildOAuthUrl(appId, "http://localhost:53682/")`, ask for the address the browser ended on, then `parseRedirectCode` and `loginWithOAuthCode`.
- `serve` = `runUi` plus `setInterval(tick, 60_000)` and an immediate tick, guarded by an in-flight flag and logged; `--no-open` skips opening the browser.
- `printUsage` lists the new commands.

- [ ] **Step 1: Failing tests:**
  - `parseJobsArgs` for each action
  - create defaults (`window` last-days:30, `include` album+ep-single, `edits` respect, `every` day at 06:00)
  - `parseWindow` errors
  - `--name` required
  - `--favourites` and `--artists` together rejected
  - `scheduleSnippet` contains the node path, script, `run-due`, and a 15-minute cadence for each target
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Smoke-check: `npm run dev -- jobs list` (empty) and `npm run dev -- schedule print --systemd`.
- [ ] **Step 6:** Commit `feat(cli): jobs, run-due, serve and schedule commands`.

### Task 11: Server routes

**Files:** Modify `src/server/router.ts`, `src/server/router.test.ts`, `src/cli.ts` (`runUi` / `serve` pass `jobs`)

**Interfaces:**
- Consumes: `JobsService`, `refreshManagedPlaylist`, `runDue`.
- Produces: `ApiDeps.jobs?: { service: JobsService; runNow(id: string, dryRun: boolean): Promise<RunSummary>; preview(input: unknown): Promise<RefreshPreview> }`. Without it, the job routes answer 404.

Routes:

| Route | Does |
|---|---|
| `GET /api/jobs` | `service.list()` |
| `POST /api/jobs` | create; 400 on validation error |
| `PUT /api/jobs/:id` | update |
| `DELETE /api/jobs/:id` | body `{ deletePlaylist?: boolean }` |
| `POST /api/jobs/:id/enabled` | `{ enabled }` |
| `POST /api/jobs/:id/resume` | resume |
| `POST /api/jobs/:id/run` | `{ dryRun? }`; 409 when the summary is `busy` |
| `POST /api/jobs/preview` | `{ job }`: dry-run a not-yet-saved definition |
| `GET /api/jobs/:id/runs` | the job's run records |

- Deleting the playlist runs inside `journal.run({ tool: "managed" })`. `runNow` already journals through `runDue`.
- The `:id` path parameter is matched by `^/api/jobs/([0-9a-f]{8})(/.*)?$`.

- [ ] **Step 1: Failing tests:** each route's happy path; 400 on invalid input; 404 for an unknown id and when `jobs` is absent; 409 on busy; delete with `deletePlaylist` calls `deletePlaylist` inside a journal entry.
- [ ] **Steps 2-4:** fail, implement, pass.
- [ ] **Step 5:** Commit `feat(server): job routes`.

### Task 12: Web Managed view and "Keep this updated"

**Files:**
- Create: `src/web/views/managed.ts`
- Modify: `src/web/main.ts` (`VIEWS` adds `"managed"` before `"history"`), `src/web/index.html` (`<section id="view-managed">` + nav link), `src/web/views/new-releases.ts`, `src/web/views/similar.ts`, `src/web/views/home.ts` (tile)

Behaviour:
- **The list** shows per job:
  - name and kind
  - schedule text ("Daily at 06:00")
  - last run (status, +added / −removed / dismissed) and next run
  - pause reason
  - failures
- **Per-job buttons:** Run now, Preview, Pause/Resume, Delete (with a "also delete the playlist" checkbox), and Runs (expands the run log).
- **Banner** for `needsSignIn` / `bundleBroken`.
- **Create/edit form** fields:
  - name
  - artists (textarea, one per line) / favourites / playlist
  - similar per artist
  - window type + value
  - release kinds
  - edit mode (respect / mirror, with a one-line explanation each)
  - schedule (every/at/weekday)
  - caps
  - public
- **Form buttons:** "Preview" (calls `/api/jobs/preview`, shows adds) and "Save".
- **"Keep this updated…"** on New releases (after a find) opens the Managed form prefilled from the current source/window/include/exclude.
- **"Keep this updated…"** on Similar opens it prefilled with the seeds as `list` artists and `similar.perArtist` from the form.
- Use the existing Console styles and components. There are no unit tests (glue); check with `npm run build`, then load the UI and exercise create → preview → save → run now on a scratch job.

- [ ] **Step 1:** Implement the view and the entry points.
- [ ] **Step 2:** Run `npm run typecheck && npm run build`; expect success.
- [ ] **Step 3:** Start the headless server and check `/api/jobs` with the nonce: 200 and an empty list.
- [ ] **Step 4:** Commit `feat(web): managed playlists view`.

### Task 13: ADR-0007, README, CHANGELOG, final verification

**Files:** Create `docs/adr/0007-background-jobs-and-managed-playlists.md`. Modify `README.md`, `CHANGELOG.md`, and the spec (refinements 1-2 above).

- [ ] **Step 1:** Write the ADR: context, the hybrid runtime decision, catch-up, lock, reconcile safety, `playlistId` in state, consequences.
- [ ] **Step 2:** README:
  - Managed playlists: what they do, edit modes, windows.
  - Commands: `jobs`, `run-due`, `serve`, `schedule print`, `login --print-url`.
  - Scheduling per OS.
  - Headless use: SSH tunnel `ssh -L 8080:127.0.0.1:<port> box`.
  - Add a Tools bullet.
- [ ] **Step 3:** CHANGELOG `[Unreleased]` Added entries; Fixed: "history compaction could drop a change written at the same moment by another qobuz-helper process; compaction now takes a lock".
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run build`; expect everything to pass.
- [ ] **Step 5:** Commit `docs: managed playlists and background jobs`.
