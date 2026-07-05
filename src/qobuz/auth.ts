/**
 * Authentication: parsing the Qobuz login response into a session.
 */

import { QobuzError } from "./errors.js";

/** An authenticated Qobuz user session. */
export interface UserSession {
  /** Token sent as the `X-User-Auth-Token` header on subsequent requests. */
  userAuthToken: string;
  userId: number;
  email: string;
  displayName: string;
  /** Human-readable subscription tier, e.g. `Studio`. */
  subscriptionLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a `/user/login` response into a {@link UserSession}.
 *
 * @throws {QobuzError} kind `authentication` if the token or user is missing.
 * @throws {QobuzError} kind `ineligible-user` if the account has no active
 *   subscription (the streaming API is unusable without one).
 */
export function parseLoginResponse(response: unknown): UserSession {
  if (!isRecord(response)) {
    throw new QobuzError("authentication", "Malformed login response");
  }

  const userAuthToken = response["user_auth_token"];
  if (typeof userAuthToken !== "string" || userAuthToken.length === 0) {
    throw new QobuzError("authentication", "No auth token in login response");
  }

  const user = response["user"];
  if (!isRecord(user)) {
    throw new QobuzError("authentication", "No user in login response");
  }

  const userId = user["id"];
  if (typeof userId !== "number") {
    throw new QobuzError("authentication", "No user id in login response");
  }

  const email = typeof user["email"] === "string" ? user["email"] : "";
  const displayName =
    typeof user["display_name"] === "string"
      ? user["display_name"]
      : typeof user["login"] === "string"
        ? user["login"]
        : "";

  const credential = user["credential"];
  const parameters = isRecord(credential) ? credential["parameters"] : undefined;
  const hasSubscription = isRecord(parameters) && Object.keys(parameters).length > 0;
  if (!hasSubscription) {
    throw new QobuzError(
      "ineligible-user",
      "Account has no active Qobuz subscription",
    );
  }

  const subscriptionLabel =
    typeof parameters["short_label"] === "string"
      ? parameters["short_label"]
      : "Unknown";

  return { userAuthToken, userId, email, displayName, subscriptionLabel };
}
