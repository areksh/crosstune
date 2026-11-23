/**
 * Bundle-token extraction from the Qobuz web player.
 *
 * Qobuz publishes no API credentials, so the `app_id` and app secrets have to
 * be scraped from the web player's JavaScript bundle. The flow is:
 *
 *   1. fetch the login page and locate the versioned `bundle.js` URL;
 *   2. fetch that bundle;
 *   3. parse out the app id, the app secrets, and (on newer bundles) the OAuth
 *      private key.
 *
 * This module holds the pure parsing logic (unit-tested here) and a thin
 * network wrapper around it. The parsing is inherently fragile: it depends on
 * the exact shape of Qobuz's minified bundle and will need updating whenever
 * Qobuz changes it.
 */

import { QobuzError } from "./errors.js";

const LOGIN_PAGE_URL = "https://play.qobuz.com/login";
const BUNDLE_BASE_URL = "https://play.qobuz.com";

/** The credentials scraped from the Qobuz web player bundle. */
export interface BundleTokens {
  appId: string;
  /** Candidate app secrets; not all are valid, so they must be validated in turn. */
  secrets: string[];
  /** OAuth private key for the `/oauth/callback` exchange; absent on older bundles. */
  privateKey?: string;
}

/**
 * Extract the versioned `bundle.js` path from the login page HTML.
 *
 * @throws {QobuzError} of kind `bundle-extraction` if the path is not found.
 */
export function extractBundleUrl(html: string): string {
  const match = html.match(
    /<script src="(\/resources\/\d+\.\d+\.\d+-[a-z]\d{3}\/bundle\.js)"><\/script>/,
  );
  if (!match?.[1]) {
    throw new QobuzError("bundle-extraction", "Bundle URL not found in login page");
  }
  return match[1];
}

/**
 * Parse the bundle version out of a `/resources/<version>/bundle.js` path,
 * e.g. `/resources/8.1.0-b019/bundle.js` -> `8.1.0-b019`.
 */
export function bundleVersionFromUrl(bundleUrl: string): string {
  return bundleUrl
    .replace(/^\/resources\//, "")
    .replace(/\/bundle\.js$/, "");
}

/**
 * Extract the 9-digit `app_id` from the bundle's production config.
 *
 * @throws {QobuzError} of kind `bundle-extraction` if no app id is found.
 */
export function extractAppId(bundle: string): string {
  const match = bundle.match(/production:\{api:\{appId:"(\d{9})"/);
  if (!match?.[1]) {
    throw new QobuzError("bundle-extraction", "App id not found in bundle");
  }
  return match[1];
}

/**
 * Extract the candidate app secrets from the bundle.
 *
 * Secrets are hidden as base64 "seeds" keyed by timezone and split across a
 * seed declaration and a matching timezone info block. For each timezone the
 * seed, info and extras strings are concatenated, the trailing 44 characters
 * are dropped, and the remainder is base64-decoded into a secret. If that
 * complex path yields nothing, a simpler `appSecret:"<32 hex>"` pattern is
 * tried as a fallback.
 *
 * @throws {QobuzError} of kind `bundle-extraction` if no secret can be found.
 */
export function extractSecrets(bundle: string): string[] {
  const seeds = new Map<string, string>();
  const timezones: string[] = [];
  const seedRe =
    /[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g;
  for (const match of bundle.matchAll(seedRe)) {
    const seed = match[1];
    const timezone = match[2];
    if (seed !== undefined && timezone !== undefined) {
      seeds.set(timezone, seed);
      timezones.push(timezone);
    }
  }

  const secrets: string[] = [];
  if (seeds.size > 0) {
    const tzAlternatives = timezones.map(capitaliseFirst).join("|");
    const infoRe = new RegExp(
      `name:"\\w+/(${tzAlternatives})",info:"([\\w=]+)",extras:"([\\w=]+)"`,
      "g",
    );
    for (const match of bundle.matchAll(infoRe)) {
      const timezone = match[1];
      const info = match[2];
      const extras = match[3];
      if (timezone === undefined || info === undefined || extras === undefined) {
        continue;
      }
      const seed = seeds.get(timezone.toLowerCase());
      if (seed === undefined) {
        continue;
      }
      const combined = `${seed}${info}${extras}`;
      if (combined.length <= 44) {
        continue;
      }
      const trimmed = combined.slice(0, combined.length - 44);
      const decoded = decodeBase64Utf8(trimmed);
      if (decoded !== undefined) {
        secrets.push(decoded);
      }
    }
  }

  // Fallback: some bundle versions expose the secret directly.
  if (secrets.length === 0) {
    const simpleRe = /appSecret:"([a-f0-9]{32})"/g;
    for (const match of bundle.matchAll(simpleRe)) {
      if (match[1] !== undefined) {
        secrets.push(match[1]);
      }
    }
  }

  if (secrets.length === 0) {
    throw new QobuzError("bundle-extraction", "No app secrets found in bundle");
  }
  return secrets;
}

/**
 * Extract the OAuth private key (`privateKey:"..."`) used by the
 * `/oauth/callback` exchange. Returns `undefined` on bundles that lack it.
 */
export function extractPrivateKey(bundle: string): string | undefined {
  const match = bundle.match(/privateKey:\s*"([A-Za-z0-9]{6,30})"/);
  return match?.[1];
}

/** Parse app id, secrets and (optional) private key out of bundle content. */
export function parseBundle(bundle: string): BundleTokens {
  const appId = extractAppId(bundle);
  const secrets = extractSecrets(bundle);
  const privateKey = extractPrivateKey(bundle);
  return privateKey === undefined
    ? { appId, secrets }
    : { appId, secrets, privateKey };
}

/**
 * Fetch the Qobuz login page and bundle, and extract the tokens.
 *
 * The `fetchImpl` parameter defaults to the global `fetch`; it is injectable so
 * the network boundary can be exercised deterministically in tests.
 *
 * @throws {QobuzError} of kind `bundle-extraction` on any network or parse failure.
 */
export async function fetchBundleTokens(
  fetchImpl: typeof fetch = fetch,
): Promise<BundleTokens> {
  const loginHtml = await fetchText(fetchImpl, LOGIN_PAGE_URL);
  const bundleUrl = extractBundleUrl(loginHtml);
  const bundleJs = await fetchText(fetchImpl, `${BUNDLE_BASE_URL}${bundleUrl}`);
  return parseBundle(bundleJs);
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new QobuzError(
      "bundle-extraction",
      `Failed to fetch ${url}: ${(cause as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new QobuzError(
      "bundle-extraction",
      `Failed to fetch ${url}: HTTP ${response.status}`,
    );
  }
  return response.text();
}

function capitaliseFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Base64-decode to a UTF-8 string, returning undefined if the bytes are not valid UTF-8. */
function decodeBase64Utf8(base64: string): string | undefined {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(Buffer.from(base64, "base64"));
  } catch {
    return undefined;
  }
}
