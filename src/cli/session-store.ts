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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config-dir.js";

interface StoredSession {
  userAuthToken: string;
}

/** The default session file path, honouring `XDG_CONFIG_HOME`. */
export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "session.json");
}

/** Save the user auth token, creating the directory and restricting permissions. */
export function saveToken(
  token: string,
  filePath: string = defaultSessionPath(),
): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const data: StoredSession = { userAuthToken: token };
  // Through a temporary file and a rename, as the other stores do: writing the
  // file in place would, if interrupted, leave it truncated and the user
  // silently signed out.
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, filePath);
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
