#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * For now this is the vertical-slice smoke test: it extracts the Qobuz bundle
 * tokens, signs in through the browser OAuth flow, and makes one authenticated
 * request, proving the whole plumbing works against live Qobuz. The web UI and
 * the actual tools build on top of this.
 *
 * Usage:
 *   npm run dev
 *
 * A browser window opens on Qobuz's sign-in page; after you sign in, Qobuz
 * redirects back to a local address and the session is established. No password
 * is ever handled by this program.
 */

import { authenticateViaBrowser } from "./cli/oauth-login.js";
import { QobuzClient, QobuzError } from "./qobuz/index.js";

async function main(): Promise<void> {
  const client = new QobuzClient();

  console.log("Extracting Qobuz bundle tokens...");
  await client.init();
  console.log(`  app id: ${client.appId}`);

  const session = await authenticateViaBrowser(client, {
    log: (message) => console.log(message),
  });
  console.log(
    `  signed in as ${session.displayName} (${session.subscriptionLabel})`,
  );

  console.log("Fetching favourite tracks...");
  const favorites = (await client.getUserFavorites("tracks")) as {
    tracks?: { total?: number };
  };
  console.log(`  favourite tracks: ${favorites.tracks?.total ?? "unknown"}`);

  console.log("\nVertical slice OK: extraction -> OAuth sign-in -> authenticated call.");
}

main().catch((error: unknown) => {
  if (error instanceof QobuzError) {
    console.error(`\nQobuz error [${error.kind}]: ${error.message}`);
  } else {
    console.error("\nError:", error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
