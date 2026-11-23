/**
 * Sign-in with an authorization code and PKCE (RFC 7636): no client secret, so
 * nothing secret is shipped or asked of the user.
 *
 * Pure over an injected fetch and clock. No error message carries a code,
 * verifier or token, as messages reach the page, the log and the run log.
 */

import { createHash, randomBytes } from "node:crypto";

import { labelOf, ServiceError } from "./errors.js";
import type { ServiceName } from "./names.js";

export interface OAuthConfig {
  service: ServiceName;
  authorizeUrl: string;
  tokenUrl: string;
  /** The user's own app, registered with the service. */
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token ends (ms). */
  expiresAt: number;
  /** When the user authorised (ms); refreshing does not change it. */
  authorisedAt: number;
  scopes: string[];
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function newPkce(verifier: string = randomBytes(48).toString("base64url")): Pkce {
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The address to open in the browser. */
export function authorizeUrl(config: OAuthConfig, request: { state: string; challenge: string }): string {
  const url = new URL(config.authorizeUrl);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: request.challenge,
    state: request.state,
  })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Trade the code the redirect carried for tokens. */
export async function exchangeCode(config: OAuthConfig, code: string, verifier: string): Promise<Tokens> {
  const answer = await askForToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  return toTokens(config, answer, { authorisedAt: clock(config) });
}

/** New tokens for old. */
export async function refreshTokens(config: OAuthConfig, tokens: Tokens): Promise<Tokens> {
  if (tokens.refreshToken === undefined) {
    throw signInAgain(config);
  }
  const answer = await askForToken(config, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
  });
  return toTokens(config, answer, tokens);
}

function clock(config: OAuthConfig): number {
  return (config.now ?? Date.now)();
}

function signInAgain(config: OAuthConfig): ServiceError {
  const label = labelOf(config.service);
  return new ServiceError(config.service, "authentication", `${label} did not accept the sign-in; connect ${label} again`);
}

async function askForToken(config: OAuthConfig, fields: Record<string, string>): Promise<unknown> {
  const label = labelOf(config.service);
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (cause) {
    throw new ServiceError(config.service, "network", `${label} could not be reached to sign in`, { cause });
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw signInAgain(config);
  }
  if (!response.ok) {
    throw new ServiceError(config.service, "api-response", `${label}'s sign-in answered HTTP ${response.status}`);
  }
  return response.json().catch(() => undefined);
}

function toTokens(
  config: OAuthConfig,
  answer: unknown,
  known: { authorisedAt: number; refreshToken?: string; scopes?: string[] },
): Tokens {
  const fields = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const accessToken = fields["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw signInAgain(config);
  }
  const given = fields["refresh_token"];
  const refreshToken = typeof given === "string" && given.length > 0 ? given : known.refreshToken;
  const seconds = typeof fields["expires_in"] === "number" ? fields["expires_in"] : 3600;
  const scope = fields["scope"];
  return {
    accessToken,
    ...(refreshToken !== undefined && { refreshToken }),
    expiresAt: clock(config) + seconds * 1000,
    authorisedAt: known.authorisedAt,
    scopes: typeof scope === "string" && scope.length > 0 ? scope.split(" ") : (known.scopes ?? [...config.scopes]),
  };
}
