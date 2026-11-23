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

import * as http from "node:http";

import type { UserSession } from "../services/qobuz/index.js";
import { QobuzClient } from "../services/qobuz/index.js";
import { buildOAuthUrl, parseRedirectCode } from "../services/qobuz/oauth.js";
import { openInBrowser } from "./open-browser.js";
import { isSubresourceRequest } from "./sign-in-listener.js";

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
      // A page's <img> or fetch must not use up the sign-in that waits.
      if (isSubresourceRequest(req.headers)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
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

/** Where Qobuz sends the browser after a pasted sign-in (nothing listens there). */
const PASTE_REDIRECT_URL = "http://localhost:53682/";

/**
 * Sign in without a browser on this machine (e.g. a headless server): print
 * the sign-in link to open on any device, then read back the address the
 * browser ended on -- a localhost page that does not load, whose address
 * carries the authorization code.
 *
 * @throws {Error} if the pasted address carries no code.
 * @throws {QobuzError} if the code exchange is rejected.
 */
export async function authenticateByPaste(
  client: QobuzClient,
  io: { print(text: string): void; readLine(prompt: string): Promise<string> },
): Promise<UserSession> {
  io.print(
    [
      "Open this link in a browser on any device and sign in to Qobuz:",
      "",
      `  ${buildOAuthUrl(client.appId, PASTE_REDIRECT_URL)}`,
      "",
      "The browser then goes to a localhost page that will not load.",
      "Copy that page's whole address from the address bar and paste it here.",
    ].join("\n"),
  );
  const pasted = (await io.readLine("Address: ")).trim();
  const code = parseRedirectCode(pasted);
  if (code === undefined) {
    throw new Error("That address has no sign-in code in it; run crosstune login --print-url again.");
  }
  return client.loginWithOAuthCode(code);
}
