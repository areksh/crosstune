import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearToken,
  defaultSessionPath,
  loadToken,
  saveToken,
} from "./session-store.js";

describe("session-store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qobuz-helper-test-"));
    file = join(dir, "nested", "session.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a token, creating the directory", () => {
    saveToken("tok-123", file);
    expect(loadToken(file)).toBe("tok-123");
  });

  it("writes the file with owner-only permissions", () => {
    saveToken("secret", file);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined when no token is stored", () => {
    expect(loadToken(file)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    saveToken("ok", file); // creates the directory
    writeFileSync(file, "not json {");
    expect(loadToken(file)).toBeUndefined();
  });

  it("treats an empty token as absent", () => {
    saveToken("", file);
    expect(loadToken(file)).toBeUndefined();
  });

  it("clears a stored token and is a no-op when already absent", () => {
    saveToken("tok", file);
    clearToken(file);
    expect(loadToken(file)).toBeUndefined();
    expect(() => clearToken(file)).not.toThrow();
  });
});

describe("defaultSessionPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(defaultSessionPath({ XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/qobuz-helper/session.json",
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const path = defaultSessionPath({});
    expect(path.endsWith("/.config/qobuz-helper/session.json")).toBe(true);
  });
});
