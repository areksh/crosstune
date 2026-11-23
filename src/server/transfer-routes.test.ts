import { describe, expect, it, vi } from "vitest";

import { Accounts } from "../accounts/accounts.js";
import { MemoryStore } from "../features/fake-account.test-support.js";
import { Journal, recordingClient } from "../features/journal.js";
import { MemoryMatches } from "../features/match.js";
import { ServiceError } from "../services/errors.js";
import { ServiceHub } from "../services/hub.js";
import { tagId, type PlaylistId, type ServiceName, type TrackId, type UserId } from "../services/ids.js";
import type { MusicService } from "../services/service.js";
import { SyncAccount } from "../sync/world.test-support.js";
import { handleApi, type ApiDeps } from "./router.js";

const PORT = 4321;
const NONCE = "nonce";

function setup() {
  const journal = new Journal({ store: new MemoryStore(), source: "web" });
  const hub = new ServiceHub();
  const accounts = new Map<ServiceName, SyncAccount & Record<string, unknown>>();
  for (const name of ["qobuz", "tidal"] as const) {
    const account = new SyncAccount(name);
    const lists: { id: PlaylistId; name: string; ownerId: UserId }[] = [];
    const full = Object.assign(account, {
      capabilities: {},
      account: () => ({ id: tagId<UserId>(name, 1), displayName: name }),
      createPlaylist: async (title: string) => {
        const id = account.seed(title, []);
        lists.push({ id, name: title, ownerId: tagId<UserId>(name, 1) });
        return { id, name: title };
      },
      getUserPlaylists: vi.fn(async () => lists),
      getFavoriteTracks: vi.fn(async () => [{ id: account.id(1), title: "Song 1", artist: "Artist", isrc: "ISRC1" }]),
      addFavoriteTracks: async () => {},
      deletePlaylist: async () => {},
    });
    accounts.set(name, full as never);
    hub.connect(recordingClient(full as unknown as MusicService, journal));
  }
  const matches = new MemoryMatches();
  const release = vi.fn();
  const deps: ApiDeps = {
    service: undefined as never,
    session: { displayName: "", subscriptionLabel: "" },
    nonce: NONCE,
    port: PORT,
    history: { journal },
    matches,
    acquireWriteLock: async () => ({ release }),
    accounts: { accounts: { rejected: () => {} } as unknown as Accounts, hub, listen: async () => ({ ok: true }), forget: () => {} },
  };
  const call = (path: string, body?: unknown, service?: string, method = "POST") =>
    handleApi({ method, path, headers: { host: `127.0.0.1:${PORT}`, nonce: NONCE, service }, body }, deps);
  return { call, hub, journal, matches, account: (name: ServiceName) => accounts.get(name)! };
}

const songs = (...numbers: number[]) =>
  numbers.map((n) => ({ id: `qobuz:${n}`, title: `Song ${n}`, artist: "Artist", isrc: `ISRC${n}`, duration: 200 }));

