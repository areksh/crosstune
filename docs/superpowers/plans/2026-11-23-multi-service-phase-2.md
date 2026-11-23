# Multi-service phase 2 (accounts and sign-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI starts with nothing connected and the user connects each service from it.

**Architecture:** `services/oauth.ts` (PKCE, exchange, refresh) and `services/tokens.ts` (keeping a token fresh, across processes) are pure over injected fetch, clock, store and lock. `accounts/` holds what is connected and the sign-ins in progress; a one-shot loopback listener is thin glue. The router gets `/api/accounts/*`; everything else needs a connected service.

**Spec:** docs/superpowers/specs/2026-11-23-multi-service-design.md (section 6)

## Global Constraints

As phase 1, plus: no token, code or verifier in any API response, log line, error message or History; files owner-only (0600); the listener binds 127.0.0.1 only, on port 53683 unless configured.

## Review Focus

1. A redirect with a wrong, reused, missing or expired `state` connects nothing.
2. Two processes refreshing one token at once: one refresh, both get the new token.
3. The sign-in port already in use: a message naming it, and the paste route still works.
4. Signing in as a different account than the one stored is refused and the old token kept.
5. Every API route answers sensibly with nothing connected.

### Task 1: OAuth and tokens
Create `src/services/oauth.ts`, `src/services/tokens.ts` and tests.
Produces: `newPkce()`, `authorizeUrl(config, {state, challenge})`, `exchangeCode(config, code, verifier)`, `refreshTokens(config, tokens)`, `interface Tokens`, `interface TokenSource { accessToken(): Promise<string>; renewedToken(rejected: string): Promise<string> }`, `class TokenKeeper implements TokenSource`.

### Task 2: Accounts
`src/accounts/{model,store,sign-in}.ts`: `services.json` (client ids), `sessions/<service>.json` (tokens, account id and name, authorisedAt); `SignIns` (start, complete by redirect or pasted address, expire after 10 minutes, single use); `accountsView()` for the page; sign out; disconnect and forget.

### Task 3: Listener and server
`src/cli/sign-in-listener.ts` (glue); `/api/accounts` GET, `/api/accounts/{start,paste,sign-out,forget,client-id}` POST; the hub replaces the single service in `ApiDeps`; `ui` and `serve` start without a sign-in; `login <service>`, `accounts` commands.

### Task 4: Jobs per service
`jobs-global.json` flags per service (older ones read as Qobuz's); a job pauses only for the services it uses.

### Task 5: Shell
Accounts view (Console style), service filter (one service until phase 4), service mark and link on songs and playlists, the not-connected state of each tool, capabilities and reasons.

### Task 6: Forget
Deleting a service's data, History included (ADR-0011); check, document.
