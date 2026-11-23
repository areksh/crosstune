/**
 * Request authorisation for the local web server.
 *
 * The server acts on the user's Qobuz account, so its API must be reachable
 * only by the UI it serves -- not by any other page the browser happens to have
 * open, and not via DNS rebinding. Three cheap, pure checks together achieve
 * that:
 *
 *   - *Host* must be `localhost`/`127.0.0.1` on our port. A rebinding attack
 *     reaches us with the attacker's hostname in Host, so this rejects it.
 *   - *Origin*, when present, must be our own origin. This rejects cross-origin
 *     calls from other pages (the browser sets Origin on those).
 *   - *Nonce*: a per-run secret injected into the served page. Only our own
 *     same-origin UI can read it, so requiring it as a header proves the caller
 *     is that UI. This is the primary guard; the others are defence in depth.
 */

export interface RequestHeaders {
  host?: string | undefined;
  origin?: string | undefined;
  nonce?: string | undefined;
}

export interface AuthConfig {
  expectedNonce: string;
  port: number;
}

export type AuthResult = { ok: true } | { ok: false; reason: string };

/** Whether a Host header names this server (`localhost` or `127.0.0.1` on our port). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host !== undefined && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
}

/** Decide whether an API request may proceed. */
export function authorise(
  headers: RequestHeaders,
  config: AuthConfig,
): AuthResult {
  const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const allowedOrigins = allowedHosts.map((host) => `http://${host}`);

  if (!hostAllowed(headers.host, config.port)) {
    return { ok: false, reason: "host not allowed" };
  }
  if (headers.origin !== undefined && !allowedOrigins.includes(headers.origin)) {
    return { ok: false, reason: "origin not allowed" };
  }
  if (headers.nonce !== config.expectedNonce) {
    return { ok: false, reason: "invalid nonce" };
  }
  return { ok: true };
}
