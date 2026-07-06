/**
 * Best-effort opening of a URL in the platform browser.
 *
 * Used by both the OAuth sign-in flow and the web UI command. Failures are
 * swallowed: the caller always prints the URL as well, so the user can open it
 * manually if the launch does not work.
 */

import { spawn } from "node:child_process";

/** Open a URL in the default browser; ignore any failure. */
export function openInBrowser(url: string): void {
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
