# ADR-0014: The app is called crosstune

- Status: accepted
- Date: 2026-11-23

## Context

The app was named `qobuz-helper` when it worked only with Qobuz. With TIDAL and
Spotify connected beside it (ADR-0010 to ADR-0013) the name says the wrong
thing, and the user asked for a new one. The project is meant to run with
`npx`, so the package name must be free on npm. The repository moved to
GitHub (`areksh/crosstune`) at the same time.

## Decision

- The app, its npm package, its command and its repository are **crosstune**
  ("tunes, across services"). `segue` and `crossfade` were considered and are
  taken on npm.
- **No compatibility with the old name** (the user's choice): there is no
  `qobuz-helper` command, the config folder is `$XDG_CONFIG_HOME/crosstune`
  only, and the page's settings are under `crosstune:` keys only. The one
  existing install had its folder moved by hand when the name changed.
- Internal names change with it (the page's nonce header and meta tag, the
  storage keys, the scheduler snippets, "Managed by crosstune" on new managed
  playlists). Playlists already made keep the description they were given.
- Accepted ADRs, dated plans and specs, and released CHANGELOG entries keep the
  old name: they describe what was true then.

## Consequences

- An install that still has `~/.config/qobuz-helper`, or a scheduler running
  `qobuz-helper run-due`, must be moved or changed by hand (the CHANGELOG says
  so).
- `qobuz` remains the name of the Qobuz service throughout (ids, adapters):
  only the app's own name changed.
