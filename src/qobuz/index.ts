/**
 * Public surface of the Qobuz client.
 */

export {
  QobuzClient,
  type QobuzClientOptions,
  type ResolvedCredentials,
} from "./client.js";
export { QobuzError, type QobuzErrorKind } from "./errors.js";
export { buildOAuthUrl, parseRedirectCode } from "./oauth.js";
export type { UserSession } from "./auth.js";
export type { BundleTokens } from "./bundle.js";
export {
  parsePlaylists,
  type Artist,
  type Playlist,
  type PlaylistsPage,
  type Track,
} from "./models.js";
