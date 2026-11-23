import { describe, expect, it } from "vitest";

import { authorizeUrl } from "../oauth.js";
import { SPOTIFY_SCOPES, spotifyOAuth } from "./oauth-config.js";

describe("spotifyOAuth", () => {
  it("sends the user to Spotify with every scope the tools use", () => {
    const config = spotifyOAuth({ clientId: "app", redirectUri: "http://127.0.0.1:53683/callback" });
    const url = new URL(authorizeUrl(config, { state: "s", challenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(config.tokenUrl).toBe("https://accounts.spotify.com/api/token");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53683/callback");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "playlist-modify-private",
      "playlist-modify-public",
      "playlist-read-collaborative",
      "playlist-read-private",
      "user-follow-modify",
      "user-follow-read",
      "user-library-modify",
      "user-library-read",
    ]);
    expect(SPOTIFY_SCOPES).toHaveLength(8);
  });

  it("refuses localhost, which Spotify does not accept", () => {
    expect(() => spotifyOAuth({ clientId: "app", redirectUri: "http://localhost:53683/callback" })).toThrow(
      /127\.0\.0\.1/,
    );
  });
});
