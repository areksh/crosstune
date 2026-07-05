/**
 * Request signing for the private Qobuz API.
 *
 * Protected endpoints require an MD5 signature of the form
 * `MD5(method + params + timestamp + secret)`, where `method` is the endpoint
 * name with the slashes removed (e.g. `/track/getFileUrl` -> `trackgetFileUrl`)
 * and `params` is a concatenation of the request's key/value pairs sorted
 * alphabetically by key. This mirrors the scheme used by the Qobuz web player.
 */

import { createHash } from "node:crypto";

/**
 * Generate the raw MD5 signature for a request.
 *
 * @param method Endpoint name with slashes removed, e.g. `trackgetFileUrl`.
 * @param params Concatenated `key1value1key2value2...` parameter string.
 * @param timestamp Unix time in seconds used for this request.
 * @param secret The validated Qobuz app secret.
 * @returns The 32-character lowercase hex MD5 digest.
 */
export function generateSignature(
  method: string,
  params: string,
  timestamp: number,
  secret: string,
): string {
  return createHash("md5")
    .update(`${method}${params}${timestamp}${secret}`)
    .digest("hex");
}

/**
 * Sign a `track/getFileUrl` request, which resolves a streamable file URL.
 *
 * @param trackId The Qobuz track id.
 * @param formatId The requested format id (e.g. 5, 27).
 * @param timestamp Unix time in seconds.
 * @param secret The validated Qobuz app secret.
 */
export function signGetFileUrl(
  trackId: number,
  formatId: number,
  timestamp: number,
  secret: string,
): string {
  const params = `format_id${formatId}intentstreamtrack_id${trackId}`;
  return generateSignature("trackgetFileUrl", params, timestamp, secret);
}

/**
 * Sign an arbitrary endpoint request from its key/value parameters.
 *
 * The pairs are sorted alphabetically by key and concatenated as
 * `key1value1key2value2...` before hashing. The caller's array is not mutated.
 *
 * @param method Endpoint name with slashes removed, e.g. `albumget`.
 * @param kvPairs The request parameters as `[key, value]` tuples, any order.
 * @param timestamp Unix time in seconds.
 * @param secret The validated Qobuz app secret.
 */
export function signRequest(
  method: string,
  kvPairs: ReadonlyArray<readonly [string, string]>,
  timestamp: number,
  secret: string,
): string {
  const params = [...kvPairs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return generateSignature(method, params, timestamp, secret);
}

/**
 * Sign a search request (`catalog/search`, `album/search`, ...).
 *
 * Query parameters are ordered `limit`, `offset`, `query`, and optionally
 * `type`, matching the order the web player uses for these endpoints.
 *
 * @param method Endpoint name with slashes removed, e.g. `catalogsearch`.
 * @param query The search query string.
 * @param limit Page size.
 * @param offset Page offset.
 * @param searchType Optional search type (e.g. `album`), appended when present.
 * @param timestamp Unix time in seconds.
 * @param secret The validated Qobuz app secret.
 */
export function signSearch(
  method: string,
  query: string,
  limit: number,
  offset: number,
  searchType: string | undefined,
  timestamp: number,
  secret: string,
): string {
  let params = `limit${limit}offset${offset}query${query}`;
  if (searchType !== undefined) {
    params += `type${searchType}`;
  }
  return generateSignature(method, params, timestamp, secret);
}
