import { describe, expect, it } from "vitest";

import {
  generateSignature,
  signGetFileUrl,
  signRequest,
  signSearch,
} from "./signing.js";

// Expected values are MD5 digests computed independently (see commit message /
// node -e 'crypto...'), so the tests do not re-implement the code under test.

describe("generateSignature", () => {
  it("hashes method + params + timestamp + secret as MD5 hex", () => {
    expect(generateSignature("test", "params", 1234567890, "secret")).toBe(
      "231f3bff18bedc54fe082b7d040ea65f",
    );
  });

  it("returns a 32-character lowercase hex string", () => {
    const sig = generateSignature("a", "b", 1, "c");
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("signGetFileUrl", () => {
  it("builds the format_id/intent/track_id param string in order", () => {
    // params = "format_id5intentstreamtrack_id123", method = "trackgetFileUrl"
    expect(signGetFileUrl(123, 5, 1700000000, "mysecret")).toBe(
      "dab690f416ff86d59daac0a80698063b",
    );
  });
});

describe("signRequest", () => {
  it("sorts key/value pairs alphabetically by key before hashing", () => {
    // Deliberately pass out of order; sorted -> album_id42extrafull
    const sig = signRequest(
      "albumget",
      [
        ["extra", "full"],
        ["album_id", "42"],
      ],
      1700000000,
      "s3cr3t",
    );
    expect(sig).toBe("66dbd3368a530a918067cb5dde5b3585");
  });

  it("does not mutate the caller's array", () => {
    const pairs: Array<[string, string]> = [
      ["b", "2"],
      ["a", "1"],
    ];
    signRequest("m", pairs, 1, "s");
    expect(pairs).toEqual([
      ["b", "2"],
      ["a", "1"],
    ]);
  });
});

describe("signSearch", () => {
  it("omits the type param when no search type is given", () => {
    // params = "limit10offset0querymiles davis"
    expect(
      signSearch("catalogsearch", "miles davis", 10, 0, undefined, 1700000000, "sk"),
    ).toBe("e1693bc543f78411067331cf6ca7bbb5");
  });

  it("appends the type param when a search type is given", () => {
    // params = "limit10offset0querymiles davistypealbum"
    expect(
      signSearch("albumsearch", "miles davis", 10, 0, "album", 1700000000, "sk"),
    ).toBe("f2175c3a038fa40fe2a9f8dd829fa17e");
  });
});
