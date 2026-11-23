import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../services/errors.js";
import { ServiceHub } from "../services/hub.js";
import { tagId, type ServiceName, type UserId } from "../services/ids.js";
import type { Account, MusicService } from "../services/service.js";
import { Accounts, type AccountRecord, type AccountStore, type Connector } from "./accounts.js";

const account = (service: ServiceName, n: number): Account => ({
  id: tagId<UserId>(service, n),
  displayName: `User ${n}`,
});

function music(service: ServiceName, n: number): MusicService {
  return { name: service, capabilities: {}, account: () => account(service, n) } as unknown as MusicService;
}

function store(): AccountStore & { accounts: Map<ServiceName, AccountRecord>; ids: Map<ServiceName, string> } {
  const accounts = new Map<ServiceName, AccountRecord>();
  const ids = new Map<ServiceName, string>();
  return {
    accounts,
    ids,
    account: (service) => accounts.get(service),
    saveAccount: (service, record) => void accounts.set(service, record),
    removeAccount: (service) => void accounts.delete(service),
    clientId: (service) => ids.get(service),
    saveClientId: (service, id) => void ids.set(service, id),
  };
}

/** A connector whose sign-in gives user `n`, with nothing saved to resume. */
function connector(service: ServiceName, overrides: Partial<Connector> = {}): Connector {
  return {
    service,
    needsClientId: service !== "qobuz",
    startUrl: async ({ state, challenge }) => `https://${service}.example/?state=${state}&c=${challenge}`,
    finish: vi.fn(async () => ({ music: music(service, 1), keep: vi.fn() })),
    resume: vi.fn(async () => undefined),
    signOut: vi.fn(),
    ...overrides,
  };
}

function setup(connectors: Connector[] = [connector("qobuz"), connector("tidal"), connector("spotify")]) {
  const hub = new ServiceHub();
  const saved = store();
  const onChange = vi.fn();
  const accounts = new Accounts({ hub, store: saved, connectors, wrap: (s) => s, onChange, now: () => 1000 });
  const signIn = async (service: ServiceName) => {
    const { url } = await accounts.start(service);
    const state = new URL(url).searchParams.get("state");
    return accounts.complete(
      service === "qobuz" ? "/callback/qobuz?code_autorisation=c" : `/callback/${service}?code=c&state=${state}`,
    );
  };
  return { hub, accounts, saved, onChange, signIn };
}

