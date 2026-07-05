#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * For now this is the vertical-slice smoke test: it extracts the Qobuz bundle
 * tokens, signs in with credentials from the environment, and makes one
 * authenticated request, proving the whole plumbing works against live Qobuz.
 * The web UI and the actual tools build on top of this.
 *
 * Usage:
 *   npm run dev                       # prompts for email and password
 *   QOBUZ_EMAIL=you@example.com npm run dev   # prompts for password only
 *
 * Prompting is recommended: it keeps the password out of the shell, which
 * otherwise mangles special characters (e.g. zsh expands `$` in double quotes).
 */

import { resolveCredentials } from "./cli/credentials.js";
import { createTerminalPrompter } from "./cli/prompt.js";
import { QobuzClient, QobuzError } from "./qobuz/index.js";

async function main(): Promise<void> {
  const prompter = createTerminalPrompter();
  let email: string;
  let password: string;
  try {
    ({ email, password } = await resolveCredentials(process.env, prompter));
  } finally {
    prompter.close();
  }
  const client = new QobuzClient();

  console.log("Extracting Qobuz bundle tokens...");
  await client.init();
  console.log(`  app id: ${client.appId}`);

  console.log(`Signing in as ${email}...`);
  const session = await client.login(email, password);
  console.log(
    `  signed in as ${session.displayName} (${session.subscriptionLabel})`,
  );

  console.log("Fetching favourite tracks...");
  const favorites = (await client.getUserFavorites("tracks")) as {
    tracks?: { total?: number };
  };
  console.log(`  favourite tracks: ${favorites.tracks?.total ?? "unknown"}`);

  console.log("\nVertical slice OK: extraction -> login -> authenticated call.");
}

main().catch((error: unknown) => {
  if (error instanceof QobuzError) {
    console.error(`\nQobuz error [${error.kind}]: ${error.message}`);
  } else {
    console.error("\nUnexpected error:", error);
  }
  process.exitCode = 1;
});
