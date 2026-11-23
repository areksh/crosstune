import { describe, expect, it } from "vitest";

import { parseLoginResponse } from "./auth.js";
import { QobuzError } from "./errors.js";

function validResponse(): unknown {
  return {
    user_auth_token: "tok-abc",
    user: {
      id: 42,
      email: "listener@example.com",
      display_name: "Listener",
      login: "listener-login",
      credential: {
        parameters: { short_label: "Studio", lossy_streaming: true },
      },
    },
  };
}

describe("parseLoginResponse", () => {
  it("maps a valid response into a user session", () => {
    expect(parseLoginResponse(validResponse())).toEqual({
      userAuthToken: "tok-abc",
      userId: 42,
      email: "listener@example.com",
      displayName: "Listener",
      subscriptionLabel: "Studio",
    });
  });

  it("falls back to the login when display_name is missing", () => {
    const response = validResponse() as {
      user: { display_name?: string };
    };
    delete response.user.display_name;
    expect(parseLoginResponse(response).displayName).toBe("listener-login");
  });

  it("throws an authentication error when the auth token is missing", () => {
    const response = validResponse() as { user_auth_token?: string };
    delete response.user_auth_token;
    expect(() => parseLoginResponse(response)).toThrow(QobuzError);
  });

  it("throws an authentication error when the user object is missing", () => {
    expect(() => parseLoginResponse({ user_auth_token: "t" })).toThrow(
      QobuzError,
    );
  });

  it("throws an ineligible-user error when there is no active subscription", () => {
    const response = validResponse() as {
      user: { credential: { parameters: unknown } };
    };
    response.user.credential.parameters = {};
    try {
      parseLoginResponse(response);
      throw new Error("expected parseLoginResponse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QobuzError);
      expect((error as QobuzError).kind).toBe("ineligible-user");
    }
  });
});
