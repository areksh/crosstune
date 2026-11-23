import * as http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type RunningServer } from "./http.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** A raw request, so the Host header and the body can be whatever the test says. */
function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("the web server", () => {
  let running: RunningServer;

  beforeEach(async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "crosstune-static-"));
    writeFileSync(join(staticDir, "index.html"), '<meta content="__CROSSTUNE_NONCE__">');
    running = await startServer({ staticDir, maxBodyBytes: 100 });
  });

  afterEach(async () => {
    await running.close();
  });

  const local = (): string => `127.0.0.1:${running.port}`;

  it("serves the page to its own host with the security headers", async () => {
    const reply = await send(running.port, { path: "/", headers: { Host: local() } });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain(running.nonce);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["x-frame-options"]).toBe("DENY");
    expect(reply.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("does not serve the page (or its nonce) to a foreign host", async () => {
    const reply = await send(running.port, { path: "/", headers: { Host: `attacker.example:${running.port}` } });
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain(running.nonce);
  });

  it("puts the security headers on API answers too", async () => {
    const reply = await send(running.port, { path: "/api/session", headers: { Host: local() } });
    expect(reply.status).toBe(403);
    expect(reply.headers["x-frame-options"]).toBe("DENY");
  });

  it("refuses a foreign host before reading its body", async () => {
    const reply = await send(running.port, {
      method: "POST",
      path: "/api/anything",
      headers: { Host: `attacker.example:${running.port}`, "Content-Type": "application/json" },
      body: "x".repeat(10_000),
    });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.text)).toEqual({ error: "forbidden: host not allowed" });
  });

  it("answers 413 to a body over the limit, however it is sent", async () => {
    const headers = { Host: local(), "X-Crosstune-Nonce": running.nonce, "Content-Type": "application/json" };
    const declared = await send(running.port, { method: "POST", path: "/api/anything", headers, body: "x".repeat(500) });
    expect(declared.status).toBe(413);
    const chunked = await send(running.port, {
      method: "POST",
      path: "/api/anything",
      headers: { ...headers, "Transfer-Encoding": "chunked" },
      body: "x".repeat(500),
    });
    expect(chunked.status).toBe(413);
  });
});
