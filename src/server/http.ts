/**
 * node:http glue for the local web server.
 *
 * This is the I/O boundary: it binds a socket on 127.0.0.1, reads each request
 * off the wire into the plain {@link ApiRequest} that {@link handleApi}
 * consumes, writes the response back (JSON, or a file download), and serves
 * the static frontend from `dist/web`. The routing, validation and security
 * all live in the pure
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

import { hostAllowed } from "./security.js";
import {
  handleApi,
  refusal,
  type ApiDeps,
  type ApiResponse,
  type QobuzApiService,
  type SessionInfo,
} from "./router.js";

/** Placeholder in index.html replaced with the per-run nonce at serve time. */
const NONCE_PLACEHOLDER = "__CROSSTUNE_NONCE__";

/** Static files the server is willing to serve, mapped to content types. */
const STATIC_FILES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/main.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  // Archivo, self-hosted so the page makes no third-party requests.
  "/fonts/archivo-latin-wdth.woff2": "font/woff2",
  "/fonts/archivo-latin-ext-wdth.woff2": "font/woff2",
};

/**
 * The most a request body may be. The largest legitimate one is an import or a
 * restored backup, sent as one JSON string; 32 MiB is far beyond any library.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Sent with every response. The page loads only its own script, styles and
 * fonts (no inline script or style) and cover images from the services'
 * https servers; nothing may frame it, embed objects or change its base URL.
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
    "img-src 'self' https: data: blob:; connect-src 'self'; " +
    "base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

/** Never used: with `accounts`, each request names its service. */
const NO_SERVICE = {} as QobuzApiService;

export interface StartServerOptions {
  /** The service every request is carried out on, without `accounts`. */
  service?: QobuzApiService;
  session?: SessionInfo;
  /** The change history the API lists and undoes (see ApiDeps). */
  history?: ApiDeps["history"];
  /** Background jobs the API manages (see ApiDeps). */
  jobs?: ApiDeps["jobs"];
  /** The connected services (see ApiDeps). */
  accounts?: ApiDeps["accounts"];
  /** Linked playlists (see ApiDeps). */
  links?: ApiDeps["links"];
  /** Remembered matches (see ApiDeps). */
  matches?: ApiDeps["matches"];
  /** For the playlist manager (see ApiDeps). */
  ownerId?: ApiDeps["ownerId"];
  acquireWriteLock?: ApiDeps["acquireWriteLock"];
  /** The most a request body may be; defaults to {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
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
  service?: string | undefined;
} {
  return {
    host: single(headers.host),
    origin: single(headers.origin),
    nonce: single(headers["x-crosstune-nonce"]),
    service: single(headers["x-music-service"]),
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
        res.writeHead(500, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
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

  const address = res.socket?.localPort ?? 0;

  if (path.startsWith("/api/")) {
    const headers = extractHeaders(req.headers);
    // Refuse a stranger before reading anything it sends.
    const refused = refusal(headers, { nonce, port: address });
    if (refused !== undefined) {
      sendResponse(res, refused, true);
      return;
    }
    const read = await readJsonBody(req, options.maxBodyBytes ?? MAX_BODY_BYTES);
    if (read.tooLarge) {
      sendResponse(res, { status: 413, body: { error: "request body too large" } }, true);
      return;
    }
    const response = await handleApi(
      {
        method: req.method ?? "GET",
        path,
        headers,
        body: read.body,
      },
      {
        service: options.service ?? NO_SERVICE,
        session: options.session ?? { displayName: "", subscriptionLabel: "" },
        nonce,
        port: address,
        ...(options.accounts !== undefined && { accounts: options.accounts }),
        ...(options.links !== undefined && { links: options.links }),
        ...(options.matches !== undefined && { matches: options.matches }),
        ...(options.history !== undefined && { history: options.history }),
        ...(options.jobs !== undefined && { jobs: options.jobs }),
        ...(options.ownerId !== undefined && { ownerId: options.ownerId }),
        ...(options.acquireWriteLock !== undefined && { acquireWriteLock: options.acquireWriteLock }),
      },
    );
    sendResponse(res, response);
    return;
  }

  if (!hostAllowed(extractHeaders(req.headers).host, address)) {
    res.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("Forbidden");
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
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const fileName = path === "/" ? "index.html" : path.slice(1);
  // Read as bytes: the fonts are binary; only the page is decoded to inject the nonce.
  let content: Buffer | string;
  try {
    content = readFileSync(join(staticDir, fileName));
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (fileName === "index.html") {
    content = injectNonce(content.toString("utf8"), nonce);
  }
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentType });
  res.end(content);
}

/** An API response as it goes on the wire: status, headers and payload. */
export interface EncodedResponse {
  status: number;
  headers: Record<string, string>;
  payload: string | Uint8Array;
}

/**
 * Encode an API response: its body as JSON, or -- for a download -- the file's
 * bytes with an attachment header. The filename in that header is reduced to
 * printable ASCII without quotes, so it can never break out of the header.
 */
export function encodeResponse(response: ApiResponse): EncodedResponse {
  const { file } = response;
  if (file === undefined) {
    return {
      status: response.status,
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify(response.body),
    };
  }
  const filename = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return {
    status: response.status,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
    payload: file.bytes,
  };
}

/** Write a response; `close` also drops the connection after it (an unread body is left behind). */
function sendResponse(res: http.ServerResponse, response: ApiResponse, close = false): void {
  const { status, headers, payload } = encodeResponse(response);
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, ...(close && { Connection: "close" }) });
  res.end(payload, () => {
    if (close) {
      res.req.destroy();
    }
  });
}

/**
 * Read a JSON body, buffering at most `limit` bytes: past that it stops
 * reading and says so. The body is undefined when empty or not JSON.
 */
export function readJsonBody(
  req: http.IncomingMessage,
  limit: number,
): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
  const declared = Number(single(req.headers["content-length"]));
  if (declared > limit) {
    return Promise.resolve({ tooLarge: true });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.pause();
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (chunks.length === 0) {
        resolve({ tooLarge: false, body: undefined });
        return;
      }
      try {
        resolve({ tooLarge: false, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ tooLarge: false, body: undefined });
      }
    });
    req.once("error", reject);
  });
}
