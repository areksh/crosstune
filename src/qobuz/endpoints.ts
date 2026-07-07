/**
 * Qobuz API endpoint definitions.
 *
 * These target the private JSON API used by the Qobuz web player. Only the
 * endpoints needed so far are listed; more are added as features need them.
 */

export const BASE_URL = "https://www.qobuz.com/api.json/0.2";

export const paths = {
  userLogin: "/user/login",
  oauthCallback: "/oauth/callback",
  trackGetFileUrl: "/track/getFileUrl",
  favoriteGetUserFavorites: "/favorite/getUserFavorites",
  artistSearch: "/artist/search",
  artistPage: "/artist/page",
  albumSearch: "/album/search",
  albumGet: "/album/get",
  playlistGet: "/playlist/get",
  playlistGetUserPlaylists: "/playlist/getUserPlaylists",
  playlistCreate: "/playlist/create",
  playlistAddTracks: "/playlist/addTracks",
  playlistDeleteTracks: "/playlist/deleteTracks",
  favoriteDelete: "/favorite/delete",
} as const;

/** Build the full URL for an endpoint path. */
export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
