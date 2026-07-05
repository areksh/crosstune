/**
 * Resolve Qobuz credentials from the environment, falling back to interactive
 * prompts.
 *
 * Prompting is the recommended path: it keeps the password out of the shell
 * (and thus out of shell history, the environment, and `ps` output) and avoids
 * the shell mangling special characters -- for example zsh expanding `$` inside
 * double quotes.
 */

export interface Credentials {
  email: string;
  password: string;
}

/** Injectable prompt functions so credential resolution can be tested. */
export interface Prompters {
  /** Prompt for a line of visible input. */
  promptLine(question: string): Promise<string>;
  /** Prompt for input without echoing it to the terminal. */
  promptHidden(question: string): Promise<string>;
}

/**
 * Resolve the email and password.
 *
 * Each value is taken from its environment variable when set and non-empty,
 * otherwise the corresponding prompt is used. The email is trimmed; the
 * password is preserved verbatim (leading/trailing characters may be
 * significant).
 *
 * @throws {Error} if a resolved value is empty.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv,
  prompters: Prompters,
): Promise<Credentials> {
  const envEmail = env["QOBUZ_EMAIL"]?.trim();
  const email = envEmail
    ? envEmail
    : (await prompters.promptLine("Qobuz email: ")).trim();
  if (email.length === 0) {
    throw new Error("No email provided");
  }

  const envPassword = env["QOBUZ_PASSWORD"];
  const password =
    envPassword && envPassword.length > 0
      ? envPassword
      : await prompters.promptHidden("Qobuz password: ");
  if (password.length === 0) {
    throw new Error("No password provided");
  }

  return { email, password };
}
