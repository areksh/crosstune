import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultHistoryPath, fileHistoryStore } from "./history-store.js";

describe("history-store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qobuz-helper-test-"));
    file = join(dir, "nested", "history.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lives beside the session, honouring XDG_CONFIG_HOME", () => {
    expect(defaultHistoryPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/qobuz-helper/history.jsonl");
  });

  it("reads nothing before anything is written", () => {
    expect(fileHistoryStore(file).read()).toBe("");
  });

  it("appends, creating the directory and an owner-only file", () => {
    const store = fileHistoryStore(file);
    store.append("one\n");
    store.append("two\n");
    expect(store.read()).toBe("one\ntwo\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces the whole file, owner-only, leaving no temporary file", () => {
    const store = fileHistoryStore(file);
    store.append("old\n");
    store.replace("new\n");
    expect(store.read()).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(file))).toEqual(["history.jsonl"]);
  });
});
