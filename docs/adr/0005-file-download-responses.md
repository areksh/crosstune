# ADR-0005: File download responses from the local API

- Status: accepted
- Date: 2026-11-01

## Context

ADR-0002 makes the local server's API a pure function from a request to a JSON
response (`handleApi` in `router.ts`), with `http.ts` as thin socket glue.
ADR-0003 has exports come back as text inside that JSON; the page turns the text
into a Blob and saves it.

Exporting every playlist at once produces many files. Handing them to the page
as a list of texts would leave the page to build an archive: a zip writer
(CRC-32, headers, optional deflate) in the untested browser glue, and without
`node:zlib`.

## Decision

- **The API may answer with a file.** `ApiResponse` gains an optional `file`
  (`filename`, `contentType`, `bytes`). When it is set, the server sends those
  bytes as the response body with `Content-Disposition: attachment` instead of
  serialising `body`. Everything else stays JSON.
- **The router stays pure.** It returns the bytes; `encodeResponse` in
  `http.ts` (tested) turns a response into status, headers and payload. The
  filename is reduced to printable ASCII without quotes or backslashes, so it
  cannot break the header.
- **Archives are built on the server**, by `src/features/zip.ts`: a
  zero-dependency zip writer (CRC-32, UTF-8 names, deflate via `node:zlib` only
  when it shrinks a file), unit-tested like the other feature modules.
- The same authorisation applies as to every API route (ADR-0002): Host,
  Origin and the per-run nonce. The Qobuz token never leaves the server.

## Consequences

- The "every playlist" export downloads one `.zip`, one file per playlist,
  named and de-duplicated the same way as `export --all-playlists --out-dir`.
- Single exports keep the ADR-0003 path (text in JSON, saved by the page); only
  routes that need binary output use `file`.
- A future binary export (e.g. a backup archive) can reuse `file` with no change
  to the glue.
