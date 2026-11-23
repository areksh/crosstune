/** How to sign in to TIDAL: authorization code with PKCE (../oauth.ts), no secret. */

import type { OAuthConfig } from "../oauth.js";

export const TIDAL_AUTHORIZE_URL = "https://login.tidal.com/authorize";
export const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

/** Everything the tools use, all of it open to THIRD_PARTY apps. */
export const TIDAL_SCOPES = [
  "user.read",
  "collection.read",
  "collection.write",
  "playlists.read",
  "playlists.write",
  "search.read",
] as const;

/** For the user's own app, registered with TIDAL. */
export function tidalOAuthConfig(clientId: string, redirectUri: string): OAuthConfig {
  return {
    service: "tidal",
    authorizeUrl: TIDAL_AUTHORIZE_URL,
    tokenUrl: TIDAL_TOKEN_URL,
    clientId,
    redirectUri,
    scopes: TIDAL_SCOPES,
  };
}
