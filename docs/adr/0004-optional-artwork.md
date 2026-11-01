# ADR-0004: Optional album artwork

- Status: accepted
- Date: 2026-11-01

## Context

Review screens list many tracks and albums, and a cover is the fastest way to
tell two releases (or two copies of a song) apart. Qobuz's API responses already
carry cover URLs: each album has an `image` object with `small` (about 230px),
`thumbnail` and `large` URLs on Qobuz's public image server
(`static.qobuz.com`). Tracks carry their album's image when they embed the
album; `album/get` tracks do not, so they take the parent album's.

ADR-0002 says the browser never talks to Qobuz: the page talks only to the local
server, which owns the session. That rule exists for two reasons: the Qobuz API
sends no CORS headers, and the session token must never reach the page. Cover
images touch neither: an `<img>` needs no CORS, and the image server is public,
unsigned and needs no token. But loading them still makes the browser contact a
third party, which tells Qobuz's CDN (and anything on the path) that this
machine is looking at these albums. A local-first tool should not do that
without being asked.

## Decision

- **Artwork is an opt-in exception to ADR-0002.** The page may load cover
  images directly from Qobuz's image server, and nothing else from Qobuz. No API
  call is made from the browser and no token or app id is involved.
- **Off by default.** A "Show artwork" checkbox in the sidebar turns it on; the
  choice is remembered in the browser's `localStorage` (every access wrapped so
  a blocked store just means "off").
- **No request while off.** Covers are rendered as `<img>` elements carrying
  the URL in `data-src` and no `src`, inside a neutral placeholder square, so
  the page layout is the same either way. Turning the setting on copies
  `data-src` into `src` (images load lazily, with `referrerpolicy="no-referrer"`
  so the local URL is not sent); turning it off hides them.
- **Only https URLs.** The model parsers keep a cover URL only if it is https,
  preferring `small` over `thumbnail` and `large`. The page checks again before
  using one.

## Alternatives considered

- **Proxy covers through the local server** (`/api/cover?url=...`). This keeps
  the browser talking only to the local server, but the server would still
  fetch from the same CDN, so the privacy gain is small (the referrer and the
  browser's fingerprint stay local; the album lookups do not). It also costs
  real work: an allow-list of image hosts to avoid an open proxy, streaming
  binary responses through glue that is deliberately thin and untested, and
  caching. Rejected for now; it can be revisited if a stricter "nothing leaves
  the machine except via the server" mode is wanted.
- **Always show covers.** Simplest, but makes the browser contact a third party
  on every review without asking, against the local-first posture.

## Consequences

- `Track.image` and `Album.image` are parsed from the API and passed through the
  router unchanged; exports do not include them.
- Each place that shows a cover renders a placeholder slot whether artwork is on
  or off, so turning it on or off does not shift the layout.
- ADR-0002's "the browser never talks to Qobuz" now reads "... except, when the
  user turns artwork on, to load cover images from Qobuz's public image
  server".
