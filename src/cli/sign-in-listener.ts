/**
 * The loopback listener a service's sign-in page sends the browser back to
 * (node:http glue; the decisions are in src/accounts). It is up only while a
 * sign-in is in progress, answers nothing but that, and serves no API.
 *
 * The port is fixed because a service may match the whole address it was told
 * (TIDAL seems to). Qobuz is sent to `localhost`, as it always was, the others
 * to 127.0.0.1 (Spotify refuses `localhost`); both end here.
 */

import * as http from "node:http";

import { SIGN_IN_HEADERS, signInPage, type SignInResult } from "./sign-in-page.js";
import { SIGN_IN_MINUTES } from "../accounts/sign-in.js";

export const DEFAULT_SIGN_IN_PORT = 53683;

export interface SignInListener {
  listen(): Promise<{ ok: true } | { ok: false; problem: string }>;
  close(): void;
}

export function signInListener(options: {
  port?: number;
  /** End the sign-in this request target carries; undefined when it carries none. */
  complete(target: string): Promise<SignInResult>;
}): SignInListener {
  const port = options.port ?? DEFAULT_SIGN_IN_PORT;
  let server: http.Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  const close = (): void => {
    clearTimeout(timer);
    server?.close();
    server?.closeAllConnections();
    server = undefined;
  };
  const expireLater = (): void => {
    clearTimeout(timer);
    timer = setTimeout(close, SIGN_IN_MINUTES * 60_000);
    timer.unref();
  };

  return {
    close,
    listen: async () => {
      expireLater();
      if (server !== undefined) {
        return { ok: true };
      }
      const candidate = http.createServer((req, res) => {
        const target = req.url ?? "/";
        // Only a top-level GET to this address, carrying a query, can be a sign-in.
        if (req.method !== "GET" || !target.includes("?") || !isOurs(req.headers.host, port)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        void options.complete(target).then(
          (result) => {
            res.writeHead(result.ok ? 200 : 400, SIGN_IN_HEADERS);
            res.end(signInPage(result), () => {
              if (result.ok) {
                close();
              }
            });
          },
          () => {
            res.writeHead(500, SIGN_IN_HEADERS);
            res.end(signInPage({ ok: false, message: "Something went wrong." }));
          },
        );
      });
      return new Promise((resolve) => {
        candidate.once("error", (error: NodeJS.ErrnoException) => {
          resolve({
            ok: false,
            problem:
              error.code === "EADDRINUSE"
                ? `Port ${port} is in use, so the sign-in cannot come back by itself. Paste the address it ends on instead.`
                : `The sign-in cannot come back by itself (${error.message}). Paste the address it ends on instead.`,
          });
        });
        candidate.listen(port, "127.0.0.1", () => {
          server = candidate;
          resolve({ ok: true });
        });
      });
    },
  };
}

function isOurs(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
