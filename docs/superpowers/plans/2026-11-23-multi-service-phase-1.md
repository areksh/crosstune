# Multi-service phase 1 (common layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every id carries its service, behind a service interface and a hub, with Qobuz as the only service and nothing changed for the user.

**Architecture:** `QobuzClient` and its tests stay native and move to `src/services/qobuz/`. `QobuzService` adapts it to `MusicService`, tagging ids. `ServiceHub` routes by tag and is what the CLI, server and jobs hold. Retyping happens in two steps: name every id type while it is still an alias of `number`, then flip the aliases to branded strings and let the compiler find the rest.

**Tech Stack:** TypeScript (NodeNext, strict), Vitest, node built-ins only.

**Spec:** docs/superpowers/specs/2026-11-23-multi-service-design.md (section 5)

**Execution:** native, in order, without waiting for review (the user asked to proceed).

## Global Constraints

- Zero runtime dependencies; relative imports end in `.js`.
- Ids are `"<service>:<native id>"`, split at the first colon; native ids are opaque.
- Native ids appear only inside `src/services/<name>/`, and in the Qobuz-format edges named in Task 6.
- Reading old files never rewrites them. Exports and `--json` output do not change.
- Existing tests may change id literals, imports and fakes only; any other changed expectation is explained in the commit.
- `npm test` and `npm run typecheck` pass at every commit. Conventional Commits.

## Review Focus

1. A Qobuz album id that is all digits (`0060254735156`) keeps its leading zeros and stays a string in exports and `--json`.
2. A history file mixing untagged and tagged records lists and undoes both.
3. A hand-edited or damaged id (`"qobuz:"`, `"nope:1"`, `12.5`, `""`) is rejected with a message, never routed.
4. A jobs.json written by version 2 runs without creating a second managed playlist.
5. A mixed list with ids from a service that is not connected fails before any write.

---

### Task 1: Ids

**Files:** Create `src/services/ids.ts`, `src/services/ids.test.ts`

**Interfaces -- Produces:**
```ts
export const SERVICES = ["qobuz", "tidal", "spotify"] as const;
export type ServiceName = (typeof SERVICES)[number];
export type TrackId; AlbumId; ArtistId; PlaylistId; EntryId; UserId; // aliases of number (AlbumId: string) until Task 4
export function tagId<T extends AnyId>(service: ServiceName, native: string | number): T;
export function parseId(id: string): { service: ServiceName; native: string } | undefined;
export function serviceOf(id: AnyId): ServiceName;       // throws ServiceError on a bad id
export function nativeOf(service: ServiceName, id: AnyId): string; // throws when it is another service's
export function readId<T extends AnyId>(value: unknown): T | undefined; // tagged string, or a legacy positive safe integer -> qobuz
export function readAlbumId(value: unknown): AlbumId | undefined;       // tagged, or a legacy bare string -> qobuz
```

- [ ] Test: `tagId("qobuz", 12) === "qobuz:12"`; `parseId("tidal:a:b")` is `{service:"tidal", native:"a:b"}`; `parseId` of `"qobuz:"`, `"nope:1"`, `"12"`, `""` is undefined; `readId(12) === "qobuz:12"`, `readId("12") === "qobuz:12"`, `readId("tidal:x") === "tidal:x"`; `readId` of `0`, `-1`, `12.5`, `"nope:1"`, `null` is undefined; `readAlbumId("0060254735156") === "qobuz:0060254735156"`; `nativeOf("qobuz", "tidal:1")` throws naming both services.
- [ ] Run, see it fail; implement; run, pass; commit `feat(services): service-tagged ids`.

### Task 2: Model, service interface and the move

**Files:** `git mv src/qobuz src/services/qobuz`; create `src/services/model.ts`, `service.ts`, `errors.ts`, `releases.ts` (the neutral types and `classifyRelease`); modify every import.

**Interfaces -- Produces:** `Track`, `Album`, `Artist`, `Playlist`, `Release`, `ArtistReleases`, `ReleaseType`, `RELEASE_TYPES` from `services/model.js`, using the id types. `ServiceError { service, kind, retryAfterSeconds? }` with kinds `authentication | network | api-response | unsupported | rate-limited | quota` plus Qobuz's own; `QobuzError extends ServiceError` with service `qobuz` and its existing constructor. `interface MusicService` (every method of the router's `QobuzApiService`, plus `name`, `capabilities`, `account()`). `Capabilities` as in the spec, each `{ ok: true } | { ok: false; reason: string }`.

