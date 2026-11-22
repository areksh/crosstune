import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { acquireLockWithin, readLock, tryAcquireLock } from "./file-lock.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qh-lock-"));
  path = join(dir, "jobs.lock");
});

const at = (iso: string) => () => new Date(iso);

describe("tryAcquireLock", () => {
  it("acquires when free and writes pid, host and startedAt", () => {
    const lock = tryAcquireLock(path, { pid: 42, host: "box", now: at("2026-11-02T10:00:00Z") });
    expect(lock).toBeDefined();
    expect(readLock(path)).toEqual({ pid: 42, host: "box", startedAt: "2026-11-02T10:00:00.000Z" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses while a live holder has it", () => {
    tryAcquireLock(path, { pid: 1, host: "box" });
    expect(tryAcquireLock(path, { pid: 2, host: "box", isAlive: () => true })).toBeUndefined();
  });

  it("takes over a lock whose pid is dead", () => {
    tryAcquireLock(path, { pid: 1, host: "box" });
    const lock = tryAcquireLock(path, { pid: 2, host: "box", isAlive: () => false });
    expect(lock).toBeDefined();
    expect(readLock(path)?.pid).toBe(2);
  });

  it("takes over a lock older than staleMs", () => {
    tryAcquireLock(path, { pid: 1, host: "other", now: at("2026-11-02T10:00:00Z") });
    const lock = tryAcquireLock(path, {
      pid: 2,
      host: "box",
      isAlive: () => true,
      staleMs: 60_000,
      now: at("2026-11-02T10:02:00Z"),
    });
    expect(lock).toBeDefined();
  });

  it("does not judge a pid from another host", () => {
    tryAcquireLock(path, { pid: 1, host: "other", now: at("2026-11-02T10:00:00Z") });
    expect(
      tryAcquireLock(path, { pid: 2, host: "box", isAlive: () => false, now: at("2026-11-02T10:00:30Z") }),
    ).toBeUndefined();
  });

  it("takes over an unreadable lock once it is a few seconds old", () => {
    writeFileSync(path, "garbage");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(tryAcquireLock(path, { pid: 2, host: "box" })).toBeDefined();
  });

  it("leaves alone a lock that is still being written", () => {
    writeFileSync(path, "");
    expect(tryAcquireLock(path, { pid: 2, host: "box" })).toBeUndefined();
  });

  it("release removes only its own lock", () => {
    const first = tryAcquireLock(path, { pid: 1, host: "box" });
    // Someone took it over (e.g. we were judged stale).
    const second = tryAcquireLock(path, { pid: 2, host: "box", isAlive: () => false });
    first?.release();
    expect(readLock(path)?.pid).toBe(2);
    second?.release();
    expect(() => readFileSync(path)).toThrow();
  });
});

describe("acquireLockWithin", () => {
  it("waits for the holder to let go", async () => {
    const held = tryAcquireLock(path, { pid: 1, host: "box" })!;
    let polls = 0;
    const lock = await acquireLockWithin(path, 5000, {
      pid: 2,
      host: "box",
      isAlive: () => true,
      sleep: async () => {
        polls += 1;
        if (polls === 3) {
          held.release();
        }
      },
    });
    expect(lock).toBeDefined();
    expect(polls).toBe(3);
  });

  it("gives up after the wait", async () => {
    tryAcquireLock(path, { pid: 1, host: "box" });
    let polls = 0;
    const sleep = async () => {
      polls += 1;
    };
    expect(await acquireLockWithin(path, 1000, { pid: 2, host: "box", isAlive: () => true, sleep })).toBeUndefined();
    expect(polls).toBe(4);
  });
});
