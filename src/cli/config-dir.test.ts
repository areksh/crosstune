import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configDir, moveOldConfigDir } from "./config-dir.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "crosstune-config-test-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("configDir", () => {
  it("is crosstune's folder under XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/crosstune");
  });
});

// The app was called qobuz-helper: its sign-ins, jobs, links and History move once.
describe("moveOldConfigDir", () => {
  const env = () => ({ XDG_CONFIG_HOME: home });

  it("moves the qobuz-helper folder to crosstune's, with what is in it", () => {
    mkdirSync(join(home, "qobuz-helper"));
    writeFileSync(join(home, "qobuz-helper", "history.jsonl"), "kept\n");
    expect(moveOldConfigDir(env())).toBe(true);
    expect(readFileSync(join(home, "crosstune", "history.jsonl"), "utf8")).toBe("kept\n");
    expect(existsSync(join(home, "qobuz-helper"))).toBe(false);
  });

  it("leaves both alone once crosstune's folder exists", () => {
    mkdirSync(join(home, "qobuz-helper"));
    mkdirSync(join(home, "crosstune"));
    writeFileSync(join(home, "crosstune", "history.jsonl"), "new\n");
    expect(moveOldConfigDir(env())).toBe(false);
    expect(readFileSync(join(home, "crosstune", "history.jsonl"), "utf8")).toBe("new\n");
    expect(existsSync(join(home, "qobuz-helper"))).toBe(true);
  });

  it("does nothing when there is no old folder", () => {
    expect(moveOldConfigDir(env())).toBe(false);
    expect(existsSync(join(home, "crosstune"))).toBe(false);
  });
});
