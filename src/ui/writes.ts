/**
 * Whether a request to the local server changes something on a service or in
 * what crosstune keeps: the page counts these while they are in flight, and
 * asks before a reload that would hide how one ended (src/web/hosting.ts).
 * The server's own list of recorded changes is the reference (a test holds
 * them together); undo, jobs and links are changes too.
 */

const WRITES = new Set([
  "/api/commit",
  "/api/new-releases/commit",
  "/api/deduplicate/apply",
  "/api/upgrade/commit",
  "/api/import/commit",
  "/api/restore",
  "/api/word-play/commit",
  "/api/transfer/commit",
  "/api/history/undo",
  ...["save", "copy", "favourite", "update", "duplicate", "delete", "remove-artists/commit"].map((name) => `/api/manager/${name}`),
]);

/** Reads that are sent as POST under jobs and links. */
const READS = [/^\/api\/jobs\/(preview|artists)$/, /^\/api\/links\/[^/]+\/compare$/];

export function isWriteRequest(method: string, path: string, body?: unknown): boolean {
  // A dry run (a job's check, a link's settle preview) reads only.
  if (method === "GET" || (typeof body === "object" && body !== null && (body as Record<string, unknown>)["dryRun"] === true)) {
    return false;
  }
  if (WRITES.has(path)) {
    return true;
  }
  return /^\/api\/(jobs|links)(\/|$)/.test(path) && !READS.some((read) => read.test(path));
}
