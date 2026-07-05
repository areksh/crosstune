# qobuz-helper

A collection of local-first utilities for [Qobuz](https://www.qobuz.com/).

`qobuz-helper` runs entirely on your own machine. You sign in with your Qobuz
account, use the tools, and nothing about you is stored on any server -- the
session lives only in the running process.

> **Status:** early development. The first milestone is a vertical slice that
> proves the Qobuz plumbing works end to end (extract API tokens, sign in, make
> one authenticated request).

## Why this exists

Qobuz has no official public API, so these tools talk to the same private JSON
API that the Qobuz web player uses. That makes the integration inherently
unofficial and subject to breakage when Qobuz changes their web bundle. See
[docs/adr/](docs/adr/) for the architectural decisions behind the project.

## Tools

- **Playlist from artists** -- build a playlist from just a list of artists,
  using each artist's top tracks. Available now (see below).

Planned:

- **Advanced deduplicator** -- find duplicate tracks in your library, including
  remasters and the same song appearing on different albums.

More to follow.

## Requirements

- Node.js `>=18`
- A paying Qobuz subscription (the streaming API rejects accounts without one).

## Quick start (development)

```sh
npm install
npm test          # run the test suite
npm run dev       # run the CLI entry point
```

Sign-in uses Qobuz's browser OAuth flow -- the same one the official web player
uses. Running the CLI opens your browser on Qobuz's own sign-in page; after you
authenticate there, Qobuz redirects back to a temporary local address and the
session is established. Your password is entered only on Qobuz's site and is
never handled by this program (email/password sign-in against the API is no
longer supported by Qobuz).

### Commands

```sh
# Vertical-slice smoke test (sign in and make one API call)
npm run dev -- check

# Build a playlist from a list of artists' top tracks
npm run dev -- playlist-from-artists --name "Road Trip" --tracks 5 \
  "Portishead" "Massive Attack" "Tricky"

# Artist names can also be piped in, one per line
cat artists.txt | npm run dev -- playlist-from-artists --name "Road Trip"
```

Options for `playlist-from-artists`: `--name` (required), `--tracks N` (top
tracks per artist, default 10), `--public` (make the playlist public).

If the browser does not open automatically, the CLI prints the URL to visit.

## Development

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `npm test`          | Run the Vitest suite once             |
| `npm run test:watch`| Run tests in watch mode               |
| `npm run typecheck` | Type-check without emitting           |
| `npm run build`     | Compile TypeScript to `dist/`         |

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Legal

This project is not affiliated with or endorsed by Qobuz. It is intended for
personal use with your own account. Use it in accordance with Qobuz's terms of
service.

## Licence

MIT
