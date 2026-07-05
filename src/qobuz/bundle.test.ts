import { describe, expect, it } from "vitest";

import {
  bundleVersionFromUrl,
  extractAppId,
  extractBundleUrl,
  extractPrivateKey,
  extractSecrets,
  fetchBundleTokens,
  parseBundle,
} from "./bundle.js";
import { QobuzError } from "./errors.js";

// A synthetic seed block that round-trips through the real decode algorithm
// (combined = seed + info + extras; drop the last 44 chars; base64-decode).
// seed = base64("qobuztestsecret001"); info+extras supply exactly 44 dropped
// characters. Computed independently, not by the code under test.
const SEED = "cW9idXp0ZXN0c2VjcmV0MDAx";
const SEED_BLOCK =
  `x.initialSeed("${SEED}",window.utimezone.berlin)` +
  `;name:"Europe/Berlin",info:"${"A".repeat(22)}",extras:"${"B".repeat(22)}"`;

describe("extractBundleUrl", () => {
  it("extracts the versioned bundle.js path from the login page", () => {
    const html = `<script src="/resources/8.1.0-b019/bundle.js"></script>`;
    expect(extractBundleUrl(html)).toBe("/resources/8.1.0-b019/bundle.js");
  });

  it("throws a bundle-extraction error when the path is absent", () => {
    expect(() => extractBundleUrl("<html>no bundle here</html>")).toThrow(
      QobuzError,
    );
  });
});

describe("bundleVersionFromUrl", () => {
  it("parses the version out of the resources path", () => {
    expect(bundleVersionFromUrl("/resources/8.1.0-b019/bundle.js")).toBe(
      "8.1.0-b019",
    );
  });
});

describe("extractAppId", () => {
  it("extracts the 9-digit app id from the production config", () => {
    const bundle = `production:{api:{appId:"123456789",appSecret:"x"}`;
    expect(extractAppId(bundle)).toBe("123456789");
  });

  it("throws when no app id is present", () => {
    expect(() => extractAppId("nothing")).toThrow(QobuzError);
  });
});

describe("extractSecrets", () => {
  it("decodes the seed/info/extras block into the app secret", () => {
    expect(extractSecrets(SEED_BLOCK)).toEqual(["qobuztestsecret001"]);
  });

  it("falls back to the simple appSecret pattern when no seeds are found", () => {
    const bundle = `appSecret:"0123456789abcdef0123456789abcdef"`;
    expect(extractSecrets(bundle)).toEqual([
      "0123456789abcdef0123456789abcdef",
    ]);
  });

  it("throws when neither seeds nor a fallback secret are present", () => {
    expect(() => extractSecrets("no secrets at all")).toThrow(QobuzError);
  });
});

describe("extractPrivateKey", () => {
  it("extracts the OAuth private key when present", () => {
    expect(extractPrivateKey(`privateKey:"abc123DEF456"`)).toBe("abc123DEF456");
  });

  it("returns undefined when no private key is present", () => {
    expect(extractPrivateKey("no key here")).toBeUndefined();
  });
});

describe("parseBundle", () => {
  it("assembles app id, secrets and private key from bundle content", () => {
    const bundle =
      `production:{api:{appId:"987654321"}` +
      SEED_BLOCK +
      `;privateKey:"myPrivateKey01"`;
    expect(parseBundle(bundle)).toEqual({
      appId: "987654321",
      secrets: ["qobuztestsecret001"],
      privateKey: "myPrivateKey01",
    });
  });
});

describe("fetchBundleTokens", () => {
  const loginHtml = `<script src="/resources/8.1.0-b019/bundle.js"></script>`;
  const bundleJs = `production:{api:{appId:"111222333"}${SEED_BLOCK}`;

  it("fetches the login page then the bundle and parses the tokens", async () => {
    const requested: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      const href = String(url);
      requested.push(href);
      const body = href.endsWith("/login") ? loginHtml : bundleJs;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const tokens = await fetchBundleTokens(fakeFetch);

    expect(tokens.appId).toBe("111222333");
    expect(tokens.secrets).toEqual(["qobuztestsecret001"]);
    expect(requested).toEqual([
      "https://play.qobuz.com/login",
      "https://play.qobuz.com/resources/8.1.0-b019/bundle.js",
    ]);
  });

  it("raises a bundle-extraction error on a non-ok response", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchBundleTokens(fakeFetch)).rejects.toBeInstanceOf(QobuzError);
  });
});
