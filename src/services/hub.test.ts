import { describe, expect, it, vi } from "vitest";

import { ServiceHub } from "./hub.js";
import { tagId, type ServiceName } from "./ids.js";
import { MUSIC_READS, MUSIC_WRITES, type MusicService } from "./service.js";

/** A service whose every method records its call. */
function fake(name: ServiceName) {
  const calls: unknown[][] = [];
  const service: Record<string, unknown> = { name, capabilities: {}, account: () => undefined };
  for (const method of [...MUSIC_READS, ...MUSIC_WRITES]) {
    service[method] = vi.fn(async (...args: unknown[]) => {
      calls.push([method, ...args]);
      return [];
    });
  }
  return { service: service as unknown as MusicService, calls };
}

function world() {
  const qobuz = fake("qobuz");
  const tidal = fake("tidal");
  const hub = new ServiceHub();
  hub.connect(qobuz.service);
  hub.connect(tidal.service);
  return { hub, qobuz, tidal };
}

const q = (n: number) => tagId<never>("qobuz", n);
const t = (n: number) => tagId<never>("tidal", n);

describe("ServiceHub", () => {
  it("routes by the id's service, although the numbers are the same", async () => {
    const { hub, qobuz, tidal } = world();
    await hub.getPlaylistTracks(t(1));
    await hub.getAlbum(q(1));
    await hub.getTrack(t(4));
    expect(tidal.calls).toEqual([["getPlaylistTracks", "tidal:1"], ["getTrack", "tidal:4"]]);
    expect(qobuz.calls).toEqual([["getAlbum", "qobuz:1"]]);
  });

  it("splits a list by service, keeping each one's order", async () => {
    const { hub, qobuz, tidal } = world();
    await hub.removeFavoriteTracks([q(1), t(1), q(2)]);
    expect(qobuz.calls).toEqual([["removeFavoriteTracks", ["qobuz:1", "qobuz:2"]]]);
    expect(tidal.calls).toEqual([["removeFavoriteTracks", ["tidal:1"]]]);
  });

  it.each([
    ["addTracksToPlaylist", [q(9), [q(1), t(1)]]],
    ["removeTracksFromPlaylist", [q(9), [t(1)]]],
    ["movePlaylistTracks", [q(9), [t(1)], 1]],
  ] as const)("%s refuses another service's ids before any call", async (method, args) => {
    const { hub, qobuz, tidal } = world();
    const call = (hub as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!;
    await expect(call.apply(hub, [...args])).rejects.toMatchObject({ kind: "bad-id" });
    expect([...qobuz.calls, ...tidal.calls]).toEqual([]);
  });

  it("fails a list naming a service that is not connected before any call", async () => {
    const { hub, qobuz } = world();
    hub.disconnect("tidal");
    await expect(hub.addFavoriteTracks([q(1), t(1)])).rejects.toMatchObject({
      kind: "not-connected",
      service: "tidal",
    });
    expect(qobuz.calls).toEqual([]);
  });

  it("lists what is connected, in the usual order", () => {
    const hub = new ServiceHub();
    hub.connect(fake("spotify").service);
    hub.connect(fake("qobuz").service);
    expect(hub.connected()).toEqual(["qobuz", "spotify"]);
    expect(() => hub.service("tidal")).toThrow(/TIDAL.*not connected/);
  });

  it("scoped to a service, searches there and still routes ids anywhere", async () => {
    const { hub, qobuz, tidal } = world();
    const view = hub.scoped("tidal");
    expect(view.name).toBe("tidal");
    await view.searchTracks("roads", 5);
    await view.createPlaylist("Mix", { isPublic: true });
    await view.getFavoriteTracks();
    await view.findByIsrc(["X"]);
    await view.getPlaylistTracks(q(3));
    expect(tidal.calls).toEqual([
      ["searchTracks", "roads", 5],
      ["createPlaylist", "Mix", { isPublic: true }],
      ["getFavoriteTracks"],
      ["findByIsrc", ["X"]],
    ]);
    expect(qobuz.calls).toEqual([["getPlaylistTracks", "qobuz:3"]]);
  });

  it("scoped, follows a service connected or replaced later", async () => {
    const hub = new ServiceHub();
    const view = hub.scoped("qobuz");
    await expect(view.searchTracks("x")).rejects.toMatchObject({ kind: "not-connected" });
    const first = fake("qobuz");
    hub.connect(first.service);
    await view.searchTracks("x");
    expect(first.calls).toEqual([["searchTracks", "x"]]);
  });
});
