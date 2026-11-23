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

/**
 * Whether a request is not a page load. A browser says what it is fetching in
 * `Sec-Fetch-Dest`/`-Mode`; an `<img src=...>` or `fetch` from another site
 * must not end a sign-in, though the real redirect back (a cross-site
 * top-level navigation) must, so `Sec-Fetch-Site` is not looked at. A request
 * without these headers (curl, an old browser) is let through.
 */
export function isSubresourceRequest(headers: http.IncomingHttpHeaders): boolean {
  const dest = headers["sec-fetch-dest"];
  const mode = headers["sec-fetch-mode"];
  return (dest !== undefined && dest !== "document") || (mode !== undefined && mode !== "navigate");
}

export type Listening = { ok: true } | { ok: false; problem: string };

export interface SignInListener {
  listen(): Promise<Listening>;
  close(): void;
  /** The next sign-in to come back, whether it worked or not. */
  nextResult(): Promise<SignInResult>;
}

export function signInListener(options: {
  port?: number;
  /** End the sign-in this request target carries; undefined when it carries none. */
  complete(target: string): Promise<SignInResult>;
  /** Whether another sign-in still waits, so a success does not close it. */
  stillNeeded?(): boolean;
}): SignInListener {
  const port = options.port ?? DEFAULT_SIGN_IN_PORT;
  const stillNeeded = options.stillNeeded ?? ((): boolean => false);
  let server: http.Server | undefined;
  // Two listens at once share the first one's binding.
  let binding: Promise<Listening> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let waiters: ((result: SignInResult) => void)[] = [];
  const tell = (result: SignInResult): void => {
    const told = waiters;
    waiters = [];
    for (const waiter of told) {
      waiter(result);
    }
  };

  // Bumped by close: a binding started before it lets the port go when done.
  let closes = 0;
  const close = (): void => {
    closes += 1;
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

  const bind = (): Promise<Listening> => {
    const asOf = closes;
    const candidate = http.createServer((req, res) => {
      const target = req.url ?? "/";
      // Only a top-level GET to this address, carrying a query, can be a sign-in.
      if (req.method !== "GET" || !target.includes("?") || !isOurs(req.headers.host, port)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      // A page's <img> or fetch must not use up the sign-in that waits.
      if (isSubresourceRequest(req.headers)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      void options.complete(target).then(
        (result) => {
          res.writeHead(result.ok ? 200 : 400, SIGN_IN_HEADERS);
          res.end(signInPage(result), () => {
            if (result.ok && !stillNeeded()) {
              close();
            }
          });
          tell(result);
        },
        () => {
          const result = { ok: false, message: "Something went wrong." };
          res.writeHead(500, SIGN_IN_HEADERS);
          res.end(signInPage(result));
          tell(result);
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
        if (closes !== asOf) {
          candidate.close();
          resolve({ ok: false, problem: "The sign-in listener was closed." });
          return;
        }
        server = candidate;
        resolve({ ok: true });
      });
    });
  };

  return {
    close,
    listen: async () => {
      expireLater();
      if (server !== undefined) {
        return { ok: true };
      }
      binding ??= bind().finally(() => {
        binding = undefined;
      });
      return binding;
    },
    nextResult: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

function isOurs(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
