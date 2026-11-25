# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project: crosstune

Local-first tools for music on Qobuz, TIDAL and Spotify (playlist builders,
deduplicator, upgrade and repair, import/export/backup, a playlist manager,
managed playlists, copying between services and two-way linked playlists),
exposed through a CLI and a local web UI. TypeScript, Node >=18, ESM. It was
called `qobuz-helper` until ADR-0014; nothing of that name is kept in the code or user docs (the CHANGELOG history and the immutable ADRs keep it). The README is the user-facing manual; the
architectural reasoning is in `docs/adr/` (read 0001-0003 before structural
work, and 0010-0013 before touching services, accounts, matching or sync).

## Commands

```sh
npm test                                   # vitest run (whole suite)
npx vitest run src/features/deduplicate.test.ts   # one file
npx vitest run -t "exact case-insensitive"  # tests whose name matches
npx vitest run --coverage                  # v8 branch coverage (diagnostic only)
npm run typecheck   # two passes: tsconfig.json (server/CLI) and tsconfig.web.json (DOM)
npm run build       # tsc -> dist/, then scripts/build-web.mjs (esbuild) -> dist/web/
npm run dev -- <command> [args]            # run the CLI via tsx, e.g. `npm run dev -- accounts`
npm run ui          # build, then serve the web UI (the UI needs a build; dev does not)
```

To start, drive or screenshot the running UI, call its API, or try an adapter
against the live services, use the `run-crosstune` skill
(`.claude/skills/run-crosstune/`): a headless-Chromium driver and a live-API
harness, with verified commands.

There is no linter or formatter configured. Run both `npm test` and
`npm run typecheck` before calling work done -- vitest does not type-check, and
`src/web` is only checked by the second tsconfig.

## Hard constraints

- **No official Qobuz API.** `app_id`/secrets are scraped from the web player's
  `bundle.js` (`src/services/qobuz/bundle.ts`, regex-fragile by nature) and
  requests are signed (`src/services/qobuz/signing.ts`). Breakage after a Qobuz
  bundle change is expected maintenance, not a design flaw.
- **TIDAL and Spotify through their official APIs**, each with an app the user
  registers (its client id is entered on the Accounts page; Spotify's owner
  needs Premium). OAuth with PKCE; the sign-in comes back to a loopback
  listener on port 53683 (`src/cli/sign-in-listener.ts`) or is pasted.
- **The browser never talks to a service**: the local server owns every client
  and sign-in, and no token is ever sent to the page.
- **Zero runtime dependencies** (for `npx` portability): `node:http`,
  `node:crypto`, built-in `fetch`. No server or UI framework. esbuild/vitest/tsx
  are dev-only. Do not add a runtime dependency without an ADR.
- `NodeNext` modules: relative imports use the `.js` extension. `strict` and
  `noUncheckedIndexedAccess` are on.

## Architecture

Layers, dependencies pointing downwards only:

- `src/services/` -- the music services behind one `MusicService` interface
  (`service.ts`, with `capabilities` saying what each can do) and a neutral
  model (`model.ts`). Every id is tagged with its service, `"<service>:<native>"`
  (`ids.ts`; ADR-0010). `hub.ts` holds the connected services (one, or all of
  them merged); `gap-filler.ts` wraps each to take what it lacks from another
  (Spotify's top tracks and similar artists) and to find another service's
  artist or album here. Adapters: `qobuz/` (the scraped-bundle client, batching
  and 400-backoff; import from `qobuz/index.js`), `tidal/` and `spotify/` (each
  a client, model parsers and the service; probed live 2026-11-23, results at
  the top of their `service.ts`). Each has a fake (`fake-*.test-support.ts`)
  and runs the shared contract tests (`contract.test-support.ts`).
- `src/accounts/` -- signing in and out, one account per service (ADR-0011).
- `src/features/` -- the tools themselves, as pure functions. Each declares the
  minimal client interface it needs; services satisfy these structurally, and
  tests stub them with `vi.fn`. Every tool is split into **resolve** (build an
  editable plan, report unmatched input rather than failing) and **commit**
  (write it). The web UI reviews between the two; the CLI either composes both
  or only writes with `--apply`. Matching across services is `match.ts`
  (ISRC, then name; remembered choices; ADR-0012). Resolve fan-out goes through
  `mapWithConcurrency` (`concurrency.ts`), which preserves input order.
- `src/jobs/` -- managed playlists and tidy-ups run on a schedule (ADR-0007).
- `src/sync/` -- linked playlists: a three-way merge per run that writes
  nothing on a conflict (ADR-0013).
- `src/cli/` + `src/cli.ts` -- `args.ts` parses each command's flags (pure,
  tested); `cli.ts` is the dispatcher and glue. Everything kept lives under
  `$XDG_CONFIG_HOME/crosstune/` (`config-dir.ts`): sign-ins, accounts, jobs,
  links, matches, History.