describe("transfer routes", () => {
  it("find songs on another service, writing nothing", async () => {
    const { call, account, journal } = setup();
    account("tidal").absent.add(3);
    const res = await call("/api/transfer/resolve", { to: "tidal", tracks: songs(1, 3) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      to: "tidal",
      counts: { exact: 1, likely: 0, missing: 1 },
      matches: [{ grade: "exact", track: { id: "tidal:1" } }, { grade: "missing" }],
    });
    expect([account("tidal").writes, journal.items()]).toEqual([[], []]);
  });

  it("find a whole playlist's songs", async () => {
    const { call, account } = setup();
    const id = account("tidal").seed("Mix", [1, 2]);
    const res = await call("/api/transfer/resolve", { to: "qobuz", playlistId: id });
    expect(res.body).toMatchObject({ counts: { exact: 2 } });
  });

  it("make a playlist there, as one undoable entry, and remember decisions", async () => {
    const { call, account, journal, matches } = setup();
    const res = await call("/api/transfer/commit", {
      to: "tidal",
      destination: { type: "new", name: "Copy", isPublic: false },
      picks: [
        { source: "qobuz:1", track: "tidal:1", decided: false },
        { source: "qobuz:2", track: "tidal:7", decided: true },
        { source: "qobuz:3", track: null, decided: true },
      ],
    });
    expect(res.status).toBe(200);
    const { playlistId } = res.body as { playlistId: PlaylistId };
    expect(account("tidal").songs(playlistId)).toEqual([1, 7]);
    expect(matches.recall("qobuz:2" as TrackId, "tidal")).toBe("tidal:7");
    expect(matches.recall("qobuz:3" as TrackId, "tidal")).toBeNull();
    expect(journal.items()).toHaveLength(1);
    expect(journal.items()[0]).toMatchObject({ tool: "transfer", label: "Created Copy with 2 tracks" });
  });

  it.each([
    ["/api/transfer/resolve", { to: "nope", tracks: songs(1) }],
    ["/api/transfer/resolve", { to: "tidal" }],
    ["/api/transfer/resolve", { to: "tidal", tracks: [] }],
    ["/api/transfer/resolve", { to: "tidal", tracks: [{ id: "bad", title: "x" }] }],
    ["/api/transfer/resolve", { to: "tidal", tracks: [{ id: "qobuz:1" }] }],
    ["/api/transfer/commit", { to: "tidal", destination: { type: "new", name: " " }, picks: [{ source: "qobuz:1", track: "tidal:1" }] }],
    ["/api/transfer/commit", { to: "tidal", destination: { type: "existing", playlistId: "qobuz:1" }, picks: [{ source: "qobuz:1", track: "tidal:1" }] }],
    ["/api/transfer/commit", { to: "tidal", destination: { type: "favourites" }, picks: [{ source: "qobuz:1", track: "qobuz:1" }] }],
    ["/api/transfer/commit", { to: "tidal", destination: { type: "favourites" }, picks: [{ source: "qobuz:1", track: "nope" }] }],
    ["/api/transfer/commit", { to: "tidal", destination: { type: "favourites" }, picks: [] }],
  ])("answer 400 to %s %j", async (path, body) => {
    const { call, account } = setup();
    expect((await call(path, body)).status).toBe(400);
    expect(account("tidal").writes).toEqual([]);
  });

  it("answer 409 for a service that is not connected", async () => {
    expect((await setup().call("/api/transfer/resolve", { to: "spotify", tracks: songs(1) })).status).toBe(409);
  });

  it("refuse to write to a playlist of someone else's", async () => {
    const { call, account } = setup();
    const id = account("tidal").seed("Theirs", []);
    account("tidal").disown(id);
    const res = await call("/api/transfer/commit", {
      to: "tidal",
      destination: { type: "existing", playlistId: id },
      picks: [{ source: "qobuz:1", track: "tidal:1", decided: false }],
    });
    expect(res.status).toBe(403);
    expect(account("tidal").writes).toEqual([]);
  });
});

describe("all services at once", () => {
  it("lists every connected service's playlists, each the user's own by its account", async () => {
    const { call, account } = setup();
    await (account("qobuz") as unknown as MusicService).createPlaylist("Q");
    await (account("tidal") as unknown as MusicService).createPlaylist("T");
    const res = await call("/api/manager/playlists", undefined, "all", "GET");
    expect((res.body as { playlists: { name: string; owned: boolean }[] }).playlists.map((p) => [p.name, p.owned])).toEqual([
      ["Q", true],
      ["T", true],
    ]);
  });

  it("shows the rest when one service fails, and says which is missing", async () => {
    const { call, account } = setup();
    await (account("qobuz") as unknown as MusicService).createPlaylist("Q");
    (account("tidal")["getUserPlaylists"] as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ServiceError("tidal", "network", "offline"),
    );
    const res = await call("/api/manager/playlists", undefined, "all", "GET");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ playlists: [{ name: "Q" }], unavailable: [{ service: "tidal", error: "offline" }] });
  });

  it("opens a playlist of whichever service its id names", async () => {
    const { call, account } = setup();
    const id = account("tidal").seed("T", [1]);
    const res = await call("/api/manager/open", { playlistId: id }, "all");
    expect(res.body).toMatchObject({ playlist: { name: "T" }, entries: [{ id: "tidal:1" }] });
  });

  it("counts the favourites of all for the stats, and fails whole when one cannot be read", async () => {
    const { call, account } = setup();
    const res = await call("/api/stats", { source: { type: "favourites" } }, "all");
    expect(res.status).toBe(200);
    (account("tidal")["getFavoriteTracks"] as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ServiceError("tidal", "network", "offline"),
    );
    expect((await call("/api/stats", { source: { type: "favourites" } }, "all")).status).toBe(502);
  });

  it.each(["/api/deduplicate/scan", "/api/upgrade/resolve", "/api/resolve", "/api/commit"])(
    "is refused by %s, which works on one service",
    async (path) => {
      const res = await setup().call(path, {}, "all");
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toMatch(/choose one/i);
    },
  );
});
