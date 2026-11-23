import { describe, expect, it } from "vitest";

import { contentTypeFor, encodeResponse, extractHeaders, injectNonce } from "./http.js";

describe("contentTypeFor", () => {
  it("maps allowed static paths to content types", () => {
    expect(contentTypeFor("/")).toMatch(/text\/html/);
    expect(contentTypeFor("/main.js")).toMatch(/javascript/);
    expect(contentTypeFor("/styles.css")).toMatch(/text\/css/);
  });

  it("serves the self-hosted fonts as woff2", () => {
    expect(contentTypeFor("/fonts/archivo-latin-wdth.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/fonts/archivo-latin-ext-wdth.woff2")).toBe("font/woff2");
  });

  it("returns undefined for anything not on the whitelist", () => {
    expect(contentTypeFor("/secret.txt")).toBeUndefined();
    expect(contentTypeFor("/../etc/passwd")).toBeUndefined();
    expect(contentTypeFor("/fonts/OFL.txt")).toBeUndefined();
    expect(contentTypeFor("/fonts/other.woff2")).toBeUndefined();
  });
});

describe("injectNonce", () => {
  it("replaces every placeholder with the nonce", () => {
    expect(injectNonce("a __CROSSTUNE_NONCE__ b __CROSSTUNE_NONCE__", "xyz")).toBe(
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
        "x-crosstune-nonce": "n",
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

describe("encodeResponse", () => {
  it("sends an API body as JSON", () => {
    const encoded = encodeResponse({ status: 400, body: { error: "nope" } });
    expect(encoded.status).toBe(400);
    expect(encoded.headers).toEqual({ "Content-Type": "application/json" });
    expect(encoded.payload).toBe('{"error":"nope"}');
  });

  it("sends a download as raw bytes with an attachment filename", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    const encoded = encodeResponse({
      status: 200,
      body: undefined,
      file: { filename: "qobuz-playlists-2026-11-01.zip", contentType: "application/zip", bytes },
    });
    expect(encoded.status).toBe(200);
    expect(encoded.headers).toEqual({
      "Content-Type": "application/zip",
      "Content-Length": "4",
      "Content-Disposition": 'attachment; filename="qobuz-playlists-2026-11-01.zip"',
    });
    expect(encoded.payload).toBe(bytes);
  });

  it("keeps the attachment header safe for any filename", () => {
    const encoded = encodeResponse({
      status: 200,
      body: undefined,
      file: { filename: 'a"b\r\nc é.zip', contentType: "application/zip", bytes: new Uint8Array() },
    });
    expect(encoded.headers["Content-Disposition"]).toBe('attachment; filename="a_b__c _.zip"');
  });
});
