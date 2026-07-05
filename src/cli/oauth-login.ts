/**
 * Browser-based OAuth sign-in for the CLI.
 *
 * Qobuz authenticates in the user's browser. This opens the Qobuz sign-in page
 * with a localhost redirect, runs a one-shot local HTTP server to capture the
 * authorization code Qobuz redirects back with, and exchanges it for a session.
 *
 * The HTTP server and browser launch are I/O glue and are not unit-tested; the
 * pure parts (URL building, code parsing) are tested in the `oauth` module.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";

import type { UserSession } from "../qobuz/index.js";
import { QobuzClient } from "../qobuz/index.js";
import { buildOAuthUrl, parseRedirectCode } from "../qobuz/oauth.js";

const OAUTH_TIMEOUT_MS = 180_000;

const SUCCESS_HTML =
  "<!doctype html><html><body style=\"font-family:system-ui;text-align:center;padding:64px\">" +
  "<h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>";
const WAITING_HTML =
  "<!doctype html><html><body style=\"font-family:system-ui;text-align:center;padding:64px\">" +
  "<h2>Waiting for Qobuz...</h2></body></html>";

export interface BrowserLoginOptions {
  /** Whether to launch the browser automatically (default true). */
  openBrowser?: boolean;
  /** Progress logger (default: no-op). */
  log?: (message: string) => void;
}

/**
 * Run the full browser sign-in and return the authenticated session.
 *
 * @throws {Error} if no code is captured within the timeout.
 * @throws {QobuzError} if the code exchange is rejected.
 */
export async function authenticateViaBrowser(
  client: QobuzClient,
  options: BrowserLoginOptions = {},
): Promise<UserSession> {
  const log = options.log ?? ((): void => {});
  const code = await captureAuthorizationCode(client.appId, {
    openBrowser: options.openBrowser ?? true,
    log,
  });
  return client.loginWithOAuthCode(code);
}

function captureAuthorizationCode(
  appId: string,
  options: { openBrowser: boolean; log: (message: string) => void },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("OAuth login timed out waiting for the browser"));
      }
    }, OAUTH_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const code = parseRedirectCode(req.url ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(code === undefined ? WAITING_HTML : SUCCESS_HTML);
      if (code !== undefined && !settled) {
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve(code);
      }
    });

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = buildOAuthUrl(appId, `http://localhost:${port}`);
      options.log("Opening your browser to sign in to Qobuz...");
      options.log(`If it does not open, visit this URL manually:\n  ${url}`);
      if (options.openBrowser) {
        openInBrowser(url);
      }
    });
  });
}

/** Best-effort open of a URL in the platform browser; failures are ignored. */
function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Ignore: the URL was printed for manual opening.
    });
    child.unref();
  } catch {
    // Ignore: the URL was printed for manual opening.
  }
}
