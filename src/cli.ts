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
 *   QOBUZ_EMAIL=you@example.com QOBUZ_PASSWORD=... npm run dev
 */

import { QobuzClient, QobuzError } from "./qobuz/index.js";

function readCredentials(): { email: string; password: string } {
  const email = process.env["QOBUZ_EMAIL"];
  const password = process.env["QOBUZ_PASSWORD"];
  if (!email || !password) {
    console.error(
      "Set QOBUZ_EMAIL and QOBUZ_PASSWORD in the environment to run the slice.",
    );
    process.exit(2);
  }
  return { email, password };
}

async function main(): Promise<void> {
  const { email, password } = readCredentials();
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