describe("Accounts", () => {
  it("starts with nothing connected", () => {
    const { accounts, hub } = setup();
    expect(hub.connected()).toEqual([]);
    expect(accounts.view().map((a) => [a.service, a.status])).toEqual([
      ["qobuz", "signed-out"],
      ["tidal", "needs-client-id"],
      ["spotify", "needs-client-id"],
    ]);
  });

  it("connects a service through its sign-in", async () => {
    const { accounts, hub, saved, onChange, signIn } = setup();
    accounts.setClientId("tidal", " my-client ");
    expect(saved.ids.get("tidal")).toBe("my-client");
    expect(await signIn("tidal")).toEqual({ service: "tidal", displayName: "User 1" });
    expect(hub.connected()).toEqual(["tidal"]);
    expect(saved.accounts.get("tidal")).toEqual({ id: "tidal:1", displayName: "User 1", since: 1000 });
    expect(onChange).toHaveBeenCalled();
    expect(accounts.view()[1]).toMatchObject({ status: "connected", displayName: "User 1" });
  });

  it("will not start without the client id a service needs", async () => {
    await expect(setup().accounts.start("spotify")).rejects.toThrow(/client id/i);
  });

  it.each(["", "  ", "has space", "x".repeat(300), "a/b"])("refuses the client id %j", (id) => {
    expect(() => setup().accounts.setClientId("tidal", id)).toThrow(/client id/i);
  });

  it("keeps the tokens only once the account is accepted", async () => {
    const keep = vi.fn();
    const { signIn } = setup([connector("qobuz", { finish: async () => ({ music: music("qobuz", 1), keep }) })]);
    await signIn("qobuz");
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it("refuses another account than the one known, keeping what there was", async () => {
    let user = 1;
    const keep = vi.fn();
    const { hub, saved, signIn } = setup([
      connector("qobuz", { finish: async () => ({ music: music("qobuz", user), keep }) }),
    ]);
    await signIn("qobuz");
    user = 2;
    await expect(signIn("qobuz")).rejects.toThrow(/User 1.*[Ff]orget/s);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(saved.accounts.get("qobuz")?.id).toBe("qobuz:1");
    expect(hub.service("qobuz").account()?.id).toBe("qobuz:1");
  });

  it("resumes what is saved, one service's failure leaving the others", async () => {
    const { accounts, hub } = setup([
      connector("qobuz", { resume: async () => music("qobuz", 1) }),
      connector("tidal", {
        resume: async () => {
          throw new ServiceError("tidal", "network", "offline");
        },
      }),
      connector("spotify", {
        resume: async () => {
          throw new ServiceError("spotify", "authentication", "expired");
        },
      }),
    ]);
    await accounts.resume();
    expect(hub.connected()).toEqual(["qobuz"]);
    expect(accounts.view().map((a) => [a.service, a.status, a.problem])).toEqual([
      ["qobuz", "connected", undefined],
      ["tidal", "unreachable", "offline"],
      ["spotify", "expired", "expired"],
    ]);
  });

  it("takes any failure but a rejection as temporary, so a lost network never looks signed out", async () => {
    const { accounts } = setup([
      connector("qobuz", {
        resume: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ]);
    await accounts.resume();
    expect(accounts.view()[0]).toMatchObject({ status: "unreachable", problem: "fetch failed" });
  });

  it("does not resume a session of another account", async () => {
    const { accounts, hub, saved } = setup([connector("qobuz", { resume: async () => music("qobuz", 2) })]);
    saved.accounts.set("qobuz", { id: tagId<UserId>("qobuz", 1), displayName: "User 1", since: 0 });
    await accounts.resume();
    expect(hub.connected()).toEqual([]);
    expect(accounts.view()[0]?.status).toBe("expired");
  });

  it("signs out, keeping who it was", async () => {
    const signOut = vi.fn();
    const { accounts, hub, saved, signIn } = setup([connector("qobuz", { signOut })]);
    await signIn("qobuz");
    accounts.signOut("qobuz");
    expect(signOut).toHaveBeenCalled();
    expect(hub.connected()).toEqual([]);
    expect(saved.accounts.get("qobuz")?.displayName).toBe("User 1");
    expect(accounts.view()[0]).toMatchObject({ status: "signed-out", knownAs: "User 1" });
  });

  it("forgets the account too, so another can sign in", async () => {
    let user = 1;
    const { accounts, saved, signIn } = setup([
      connector("qobuz", { finish: async () => ({ music: music("qobuz", user), keep: () => {} }) }),
    ]);
    await signIn("qobuz");
    accounts.forget("qobuz");
    expect(saved.accounts.size).toBe(0);
    user = 2;
    await signIn("qobuz");
    expect(saved.accounts.get("qobuz")?.id).toBe("qobuz:2");
  });

  it("marks a service whose sign-in stopped working while connected", async () => {
    const { accounts, hub, signIn } = setup([connector("qobuz")]);
    await signIn("qobuz");
    accounts.rejected("qobuz", "session expired");
    expect(hub.connected()).toEqual([]);
    expect(accounts.view()[0]).toMatchObject({ status: "expired", problem: "session expired" });
  });

  it("warns from 14 days before a sign-in ends for good", async () => {
    const DAY = 86_400_000;
    const ends = 1000 + 20 * DAY;
    let now = 1000;
    const hub = new ServiceHub();
    const accounts = new Accounts({
      hub,
      store: store(),
      connectors: [connector("qobuz", { endsAt: () => ends })],
      wrap: (s) => s,
      onChange: () => {},
      now: () => now,
    });
    await accounts.start("qobuz");
    await accounts.complete("/callback/qobuz?code_autorisation=c");
    expect(accounts.view()[0]).toMatchObject({ endsAt: ends, endsSoon: false });
    now = ends - 13 * DAY;
    expect(accounts.view()[0]).toMatchObject({ endsSoon: true });
  });

  it("puts each connected service through the recorder", async () => {
    const hub = new ServiceHub();
    const wrapped = music("qobuz", 1);
    const accounts = new Accounts({ hub, store: store(), connectors: [connector("qobuz")], wrap: () => wrapped, onChange: () => {} });
    await accounts.start("qobuz");
    await accounts.complete("/callback/qobuz?code_autorisation=c");
    expect(hub.service("qobuz")).toBe(wrapped);
  });

  it("shows no token, code or client secret in its view", async () => {
    const { accounts, signIn } = setup();
    accounts.setClientId("tidal", "cid");
    await signIn("tidal");
    const text = JSON.stringify(accounts.view());
    expect(text).not.toMatch(/token|verifier|code=|state=/i);
  });
});
