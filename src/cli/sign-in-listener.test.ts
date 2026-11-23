import * as http from "node:http";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { signInListener, type SignInListener } from "./sign-in-listener.js";
import type { SignInResult } from "./sign-in-page.js";

/** A port nothing listens on, found by asking the system for one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

async function visit(port: number, path: string): Promise<number | "refused"> {
  // Not fetch: that says `Sec-Fetch-Mode: cors`, which is not a page load.
  return new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", () => resolve("refused"));
  });
}

let open: SignInListener | undefined;
afterEach(() => open?.close());

async function setup(options: { results?: SignInResult[]; stillNeeded?: () => boolean } = {}) {
  const port = await freePort();
  const results = [...(options.results ?? [{ ok: true, message: "Connected" }])];
  const listener = signInListener({
    port,
    complete: async () => results.shift() ?? { ok: true, message: "Connected" },
    ...(options.stillNeeded !== undefined && { stillNeeded: options.stillNeeded }),
  });
  open = listener;
  return { listener, port };
}

describe("signInListener", () => {
  it("closes after a sign-in that worked when no other waits", async () => {
    const { listener, port } = await setup();
    expect(await listener.listen()).toEqual({ ok: true });
    expect(await visit(port, "/callback/tidal?code=c")).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await visit(port, "/callback/spotify?code=c")).toBe("refused");
  });

  it("stays open after a sign-in that worked while another still waits", async () => {
    let waiting = true;
    const { listener, port } = await setup({ stillNeeded: () => waiting });
    await listener.listen();
    expect(await visit(port, "/callback/tidal?code=c")).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    waiting = false;
    expect(await visit(port, "/callback/spotify?code=c")).toBe(200);
  });

  it("starts one server for two listens at once", async () => {
    const { listener } = await setup();
    expect(await Promise.all([listener.listen(), listener.listen()])).toEqual([{ ok: true }, { ok: true }]);
  });

  it("tells the next result, including why a sign-in did not work", async () => {
    const { listener, port } = await setup({ results: [{ ok: false, message: "TIDAL says the sign-in was declined." }] });
    await listener.listen();
    const next = listener.nextResult();
    expect(await visit(port, "/callback/tidal?error=access_denied")).toBe(400);
    expect(await next).toEqual({ ok: false, message: "TIDAL says the sign-in was declined." });
  });

  // Review: a close while the port was still being bound left it bound.
  it("lets the port go when closed while it is still starting", async () => {
    const { listener, port } = await setup();
    const listening = listener.listen();
    listener.close();
    await listening;
    expect(await visit(port, "/callback/tidal?code=c")).toBe("refused");
  });

  it("says the port is in use when another program holds it", async () => {
    const { listener, port } = await setup();
    const other = net.createServer();
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    try {
      expect(await listener.listen()).toMatchObject({ ok: false, problem: expect.stringMatching(/in use/) });
    } finally {
      other.close();
    }
  });

  describe("requests that are not page loads", () => {
    const get = (port: number, headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/?code_autorisation=junk", headers }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          })
          .on("error", reject);
      });

    it("refuses an <img> or fetch without using up the sign-in", async () => {
      const { listener, port } = await setup();
      await listener.listen();
      const host = { Host: `localhost:${port}` };
      expect(await get(port, { ...host, "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors" })).toBe(403);
      expect(await get(port, { ...host, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors" })).toBe(403);
      // Still waiting: the real redirect (a cross-site navigation) completes it.
      expect(
        await get(port, { ...host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site" }),
      ).toBe(200);
    });

    it("lets a request without Fetch Metadata through", async () => {
      const { listener, port } = await setup();
      await listener.listen();
      expect(await get(port, { Host: `localhost:${port}` })).toBe(200);
    });
  });
});
