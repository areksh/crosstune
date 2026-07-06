/**
 * node:http glue for the local web server.
 *
 * This is the I/O boundary: it binds a socket on 127.0.0.1, reads each request
 * off the wire into the plain {@link ApiRequest} that {@link handleApi}
 * consumes, writes the JSON response back, and serves the static frontend from
 * `dist/web`. The routing, validation and security all live in the pure
 * `router`/`security` modules, which are unit-tested; only the wiring here is
 * not.
 *
 * The per-run nonce is generated here and injected into the served
 * `index.html`, so the same-origin UI can read it and echo it back on API
 * calls while no other page can.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleApi,
  type ApiResponse,
  type PlaylistService,
  type SessionInfo,
} from "./router.js";

/** Placeholder in index.html replaced with the per-run nonce at serve time. */
const NONCE_PLACEHOLDER = "__QOBUZ_NONCE__";

/** Static files the server is willing to serve, mapped to content types. */
const STATIC_FILES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/main.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
};

export interface StartServerOptions {
  service: PlaylistService;
  session: SessionInfo;
  /** Port to bind; 0 (default) picks an ephemeral free port. */
  port?: number;
  /** Directory holding the built frontend; defaults to the bundled `dist/web`. */
  staticDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  nonce: string;
  close(): Promise<void>;
}

/** Content type for a served static path, or undefined if not allowed. */
export function contentTypeFor(path: string): string | undefined {
  return STATIC_FILES[path];
}

/** Inject the per-run nonce into the served HTML. */
export function injectNonce(html: string, nonce: string): string {
  return html.split(NONCE_PLACEHOLDER).join(nonce);
}

/** Extract the headers the router needs from node's header map. */
export function extractHeaders(headers: http.IncomingHttpHeaders): {
  host?: string | undefined;
  origin?: string | undefined;
  nonce?: string | undefined;
} {
  return {
    host: single(headers.host),
    origin: single(headers.origin),
    nonce: single(headers["x-qobuz-nonce"]),
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Start the local web server and resolve once it is listening. */
export function startServer(
  options: StartServerOptions,
): Promise<RunningServer> {
  const nonce = randomBytes(16).toString("hex");
  const staticDir =
    options.staticDir ?? fileURLToPath(new URL("../web/", import.meta.url));

  const server = http.createServer((req, res) => {
    handle(req, res, options, nonce, staticDir).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        nonce,
        close: () =>
          new Promise((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: StartServerOptions,
  nonce: string,
  staticDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    const body = await readJsonBody(req);
    const address = res.socket?.localPort ?? 0;
    const response = await handleApi(
      {
        method: req.method ?? "GET",
        path,
        headers: extractHeaders(req.headers),
        body,
      },
      {
        service: options.service,
        session: options.session,
        nonce,
        port: address,
      },
    );
    sendJson(res, response);
    return;
  }

  serveStatic(res, path, staticDir, nonce);
}

function serveStatic(
  res: http.ServerResponse,
  path: string,
  staticDir: string,
  nonce: string,
): void {
  const contentType = contentTypeFor(path);
  if (contentType === undefined) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const fileName = path === "/" ? "index.html" : path.slice(1);
  let content: string;
  try {
    content = readFileSync(join(staticDir, fileName), "utf8");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (fileName === "index.html") {
    content = injectNonce(content, nonce);
  }
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function sendJson(res: http.ServerResponse, response: ApiResponse): void {
  res.writeHead(response.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response.body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
