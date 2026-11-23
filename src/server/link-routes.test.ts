import { describe, expect, it, vi } from "vitest";

import type { LinksService } from "../sync/service.js";
import { handleApi, type ApiDeps } from "./router.js";

const PORT = 4321;
const NONCE = "nonce";

function setup() {
  const service = {
    list: vi.fn(() => ({ links: [], invalid: [] })),
    create: vi.fn(async () => ({ link: { id: "abcdef01" }, summary: { reports: [], conflicts: 0 } })),
    run: vi.fn(async () => ({ reports: [], conflicts: 0 })),
    resolve: vi.fn(async () => ({ status: "synced", changes: [] })),
    startFromCommon: vi.fn(async () => ({ reports: [], conflicts: 0 })),
    answer: vi.fn(async () => ({ reports: [], conflicts: 0 })),
    chooseMatch: vi.fn(async () => ({ reports: [], conflicts: 0 })),
    setEnabled: vi.fn(() => ({ id: "abcdef01" })),
    remove: vi.fn(),
    compare: vi.fn(async () => ({ since: "last-sync", copies: [] })),
  } as unknown as LinksService & Record<string, ReturnType<typeof vi.fn>>;
  const deps: ApiDeps = {
    service: undefined as never,
    session: { displayName: "", subscriptionLabel: "" },
    nonce: NONCE,
    port: PORT,
    links: service,
  };
  const call = (method: string, path: string, body?: unknown) =>
    handleApi({ method, path, headers: { host: `127.0.0.1:${PORT}`, nonce: NONCE }, body }, deps);
  return { call, service };
}

describe("link routes", () => {
  it("list and create", async () => {
    const { call, service } = setup();
    expect((await call("GET", "/api/links")).status).toBe(200);
    expect((await call("POST", "/api/links", { name: "Mix" })).status).toBe(200);
    expect(service.create).toHaveBeenCalledWith({ name: "Mix" });
  });

  it("refuse what does not make sense", async () => {
    const { call, service } = setup();
    expect((await call("POST", "/api/links/abcdef01/resolve", { use: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/links/abcdef01/answer", { key: "k", answer: "maybe" })).status).toBe(400);
    expect((await call("POST", "/api/links/abcdef01/match", { key: "k", track: "nope:1" })).status).toBe(400);
    expect((await call("POST", "/api/links/ABC/run")).status).toBe(404);
    expect((await call("POST", "/api/links/abcdef01/explode")).status).toBe(404);
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("pass on what does", async () => {
    const { call, service } = setup();
    await call("POST", "/api/links/abcdef01/resolve", { merge: "tidal", dryRun: true });
    expect(service.resolve).toHaveBeenCalledWith("abcdef01", { merge: "tidal" }, true);
    await call("POST", "/api/links/abcdef01/match", { key: "k", track: null });
    expect(service.chooseMatch).toHaveBeenCalledWith("abcdef01", "k", null);
    await call("POST", "/api/links/abcdef01/answer", { key: "k", answer: "removed" });
    expect(service.answer).toHaveBeenCalledWith("abcdef01", "k", "removed");
    expect(await call("POST", "/api/links/abcdef01/compare")).toEqual({ status: 200, body: { since: "last-sync", copies: [] } });
    expect(service.compare).toHaveBeenCalledWith("abcdef01");
  });

  it("answer 404 for a link that is not there, and 400 for a bad definition", async () => {
    const { call, service } = setup();
    service.run.mockRejectedValueOnce(new Error("No link abcdef01"));
    expect((await call("POST", "/api/links/abcdef01/run")).status).toBe(404);
    service.create.mockRejectedValueOnce(new Error("a link joins playlists on two or more services"));
    expect((await call("POST", "/api/links", {})).status).toBe(400);
  });
});
