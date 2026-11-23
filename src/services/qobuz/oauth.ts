/**
 * OAuth sign-in helpers.
 *
 * Qobuz no longer accepts email/password against `/user/login`; sign-in goes
 * through the web OAuth flow. The user authenticates on Qobuz's own site, which
 * redirects to a URL (here a localhost address) carrying an authorization code.
 * That code is then exchanged for a session (see QobuzClient.loginWithOAuthCode).
 */

const OAUTH_SIGNIN_URL = "https://www.qobuz.com/signin/oauth";

/**
 * Build the Qobuz OAuth sign-in URL to open in the user's browser.
 *
 * @param appId The app id extracted from the web player bundle.
 * @param redirectUrl Where Qobuz should redirect after sign-in (a localhost URL
 *   served by this process).
 */
export function buildOAuthUrl(appId: string, redirectUrl: string): string {
  const params = new URLSearchParams({
    ext_app_id: appId,
    redirect_url: redirectUrl,
  });
  return `${OAUTH_SIGNIN_URL}?${params.toString()}`;
}

/**
 * Extract the authorization code from an OAuth redirect request target.
 *
 * Qobuz returns the code as `code_autorisation`; some flows use `code`. The
 * former is preferred when both are present. Returns `undefined` for requests
 * that carry no code (browser noise such as favicon requests).
 *
 * @param target The request target, e.g. `/?code_autorisation=abc` or a full URL.
 */
export function parseRedirectCode(target: string): string | undefined {
  const query = target.includes("?")
    ? target.slice(target.indexOf("?") + 1)
    : "";
  if (query.length === 0) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  return params.get("code_autorisation") ?? params.get("code") ?? undefined;
}
