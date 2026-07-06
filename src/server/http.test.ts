import { describe, expect, it } from "vitest";

import { contentTypeFor, extractHeaders, injectNonce } from "./http.js";

describe("contentTypeFor", () => {
  it("maps allowed static paths to content types", () => {
    expect(contentTypeFor("/")).toMatch(/text\/html/);
    expect(contentTypeFor("/main.js")).toMatch(/javascript/);
    expect(contentTypeFor("/styles.css")).toMatch(/text\/css/);
  });

  it("returns undefined for anything not on the whitelist", () => {
    expect(contentTypeFor("/secret.txt")).toBeUndefined();
    expect(contentTypeFor("/../etc/passwd")).toBeUndefined();
  });
});

describe("injectNonce", () => {
  it("replaces every placeholder with the nonce", () => {
    expect(injectNonce("a __QOBUZ_NONCE__ b __QOBUZ_NONCE__", "xyz")).toBe(
      "a xyz b xyz",
    );
  });
});

describe("extractHeaders", () => {
  it("pulls host, origin and the nonce header", () => {
    expect(
      extractHeaders({
        host: "127.0.0.1:4747",
        origin: "http://127.0.0.1:4747",
        "x-qobuz-nonce": "n",
      }),
    ).toEqual({
      host: "127.0.0.1:4747",
      origin: "http://127.0.0.1:4747",
      nonce: "n",
    });
  });

  it("collapses array-valued headers to the first value", () => {
    expect(extractHeaders({ host: ["a", "b"] }).host).toBe("a");
  });
});
