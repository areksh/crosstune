/**
 * Local persistence of the Qobuz session token.
 *
 * The token is stored on the user's own machine (never a server), keeping with
 * the local-first design. It is a bearer credential, so the file is written
 * with owner-only permissions. This mirrors how CLIs such as gh and npm store
 * tokens; a system keyring would need a native dependency and would break the
 * zero-dependency, npx-friendly footprint.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StoredSession {
  userAuthToken: string;
}

/** The default session file path, honouring `XDG_CONFIG_HOME`. */
export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : join(homedir(), ".config");
  return join(configHome, "qobuz-helper", "session.json");
}

/** Save the user auth token, creating the directory and restricting permissions. */
export function saveToken(
  token: string,
  filePath: string = defaultSessionPath(),
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const data: StoredSession = { userAuthToken: token };
  writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Load the saved token, or undefined if none is stored or the file is unusable. */
export function loadToken(
  filePath: string = defaultSessionPath(),
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    return typeof parsed.userAuthToken === "string" && parsed.userAuthToken.length > 0
      ? parsed.userAuthToken
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remove any saved token. A no-op if none exists. */
export function clearToken(filePath: string = defaultSessionPath()): void {
  rmSync(filePath, { force: true });
}
