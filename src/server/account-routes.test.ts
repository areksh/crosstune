import { describe, expect, it, vi } from "vitest";

import { Accounts, type AccountRecord, type AccountStore, type Connector } from "../accounts/accounts.js";
import { ServiceError } from "../services/errors.js";
import { ServiceHub } from "../services/hub.js";
import { tagId, type ServiceName, type UserId } from "../services/ids.js";
import type { MusicService } from "../services/service.js";
import { handleApi, type ApiDeps, type QobuzApiService } from "./router.js";

const PORT = 4321;
const NONCE = "nonce";

function music(service: ServiceName, methods: Partial<MusicService> = {}): MusicService {
  return {
    name: service,
    capabilities: {},
    account: () => ({ id: tagId<UserId>(service, 1), displayName: `${service} user`, plan: "Plus" }),
    getUserPlaylists: async () => [{ id: tagId(service, 1), name: `on ${service}` }],
    ...methods,
  } as unknown as MusicService;
}

function setup(overrides: Partial<Record<ServiceName, Partial<MusicService>>> = {}) {
  const records = new Map<ServiceName, AccountRecord>();
  const ids = new Map<ServiceName, string>();
  const store: AccountStore = {
    account: (s) => records.get(s),
    saveAccount: (s, r) => void records.set(s, r),
    removeAccount: (s) => void records.delete(s),
    clientId: (s) => ids.get(s),
    saveClientId: (s, id) => void ids.set(s, id),
  };
  const connector = (service: ServiceName): Connector => ({
    service,
    needsClientId: service !== "qobuz",
    startUrl: async ({ state }) => `https://${service}.example/?state=${state}`,
    finish: async () => ({ music: music(service, overrides[service]), keep: () => {} }),
    resume: async () => undefined,
    signOut: () => {},
  });
  const hub = new ServiceHub();
  const accounts = new Accounts({
    hub,
    store,
    connectors: (["qobuz", "tidal"] as const).map(connector),
    wrap: (s) => s,
    onChange: () => {},
  });
  const listen = vi.fn(async (): Promise<{ ok: true } | { ok: false; problem: string }> => ({ ok: true }));
  const forget = vi.fn();
  const deps: ApiDeps = {
    service: undefined as unknown as QobuzApiService,
    session: { displayName: "", subscriptionLabel: "" },
    nonce: NONCE,
    port: PORT,
    accounts: { accounts, hub, listen, forget },
  };
  const call = (method: string, path: string, body?: unknown, service?: string) =>
    handleApi(
      {
        method,
        path,
        headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, nonce: NONCE, service },
        body,
      },
      deps,
    );
  const connect = async (service: ServiceName) => {
    const started = (await call("POST", "/api/accounts/start", { service })).body as { url: string };
    const state = new URL(started.url).searchParams.get("state");
    return call("POST", "/api/accounts/paste", {
      address:
        service === "qobuz" ? "http://localhost/?code_autorisation=c" : `http://127.0.0.1/callback/${service}?code=c&state=${state}`,
    });
  };
  return { call, connect, hub, accounts, listen, forget, ids };
}

