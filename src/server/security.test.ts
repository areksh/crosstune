import { describe, expect, it } from "vitest";

import { authorise } from "./security.js";

const CONFIG = { expectedNonce: "secret-nonce", port: 4747 };

describe("authorise", () => {
  it("accepts a request from the local origin with the right nonce", () => {
    expect(
      authorise(
        {
          host: "127.0.0.1:4747",
          origin: "http://127.0.0.1:4747",
          nonce: "secret-nonce",
        },
        CONFIG,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts localhost as host and origin", () => {
    expect(
      authorise(
        {
          host: "localhost:4747",
          origin: "http://localhost:4747",
          nonce: "secret-nonce",
        },
        CONFIG,
      ).ok,
    ).toBe(true);
  });

  it("accepts a same-origin request that omits the Origin header", () => {
    expect(
      authorise(
        { host: "127.0.0.1:4747", nonce: "secret-nonce" },
        CONFIG,
      ).ok,
    ).toBe(true);
  });

  it("rejects a foreign Host header (defeats DNS rebinding)", () => {
    const result = authorise(
      { host: "evil.example.com", origin: "http://127.0.0.1:4747", nonce: "secret-nonce" },
      CONFIG,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a foreign Origin header", () => {
    const result = authorise(
      { host: "127.0.0.1:4747", origin: "http://evil.example.com", nonce: "secret-nonce" },
      CONFIG,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or wrong nonce", () => {
    expect(authorise({ host: "127.0.0.1:4747" }, CONFIG).ok).toBe(false);
    expect(
      authorise({ host: "127.0.0.1:4747", nonce: "wrong" }, CONFIG).ok,
    ).toBe(false);
  });
});
