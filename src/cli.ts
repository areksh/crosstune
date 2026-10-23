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
 *       [--exclude-track <term>]... [--exclude-album <term>]... \
 *       "Artist One" "Artist Two" ...
 *       Build a playlist from the given artists' top tracks. Artist names may
 *       also be piped on stdin, one per line. Tracks whose title, or whose
 *       album's title, matches an exclude term are replaced by the artist's
 *       next most popular tracks.
 *
 *   qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] \
 *       [--public] [--discs <list>] [--exclude-track <term>]... \
 *       [--exclude-album <term>]... "Artist One - Album One" ...
 *       Build a playlist from whole albums. Each entry is "Artist - Album";
 *       entries may also be piped on stdin, one per line. When an album has
 *       several versions, --prefer picks one: highest-quality (default), newest,
 *       or oldest. Releases matching --exclude-album are never picked; tracks
 *       matching --exclude-track, or on a disc outside --discs, are left out.
 *
 *   qobuz-helper deduplicate (--playlist <id> | --favourites)
 *                            [--keep <strategy>] [--apply]
 *       Report duplicate tracks (including remasters and same-song-different-
 *       album) in a playlist or in your favourites, marking which copy to keep.
 *       --keep: first-added (default), last-added, highest-quality, oldest,
 *       newest. Without --apply it only reports; with --apply it removes the
 *       tracks marked "drop".
 *
 *   qobuz-helper export (--favourites | --favourite-albums | --favourite-artists
 *       | --playlist <id> | --account) [--format <json|csv|text|m3u>] [--out <file>]
 *       Export favourites or a playlist (or the whole account, with --account)
 *       to a file or stdout. --account always writes a lossless JSON backup;
 *       otherwise --format chooses the format (inferred from --out's extension
 *       when omitted, else JSON).
 *
 *   qobuz-helper import (--favourites | --favourite-albums | --favourite-artists
 *       | --playlist <id> | --new-playlist <name> | --account)
 *       [--format <json|csv|text|m3u>] [--public] [--apply] <file>
 *       Import a file into favourites or a playlist, resolving each entry to a
 *       Qobuz item (by its id when present, else by search). --account restores
 *       a full backup. Without --apply it resolves and reports only; the format
 *       is inferred from the filename when --format is omitted.
 *
 *   qobuz-helper similar-artists --name "<name>" [--similar N] [--depth D] \
 *       [--tracks M] [--seed-tracks K] [--public] [filters] "Artist" ...
 *   qobuz-helper similar-artists --playlist <id> [--seeds S] [--similar N] \
 *       [--depth D] [--tracks M] [filters] [--apply]
 *       Add the top tracks of Qobuz's similar artists, walked to depth D from
 *       the given artists (alongside K of their own tracks, in a new playlist)
 *       or from a playlist's S most frequent artists (added to that playlist;
 *       without --apply it only reports). Artists already in the playlist are
 *       never suggested.
 *
 * With no command, `check` runs. The session is stored at
 * $XDG_CONFIG_HOME/qobuz-helper/session.json (owner-only).
 *
 * A global `--loglevel <silent|error|warn|info|debug>` option (default `info`)
 * controls how much is logged; it may appear anywhere in the arguments.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseDedupeArgs,
  parseExportArgs,
  parseImportArgs,
  parsePlaylistArgs,
  parseSimilarArgs,
  type DedupeSource,
  type ExportArgs,
  type ImportArgs,
  type ImportTargetArg,
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
import {
  addTracksToExistingPlaylist,
  buildPlaylistFromArtists,
  createPlaylistWithTracks,
} from "./features/playlist-from-artists.js";
import {
  planFromArtists,
  planFromPlaylist,
  similarTrackIds,
  type SimilarPlan,
} from "./features/similar-artists.js";
import { compileTrackFilter } from "./features/track-filter.js";
import {
  buildBackup,
  collectCollection,
  commitImport,
  formatFromFilename,
  looksLikeBackup,
  parseBackup,
  parseCollection,
  resolveImport,
  restoreBackup,
  serializeBackup,
  serializeCollection,
  type CollectionKind,
  type Format,
  type ImportTarget,
} from "./features/import-export.js";
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
    case "similar-artists": {
      const plan = planSimilarArtists(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "deduplicate": {
      const plan = planDeduplicate(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "export": {
      const plan = planExport(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "import": {
      const plan = planImport(args.slice(1));
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
      ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
    });

    logger.info(
      `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.trackCount} tracks:`,
    );
    for (const resolved of result.resolvedArtists) {
      logger.info(
        `  ${resolved.artist.name}: ${resolved.trackCount} tracks${excludedNote(resolved.excludedCount)}`,
      );
    }
    for (const partial of result.partialArtists) {
      logger.info(
        `  (only ${partial.trackCount} of ${partial.requested} available for ${partial.artist.name})`,
      );
    }
    if (result.emptyArtists.length > 0) {
      logger.warn(
        `no tracks available for: ${result.emptyArtists
          .map((a) => a.artist.name)
          .join(", ")}`,
      );
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
      ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
    });

    logger.info(
      `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.trackCount} tracks:`,
    );
    for (const resolved of result.resolvedAlbums) {
      const version =
        resolved.album.version === undefined ? "" : ` [${resolved.album.version}]`;
      logger.info(
        `  ${resolved.album.artist} - ${resolved.album.title}${version}: ${resolved.trackCount} tracks${excludedNote(resolved.excludedCount)}`,
      );
    }
    if (result.unresolvedAlbums.length > 0) {
      logger.warn(`not found: ${result.unresolvedAlbums.join(", ")}`);
    }
    if (result.excludedAlbums.length > 0) {
      logger.warn(
        `every release excluded by --exclude-album: ${result.excludedAlbums.join(", ")}`,
      );
    }
    if (result.failedAlbums.length > 0) {
      logger.warn(`could not fetch tracks: ${result.failedAlbums.join(", ")}`);
    }
  };
}

/**
 * Validate the similar-artists command's arguments (and read any piped artist
 * names) up front, returning an executor to run once the client is signed in.
 */
function planSimilarArtists(
  argv: string[],
): (client: QobuzClient) => Promise<void> {
  const parsed = parseSimilarArgs(argv);
  const { source } = parsed;
  const artists =
    source.type === "artists"
      ? source.artists.length > 0
        ? source.artists
        : readLinesFromStdin()
      : [];
  if (source.type === "artists" && artists.length === 0) {
    throw new Error("No artists given. Pass them as arguments or pipe them on stdin.");
  }
  const walk = {
    similarPerArtist: parsed.similarPerArtist,
    depth: parsed.depth,
    tracksPerSimilar: parsed.tracksPerSimilar,
    ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
  };

  return async (client: QobuzClient): Promise<void> => {
    logger.info(
      `Finding ${parsed.similarPerArtist} similar artist${parsed.similarPerArtist === 1 ? "" : "s"} per artist, ${parsed.depth} level${parsed.depth === 1 ? "" : "s"} deep...`,
    );
    const plan =
      source.type === "artists"
        ? await planFromArtists(client, { ...walk, artists, tracksPerSeed: source.tracksPerSeed })
        : await planFromPlaylist(client, {
            ...walk,
            playlistId: source.playlistId,
            maxSeeds: source.maxSeeds,
          });
    const trackIds = similarTrackIds(plan.seeds, plan.similar);
    reportSimilarPlan(plan, source.type === "artists" && source.tracksPerSeed > 0);
    if (trackIds.length === 0) {
      logger.warn("No tracks found to add.");
      return;
    }

    if (source.type === "artists") {
      const playlist = await createPlaylistWithTracks(client, {
        name: source.playlistName,
        trackIds,
        isPublic: source.isPublic,
      });
      logger.info(
        `\nCreated "${playlist.name}" (id ${playlist.id}) with ${trackIds.length} tracks.`,
      );
      return;
    }
    if (!source.apply) {
      logger.info(
        `\n(dry run -- pass --apply to add up to ${trackIds.length} tracks to the playlist)`,
      );
      return;
    }
    const { added, skipped } = await addTracksToExistingPlaylist(client, {
      playlistId: source.playlistId,
      trackIds,
    });
    logger.info(
      `\nAdded ${added.length} tracks to the playlist${skipped.length > 0 ? ` (${skipped.length} already present, skipped)` : ""}.`,
    );
  };
}

/** Log a similar-artists plan: per seed, its tracks and the similar artists found. */
function reportSimilarPlan(plan: SimilarPlan, showSeedTracks: boolean): void {
  for (const seed of plan.seeds) {
    logger.info(
      showSeedTracks
        ? `  ${seed.artist.name}: ${seed.tracks.length} tracks${excludedNote(seed.excluded.length)}`
        : `  ${seed.artist.name}`,
    );
    for (const entry of plan.similar.filter((s) => s.seed.id === seed.artist.id)) {
      logger.info(
        `    + ${entry.artist.name} (similar to ${entry.via.name}): ${entry.tracks.length} tracks${excludedNote(entry.excluded.length)}`,
      );
    }
  }
  if (plan.seeds.length === 0) {
    logger.warn("no artists to start from (the playlist has no tracks with an artist id)");
  }
  if (plan.truncated) {
    logger.warn("stopped at 100 similar artists; lower --similar or --depth for a fuller walk");
  }
  if (plan.emptyArtists.length > 0) {
    logger.warn(
      `no tracks available for: ${plan.emptyArtists.map((a) => a.artist.name).join(", ")}`,
    );
  }
  if (plan.unresolvedArtists.length > 0) {
    logger.warn(`not found: ${plan.unresolvedArtists.join(", ")}`);
  }
}

/** " (N excluded)" for a summary line, or nothing when the filter left everything in. */
function excludedNote(count: number): string {
  return count > 0 ? ` (${count} excluded)` : "";
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

/**
 * Validate the export command's arguments up front, returning an executor that
 * reads the chosen source and writes it to a file (`--out`) or stdout.
 *
 * When streaming to stdout the content is the only thing written there, so it
 * pipes cleanly; progress notes are shown only when writing to a file.
 */
function planExport(argv: string[]): (client: QobuzClient) => Promise<void> {
  const args = parseExportArgs(argv);
  const toFile = args.out !== undefined;
  const note = (message: string): void => {
    if (toFile) logger.info(message);
  };

  return async (client: QobuzClient): Promise<void> => {
    let content: string;
    if (args.source.type === "account") {
      note("Backing up your account...");
      const backup = await buildBackup(client);
      content = serializeBackup(backup);
      note(
        `  ${backup.favourites.tracks.length} favourite tracks, ` +
          `${backup.favourites.albums.length} albums, ` +
          `${backup.favourites.artists.length} artists, ` +
          `${backup.playlists.length} playlists`,
      );
    } else {
      const format = resolveExportFormat(args);
      const collection = await collectCollection(client, args.source);
      if (format === "m3u" && collection.kind !== "tracks") {
        throw new Error("M3U can only hold tracks; choose another format");
      }
      content = serializeCollection(collection, format);
      note(`  ${collection.items.length} ${collection.kind}`);
    }

    if (args.out !== undefined) {
      writeFileSync(args.out, content);
      logger.info(`Wrote ${args.out}`);
    } else {
      process.stdout.write(content);
    }
  };
}

/** Format for an export: an explicit `--format`, else inferred from `--out`, else JSON. */
function resolveExportFormat(args: ExportArgs): Format {
  if (args.format !== undefined) {
    return args.format;
  }
  if (args.out !== undefined) {
    const inferred = formatFromFilename(args.out);
    if (inferred !== undefined) {
      return inferred;
    }
  }
  return "json";
}

/**
 * Validate the import command's arguments and read the file up front, returning
 * an executor. Resolving to Qobuz ids and (with `--apply`) writing happen once
 * the client is signed in; without `--apply` it resolves and reports only.
 */
function planImport(argv: string[]): (client: QobuzClient) => Promise<void> {
  const args = parseImportArgs(argv);
  const content = readFileSync(args.file, "utf8");

  if (args.target.type === "account") {
    return planRestore(content, args.apply);
  }
  if (looksLikeBackup(content)) {
    throw new Error(
      "This looks like a full-account backup; restore it with `import --account`.",
    );
  }

  const format = resolveImportFormat(args);
  const kind = kindForTarget(args.target);
  const target = toImportTarget(args.target, args.isPublic);

  return async (client: QobuzClient): Promise<void> => {
    const parsed = parseCollection(content, format, kind);
    logger.info(`Resolving ${parsed.items.length} ${kind} from ${args.file}...`);
    const plan = await resolveImport(client, parsed);
    logger.info(`  matched ${plan.matched.length} of ${parsed.items.length}`);
    if (plan.unmatched.length > 0) {
      logger.warn(`not found: ${plan.unmatched.join(", ")}`);
    }

    if (!args.apply) {
      if (plan.matched.length > 0) {
        logger.info(
          `\n(dry run -- pass --apply to import the ${plan.matched.length} matched ${kind})`,
        );
      }
      return;
    }
    if (plan.matched.length === 0) {
      logger.info("\nNothing to import.");
      return;
    }
    const result = await commitImport(client, plan, target);
    if (result.playlist !== undefined) {
      logger.info(
        `\nCreated "${result.playlist.name}" (id ${result.playlist.id}) with ${result.written} tracks.`,
      );
    } else {
      logger.info(`\nImported ${result.written} ${kind}.`);
    }
  };
}

/** Executor for restoring a full-account backup (dry-run unless `apply`). */
function planRestore(
  content: string,
  apply: boolean,
): (client: QobuzClient) => Promise<void> {
  const backup = parseBackup(content);
  return async (client: QobuzClient): Promise<void> => {
    const counts =
      `${backup.favourites.tracks.length} favourite tracks, ` +
      `${backup.favourites.albums.length} albums, ` +
      `${backup.favourites.artists.length} artists, ` +
      `${backup.playlists.length} playlists`;
    if (!apply) {
      logger.info(`Backup contains ${counts}.`);
      logger.info("\n(dry run -- pass --apply to restore it)");
      return;
    }
    logger.info(`Restoring ${counts}...`);
    const result = await restoreBackup(client, backup);
    logger.info(
      `\nRestored ${result.favouriteTracks} favourite tracks, ` +
        `${result.favouriteAlbums} albums, ${result.favouriteArtists} artists, ` +
        `and recreated ${result.playlists.length} playlists.`,
    );
  };
}

/** Format for an import: an explicit `--format`, else inferred from the filename. */
function resolveImportFormat(args: ImportArgs): Format {
  if (args.format !== undefined) {
    return args.format;
  }
  const inferred = formatFromFilename(args.file);
  if (inferred === undefined) {
    throw new Error(
      "Could not infer the format from the filename; pass --format <json|csv|text|m3u>",
    );
  }
  return inferred;
}

/** Which collection kind a target imports (favourite albums/artists aside, tracks). */
function kindForTarget(target: ImportTargetArg): CollectionKind {
  if (target.type === "favourite-albums") return "albums";
  if (target.type === "favourite-artists") return "artists";
  return "tracks";
}

/** Map a CLI import target to the feature module's write target. */
function toImportTarget(target: ImportTargetArg, isPublic: boolean): ImportTarget {
  switch (target.type) {
    case "favourites":
    case "favourite-albums":
    case "favourite-artists":
      // Favourites route by the plan's kind inside commitImport.
      return { type: "favourites" };
    case "playlist-existing":
      return { type: "playlist-existing", playlistId: target.playlistId };
    case "playlist-new":
      return { type: "playlist-new", name: target.name, isPublic };
    case "account":
      // Restores never reach here (planImport handles account separately).
      throw new Error("account restore is handled separately");
  }
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
      '  qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] [--exclude-track <term>]... [--exclude-album <term>]... "Artist" ...',
      '  qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] [--public] [--discs <list>] [--exclude-track <term>]... [--exclude-album <term>]... "Artist - Album" ...',
      '  qobuz-helper similar-artists --name "<name>" [--similar N] [--depth D] [--tracks M] [--seed-tracks K] [--public] [--exclude-track <term>]... [--exclude-album <term>]... "Artist" ...',
      "  qobuz-helper similar-artists --playlist <id> [--seeds S] [--similar N] [--depth D] [--tracks M] [--exclude-track <term>]... [--exclude-album <term>]... [--apply]",
      "  qobuz-helper deduplicate (--playlist <id> | --favourites) [--keep <strategy>] [--apply]",
      "  qobuz-helper export (--favourites | --favourite-albums | --favourite-artists | --playlist <id> | --account) [--format <json|csv|text|m3u>] [--out <file>]",
      "  qobuz-helper import (--favourites | --favourite-albums | --favourite-artists | --playlist <id> | --new-playlist <name> | --account) [--format <json|csv|text|m3u>] [--public] [--apply] <file>",
      "",
      "Global options:",
      "  --loglevel <silent|error|warn|info|debug>   how much to log (default info)",
      "",
      "The session is saved after first sign-in and resumed automatically; use logout to clear it.",
      "Artist names (playlist-from-artists) and 'Artist - Album' lines (playlist-from-albums) may also be piped on stdin, one per line.",
      "Album version preferences: highest-quality (default), newest, oldest.",
      "Exclude terms match whole words, ignoring case (\"live\" skips \"Live at Leeds\", not \"Alive\"); write /pattern/ for a regex. Repeat the flag for more terms.",
      "--discs keeps only the listed discs of each album, e.g. 1 or 1,3-4.",
      "similar-artists defaults: --similar 3 (1-20), --depth 1 (1-3), --tracks 3 (1-30), --seed-tracks 5 (0-100), --seeds 10 (1-50); --playlist adds only with --apply.",
      "Keep strategies: first-added (default), last-added, highest-quality, oldest, newest.",
      "deduplicate reports only unless --apply is given.",
      "export writes to stdout unless --out is given; --account writes a full JSON backup.",
      "import resolves and reports only unless --apply is given; --account restores a backup.",
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
