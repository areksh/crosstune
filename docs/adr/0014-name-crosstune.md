# ADR-0014: The app is called crosstune

- Status: accepted
- Date: 2026-11-23

## Context

The app was named `qobuz-helper` when it worked only with Qobuz. With TIDAL and
Spotify connected beside it (ADR-0010 to ADR-0013) the name says the wrong
thing, and the user asked for a new one. Users already have a config folder,
browser settings and possibly an OS scheduler entry under the old name, and the
project is meant to run with `npx`, so the package name must be free on npm.

## Decision

- The app, its npm package and its command are **crosstune** ("tunes, across
  services"). `segue` and `crossfade` were considered and are taken on npm.
- **Nothing a user has is lost or broken**:
  - the command `qobuz-helper` stays as a second `bin` entry, so a scheduler
    that runs `qobuz-helper run-due` keeps working;
  - on start the CLI moves `$XDG_CONFIG_HOME/qobuz-helper` to
    `$XDG_CONFIG_HOME/crosstune` (sign-ins, jobs, links, matches, History) --
    one atomic rename, and only while the new folder does not exist, so nothing
    is overwritten (`src/cli/config-dir.ts`);
  - the page copies its `localStorage` settings from the `qobuz-helper:` keys
    to `crosstune:` once (`src/web/old-settings.ts`).
- Internal names change with it (the page's nonce header and meta tag, the
  storage keys, the scheduler snippets, "Managed by crosstune" on new managed
  playlists). Playlists already made keep the description they were given.
- Accepted ADRs, dated plans and specs, and released CHANGELOG entries keep the
  old name: they describe what was true then. The repository folder and any
  remote are the user's to rename.

## Consequences

- One release later the `qobuz-helper` command could be dropped; it costs
  nothing to keep, so it stays until there is a reason.
- `qobuz` remains the name of the Qobuz service throughout (ids, adapters):
  only the app's own name changed.