- `src/server/` -- `router.ts` `handleApi` is a pure request -> response
  function (all `/api/*` routes, input validation, service errors mapped to
  4xx/502); route groups for accounts, links, playlists and transfer are in
  their own files. `security.ts` `authorise` checks Host (anti DNS rebinding),
  Origin, and a per-run nonce injected into the served page (header
  `X-Crosstune-Nonce`); `http.ts` is thin socket glue. The page names the
  service it is on in `X-Music-Service` (`all` where a view can show them all).
- `src/ui/` -- DOM-free, tested logic for the web page: the hash routes
  (`routes.ts`: `#/` library, `#/p/<id>[/<tool>]` a playlist and a tool on it,
  `#/favourites|all/<service>[/<tool>]`, `#/new/<tool>`, `#/jobs`; old
  addresses redirected), the tools each source offers and how each fills its
  view (`tools.ts`), whether opening a tool must reload the page
  (`hosting-decision.ts`), covers drawn from a name (`cover-art.ts`), what the
  sidebar shows (`library.ts`), and which service a one-service tool names
  (`working-service.ts`). `src/web/` imports it; logic the page needs goes here
  rather than in the untested glue.
- `src/web/` -- vanilla TypeScript, bundled by esbuild. The frame is a top bar
  (`shell.ts`: service tabs that only filter, + New) over a library sidebar
  (`library.ts`: playlists, ticks and group actions); `main.ts` routes hashes
  onto the `VIEWS` sections. A playlist's page is its header and action row
  (`playlist-page.ts`) over the editor. Tools are *hosted* (`hosting.ts`): a
  tool route shows today's tool view under a context bar, its source picker
  hidden and filled from the route; when the route's service or source differs
  from the page's, the page reloads -- always through `reloadHere`, which asks
  about unsaved previews first. Anything handed to the next page across a
  reload is applied only on the page that stays (`VIEW_SHOWN` in
  `route-state.ts`); views ask `isViewShown(view)`, never compare the hash.
  Each tool has a view module in `views/` and a `<section id="view-...">` in
  `index.html`; `api.ts` is the only thing that calls the server, and takes the
  service per call (a playlist's own).

Logic belongs in the tested pure modules; the glue files (`src/cli.ts`,
`src/web/**`, `src/server/http.ts`, `src/cli/oauth-login.ts`,
`src/cli/sign-in-listener.ts`, `src/cli/open-browser.ts`) are excluded from
coverage in `vitest.config.ts`. Keep them thin.

A new tool typically touches: a feature module and its test; `MusicService`
methods (and each adapter) if it needs new reads or writes; a command in
`cli.ts` with a parser in `args.ts`; routes in `router.ts`; a view, its
`index.html` section and its `VIEWS` entry; the README; and the CHANGELOG. A
new service is an adapter under `src/services/`, a name in `names.ts`, and a
connector in `cli.ts`.

## Conventions

- Tests are co-located `*.test.ts` (Vitest, `describe`/`it`/`expect`), with
  stubbed clients or a fake `fetch` -- no live service calls in the suite.
- Live checks against the real services (with the `run-crosstune` skill) write
  only to scratch playlists named "... (delete me)", deleted afterwards.
- Commits are Conventional Commits with scopes such as `qobuz`, `tidal`,
  `spotify`, `sync`, `cli`, `server`, `web`, or the feature name.
- `CHANGELOG.md` follows Keep a Changelog; add user-facing changes under
  `[Unreleased]`, explaining the symptom and the cause for fixes.
- ADRs are numbered `docs/adr/NNNN-title.md`, immutable once accepted.
- `crosstune.wiki/` is gitignored; it is not currently checked out. The
  repository is `git@github.com:areksh/crosstune.git`.
