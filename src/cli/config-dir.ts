import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The app's name, as its config folder and command are called. */
export const APP_NAME = "crosstune";

/** What the app was called before (ADR-0014): its folder is moved once. */
const OLD_NAME = "qobuz-helper";

function configHome(env: NodeJS.ProcessEnv): string {
  return env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0 ? env["XDG_CONFIG_HOME"] : join(homedir(), ".config");
}

/** crosstune's config directory, honouring `XDG_CONFIG_HOME`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), APP_NAME);
}

/**
 * Move the folder the app kept under its old name (sign-ins, jobs, links,
 * History) to the new one, once: only while the new one does not exist, so
 * nothing is ever overwritten. A rename within one folder is atomic.
 *
 * @returns whether it moved.
 */
export function moveOldConfigDir(env: NodeJS.ProcessEnv = process.env): boolean {
  const old = join(configHome(env), OLD_NAME);
  const now = configDir(env);
  if (!existsSync(old) || existsSync(now)) {
    return false;
  }
  renameSync(old, now);
  return true;
}
