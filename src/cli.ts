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
 *   qobuz-helper ui
 *       Serve the local web UI and open it in the browser.
 *
 *   qobuz-helper check
 *       Vertical-slice smoke test (extraction -> sign-in -> one API call).
 *
 *   qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] \
 *       "Artist One" "Artist Two" ...
 *       Build a playlist from the given artists' top tracks. Artist names may
 *       also be piped on stdin, one per line.
 *
 *   qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] \
 *       [--public] "Artist One - Album One" "Artist Two - Album Two" ...
 *       Build a playlist from whole albums. Each entry is "Artist - Album";
 *       entries may also be piped on stdin, one per line. When an album has
 *       several versions, --prefer picks one: highest-quality (default), newest,
 *       or oldest.
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
 *
 * A global `--loglevel <silent|error|warn|info|debug>` option (default `info`)
 * controls how much is logged; it may appear anywhere in the arguments.
 */

import { readFileSync } from "node:fs";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseDedupeArgs,
  parsePlaylistArgs,
  type DedupeSource,
} from "./cli/args.js";
import { clearCredentials } from "./cli/bundle-store.js";
import { fileCredentialStore, initClientWithCache } from "./cli/init.js";
import { createLogger, DEFAULT_LOG_LEVEL, type Logger } from "./cli/logger.js";
import { authenticateViaBrowser } from "./cli/oauth-login.js";
import { openInBrowser } from "./cli/open-browser.js";
import { fileTokenStore, restoreOrLogin } from "./cli/session.js";
import { startServer } from "./server/http.js";
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
import {
  buildPlaylistFromAlbums,
  parseAlbumEntry,
  type AlbumEntry,
} from "./features/playlist-from-albums.js";
import { QobuzClient, QobuzError, type UserSession } from "./qobuz/index.js";

/**
 * Whether the current run was primed from cached bundle credentials. Tracked so
 * the top-level handler can discard a cache that turns out to be stale.
 */
let usedCachedCredentials = false;

/**
 * Active logger. Replaced in {@link main} once `--loglevel` is parsed; the
 * default-level instance covers the top-level error handler when parsing the
 * level itself fails.
 */
let logger: Logger = createLogger(DEFAULT_LOG_LEVEL);

