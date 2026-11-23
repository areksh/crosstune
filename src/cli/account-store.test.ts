import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tagId, type UserId } from "../services/ids.js";
import type { Tokens } from "../services/oauth.js";
import { fileAccountStore, fileTokenVault, hasSavedSignIn, removeTokens } from "./account-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qh-accounts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tokens: Tokens = { accessToken: "A", refreshToken: "R", expiresAt: 5, authorisedAt: 1, scopes: ["x"] };
const mode = (path: string) => statSync(path).mode & 0o777;

describe("fileAccountStore", () => {
  it("keeps accounts and client ids, owner-only", () => {
    const store = fileAccountStore(dir);
    store.saveAccount("tidal", { id: tagId<UserId>("tidal", "u:1"), displayName: "Arek", since: 7 });
    store.saveClientId("tidal", "cid");
    const again = fileAccountStore(dir);
    expect(again.account("tidal")).toEqual({ id: "tidal:u:1", displayName: "Arek", since: 7 });
    expect(again.clientId("tidal")).toBe("cid");
    expect(again.account("qobuz")).toBeUndefined();
    expect(mode(join(dir, "accounts.json"))).toBe(0o600);
  });

  it("removes an account but keeps the client id", () => {
    const store = fileAccountStore(dir);
    store.saveAccount("tidal", { id: tagId<UserId>("tidal", "1"), displayName: "A", since: 0 });
    store.saveClientId("tidal", "cid");
    store.removeAccount("tidal");
    expect(store.account("tidal")).toBeUndefined();
    expect(store.clientId("tidal")).toBe("cid");
  });

  it("ignores an account of another service under a service's name, and junk", () => {
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({ version: 1, accounts: { tidal: { id: "qobuz:1", displayName: "x", since: 0 }, spotify: 5 }, clientIds: { tidal: 9 } }),
    );
    const store = fileAccountStore(dir);
    expect(store.account("tidal")).toBeUndefined();
    expect(store.account("spotify")).toBeUndefined();
    expect(store.clientId("tidal")).toBeUndefined();
  });

  it("refuses to overwrite a file it cannot read", () => {
    writeFileSync(join(dir, "accounts.json"), "{ not json");
    const store = fileAccountStore(dir);
    expect(() => store.saveClientId("tidal", "cid")).toThrow(/accounts\.json/);
    expect(readFileSync(join(dir, "accounts.json"), "utf8")).toBe("{ not json");
  });
});

describe("fileTokenVault", () => {
  it("keeps a service's tokens, owner-only, apart from others'", () => {
    const vault = fileTokenVault("tidal", dir);
    expect(vault.load()).toBeUndefined();
    vault.save(tokens);
    expect(fileTokenVault("tidal", dir).load()).toEqual(tokens);
    expect(fileTokenVault("spotify", dir).load()).toBeUndefined();
    expect(mode(join(dir, "sessions", "tidal.json"))).toBe(0o600);
    removeTokens("tidal", dir);
    expect(vault.load()).toBeUndefined();
    removeTokens("tidal", dir);
  });

  it.each(["{", "[]", '{"accessToken":""}', '{"accessToken":"A"}'])("reads %j as no tokens", (text) => {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "tidal.json"), text);
    expect(fileTokenVault("tidal", dir).load()).toBeUndefined();
  });

  it("lets one refresh run at a time, across vaults of the same file", async () => {
    const order: string[] = [];
    const run = (name: string) =>
      fileTokenVault("tidal", dir, { pollMs: 5 }).exclusive(async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`${name} out`);
      });
    await Promise.all([run("a"), run("b")]);
    expect([order[0]?.[0] === order[1]?.[0], order[2]?.[0] === order[3]?.[0]]).toEqual([true, true]);
  });

  it("frees the lock when a refresh fails", async () => {
    const vault = fileTokenVault("tidal", dir, { pollMs: 5 });
    await expect(vault.exclusive(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await vault.exclusive(async () => 1)).toBe(1);
  });

  it("gives up with a temporary error when the lock stays taken", async () => {
    const vault = fileTokenVault("tidal", dir, { pollMs: 5, waitMs: 20 });
    let release = (): void => {};
    const held = vault.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(fileTokenVault("tidal", dir, { pollMs: 5, waitMs: 20 }).exclusive(async () => 1)).rejects.toMatchObject({
      kind: "network",
    });
    release();
    await held;
  });
});

describe("hasSavedSignIn", () => {
  it("says whether a sign-in is saved, Qobuz's in its own file", () => {
    expect(hasSavedSignIn("qobuz", dir)).toBe(false);
    writeFileSync(join(dir, "session.json"), "{}");
    expect(hasSavedSignIn("qobuz", dir)).toBe(true);
    expect(hasSavedSignIn("tidal", dir)).toBe(false);
    fileTokenVault("tidal", dir).save(tokens);
    expect(hasSavedSignIn("tidal", dir)).toBe(true);
  });
});
