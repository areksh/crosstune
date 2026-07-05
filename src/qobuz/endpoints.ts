/**
 * Qobuz API endpoint definitions.
 *
 * These target the private JSON API used by the Qobuz web player. Only the
 * endpoints needed so far are listed; more are added as features need them.
 */

export const BASE_URL = "https://www.qobuz.com/api.json/0.2";

export const paths = {
  userLogin: "/user/login",
  trackGetFileUrl: "/track/getFileUrl",
  favoriteGetUserFavorites: "/favorite/getUserFavorites",
} as const;

/** Build the full URL for an endpoint path. */
export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