- [ ] Test: `QobuzError` is a `ServiceError` with service `qobuz`; a router test that a `ServiceError` from any service answers 502 with `{ error, kind, service }`.
- [ ] Move, add the types, point features/jobs/server/cli at `services/model.js`; suite and type checks pass; commit `refactor(services): move the Qobuz client behind a neutral model`.

### Task 3: QobuzService, hub and contract tests

**Files:** Create `src/services/qobuz/service.ts` (+test), `src/services/hub.ts` (+test), `src/services/contract.test-support.ts`

**Interfaces -- Produces:** `class QobuzService implements MusicService` (constructor takes a `QobuzClient`); `class ServiceHub` with `service(name): MusicService`, `connected(): ServiceName[]`, `connect(service)`, `disconnect(name)`, and every id-taking method of `MusicService`; `describeServiceContract(name, makeAccount)`.

- [ ] Test (adapter): native 12 comes back as `qobuz:12` in every id field, including `artistId`, `albumId`, `playlistTrackId`, `ownerId` and releases; tagged ids reach the client native; an id of another service throws before any request.
- [ ] Test (hub): two fakes with colliding natives: `getPlaylistTracks("tidal:1")` reads TIDAL's; `removeFavoriteTracks(["qobuz:1","tidal:1"])` calls each with its own; `addTracksToPlaylist("qobuz:9", ["tidal:1"])` is refused before any call; a mixed list with an unconnected service fails before any call.
- [ ] Implement; commit `feat(services): Qobuz adapter, hub and contract tests`.

### Task 4: Tagged ids through features and jobs

**Files:** all of `src/features`, `src/jobs`, `fake-account.test-support.ts`, `world.test-support.ts`

- [ ] Replace id annotations (`number`) with the named types while they are aliases; `Map<number` / `Set<number` likewise; suite and type checks pass; commit `refactor: name every id type`.
- [ ] Flip the aliases to branded strings; fix every compiler error; the fakes return tagged ids; wire the hub into `cli.ts` and `jobs`; wrap the hub with `recordingClient`, and point the method-classifying test at `MusicService`.
- [ ] Commit together with Tasks 5-7 if the type checks cannot pass between them: `feat: service-tagged ids throughout`.

### Task 5: Stored files

**Files:** `src/features/history.ts`, `src/jobs/model.ts`, `src/cli/job-store.ts` and tests

- [ ] Test: fixtures written by today's code (copied from a run before the change) -- a history file with every operation kind, a version 2 jobs.json, a jobs-state file -- read as tagged; a mixed history file lists and undoes both kinds; a version 2 `created` job with state does not create a playlist; reading changes no file.
- [ ] New history lines keep `v: 1` with tagged ids; jobs.json is written as version 3 and reads 1, 2 and 3.

### Task 6: Formats that keep Qobuz's own ids

**Files:** `src/features/import-export.ts`, `src/cli/output.ts` and tests

**Produces:** `legacyJson(value)` in `output.ts`: a tagged Qobuz id becomes a number when it is 1-11 digits without a leading zero, otherwise the bare string; `albumId` is always a string; applies to values and Map keys.

- [ ] Test: CSV, JSON, M3U and backup of a fixture account are byte-identical to before; `--json` of a deduplicate report and a new-releases report likewise, including an all-digit album id; old files import.

### Task 7: Server, CLI and web

**Files:** `src/server/*`, `src/cli/args.ts`, `src/cli.ts`, `src/features/qobuz-links.ts`, `src/web/**`

- [ ] Test: routes accept a tagged id and a bare number; reject the Review Focus 3 values with 400; `parsePlaylistId` accepts a number, a tagged id and a link; CLI `--playlist` likewise.
- [ ] Web: `Number(...)` on ids goes; `#/playlists/12` and `#/playlists/qobuz:12` both open.

### Task 8: Check and document

- [ ] Live, read-only, on the user's account before and after: `stats --json`, `deduplicate --favourites --json`, `export` of one playlist; outputs match apart from account changes. `undo` (dry run) of an earlier entry if there is one.
- [ ] UI check in headless Chromium against a stub server: every view loads without console errors; the playlist editor selects, drags and saves.
- [ ] ADR-0010, README/CHANGELOG (under the hood only); commit.
