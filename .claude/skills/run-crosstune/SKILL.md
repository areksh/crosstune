---
name: run-crosstune
description: Build, run, and drive crosstune (Qobuz/TIDAL/Spotify web UI, local server and CLI). Use when asked to start or serve the web UI, take a screenshot of it, click through a view, check a change in the running app, call its API, try a service adapter against the live Qobuz/TIDAL/Spotify APIs, or run its tests.
---

crosstune is a CLI plus a local web server (`serve`) whose page talks only to that server.
Drive the page with `.claude/skills/run-crosstune/driver.mjs` (headless Chromium over the
DevTools protocol, JSON steps on stdin), the API with `curl`, and a service adapter against the
real APIs with `.claude/skills/run-crosstune/live.mts`. All paths are relative to the repo root.

**The accounts are real.** `serve` uses the sign-ins saved under `~/.config/crosstune/`;
anything written goes to the user's real Qobuz/TIDAL/Spotify. Write only to scratch playlists
named "... (delete me)", and delete them afterwards.

## Prerequisites

- Node 22 (the driver uses its built-in `fetch` and `WebSocket`; `node --version`).
- `chromium-browser` on PATH (it was already installed on this machine).
- `node_modules` present (`npm install`); no runtime dependencies beyond that.
- Signed in to the services (the UI also runs with none):

```bash
npm run dev -- accounts      # Qobuz: <name> / TIDAL: <email> / Spotify: <name>
```

## Build

The page is served from `dist/`, so rebuild after any change under `src/`:

```bash
npm run build                # tsc -> dist/, then esbuild -> dist/web/ ("Built web UI into dist/web")
```

## Run (agent path)

Start the server in the background and wait for it:

```bash
(node dist/cli.js serve --no-open --port 4567 > /tmp/crosstune-serve.log 2>&1 &)
timeout 60 bash -c 'until curl -sf http://127.0.0.1:4567/ >/dev/null; do sleep 1; done'
cat /tmp/crosstune-serve.log      # lists who is signed in to each service
```

Drive the page: pipe a JSON array of steps to the driver. This one pastes a Spotify link and an
artist into the ask box in the top bar and opens the tool it suggests (writes nothing):

```bash
node .claude/skills/run-crosstune/driver.mjs <<'EOF'
[
  {"service": "all"},
  {"nav": "#/"},
  {"waitFor": "!document.getElementById('view-home').hidden"},
  {"eval": "(() => { const box = document.getElementById('ask'); box.focus(); box.value = 'https://open.spotify.com/artist/6liAMWkVf5LH7YR9yfFy1Y\\nMassive Attack'; box.dispatchEvent(new Event('input')); return true; })()"},
  {"eval": "document.getElementById('ask').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); true"},
  {"waitFor": "location.hash === '#/new/artists' && document.getElementById('artists').value.includes('open.spotify.com')"},
  {"shot": "prefilled"}
]
EOF
```

| step | what it does |
|---|---|
| `{"service": "all"}` | choose the service (`all`, `qobuz`, `tidal`, `spotify`), as the sidebar does |
| `{"nav": "#/playlists"}` | open a view (a hash, or a whole URL); a hash alone does not reload the page |
| `{"reload": true}` | load the page again (its modules re-read their settings) |
| `{"waitFor": "<js>"}` | poll until true (500 ms, `"tries"` default 120) - wait for data, not a fixed sleep |
| `{"click": "Text"}` | click the first visible button/link with exactly that text |
| `{"dialog": "Write it"}` | click a button in the open confirmation `<dialog>` |
| `{"eval": "<js>"}` | print the value (awaited, JSON) |
| `{"shot": "name"}` | screenshot to `/tmp/crosstune-shots/name.png` - then look at it |
| `{"sleep": 1000}` | wait |

It prints each step's result and the page's errors; it exits 1 if a `waitFor` timed out, a
click found nothing, or the page threw.

Call the API directly (every route needs the page's nonce and the Origin):

```bash
NONCE=$(curl -s http://127.0.0.1:4567/ | grep -o 'nonce" content="[0-9a-f]*' | cut -d'"' -f3)
curl -s http://127.0.0.1:4567/api/accounts -H "X-Crosstune-Nonce: $NONCE" -H "Origin: http://127.0.0.1:4567"
```

Add `-H "X-Music-Service: all"` (or `tidal`, ...) for the service the page would send.

Try a service adapter against the live API (no server needed; requests are logged to
`/tmp/crosstune-live-<service>.jsonl`, tokens and request signatures left out):

```bash
cat > /tmp/crosstune-live-check.mts <<EOF
import { open } from "$PWD/.claude/skills/run-crosstune/live.mts";
for (const service of ["qobuz", "tidal", "spotify"] as const) {
  const { music } = await open(service);
  const found = await music.searchTracks("Portishead Roads", 2);
  console.log(service, found.map((t) => \`\${t.id} \${t.title}\`));
}
EOF
npx tsx /tmp/crosstune-live-check.mts
```

Stop the server when done (by its port: the background shell does not pass a signal on):

```bash
lsof -ti:4567 -sTCP:LISTEN | xargs -r kill
```

`open("tidal" | "spotify")` also returns `client` for raw calls (`client.get(path, query)`,
`client.send(method, path, ...)`).

## Run (human path)

`npm run ui` builds, serves and opens a browser (see CLAUDE.md); no use headless.

## Test

```bash
npm test             # vitest, ~2,300 tests, a few seconds
npm run typecheck    # two passes; vitest does not type-check, and src/web only the second does
```

## Gotchas

- **Screenshots stay out of the repo.** A signed-in page shows account names and the TIDAL
  email, so the driver writes to `/tmp/crosstune-shots/` (or `$CROSSTUNE_SHOTS`); the
  skill's `.gitignore` refuses `*.png` as a backstop.
- **The service choice lives in `localStorage["crosstune:service"]`**, and a fresh browser
  profile has none: start with a `{"service": ...}` step, or views run on the first connected
  service. With `all`, a view that works on one service (Playlist from artists, ...) shows
  "This works on one music service. Choose it ..." above it: choose that service for those.
- **Covers are off by default** (they load from the services' image servers, ADR-0004), so an
  `<img>` without `src` in a fresh profile is expected, not a bug.
- **`serve` runs the user's due managed playlists every minute** while it is up. Stop it when done.
- **API calls without the nonce answer 403**; the nonce changes on every start of the server.
- **Chromium's helper processes outlive it**: the driver starts it in its own process group and
  stops the group, or its temp profile cannot be removed (`ENOTEMPTY` on rmdir).
- **Scripts run with tsx that use top-level await must be `.mts`**: as `.ts` outside the repo
  they fail with "Top-level await is currently not supported with the cjs output format".

## Troubleshooting

- **`Error: ENOTEMPTY: directory not empty, rmdir '/tmp/crosstune-chromium-.../Default'`**:
  Chromium was still writing its profile; fixed in the driver (process-group kill, then wait).
  Leftovers in `/tmp/crosstune-chromium-*` are safe to delete.
- **`Top-level await is currently not supported with the "cjs" output format`**: rename the
  script to `.mts`.
- **`curl` to `/api/...` gives 403**: fetch the nonce again (the server was restarted) and send
  the `Origin` header.
