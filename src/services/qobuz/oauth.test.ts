import { describe, expect, it } from "vitest";

import { buildOAuthUrl, parseRedirectCode } from "./oauth.js";

describe("buildOAuthUrl", () => {
  it("includes the app id and the url-encoded redirect", () => {
    const url = buildOAuthUrl("100200300", "http://localhost:54321");
    expect(url).toBe(
      "https://www.qobuz.com/signin/oauth" +
        "?ext_app_id=100200300" +
        "&redirect_url=http%3A%2F%2Flocalhost%3A54321",
    );
  });
});

describe("parseRedirectCode", () => {
  it("extracts the code_autorisation parameter", () => {
    expect(parseRedirectCode("/?code_autorisation=abc123")).toBe("abc123");
  });

  it("falls back to the code parameter", () => {
    expect(parseRedirectCode("/callback?a=1&code=xyz789")).toBe("xyz789");
  });

  it("prefers code_autorisation over code when both are present", () => {
    expect(parseRedirectCode("/?code=plain&code_autorisation=primary")).toBe(
      "primary",
    );
  });

  it("percent-decodes the captured code", () => {
    expect(parseRedirectCode("/?code=x%2Fy")).toBe("x/y");
  });

  it("returns undefined for unrelated requests (e.g. favicon)", () => {
    expect(parseRedirectCode("/favicon.ico")).toBeUndefined();
    expect(parseRedirectCode("/?other=1")).toBeUndefined();
  });
});
