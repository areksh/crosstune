#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Signs in through the browser OAuth flow, then runs a command:
 *
 *   qobuz-helper check
 *       Vertical-slice smoke test (extraction -> sign-in -> one API call).
 *
 *   qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] \
 *       "Artist One" "Artist Two" ...
 *       Build a playlist from the given artists' top tracks. Artist names may
 *       also be piped on stdin, one per line.
 *
 *   qobuz-helper deduplicate (--playlist <id> | --favourites) [--keep <strategy>]
 *       Report duplicate tracks (including remasters and same-song-different-
 *       album) in a playlist or in your favourites, marking which copy to keep
 *       (--keep, default first-added). Reports only; changes nothing.
 *
 * With no command, `check` runs.
 */

import { readFileSync } from "node:fs";

import { parseDedupeArgs, parsePlaylistArgs } from "./cli/args.js";
import { authenticateViaBrowser } from "./cli/oauth-login.js";
import {
  deduplicateTracks,
  formatResolutionReport,
  resolveDuplicateGroups,
} from "./features/deduplicate.js";
import { buildPlaylistFromArtists } from "./features/playlist-from-artists.js";
import { QobuzClient, QobuzError } from "./qobuz/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "check";
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // Resolve the command and validate its arguments *before* any network or
  // sign-in, so bad input fails fast without opening a browser.
  let run: (client: QobuzClient) => Promise<void>;
  switch (command) {
    case "check":
      run = runCheck;
      break;
    case "playlist-from-artists": {
      const plan = planPlaylistFromArtists(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "deduplicate": {
      const plan = planDeduplicate(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 2;
      return;
  }

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

  await run(client);
}

async function runCheck(client: QobuzClient): Promise<void> {
  console.log("Fetching favourite tracks...");
  const favorites = (await client.getUserFavorites("tracks")) as {
    tracks?: { total?: number };
  };
  console.log(`  favourite tracks: ${favorites.tracks?.total ?? "unknown"}`);
  console.log("\nOK: extraction -> OAuth sign-in -> authenticated call.");
}

/**
 * Validate the playlist command's arguments (and read any piped artist names)
 * up front, returning an executor to run once the client is signed in.
 */
function planPlaylistFromArtists(
  argv: string[],
): (client: QobuzClient) => Promise<void> {
  const parsed = parsePlaylistArgs(argv);
  const artists =
    parsed.artists.length > 0 ? parsed.artists : readArtistsFromStdin();
  if (artists.length === 0) {
    throw new Error(
      "No artists given. Pass them as arguments or pipe them on stdin.",
    );
  }

  return async (client: QobuzClient): Promise<void> => {
    console.log(
      `Building playlist "${parsed.playlistName}" from ${artists.length} artists...`,
    );
    const result = await buildPlaylistFromArtists(client, {
      artists,
      playlistName: parsed.playlistName,
      isPublic: parsed.isPublic,
      ...(parsed.tracksPerArtist !== undefined && {
        tracksPerArtist: parsed.tracksPerArtist,
      }),
    });

    console.log(
      `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.trackCount} tracks:`,
    );
    for (const resolved of result.resolvedArtists) {
      console.log(`  ${resolved.artist.name}: ${resolved.trackCount} tracks`);
    }
    if (result.unresolvedArtists.length > 0) {
      console.log(`  not found: ${result.unresolvedArtists.join(", ")}`);
    }
  };
}

/**
 * Validate the deduplicate command's source up front, returning an executor to
 * run once the client is signed in.
 */
function planDeduplicate(
  argv: string[],
): (client: QobuzClient) => Promise<void> {
  const { source, keep } = parseDedupeArgs(argv);

  return async (client: QobuzClient): Promise<void> => {
    const where =
      source.type === "playlist"
        ? `playlist ${source.playlistId}`
        : "your favourites";
    console.log(`Fetching tracks from ${where}...`);
    const tracks =
      source.type === "playlist"
        ? await client.getPlaylistTracks(source.playlistId)
        : await client.getFavoriteTracks();
    console.log(`  ${tracks.length} tracks fetched`);

    const groups = deduplicateTracks(tracks);
    const resolved = resolveDuplicateGroups(groups, keep);
    console.log(`  keeping the ${keep} copy of each duplicate\n`);
    console.log(formatResolutionReport(resolved));
  };
}

/** Read artist names from piped stdin (one per line); empty when stdin is a TTY. */
function readArtistsFromStdin(): string[] {
  if (process.stdin.isTTY) {
    return [];
  }
  try {
    return readFileSync(0, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  qobuz-helper check",
      '  qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] "Artist" ...',
      "  qobuz-helper deduplicate (--playlist <id> | --favourites) [--keep first-added]",
      "",
      "Artist names for playlist-from-artists may also be piped on stdin, one per line.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  if (error instanceof QobuzError) {
    console.error(`\nQobuz error [${error.kind}]: ${error.message}`);
  } else {
    console.error("\nError:", error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
