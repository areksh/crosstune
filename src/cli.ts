#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * On first use it signs in through the browser OAuth flow and saves the session
 * locally; later runs resume that session automatically until it expires or you
 * sign out. Commands:
 *
 *   qobuz-helper login
 *       Sign in (or resume a saved session) and persist it.
 *
 *   qobuz-helper logout
 *       Discard the saved session.
 *
 *   qobuz-helper check
 *       Vertical-slice smoke test (extraction -> sign-in -> one API call).
 *
 *   qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] \
 *       "Artist One" "Artist Two" ...
 *       Build a playlist from the given artists' top tracks. Artist names may
 *       also be piped on stdin, one per line.
 *
 *   qobuz-helper deduplicate (--playlist <id> | --favourites)
 *                            [--keep <strategy>] [--apply]
 *       Report duplicate tracks (including remasters and same-song-different-
 *       album) in a playlist or in your favourites, marking which copy to keep.
 *       --keep: first-added (default), last-added, highest-quality, oldest,
 *       newest. Without --apply it only reports; with --apply it removes the
 *       tracks marked "drop".
 *
 * With no command, `check` runs. The session is stored at
 * $XDG_CONFIG_HOME/qobuz-helper/session.json (owner-only).
 */

import { readFileSync } from "node:fs";

import {
  parseDedupeArgs,
  parsePlaylistArgs,
  type DedupeSource,
} from "./cli/args.js";
import { clearCredentials } from "./cli/bundle-store.js";
import { fileCredentialStore, initClientWithCache } from "./cli/init.js";
import { authenticateViaBrowser } from "./cli/oauth-login.js";
import { fileTokenStore, restoreOrLogin } from "./cli/session.js";
import {
  deduplicateTracks,
  enrichReleaseDates,
  formatResolutionReport,
  resolveDuplicateGroups,
  strategyNeedsReleaseDates,
  tracksToRemove,
  type DedupTrack,
} from "./features/deduplicate.js";
import { buildPlaylistFromArtists } from "./features/playlist-from-artists.js";
import { QobuzClient, QobuzError } from "./qobuz/index.js";

/**
 * Whether the current run was primed from cached bundle credentials. Tracked so
 * the top-level handler can discard a cache that turns out to be stale.
 */
let usedCachedCredentials = false;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "check";
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // `logout` needs neither the network nor a session: just drop the saved token.
  if (command === "logout") {
    const store = fileTokenStore();
    const hadSession = store.load() !== undefined;
    store.clear();
    console.log(hadSession ? "Signed out." : "No saved session to clear.");
    return;
  }

  // Resolve the command and validate its arguments *before* any network or
  // sign-in, so bad input fails fast without opening a browser. `login` just
  // establishes (and persists) a session, so its action is a no-op.
  let run: (client: QobuzClient) => Promise<void>;
  switch (command) {
    case "login":
      run = async () => {};
      break;
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
  const { fromCache } = await initClientWithCache(client, fileCredentialStore());
  usedCachedCredentials = fromCache;
  console.log(
    fromCache
      ? `Using cached Qobuz credentials (app id ${client.appId}).`
      : `Extracted Qobuz bundle tokens (app id ${client.appId}).`,
  );

  const { session, restored } = await restoreOrLogin(
    client,
    fileTokenStore(),
    () => authenticateViaBrowser(client, { log: (message) => console.log(message) }),
    (message) => console.log(message),
  );
  console.log(
    `  ${restored ? "resumed session" : "signed in"} as ${session.displayName} (${session.subscriptionLabel})`,
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
  const { source, keep, apply } = parseDedupeArgs(argv);

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

    let groups = deduplicateTracks(tracks);
    if (strategyNeedsReleaseDates(keep) && groups.length > 0) {
      console.log("  looking up release dates...");
      groups = await enrichReleaseDates(groups, (albumId) =>
        client.getAlbumReleaseDate(albumId),
      );
    }

    const resolved = resolveDuplicateGroups(groups, keep);
    console.log(`  keeping the ${keep} copy of each duplicate\n`);
    console.log(formatResolutionReport(resolved));

    const removals = tracksToRemove(resolved);
    if (!apply) {
      if (removals.length > 0) {
        console.log(
          `\n(dry run -- pass --apply to remove the ${removals.length} 'drop' track${removals.length === 1 ? "" : "s"})`,
        );
      }
      return;
    }
    await applyRemovals(client, source, removals);
  };
}

/** Execute the removals for an --apply run, using the id each source needs. */
async function applyRemovals(
  client: QobuzClient,
  source: DedupeSource,
  removals: readonly DedupTrack[],
): Promise<void> {
  if (removals.length === 0) {
    console.log("\nNothing to remove.");
    return;
  }
  console.log(`\nRemoving ${removals.length} track(s)...`);
  if (source.type === "playlist") {
    const ids = removals
      .map((track) => track.playlistTrackId)
      .filter((id): id is number => id !== undefined);
    const skipped = removals.length - ids.length;
    if (skipped > 0) {
      console.log(`  skipped ${skipped} track(s) with no playlist-track id`);
    }
    await client.removeTracksFromPlaylist(source.playlistId, ids);
  } else {
    await client.removeFavoriteTracks(removals.map((track) => track.id));
  }
  console.log("  done.");
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
      "  qobuz-helper login",
      "  qobuz-helper logout",
      "  qobuz-helper check",
      '  qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] "Artist" ...',
      "  qobuz-helper deduplicate (--playlist <id> | --favourites) [--keep <strategy>] [--apply]",
      "",
      "The session is saved after first sign-in and resumed automatically; use logout to clear it.",
      "Artist names for playlist-from-artists may also be piped on stdin, one per line.",
      "Keep strategies: first-added (default), last-added, highest-quality, oldest, newest.",
      "deduplicate reports only unless --apply is given.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  // A run primed from cached credentials that then fails on a credential-related
  // error most likely has a stale cache (Qobuz rotated its app id or secret).
  // Drop it so the next run refetches, and say so.
  if (
    usedCachedCredentials &&
    error instanceof QobuzError &&
    (error.kind === "bundle-extraction" ||
      error.kind === "api-response" ||
      error.kind === "authentication")
  ) {
    clearCredentials();
    console.error(
      "\nCached Qobuz credentials may be stale; cleared them -- please re-run.",
    );
  }
  if (error instanceof QobuzError) {
    console.error(`\nQobuz error [${error.kind}]: ${error.message}`);
  } else {
    console.error("\nError:", error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
