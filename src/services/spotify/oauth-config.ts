/**
 * How to sign in to Spotify (../oauth.ts): an authorization code with PKCE, for
 * an app the user registers. No client secret.
 */

import type { OAuthConfig } from "../oauth.js";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Signing in lasts this long, however often the token is refreshed. */
export const SPOTIFY_SIGN_IN_MONTHS = 6;

export const SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read",
  "user-library-modify",
  "user-follow-read",
  "user-follow-modify",
] as const;

/**
 * @throws {Error} for a `localhost` redirect: Spotify takes only the address
 *   (registered without a port, any port may then be used).
 */
export function spotifyOAuth(
  app: Pick<OAuthConfig, "clientId" | "redirectUri" | "fetchImpl" | "now">,
): OAuthConfig {
  if (new URL(app.redirectUri).hostname === "localhost") {
    throw new Error("Spotify refuses a redirect to localhost; use 127.0.0.1");
  }
  return {
    ...app,
    service: "spotify",
    authorizeUrl: SPOTIFY_AUTHORIZE_URL,
    tokenUrl: SPOTIFY_TOKEN_URL,
    scopes: SPOTIFY_SCOPES,
  };
}
