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
  trackSearch: "/track/search",
  artistSearch: "/artist/search",
  artistPage: "/artist/page",
  artistGetSimilarArtists: "/artist/getSimilarArtists",
  // An artist's releases (albums, EPs, singles, live, compilations). Inferred
  // from the current Qobuz web player and NOT verified against the live API:
  // the parameters (artist_id, release_type, sort, order, limit, offset) and
  // the response shape are best guesses, so its parser also accepts the older
  // artist/get?extra=albums shape (see releases.ts).
  artistGetReleasesList: "/artist/getReleasesList",
  albumSearch: "/album/search",
  albumGet: "/album/get",
  playlistGet: "/playlist/get",
  playlistGetUserPlaylists: "/playlist/getUserPlaylists",
  playlistCreate: "/playlist/create",
  playlistAddTracks: "/playlist/addTracks",
  playlistDeleteTracks: "/playlist/deleteTracks",
  favoriteCreate: "/favorite/create",
  favoriteDelete: "/favorite/delete",
  /**
   * Move playlist entries. UNVERIFIED: inferred from the web player (and
   * third-party API wrappers), not documented and not exercised against the
   * live API; see {@link QobuzClient.movePlaylistTracks}.
   */
  playlistUpdateTracksPosition: "/playlist/updateTracksPosition",
} as const;

/** Build the full URL for an endpoint path. */
export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
