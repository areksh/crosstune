# ADR-0001: Adopt engineering practices and project shape

- Status: accepted
- Date: 2026-07-05

## Context

`qobuz-helper` is a new, greenfield project: a collection of local-first
utilities for Qobuz, intended to be shared with other users and maintained over
time. As a project that others will consume and that is meant to last, it sits
in the "real application" band -- it warrants a tested public surface, developer
documentation, a changelog, and records of significant decisions, without the
full apparatus of a large long-lived system.

Two properties shape the design:

1. **There is no official public Qobuz API.** The tools must talk to the private
   JSON API used by the Qobuz web player. Credentials (`app_id`, `app_secret`)
   are not published and must be extracted from the web player's JavaScript
   bundle, and protected requests must be signed. This integration is inherently
   unofficial and will break when Qobuz rotates its bundle.
2. **The Qobuz API sends no CORS headers,** so a browser cannot call it directly.
   Any UI therefore needs a local backend that owns the Qobuz client.

## Decision

- **Local-first.** The application runs on the user's own machine (a local
  server plus a browser UI, and/or a CLI). It is not a hosted multi-user
  service. This keeps user data on the user's machine, spreads API rate limits
  across users rather than a single shared IP, and keeps the project off the
  Qobuz terms-of-service radar.
- **Distribution via `npx`.** The published artifact targets the Node runtime so
  users can run it with `npx qobuz-helper`. Runtime dependencies are kept minimal
  (ideally zero) to preserve `npx` portability; signing uses `node:crypto` and
  HTTP uses the built-in `fetch`.
- **TypeScript** end to end.
- **Adopt the team engineering standard as the going-forward bar:** test-driven
  development for all new code, a developer manual under `docs/`, a `CHANGELOG`,
  docstrings on public surface, and ADRs for architecturally significant
  decisions.

## Consequences

- New code is written test-first. The Qobuz client's live network boundary is
  tested against recorded fixtures to keep the suite deterministic; genuine
  end-to-end validation against live Qobuz is a manual, opt-in step.
- The bundle-token extraction and request-signing scheme are load-bearing and
  fragile; they will need maintenance whenever Qobuz changes its web bundle.
  Future significant decisions (the deduplication matching model, caching
  strategy) will get their own ADRs.
- Choosing local-first now does not preclude a hosted deployment later, but the
  project is not designed around one.