describe("account routes", () => {
  it("list the accounts with nothing connected", async () => {
    const res = await setup().call("GET", "/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accounts: [
        { service: "qobuz", label: "Qobuz", status: "signed-out" },
        { service: "tidal", label: "TIDAL", status: "needs-client-id" },
      ],
    });
  });

  it("take a client id, start a sign-in and listen for its redirect", async () => {
    const { call, listen, ids } = setup();
    expect((await call("POST", "/api/accounts/client-id", { service: "tidal", clientId: "cid" })).status).toBe(200);
    expect(ids.get("tidal")).toBe("cid");
    const res = await call("POST", "/api/accounts/start", { service: "tidal" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: expect.stringContaining("https://tidal.example/"), listening: true });
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("say when the redirect cannot be listened for, leaving the paste", async () => {
    const { call, connect, listen } = setup();
    listen.mockResolvedValue({ ok: false, problem: "Port 53683 is in use." });
    const res = await call("POST", "/api/accounts/start", { service: "qobuz" });
    expect(res.body).toMatchObject({ listening: false, problem: "Port 53683 is in use." });
    expect((await connect("qobuz")).body).toEqual({ service: "qobuz", displayName: "qobuz user" });
  });

  it.each([
    ["/api/accounts/start", { service: "nope" }],
    ["/api/accounts/start", {}],
    ["/api/accounts/client-id", { service: "tidal", clientId: "a b" }],
    ["/api/accounts/paste", { address: 5 }],
    ["/api/accounts/paste", { address: "hello" }],
    ["/api/accounts/sign-out", {}],
    ["/api/accounts/start", { service: "tidal" }],
  ])("answer 400 to %s %j", async (path, body) => {
    expect((await setup().call("POST", path, body)).status).toBe(400);
  });

  it("sign out, and forget with everything kept about the service", async () => {
    const { call, connect, hub, forget } = setup();
    await connect("qobuz");
    await call("POST", "/api/accounts/sign-out", { service: "qobuz" });
    expect(hub.connected()).toEqual([]);
    expect(forget).not.toHaveBeenCalled();
    expect((await call("POST", "/api/accounts/forget", { service: "qobuz" })).status).toBe(200);
    expect(forget).toHaveBeenCalledWith("qobuz");
  });

  it("put no code, state or token in an answer but the address to open", async () => {
    const { call, connect } = setup();
    const done = await connect("qobuz");
    const list = await call("GET", "/api/accounts");
    expect(JSON.stringify([done.body, list.body])).not.toMatch(/token|verifier|code=|state=/i);
  });

  it("are guarded by the nonce like every route", async () => {
    const { accounts, hub } = setup();
    const res = await handleApi(
      { method: "GET", path: "/api/accounts", headers: { host: `127.0.0.1:${PORT}`, nonce: "wrong" } },
      { service: undefined as never, session: { displayName: "", subscriptionLabel: "" }, nonce: NONCE, port: PORT, accounts: { accounts, hub, listen: async () => ({ ok: true }), forget: () => {} } },
    );
    expect(res.status).toBe(403);
  });
});

describe("other routes", () => {
  it.each(["/api/playlists", "/api/session", "/api/manager/playlists"])(
    "answer 409 to %s with nothing connected, saying what to do",
    async (path) => {
      const res = await setup().call("GET", path);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ kind: "not-connected" });
      expect((res.body as { error: string }).error).toMatch(/connect/i);
    },
  );

  it("use the service chosen on the page, else the first connected", async () => {
    const { call, connect, ids } = setup();
    ids.set("tidal", "cid");
    await connect("tidal");
    await connect("qobuz");
    const names = async (service?: string) =>
      ((await call("GET", "/api/playlists", undefined, service)).body as { playlists: { name: string }[] }).playlists.map((p) => p.name);
    expect(await names()).toEqual(["on qobuz"]);
    expect(await names("tidal")).toEqual(["on tidal"]);
    expect(await names("nope")).toEqual(["on qobuz"]);
    expect((await call("GET", "/api/playlists", undefined, "spotify")).status).toBe(409);
    expect((await call("GET", "/api/session", undefined, "tidal")).body).toMatchObject({
      displayName: "tidal user",
      subscriptionLabel: "Plus",
      service: "tidal",
    });
  });

  it("tell whose playlists are the user's by the service's own account", async () => {
    const { call, connect, ids } = setup({
      tidal: {
        getUserPlaylists: async () => [
          { id: tagId("tidal", 1), name: "mine", ownerId: tagId("tidal", 1) },
          { id: tagId("tidal", 2), name: "theirs", ownerId: tagId("tidal", 9) },
        ],
      },
    });
    ids.set("tidal", "cid");
    await connect("tidal");
    const res = await call("GET", "/api/manager/playlists", undefined, "tidal");
    expect((res.body as { playlists: { owned: boolean }[] }).playlists.map((p) => p.owned)).toEqual([true, false]);
  });

  it("mark a service whose sign-in is rejected, so the page can say so", async () => {
    const { call, connect, accounts } = setup({
      qobuz: {
        getUserPlaylists: async () => {
          throw new ServiceError("qobuz", "authentication", "session expired");
        },
      },
    });
    await connect("qobuz");
    expect((await call("GET", "/api/playlists")).status).toBe(502);
    expect(accounts.view()[0]).toMatchObject({ status: "expired" });
    expect((await call("GET", "/api/playlists")).status).toBe(409);
  });
});
