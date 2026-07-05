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

## Planned tools

- **Advanced deduplicator** -- find duplicate tracks in your library, including
  remasters and the same song appearing on different albums.
- **Playlist from artists** -- build a playlist from just a list of artists.

More to follow.

## Requirements

- Node.js `>=18`
- A paying Qobuz subscription (the streaming API rejects accounts without one).

## Quick start (development)

```sh
npm install
npm test          # run the test suite
npm run dev       # run the CLI entry point (prompts for credentials)
```

By default the CLI prompts for your email and password, with the password
hidden. This is the recommended path: it keeps the password out of your shell
history and out of the environment, and avoids the shell mangling special
characters (for example, zsh expands `$` inside double quotes, silently
corrupting a password before the program ever sees it).

You can supply either value via an environment variable to skip its prompt; any
value not supplied is prompted for:

```sh
QOBUZ_EMAIL=you@example.com npm run dev   # prompts for the password only
```

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
