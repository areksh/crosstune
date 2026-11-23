# ADR-0015: A playlist's header is tinted by its real cover, read in the page

- Status: accepted
- Date: 2026-11-23

## Context

The redesigned web UI ("Cover glow", docs/superpowers/specs/2026-11-23-ui-redesign-design.md)
tints a playlist's header with its cover's colours. Until now those colours
come from a cover drawn from the playlist's name, which is all there is while
artwork is off (ADR-0004). With artwork on, the real cover is on the page, and
the tint should follow it.

A page can read an image's pixels (a canvas) only if the image allows it:
served from the page's own origin, or with CORS. The spec assumed neither held
and proposed routing covers through the local server, the alternative
ADR-0004 had rejected. Probed on 2026-11-23, all three image servers answer an
image request carrying an `Origin` with `Access-Control-Allow-Origin: *`:
`static.qobuz.com`, `resources.tidal.com` and `i.scdn.co`.

## Decision

- **The header cover is read in the page, through CORS.** Only the one cover
  in a playlist's header (and the bar over a tool on it) is loaded with
  `crossOrigin = "anonymous"` (still `referrerpolicy="no-referrer"`), drawn to
  an 8x8 canvas, and averaged; the tint is made from that colour
  (`coverFromColour` in `src/ui/cover-art.ts`, tested).
- **Only while artwork is on.** With it off nothing changes: no request, and the
  tint comes from the name, as before.
- **Any failure falls back to the name's colours**, silently: a cover that does
  not load, a server that stops sending CORS, a canvas that cannot be read.
- No proxy, and no server change.

## Alternatives considered

- **A local cover proxy** (`/api/cover?url=...`, ADR-0004's alternative). It
  makes every cover same-origin, but means an allow-list of image hosts,
  binary responses through glue kept thin and untested, and caching -- and the
  server would still fetch from the same image servers. Not needed while the
  servers send CORS; it remains the way back if they stop and the tint matters.
- **No tint from real covers.** The header would keep the name's colours even
  under a real cover, which looks unrelated to it.

## Consequences

- The header cover's request carries `Origin: http://127.0.0.1:<port>`: the
  image server learns the request comes from a page on this machine (it already
  learns which album, which is what turning artwork on accepts). Other covers
  are requested as before.
- ADR-0004's "the browser loads cover images from the services' public image
  servers, only when artwork is on" still holds, with this one request in CORS
  mode.
- If an image server drops CORS, the tint quietly returns to the name's colours;
  nothing breaks.