async function main(): Promise<void> {
  const { level, rest: args } = extractLogLevel(process.argv.slice(2));
  logger = createLogger(level);
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
    logger.info(hadSession ? "Signed out." : "No saved session to clear.");
    return;
  }

  // Resolve the command and validate its arguments *before* any network or
  // sign-in, so bad input fails fast without opening a browser. `login` just
  // establishes (and persists) a session, so its action is a no-op.
  let run: (client: QobuzClient, session: UserSession) => Promise<void>;
  switch (command) {
    case "login":
      run = async () => {};
      break;
    case "check":
      run = runCheck;
      break;
    case "ui":
      run = runUi;
      break;
    case "playlist-from-artists": {
      const plan = planPlaylistFromArtists(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "playlist-from-albums": {
      const plan = planPlaylistFromAlbums(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "deduplicate": {
      const plan = planDeduplicate(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    default:
      logger.error(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 2;
      return;
  }

  const client = new QobuzClient({ logger });
  const { fromCache } = await initClientWithCache(client, fileCredentialStore());
  usedCachedCredentials = fromCache;
  logger.info(
    fromCache
      ? `Using cached Qobuz credentials (app id ${client.appId}).`
      : `Extracted Qobuz bundle tokens (app id ${client.appId}).`,
  );

  const { session, restored } = await restoreOrLogin(
    client,
    fileTokenStore(),
    () => authenticateViaBrowser(client, { log: (message) => logger.info(message) }),
    (message) => logger.info(message),
  );
  logger.info(
    `  ${restored ? "resumed session" : "signed in"} as ${session.displayName} (${session.subscriptionLabel})`,
  );

  await run(client, session);
}

/**
 * Serve the web UI locally and open it in the browser. The client (already
 * signed in) is the API's Qobuz backend; the server runs until interrupted.
 */
async function runUi(client: QobuzClient, session: UserSession): Promise<void> {
  const server = await startServer({
    service: client,
    session: {
      displayName: session.displayName,
      subscriptionLabel: session.subscriptionLabel,
    },
  });
  logger.info(`\nWeb UI running at ${server.url}`);
  logger.info("Open it in your browser (it should open automatically).");
  logger.info("Press Ctrl-C to stop.");
  openInBrowser(server.url);
  await waitForInterrupt();
  logger.info("\nStopping...");
  await server.close();
}

/** Resolve when the process receives an interrupt (Ctrl-C). */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function runCheck(client: QobuzClient): Promise<void> {
  logger.info("Fetching favourite tracks...");
  const favorites = (await client.getUserFavorites("tracks")) as {
    tracks?: { total?: number };
  };
  logger.info(`  favourite tracks: ${favorites.tracks?.total ?? "unknown"}`);
  logger.info("\nOK: extraction -> OAuth sign-in -> authenticated call.");
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
    parsed.artists.length > 0 ? parsed.artists : readLinesFromStdin();
  if (artists.length === 0) {
    throw new Error(
      "No artists given. Pass them as arguments or pipe them on stdin.",
    );
  }

  return async (client: QobuzClient): Promise<void> => {
    logger.info(
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

    logger.info(
      `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.trackCount} tracks:`,
    );
    for (const resolved of result.resolvedArtists) {
      logger.info(`  ${resolved.artist.name}: ${resolved.trackCount} tracks`);
    }
    if (result.unresolvedArtists.length > 0) {
      logger.warn(`not found: ${result.unresolvedArtists.join(", ")}`);
    }
  };
}

/**
 * Validate the album command's arguments (and read any piped "Artist - Album"
 * lines) up front, returning an executor to run once the client is signed in.
 */
function planPlaylistFromAlbums(
  argv: string[],
): (client: QobuzClient) => Promise<void> {
  const parsed = parseAlbumArgs(argv);
  const lines = parsed.entries.length > 0 ? parsed.entries : readLinesFromStdin();
  if (lines.length === 0) {
    throw new Error(
      "No albums given. Pass them as arguments or pipe them on stdin.",
    );
  }

  // Split each "Artist - Album" line up front so bad input fails before sign-in.
  const entries: AlbumEntry[] = [];
  const malformed: string[] = [];
  for (const line of lines) {
    const entry = parseAlbumEntry(line);
    if (entry === undefined) {
      malformed.push(line);
    } else {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    throw new Error(
      'No albums in the expected "Artist - Album" format were given.',
    );
  }

  return async (client: QobuzClient): Promise<void> => {
    if (malformed.length > 0) {
      logger.warn(`ignored (not "Artist - Album"): ${malformed.join(", ")}`);
    }
    logger.info(
      `Building playlist "${parsed.playlistName}" from ${entries.length} albums (preferring ${parsed.preference})...`,
    );
    const result = await buildPlaylistFromAlbums(client, {
      entries,
      playlistName: parsed.playlistName,
      preference: parsed.preference,
      isPublic: parsed.isPublic,
    });

    logger.info(
      `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.trackCount} tracks:`,
    );
    for (const resolved of result.resolvedAlbums) {
      const version =
        resolved.album.version === undefined ? "" : ` [${resolved.album.version}]`;
      logger.info(
        `  ${resolved.album.artist} - ${resolved.album.title}${version}: ${resolved.trackCount} tracks`,
      );
    }
    if (result.unresolvedAlbums.length > 0) {
      logger.warn(`not found: ${result.unresolvedAlbums.join(", ")}`);
    }
    if (result.failedAlbums.length > 0) {
      logger.warn(`could not fetch tracks: ${result.failedAlbums.join(", ")}`);
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
    logger.info(`Fetching tracks from ${where}...`);
    const tracks =
      source.type === "playlist"
        ? await client.getPlaylistTracks(source.playlistId)
        : await client.getFavoriteTracks();
    logger.info(`  ${tracks.length} tracks fetched`);

    let groups = deduplicateTracks(tracks);
    if (strategyNeedsReleaseDates(keep) && groups.length > 0) {
      logger.info("  looking up release dates...");
      groups = await enrichReleaseDates(groups, (albumId) =>
        client.getAlbumReleaseDate(albumId),
      );
    }

    const resolved = resolveDuplicateGroups(groups, keep);
    logger.info(`  keeping the ${keep} copy of each duplicate\n`);
    logger.info(formatResolutionReport(resolved));

    const removals = tracksToRemove(resolved);
    if (!apply) {
      if (removals.length > 0) {
        logger.info(
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
    logger.info("\nNothing to remove.");
    return;
  }
  logger.info(`\nRemoving ${removals.length} track(s)...`);
  if (source.type === "playlist") {
    const ids = removals
      .map((track) => track.playlistTrackId)
      .filter((id): id is number => id !== undefined);
    const skipped = removals.length - ids.length;
    if (skipped > 0) {
      logger.warn(`skipped ${skipped} track(s) with no playlist-track id`);
    }
    await client.removeTracksFromPlaylist(source.playlistId, ids);
  } else {
    await client.removeFavoriteTracks(removals.map((track) => track.id));
  }
  logger.info("  done.");
}

/** Read lines from piped stdin (one per line, trimmed); empty when stdin is a TTY. */
function readLinesFromStdin(): string[] {
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
  logger.info(
    [
      "Usage:",
      "  qobuz-helper login",
      "  qobuz-helper logout",
      "  qobuz-helper ui",
      "  qobuz-helper check",
      '  qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] "Artist" ...',
      '  qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] [--public] "Artist - Album" ...',
      "  qobuz-helper deduplicate (--playlist <id> | --favourites) [--keep <strategy>] [--apply]",
      "",
      "Global options:",
      "  --loglevel <silent|error|warn|info|debug>   how much to log (default info)",
      "",
      "The session is saved after first sign-in and resumed automatically; use logout to clear it.",
      "Artist names (playlist-from-artists) and 'Artist - Album' lines (playlist-from-albums) may also be piped on stdin, one per line.",
      "Album version preferences: highest-quality (default), newest, oldest.",
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
    logger.warn(
      "\nCached Qobuz credentials may be stale; cleared them -- please re-run.",
    );
  }
  if (error instanceof QobuzError) {
    logger.error(`\nQobuz error [${error.kind}]: ${error.message}`);
  } else {
    logger.error(
      `\nError: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
});
