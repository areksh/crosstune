# ADR-0002: Web UI architecture

- Status: accepted
- Date: 2026-07-06

## Context

The CLI covers the core tools, but the more valuable interactions are visual:
reviewing which duplicate copy to keep, or previewing and editing the tracks a
playlist-from-artists run would add before committing them. ADR-0001 already
noted the two forces that constrain any UI:

1. There is no official Qobuz API; the tools talk to the private web-player API.
2. That API sends no CORS headers, so a browser cannot call it directly.

Consequence (2) means a browser UI cannot be a static page that talks to Qobuz.
It needs a local backend that owns the Qobuz client and proxies for it. We also
want to preserve ADR-0001's local-first, `npx`-friendly, zero-runtime-dependency
posture.

## Decision

- **Local server plus browser frontend.** `qobuz-helper ui` starts a
  `node:http` server bound to `127.0.0.1`, opens the browser at it, and runs
  until interrupted. The server owns the (already signed-in) Qobuz client and
  exposes a small JSON API; the frontend talks only to that API, never to Qobuz.
- **No server framework.** The server uses `node:http` directly, matching the
  zero-runtime-dependency rule. The routing, validation and security are pure
  functions (`router`, `security`) with the socket handling as a thin,
  separately-kept glue layer, so the logic is unit-tested without a live socket.
- **Session stays server-side.** The frontend never receives a Qobuz token. It
  calls local routes; the server holds the session (restored from the same local
  session file the CLI uses). A browser tab cannot leak the credential.
- **Two-phase feature flow.** Features are split into a *resolve* step (produce
  an editable plan) and a *commit* step, with the review/edit happening in the
  browser between them. The playlist tool resolves artists to tracks, the user
  edits the selection and picks a destination (new or existing playlist), then
  commits.
- **Frontend: vanilla TypeScript bundled with esbuild.** No UI framework. This
  keeps the client framework-less to match the framework-less server and the
  project's minimal-dependency ethos; the two UIs are small enough not to need a
  reactive framework. esbuild is a single build-time dependency that emits a
  tiny static bundle into `dist/web` with no client runtime. A framework can be
  adopted later if the UI grows.

## Security

The server acts on the user's Qobuz account, and any page in the user's browser
can send requests to `127.0.0.1`. Each API request is therefore authorised by
three cheap checks (see `src/server/security.ts`):

- **Host** must be `localhost`/`127.0.0.1` on our port, which defeats DNS
  rebinding (an attacker's hostname would appear in `Host`).
- **Origin**, when present, must be our own origin, rejecting cross-origin calls
  from other pages.
- **Nonce**: a per-run secret injected into the served page. Only our own
  same-origin UI can read it, so requiring it as a header proves the caller is
  that UI. This is the primary guard; the other two are defence in depth.

## Consequences

- The web UI ships as pre-built static assets in `dist/web`; `npm run build`
  compiles the server/CLI with `tsc` and bundles the frontend with esbuild.
  Running the UI requires a build first (`npm run ui` does both).
- The frontend TypeScript is type-checked against the DOM lib via a separate
  `tsconfig.web.json`; the DOM/socket glue (frontend, `http.ts`) is not
  unit-tested, consistent with how the OAuth glue is treated.
- The resolve/commit split is reusable: the CLI's one-shot builder now composes
  the same steps, and a future `--preview` CLI mode could reuse them too.
- Local-first is preserved: nothing is sent anywhere but Qobuz, and the server
  is only reachable from the local machine.
