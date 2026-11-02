import { homedir } from "node:os";
import { join } from "node:path";

/** qobuz-helper's config directory, honouring `XDG_CONFIG_HOME`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"].length > 0
      ? env["XDG_CONFIG_HOME"]
      : join(homedir(), ".config");
  return join(configHome, "qobuz-helper");
}
