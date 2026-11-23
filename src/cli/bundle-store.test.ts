import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedCredentials } from "../services/qobuz/index.js";
import {
  clearCredentials,
  defaultBundlePath,
  loadCredentials,
  saveCredentials,
} from "./bundle-store.js";

const CREDS: ResolvedCredentials = {
  appId: "100200300",
  secret: "qobuztestsecret001",
  privateKey: "testPrivKey01",
};

describe("bundle-store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qobuz-helper-bundle-test-"));
    file = join(dir, "nested", "bundle.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips credentials, creating the directory", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    expect(loadCredentials(file, { now: () => 1000 })).toEqual(CREDS);
  });

  it("round-trips credentials without a private key", () => {
    const noKey: ResolvedCredentials = { appId: "1", secret: "s" };
    saveCredentials(noKey, file, { now: () => 1000 });
    expect(loadCredentials(file, { now: () => 1000 })).toEqual(noKey);
  });

  it("writes the file with owner-only permissions", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("returns undefined when nothing is cached", () => {
    expect(loadCredentials(file)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    writeFileSync(file, "not json {");
    expect(loadCredentials(file)).toBeUndefined();
  });

  it("returns undefined for a stale cache older than the max age", () => {
    saveCredentials(CREDS, file, { now: () => 0 });
    const dayMs = 24 * 60 * 60 * 1000;
    expect(
      loadCredentials(file, { now: () => 8 * dayMs, maxAgeMs: 7 * dayMs }),
    ).toBeUndefined();
  });

  it("returns the cache when within the max age", () => {
    saveCredentials(CREDS, file, { now: () => 0 });
    const dayMs = 24 * 60 * 60 * 1000;
    expect(
      loadCredentials(file, { now: () => 6 * dayMs, maxAgeMs: 7 * dayMs }),
    ).toEqual(CREDS);
  });

  it("returns undefined for a cache written in an older format version", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    writeFileSync(
      file,
      JSON.stringify({ version: 0, cachedAt: 1000, credentials: CREDS }),
    );
    expect(loadCredentials(file, { now: () => 1000 })).toBeUndefined();
  });

  it("returns undefined when the stored credentials are malformed", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    writeFileSync(
      file,
      JSON.stringify({ version: 1, cachedAt: 1000, credentials: { appId: 5 } }),
    );
    expect(loadCredentials(file, { now: () => 1000 })).toBeUndefined();
  });

  it("clears a cache and is a no-op when already absent", () => {
    saveCredentials(CREDS, file, { now: () => 1000 });
    clearCredentials(file);
    expect(loadCredentials(file)).toBeUndefined();
    expect(() => clearCredentials(file)).not.toThrow();
  });
});

describe("defaultBundlePath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(defaultBundlePath({ XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/qobuz-helper/bundle.json",
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(defaultBundlePath({}).endsWith("/.config/qobuz-helper/bundle.json")).toBe(
      true,
    );
  });
});
