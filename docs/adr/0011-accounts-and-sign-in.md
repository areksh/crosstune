# ADR-0011: Accounts and signing in from the web UI

- Status: accepted
- Date: 2026-11-23

## Context

With TIDAL and Spotify beside Qobuz (ADR-0010), signing in can no longer be a
step before the CLI or the web UI starts: the user connects each service, from
the UI, and one expiring must not stop the others. TIDAL and Spotify use OAuth
with a client id; their terms ask each person to register an app of their own.

## Decision

- **The UI starts with nothing connected.** `ui` and `serve` resume what is
  saved; the Accounts view connects the rest. Every request names its service
  (header `X-Music-Service`); without a connected one a route answers 409.
- **Sign-in** is an authorization code with PKCE and no client secret
  (`services/oauth.ts`). The redirect comes back to a one-shot loopback listener
  on a fixed port (53683), up only while a sign-in waits, answering nothing
  else. A redirect is taken only with the `state` of a sign-in started here,
  for that service, once, within 10 minutes (`accounts/sign-in.ts`). Qobuz's
  flow has no state: it is taken only while a Qobuz sign-in waits, and an
  account other than the known one is refused. Pasting the address is the
  fallback (another machine, the port taken).
- **Tokens** live in `sessions/<service>.json` (Qobuz keeps `session.json`),
  owner-only; refreshing holds a file lock and re-reads first, as a server and
  a scheduled run may refresh at once and refresh tokens may rotate
  (`services/tokens.ts`). No token, code or verifier reaches the page, a log or
  History.
- **One account per service.** Its id is kept (`accounts.json`) after signing
  out; signing in as someone else is refused until the first is forgotten.
- **Sign out** drops the token only. **Disconnect and forget** also deletes the
  service's matches, links and jobs, and its History entries; an entry that
  also changed another service keeps its label and can no longer be undone.
  This is the one exception to ADR-0006's never-edited History.
- **Jobs pause per service** (`jobs-global.json` keeps Qobuz's flags as before
  and others under `signIn`).

## Consequences

- TIDAL and Spotify need the user to register an app and paste its client id;
  Spotify's must be owned by a Premium account, and its sign-in ends six months
  after authorising (the UI warns from 14 days before).
- A service whose sign-in fails to resume is "expired" only when it rejected
  the sign-in; anything else is "unreachable", never a reason to sign out.
