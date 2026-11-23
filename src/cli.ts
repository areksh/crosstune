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
 *       [--exclude-artist <name>]... [--order by-artist|take-turns|shuffle] \
 *       [--skip-favourites] [--one-copy] [--fit <minutes>] "Artist One" ...
 *       Build a playlist from the given artists' top tracks. Artist names (or
 *       Qobuz artist links) may also be piped on stdin, one per line. Tracks whose title, album's
 *       title or performer matches an exclude term -- or, with
 *       --skip-favourites, already in your favourites, or with --one-copy, a
 *       later copy of a song already in the playlist -- are replaced by the
 *       artist's next most popular tracks. --fit trims the playlist to at most
 *       about that many minutes, from the end of each artist's tracks in turn;
 *       --order chooses how it plays (default by-artist).
 *
 *   qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] \
 *       [--public] [--discs <list>] [--exclude-track <term>]... \
 *       [--exclude-album <term>]... [--exclude-artist <name>]... \
 *       "Artist One - Album One" ...
 *       Build a playlist from whole albums. Each entry is "Artist - Album" or
 *       a Qobuz album link (that exact release); entries may also be piped on
 *       stdin, one per line. When an album has
 *       several versions, --prefer picks one: highest-quality (default), newest,
 *       or oldest. Releases matching --exclude-album are never picked; tracks
 *       matching --exclude-track or --exclude-artist, or on a disc outside
 *       --discs, are left out. --skip-favourites, --one-copy, --fit <minutes>
 *       (trimming the end of the list) and --order as-listed|shuffle work as
 *       for playlist-from-artists, without replacements.
 *
 *   qobuz-helper playlist-from-albums --name "<name>" --discography "<artist>" \
 *       [--include albums,eps,live,compilations] [--all-versions] \
 *       [--prefer <preference>] [--public] [filters]
 *       The same, from an artist's releases (oldest first) instead of album
 *       lines: studio albums unless --include names other kinds, and one
 *       version of each album (chosen by --prefer) unless --all-versions.
 *
 *   qobuz-helper deduplicate (--playlist <id> | --favourites | --all-playlists)
 *                            [--keep <strategy>[,<strategy>...]]
 *                            [--include-versions] [--apply]
 *       Report duplicate tracks (including remasters and same-song-different-
 *       album) in a playlist, in your favourites, or in each of your playlists,
 *       marking which copy to keep. --keep: first-added (default), last-added,
 *       highest-quality, oldest, newest; a comma-separated chain breaks ties in
 *       order. --all-playlists also lists songs saved in more than one
 *       playlist (report only; choose where each stays in the web UI). Without
 *       --apply it only reports; with --apply it removes the tracks marked
 *       "drop".
 *
 *   qobuz-helper remove-artists (--playlist <id>... | --all-playlists)
 *                               [--include-guests] [--apply] <artist>...
 *       Report the songs by these artists (names, Qobuz artist links or
 *       /patterns/, also on stdin) in your playlists; with --apply, remove
 *       them. Songs where they are only a guest are kept unless
 *       --include-guests is given.
 *
 *   qobuz-helper upgrade (--favourites | --playlist <id> | --all-playlists)
 *                        [--allow-signature-match] [--remove-unplayable] [--apply]
 *       Find tracks with a better-quality release of the same recording (same
 *       ISRC), and tracks Qobuz no longer streams, proposing a streamable
 *       replacement for each. --allow-signature-match also proposes upgrades
 *       matched by artist+title only (maybe a different recording);
 *       --remove-unplayable removes unplayable tracks with no replacement.
 *       Without --apply it only reports.
 *
 *   qobuz-helper export (--favourites | --favourite-albums | --favourite-artists
 *       | --playlist <id> | --account) [--format <json|csv|text|m3u>] [--out <file>]
 *       Export favourites or a playlist (or the whole account, with --account)
 *       to a file or stdout. --account always writes a lossless JSON backup;
 *       otherwise --format chooses the format (inferred from --out's extension
 *       when omitted, else JSON).
 *
 *   qobuz-helper export --all-playlists --out-dir <dir> [--format <json|csv|text|m3u>]
 *       Export every playlist to its own file in <dir> (JSON unless --format),
 *       named after the playlist (made safe and unique).
 *
 *   qobuz-helper import (--favourites | --favourite-albums | --favourite-artists
 *       | --playlist <id> | --new-playlist <name> | --account)
 *       [--format <json|csv|text|m3u|spotify>] [--public] [--apply] <file>
 *       Import a file into favourites or a playlist, resolving each entry to a
 *       Qobuz item (by its id when present, else by its ISRC, else by search).
 *       --account restores a full backup. Without --apply it resolves and
 *       reports only; the format is inferred from the filename when --format is
 *       omitted, and a CSV exported from Spotify by Exportify is recognised
 *       from its header.
 *
 *   qobuz-helper similar-artists --name "<name>" [--similar N] [--depth D] \
 *       [--tracks M] [--max-artists A] [--seed-tracks K] [--public] [--yes] \
 *       [--replace-repeats] [filters] "Artist" ...
 *   qobuz-helper similar-artists --playlist <id> [--seeds S] [--similar N] \
 *       [--depth D] [--tracks M] [--max-artists A] [--yes] [--replace-repeats] \
 *       [filters] [--apply]
 *       Add the top tracks of Qobuz's similar artists, walked to depth D from
 *       the given artists (alongside K of their own tracks, in a new playlist)
 *       or from a playlist's S most frequent artists (added to that playlist;
 *       without --apply it only reports). Artists already in the playlist are
 *       never suggested. Each artist is kept to its own top N: one that already
 *       came up uses a slot and is listed again (added once), unless
 *       --replace-repeats takes the next most similar instead. The walk stops
 *       after A similar artists (default 100); a run estimated to be very large
 *       is refused unless --yes is given. A similar artist matching
 *       --exclude-artist is left out (and not walked from), and the next most
 *       similar one takes its place; seeds are used regardless.
 *       --skip-favourite-artists treats your favourite artists like the
 *       playlist's own; --order, --skip-favourites, --one-copy and --fit work
 *       as for playlist-from-artists.
 *
 *   qobuz-helper combine --playlist <id> --playlist <id> [...] [--favourites] \
 *       [--mode merge|only-first|common] [--order sequential|interleave|shuffle] \
 *       [--keep highest-quality|first] [--exact-ids-only] [--name <name>] \
 *       [--public] [--apply]
 *       Merge two or more playlists (and/or your favourites) into a new
 *       playlist, each song once; or keep only the songs of the first that the
 *       others lack, or only the songs all of them share. Remasters count as
 *       the same song unless --exact-ids-only. Without --apply it only reports.
 *
 *   qobuz-helper stats (--favourites | --playlist <id> | --everything) [--json]
 *       [--decade-playlist <decade> [--name <name>] [--public] [--apply]]
 *       Report track and artist counts, total length, quality split, tracks
 *       by decade and the most-saved artists and albums. --decade-playlist
 *       (e.g. 1990s) makes a playlist of one decade's tracks (with --apply).
 *
 *   qobuz-helper word-play (--sentence "<text>" [--split fewest|words|any] \
 *       [--max-span K] | --contains <word> [--count N] | --exact <word> \
 *       [--count N] | --acrostic <word> (--favourites | --playlist <id>) \
 *       | --a-to-z (--favourites | --playlist <id>)) [--close-forms] \
 *       [--keep-punctuation] [--keep-versions] [--allow-repeat-artists] \
 *       [--prefer-hires] [--name <name>] [--public] [--add-to <id>] \
 *       [filters] [--apply]
 *       Make a playlist out of song titles: titles containing or equal to a
 *       word, titles that read as a sentence in order, or (from favourites or
 *       a playlist) titles whose first letters spell a word or run A to Z.
 *       Reports the plan only unless --apply is given.
 *
 *   qobuz-helper new-releases [--since YYYY-MM-DD | --days N] [--playlist <id>] \
 *       [--include albums,eps,live,compilations] [filters] \
 *       [--name "<name>" [--public] --apply | --favourite-albums --apply]
 *       List what your favourite artists (or a playlist's artists) released
 *       lately: by default albums, EPs and singles from the last 30 days,
 *       without releases already in your favourite albums or reissues of older
 *       albums. With --apply, put them in a new playlist (--name) or add them
 *       to your favourite albums; otherwise it only reports.
 *
 *   qobuz-helper history [--limit N]
 *       List the changes qobuz-helper made to your account (newest first):
 *       each entry's id, time, what it did, and how much it added/removed.
 *
 *   qobuz-helper undo [<id>] [--apply]
 *       Show how an entry (by default the latest change not yet undone) would
 *       be reversed; with --apply, reverse it. The undo is recorded too.
 *
 * With no command, `check` runs. The session is stored at
 * $XDG_CONFIG_HOME/qobuz-helper/session.json (owner-only), and every change a
 * command makes is recorded in history.jsonl beside it (see
 * src/features/journal.ts).
 *
 * A global `--loglevel <silent|error|warn|info|debug>` option (default `info`)
 * controls how much is logged; it may appear anywhere in the arguments.
 *
 * A global `--json` option (also anywhere) makes a command print exactly one
 * JSON document -- its plan or result -- to stdout, with every log line on
 * stderr instead (see src/cli/output.ts).
 */

import { shortId, type ArtistId, type PlaylistId, type UserId } from "./services/ids.js";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractLogLevel,
  parseAlbumArgs,
  parseCombineArgs,
  parseDedupeArgs,
  parseExportArgs,
  parseHistoryArgs,
  parseImportArgs,
  parseJobsArgs,
  parseLoginArgs,
  type LoginArgs,
  parseRunDueArgs,
  parseScheduleArgs,
  parseServeArgs,
  parseNewReleasesArgs,
  parsePlaylistArgs,
  parseSimilarArgs,
  parseStatsArgs,
  parseUndoArgs,
  parseWordPlayArgs,
  parseRemoveArtistsArgs,
  parseUpgradeArgs,
  type DedupeSource,
  type RemoveArtistsArgs,
  type ExportArgs,
  type ImportArgs,
  type ImportTargetArg,
  type UndoArgs,
  type JobsArgs,
} from "./cli/args.js";
import { clearCredentials } from "./cli/bundle-store.js";
import { fileHistoryStore } from "./cli/history-store.js";
import { fileCredentialStore, initClientWithCache } from "./cli/init.js";
import { count } from "./cli/text.js";
import { createLogger, DEFAULT_LOG_LEVEL, defaultSinks, type Logger } from "./cli/logger.js";
import { authenticateByPaste, authenticateViaBrowser } from "./cli/oauth-login.js";
import { configDir } from "./cli/config-dir.js";
import { acquireLockWithin, tryAcquireLock } from "./cli/file-lock.js";
import {
  fileGlobalStore,
  fileJobStateStore,
  fileJobStore,
  fileRunLog,
} from "./cli/job-store.js";
import {
  describeResult,
  formatAccept,
  formatJobList,
  formatPreview,
  formatRunSummary,
  formatSuggestions,
} from "./jobs/format.js";
import { emptyJobState, validateJob, type Job } from "./jobs/model.js";
import { runPass, type RefreshClient } from "./jobs/refresh.js";
import { acceptNow, runDue, type ConnectResult, type RunDueDeps } from "./jobs/run-due.js";
import { scheduleSnippet } from "./jobs/schedule-print.js";
import { jobsService, type JobsService } from "./jobs/service.js";
import { openInBrowser } from "./cli/open-browser.js";
import {
  createOutput,
  extractJsonFlag,
  logSinksFor,
  omitKeys,
  toJson,
  type CommandOutput,
} from "./cli/output.js";
import { fileTokenStore, restoreOrLogin } from "./cli/session.js";
import { createInterface } from "node:readline/promises";
import { startServer, type RunningServer } from "./server/http.js";
import type { ApiDeps } from "./server/router.js";
import {
  deduplicateTracks,
  formatOtherVersions,
  otherVersions,
  enrichReleaseDates,
  formatAcrossPlaylistsReport,
  formatResolutionReport,
  removePlaylistEntries,
  resolveDuplicateGroups,
  scanAllPlaylists,
  strategyNeedsReleaseDates,
  tracksToRemove,
  type DedupTrack,
  type KeepStrategy,
  type PlaylistEntry,
} from "./features/deduplicate.js";
import {
  addTracksToExistingPlaylist,
  buildPlaylistFromArtists,
  createPlaylistWithTracks,
  lookUpArtist,
  shapeArtistGroups,
} from "./features/playlist-from-artists.js";
import { formatDuration } from "./features/playlist-shape.js";
import { createSongPicker } from "./features/song-picker.js";
import {
  describeEstimate,
  estimateSimilar,
  favouriteArtistIds,
  planFromArtists,
  planFromPlaylist,
  similarTrackGroups,
  type SimilarPlan,
} from "./features/similar-artists.js";
import { compileTrackFilter } from "./features/track-filter.js";
import {
  commitUpgrades,
  formatUpgradeReport,
  planChanges,
  resolveUpgrades,
} from "./features/upgrade.js";
import {
  buildBackup,
  collectCollection,
  commitImport,
  countMatchMethods,
  describeMatchCounts,
  effectiveImportFormat,
  exportAllPlaylists,
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
  type ImportFormat,
  type ImportTarget,
} from "./features/import-export.js";
import {
  buildPlaylistFromAlbums,
  parseAlbumLine,
  type AlbumEntry,
  type AlbumLinkEntry,
  type BuildAlbumPlaylistResult,
} from "./features/playlist-from-albums.js";
import {
  combinedTrackIds,
  formatCombineReport,
  resolveCombine,
} from "./features/combine.js";
import {
  collectLibrary,
  computeStats,
  findDecade,
  formatStatsReport,
} from "./features/stats.js";
import {
  commitWordPlay,
  resolveWordPlay,
  splitTrackIds,
  type WordPlayPlan,
  type WordPlaySlot,
  type WordPlaySplit,
} from "./features/word-play.js";
import { buildPlaylistFromDiscography } from "./features/discography.js";
import {
  commitNewReleases,
  daysBefore,
  DEFAULT_WINDOW_DAYS,
  findNewReleases,
} from "./features/new-releases.js";
import { formatHistoryList, selectEntry, toSummary, type HistorySource } from "./features/history.js";
import { Journal, recordingClient } from "./features/journal.js";
import {
  commitRemovals,
  formatRemoveArtists,
  removalsOf,
  resolveRemoveArtists,
} from "./features/playlist-manager.js";
import {
  applyUndo,
  describeStep,
  formatUndoPlan,
  formatUndoResult,
  planUndo,
} from "./features/undo.js";
import { QobuzClient, QobuzError } from "./services/qobuz/index.js";
import { Accounts, type AccountStore, type Connector } from "./accounts/accounts.js";
import { oauthConnector, type OAuthConnectorOptions } from "./accounts/oauth-connector.js";
import { SpotifyClient } from "./services/spotify/client.js";
import {
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_SCOPES,
  SPOTIFY_SIGN_IN_MONTHS,
  SPOTIFY_TOKEN_URL,
} from "./services/spotify/oauth-config.js";
import { SpotifyService } from "./services/spotify/service.js";
import { TidalClient } from "./services/tidal/client.js";
import { TIDAL_AUTHORIZE_URL, TIDAL_SCOPES, TIDAL_TOKEN_URL } from "./services/tidal/oauth-config.js";
import { TidalService } from "./services/tidal/service.js";
import { fileAccountStore, fileTokenVault, removeTokens } from "./cli/account-store.js";
import { fileLinkStateStore, fileLinkStore } from "./cli/link-store.js";
import { fileMatches } from "./cli/match-store.js";
import type { LinkConnect } from "./sync/runner.js";
import { linksService, type LinksService } from "./sync/service.js";
import { qobuzConnector } from "./cli/qobuz-connector.js";
import { DEFAULT_SIGN_IN_PORT, signInListener, type SignInListener } from "./cli/sign-in-listener.js";
import { forgetInHistory } from "./features/forget.js";
import { parseHistory, serializeRecords } from "./features/history.js";
import { homeService, jobServices } from "./jobs/model.js";
import { unflag } from "./jobs/stores.js";
import { labelOf, ServiceError } from "./services/errors.js";
import { ServiceHub } from "./services/hub.js";
import { isServiceName, SERVICES, type ServiceName } from "./services/names.js";
import { QobuzService } from "./services/qobuz/service.js";
import type { Account, MusicService } from "./services/service.js";

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

/**
 * The command's machine-readable output. Replaced in {@link main} once
 * `--json` is parsed; commands record their plan/result into it, and it is
 * written (in JSON mode only) when the command finishes.
 */
let output: CommandOutput = createOutput(false, "");

async function main(): Promise<void> {
  const { level, rest: afterLevel } = extractLogLevel(process.argv.slice(2));
  const { json, rest: args } = extractJsonFlag(afterLevel);
  logger = createLogger(level, logSinksFor(json, defaultSinks));
  const command = args[0] ?? "check";
  output = createOutput(json, command);
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
    output.set("cleared", hadSession);
    output.flush();
    return;
  }

  // Every change a command makes is recorded here (see recordingClient below).
  const journal = openJournal("cli");

  // `history` only reads the local history file.
  if (command === "history") {
    const { limit } = parseHistoryArgs(args.slice(1));
    const items = journal.items().slice(0, limit);
    output.set("entries", items.map(toSummary));
    logger.info(formatHistoryList(items));
    if (items.length > 0) {
      logger.info("\nSee how one would be undone with: qobuz-helper undo <id>");
    }
    output.flush();
    return;
  }

  // `schedule print` only prints a snippet for the OS scheduler.
  if (command === "schedule") {
    const { target } = parseScheduleArgs(args.slice(1));
    const text = scheduleSnippet(target, {
      node: process.execPath,
      script: realpathSync(process.argv[1] ?? "."),
      logFile: join(configDir(), "run-due.log"),
    });
    output.set("snippet", text);
    logger.info(text);
    if (/[\\/]_npx[\\/]/.test(realpathSync(process.argv[1] ?? "."))) {
      logger.warn(
        "\nThis points into npx's temporary cache, which npm may clear; install qobuz-helper (npm install -g) and run schedule print from there.",
      );
    }
    if (/\.[cm]?ts$/.test(process.argv[1] ?? "")) {
      logger.warn(
        "\nThis points at the TypeScript source; run schedule print from a built install (npm run build, then node dist/cli.js) so the scheduler can run it.",
      );
    }
    output.flush();
    return;
  }

  // `run-due` signs in (without a browser) only when a job is due.
  if (command === "run-due") {
    const { dryRun } = parseRunDueArgs(args.slice(1));
    await runDueCommand(journal, dryRun);
    output.flush();
    return;
  }

  // The web UI opens whatever is connected: accounts are signed in to from it.
  if (command === "ui") {
    await runUi();
    return;
  }
  if (command === "serve") {
    await runServe(parseServeArgs(args.slice(1)));
    return;
  }

  // Other services than Qobuz sign in through the accounts.
  if (command === "login") {
    const login = parseLoginArgs(args.slice(1));
    if (login.service !== "qobuz") {
      await signIn(login, journal);
      output.flush();
      return;
    }
  }

  // `sync`: sync every linked playlist now, due or not.
  if (command === "sync") {
    const connections = openConnections(journal);
    await connections.accounts.resume();
    await runLinksNow(openLinks(journal, connections), { all: true });
    output.flush();
    return;
  }

  // `forget <service>`: sign out and delete what is kept about it.
  if (command === "forget") {
    const service = args[1];
    if (!isServiceName(service) || args.length > 2) {
      throw new Error("forget takes one service: qobuz, tidal or spotify");
    }
    openConnections(journal).accounts.forget(service);
    forgetService(service);
    output.flush();
    return;
  }

  // `accounts` only reads what is saved.
  if (command === "accounts") {
    showAccounts();
    output.flush();
    return;
  }

  // Most `jobs` actions only touch the local job files.
  let jobsArgs: JobsArgs | undefined;
  if (command === "jobs") {
    jobsArgs = parseJobsArgs(args.slice(1));
    if (runJobsOffline(jobsArgs)) {
      output.flush();
      return;
    }
  }

  // Resolve the command and validate its arguments *before* any network or
  // sign-in, so bad input fails fast without opening a browser. `login` just
  // establishes (and persists) a session, so its action is a no-op.
  let run: (client: MusicService, signedIn: SignedIn) => Promise<void>;
  let printLoginUrl = false;
  switch (command) {
    case "login":
      printLoginUrl = parseLoginArgs(args.slice(1)).printUrl;
      run = async () => clearSignInFlag();
      break;
    case "jobs": {
      const parsed = jobsArgs;
      if (parsed === undefined) {
        throw new Error("unreachable: jobs arguments not parsed");
      }
      run = (client) => runJobsOnline(client, journal, parsed);
      break;
    }
    case "check":
      run = (_client, { qobuz }) => runCheck(qobuz);
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
    case "remove-artists": {
      const given = parseRemoveArtistsArgs(args.slice(1));
      const parsed = { ...given, artists: given.artists.length > 0 ? given.artists : readLinesFromStdin() };
      if (parsed.artists.length === 0) {
        throw new Error("No artists given. Pass them as arguments or pipe them on stdin.");
      }
      run = (client, { account }) => runRemoveArtists(client, account, parsed);
      break;
    }
    case "upgrade": {
      const plan = planUpgrade(args.slice(1));
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
    case "new-releases": {
      const plan = planNewReleases(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "combine": {
      const plan = planCombine(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "stats": {
      const plan = planStats(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "word-play": {
      const plan = planWordPlay(args.slice(1));
      run = (client) => plan(client);
      break;
    }
    case "undo": {
      const parsed = parseUndoArgs(args.slice(1));
      run = (client) => runUndo(client, journal, parsed);
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
    printLoginUrl
      ? () => authenticateByPaste(client, consoleIO())
      : () => authenticateViaBrowser(client, { log: (message) => logger.info(message) }),
    (message) => logger.info(message),
  );
  logger.info(
    `  ${restored ? "resumed session" : "signed in"} as ${session.displayName} (${session.subscriptionLabel})`,
  );

  const service = new QobuzService(client);
  const account = service.account();
  if (account === undefined) {
    throw new Error("unreachable: not signed in");
  }
  const signedIn: SignedIn = { account, qobuz: client };
  // The command sees a client that records every change it makes, all of it
  // one history entry (an undo records its own "Undid: ..." entry).
  const hub = new ServiceHub();
  hub.connect(recordingClient<MusicService>(service, journal));
  const recorded = hub.scoped("qobuz");
  await (command === "undo"
    ? run(recorded, signedIn)
    : journal.run({ tool: command === "jobs" ? "managed" : command }, () => run(recorded, signedIn)));
  output.flush();
}

/** Who is signed in, and Qobuz's client for what only it can do. */
interface SignedIn {
  account: Account;
  qobuz: QobuzClient;
}

/** The history journal, writing to the history file beside the session. */
function openJournal(source: HistorySource): Journal {
  return new Journal({
    store: fileHistoryStore(),
    source,
    onWriteError: (error) =>
      logger.warn(
        `could not write the history file (${error instanceof Error ? error.message : String(error)}); this change cannot be undone with qobuz-helper`,
      ),
  });
}

/**
 * Executor for `undo`: show how the chosen entry would be reversed, and with
 * --apply reverse it (recorded as an entry of its own).
 */
async function runUndo(client: MusicService, journal: Journal, args: UndoArgs): Promise<void> {
  const items = journal.items();
  const item = selectEntry(items, args.id);
  if (item === undefined) {
    if (args.id !== undefined) {
      throw new Error(`No history entry ${args.id} (see qobuz-helper history).`);
    }
    output.assign({ entry: null, applied: false });
    logger.info("Nothing to undo.");
    return;
  }
  const plan = await planUndo(client, item, items);
  output.assign({
    entry: toSummary(item),
    plan: {
      steps: plan.steps.map(describeStep),
      notes: plan.notes,
      warnings: plan.warnings,
      ...(plan.blocked !== undefined && { blocked: plan.blocked }),
    },
    applied: false,
  });
  logger.info(formatUndoPlan(plan));
  if (plan.blocked !== undefined) {
    process.exitCode = 1;
    return;
  }
  if (!args.apply) {
    logger.info(`\n(dry run -- pass --apply to undo it: qobuz-helper undo ${item.id} --apply)`);
    return;
  }
  const outcome = await applyUndo(journal, client, item, plan);
  const paused = openLinks(journal, undefined).undone(item.id);
  if (paused.length > 0) {
    logger.info(`The linked playlist this synced is paused; resume it when its copies are as you want them.`);
  }
  output.assign({ applied: true, result: outcome });
  logger.info(`\n${formatUndoResult(outcome)}`);
  if (outcome.undone) {
    logger.info(`\nUndone; recorded as ${outcome.entryId}.`);
  } else {
    logger.warn("nothing could be undone; the entry is left as it was so you can try again");
    process.exitCode = 1;
  }
}

/** The connected services and the sign-ins to them, for the web UI and jobs. */
interface Connections {
  hub: ServiceHub;
  accounts: Accounts;
  listener: SignInListener;
}

function openConnections(journal: Journal): Connections {
  const hub = new ServiceHub();
  const store = fileAccountStore();
  const accounts = new Accounts({
    hub,
    store,
    connectors: connectors(store),
    wrap: (service) => recordingClient<MusicService>(service, journal),
    onChange: (service) => {
      // A service that works again lets the jobs it stopped run.
      if (hub.connected().includes(service)) {
        const global = fileGlobalStore();
        global.save(unflag(global.load(), [service]));
      }
    },
  });
  const listener = signInListener({
    complete: async (target) => {
      try {
        const { service, displayName } = await accounts.complete(target);
        return { ok: true, message: `${labelOf(service)} is connected as ${displayName}.` };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    },
  });
  return { hub, accounts, listener };
}

/** Where a service's sign-in comes back to; registered with the user's app. */
function redirectUri(service: ServiceName): string {
  return `http://127.0.0.1:${DEFAULT_SIGN_IN_PORT}/callback/${service}`;
}

/** How each service is signed in to. A new service is one entry here. */
function connectors(store: AccountStore): Connector[] {
  const oauth = (
    service: ServiceName,
    settings: Pick<OAuthConnectorOptions, "authorizeUrl" | "tokenUrl" | "scopes" | "lifetimeMs" | "load">,
  ): Connector =>
    oauthConnector({
      ...settings,
      service,
      redirectUri: redirectUri(service),
      clientId: () => store.clientId(service),
      vault: fileTokenVault(service),
      dropTokens: () => removeTokens(service),
    });
  return [
    qobuzConnector({
      newClient: () => new QobuzClient({ logger }),
      credentials: fileCredentialStore(),
      tokens: fileTokenStore(),
      port: DEFAULT_SIGN_IN_PORT,
    }),
    oauth("tidal", {
      authorizeUrl: TIDAL_AUTHORIZE_URL,
      tokenUrl: TIDAL_TOKEN_URL,
      scopes: TIDAL_SCOPES,
      load: async (tokens) => {
        const service = new TidalService(new TidalClient({ tokens, logger }));
        await service.load();
        return service;
      },
    }),
    oauth("spotify", {
      authorizeUrl: SPOTIFY_AUTHORIZE_URL,
      tokenUrl: SPOTIFY_TOKEN_URL,
      scopes: SPOTIFY_SCOPES,
      lifetimeMs: SPOTIFY_SIGN_IN_MONTHS * 30 * 24 * 60 * 60 * 1000,
      load: async (tokens) => {
        const service = new SpotifyService(new SpotifyClient({ tokens, logger }));
        await service.load();
        return service;
      },
    }),
  ];
}

/** `login <service>`: sign in from the terminal, by redirect or a pasted address. */
async function signIn(login: LoginArgs, journal: Journal): Promise<void> {
  const { hub, accounts, listener } = openConnections(journal);
  const { service } = login;
  if (login.clientId !== undefined) {
    accounts.setClientId(service, login.clientId);
  }
  const { url } = await accounts.start(service);
  const listening = login.printUrl ? undefined : await listener.listen();
  if (listening?.ok === true) {
    logger.info(`Opening your browser to sign in to ${labelOf(service)}...`);
    logger.info(`If it does not open, visit this URL manually:\n  ${url}`);
    openInBrowser(url);
    while (accounts.waiting(service)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // The redirect has been taken; the token and account are read after it.
    for (let waited = 0; waited < 60 && !hub.connected().includes(service); waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    listener.close();
  } else {
    if (listening !== undefined) {
      logger.warn(listening.problem);
    }
    const io = consoleIO();
    io.print(`Open this link in a browser on any device and sign in to ${labelOf(service)}:\n\n  ${url}\n`);
    io.print("Then copy the address of the page it ends on (it may not load) and paste it here.");
    await accounts.complete(await io.readLine("Address: "));
  }
  if (!hub.connected().includes(service)) {
    throw new Error(`${labelOf(service)} was not connected; run qobuz-helper login ${service} again.`);
  }
  logConnected(accounts);
}

/** Start the web server over the connected services. */
async function startUi(
  { hub, accounts, listener }: Connections,
  journal: Journal,
  jobs: RunDueDeps,
  options: { port?: number } = {},
  links?: LinksService,
): Promise<RunningServer> {
  return startServer({
    ...(links !== undefined && { links }),
    accounts: { accounts, hub, listen: () => listener.listen(), forget: (service) => forgetService(service) },
    history: { journal },
    matches: fileMatches(),
    jobs: jobsApi(jobs, hub),
    acquireWriteLock: () => acquireLockWithin(jobsLockPath(), WRITE_LOCK_WAIT_MS),
    ...(options.port !== undefined && { port: options.port }),
  });
}

/** What is connected, one line each; or how to connect something. */
function logConnected(accounts: Accounts): void {
  for (const account of accounts.view()) {
    if (account.status === "connected") {
      logger.info(`  ${account.label}: signed in as ${account.displayName}${account.plan === undefined ? "" : ` (${account.plan})`}`);
    } else if (account.problem !== undefined) {
      logger.warn(`${account.label}: ${account.problem}`);
    }
  }
}

/**
 * Forget what is kept about a service, once its sign-in is dropped: its
 * matches, the links and jobs that use it, and its entries in History.
 */
function forgetService(service: ServiceName): void {
  const dir = configDir();
  fileMatches(dir).forgetService(service);
  const links = fileLinkStore(dir);
  const linkStates = fileLinkStateStore(dir);
  const { links: all } = links.load();
  const gone = all.filter((link) => link.copies[service] !== undefined);
  links.save(all.filter((link) => !gone.includes(link)));
  gone.forEach((link) => linkStates.remove(link.id));
  const jobs = fileJobStore(dir);
  const states = fileJobStateStore(dir);
  const { file } = jobs.load();
  const unused = file.jobs.filter((job) => jobServices(job).includes(service));
  jobs.save({ ...file, jobs: file.jobs.filter((job) => !unused.includes(job)) });
  unused.forEach((job) => states.remove(job.id));
  const history = fileHistoryStore();
  const rewrite = (): number => {
    const { records, dropped } = forgetInHistory(parseHistory(history.read()), service);
    history.replace(serializeRecords(records));
    return dropped;
  };
  const dropped = history.exclusive === undefined ? rewrite() : history.exclusive(rewrite);
  if (dropped === undefined) {
    throw new Error(`History is busy; its ${labelOf(service)} entries were not removed. Forget ${labelOf(service)} again in a moment.`);
  }
  logger.info(
    `Forgot ${labelOf(service)}: ${gone.length} linked and ${unused.length} managed playlist(s) that used it, and ${dropped} History entr${dropped === 1 ? "y" : "ies"}.`,
  );
}

/**
 * Serve the web UI locally and open it in the browser, with the accounts that
 * are saved; others are connected from its Accounts page. The server runs until
 * interrupted, recording every change the UI commits as web entries.
 */
async function runUi(): Promise<void> {
  const journal = openJournal("web");
  const connections = openConnections(journal);
  const jobs = jobRunnerDeps(journal, connectThrough(connections));
  await connections.accounts.resume();
  const server = await startUi(connections, journal, jobs, {}, openLinks(journal, connections));
  logger.info(`\nWeb UI running at ${server.url}`);
  logConnected(connections.accounts);
  logger.info("Open it in your browser (it should open automatically).");
  logger.info("Press Ctrl-C to stop.");
  openInBrowser(server.url);
  await waitForInterrupt();
  logger.info("\nStopping...");
  connections.listener.close();
  await server.close();
}

/** Resolve when the process receives an interrupt (Ctrl-C). */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Read a line from the terminal (for the pasted sign-in). */
function consoleIO(): { print(text: string): void; readLine(prompt: string): Promise<string> } {
  return {
    print: (text) => logger.info(text),
    readLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}

/** A successful sign-in lets stopped jobs run again. */
function clearSignInFlag(): void {
  const global = fileGlobalStore();
  const { needsSignIn: _cleared, ...rest } = global.load();
  if (_cleared !== undefined) {
    global.save(rest);
    logger.info("Jobs stopped by the expired session will run again.");
  }
}

function openJobsService(): JobsService {
  const dir = configDir();
  return jobsService({
    jobs: fileJobStore(dir),
    state: fileJobStateStore(dir),
    runs: fileRunLog(dir),
    global: fileGlobalStore(dir),
  });
}

/** The lock held while a managed playlist is refreshed or the playlist manager writes. */
function jobsLockPath(dir: string = configDir()): string {
  return join(dir, "jobs.lock");
}

/** How long a playlist manager change waits for a refresh to finish. */
const WRITE_LOCK_WAIT_MS = 5000;

/** The job runner's files and lock, with each refresh one history entry. */
function jobRunnerDeps(journal: Journal, connect: RunDueDeps["connect"]): RunDueDeps {
  const dir = configDir();
  return {
    jobs: fileJobStore(dir),
    state: fileJobStateStore(dir),
    runs: fileRunLog(dir),
    global: fileGlobalStore(dir),
    acquireLock: () => tryAcquireLock(jobsLockPath(dir)),
    connect,
    journalRun: (label, fn) => journal.run({ tool: "managed", label }, fn),
  };
}

/**
 * Connect for unattended runs, from what is saved -- never a browser sign-in.
 * A service that was not connected, or stopped working, is tried again, so that
 * a sign-in made elsewhere is picked up.
 */
function connectThrough({ hub, accounts }: Connections): RunDueDeps["connect"] {
  return async (services) => {
    for (const service of services) {
      if (!hub.connected().includes(service)) {
        await accounts.resumeOne(service);
      }
      const view = accounts.view().find((account) => account.service === service);
      if (view?.problemKind === "bundle-extraction") {
        return { ok: false, reason: "bundle-broken", message: view.problem ?? "", service };
      }
      if (view?.status === "unreachable") {
        throw new ServiceError(service, view.problemKind ?? "network", view.problem ?? `${labelOf(service)} could not be reached`);
      }
      if (view?.status !== "connected") {
        const message = view?.problem ?? `${labelOf(service)} is not signed in; run qobuz-helper login${service === "qobuz" ? "" : ` ${service}`}`;
        return { ok: false, reason: "needs-sign-in", message, service };
      }
    }
    return { ok: true, client: hub.scoped(services[0] ?? "qobuz") };
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Executor for `run-due`: run the jobs and links that are due, then exit. */
async function runDueCommand(journal: Journal, dryRun: boolean): Promise<void> {
  const connections = openConnections(journal);
  const summary = await runDue(jobRunnerDeps(journal, connectThrough(connections)), new Date(), { dryRun });
  if (!dryRun) {
    await runLinksNow(openLinks(journal, connections));
  }
  output.set("summary", summary);
  logger.info(`${new Date().toISOString()} ${formatRunSummary(summary)}`);
  for (const bad of summary.invalid) {
    logger.warn(`job ${bad.id ?? `#${bad.index + 1}`} in jobs.json is invalid and skipped: ${bad.error}`);
  }
  if (summary.status === "jobs-file-error") {
    process.exitCode = 1;
  }
}

/** `jobs` actions that need no Qobuz session; true when handled. */
function runJobsOffline(args: JobsArgs): boolean {
  const service = openJobsService();
  switch (args.action) {
    case "list": {
      const list = service.list();
      output.assign(list);
      logger.info(formatJobList(list));
      return true;
    }
    case "show": {
      const view = service.get(args.id);
      if (view === undefined) {
        throw new Error(`No job ${args.id} (see qobuz-helper jobs list)`);
      }
      output.assign({ ...view });
      logger.info(formatJobList({ jobs: [view], invalid: [], flags: {} }));
      logger.info(toJson(view.job).trimEnd());
      for (const run of view.recentRuns) {
        logger.info(`  ${run.at}  ${describeResult(run.result)}`);
      }
      return true;
    }
    case "pause":
      output.set("job", service.setEnabled(args.id, false));
      logger.info(`Paused ${args.id}; it will not run until resumed.`);
      return true;
    case "resume": {
      service.setEnabled(args.id, true);
      const state = service.resume(args.id);
      output.set("state", state);
      logger.info(`Resumed ${args.id}; it runs on the next run-due or serve tick.`);
      return true;
    }
    case "suggestions": {
      const view = service.get(args.id);
      if (view === undefined) {
        throw new Error(`No job ${args.id} (see qobuz-helper jobs list)`);
      }
      output.set("suggestions", view.state.suggestions);
      logger.info(formatSuggestions(view));
      return true;
    }
    case "ignore": {
      const state = service.ignore(args.id, args.keys);
      output.set("state", state);
      logger.info(`Ignored; ${state.suggestions.length} suggestion(s) left.`);
      return true;
    }
    case "remove":
      if (args.deletePlaylist) {
        return false;
      }
      output.assign(service.remove(args.id));
      logger.info(`Removed ${args.id}; its playlist is left as it is.`);
      return true;
    default:
      return false;
  }
}

/** `jobs` actions that talk to Qobuz: create (with a preview), run, remove a playlist. */
async function runJobsOnline(client: MusicService, journal: Journal, args: JobsArgs): Promise<void> {
  const service = openJobsService();
  if (args.action === "remove") {
    const { job, playlistId } = service.remove(args.id);
    if (playlistId !== undefined) {
      await client.deletePlaylist(playlistId);
    }
    output.assign({ job, playlistId, playlistDeleted: playlistId !== undefined });
    logger.info(
      playlistId === undefined
        ? `Removed ${args.id}; it had not made a playlist yet.`
        : `Removed ${args.id} and deleted its playlist "${job.name}".`,
    );
    return;
  }
  if (args.action === "accept") {
    const outcome = await acceptNow(
      jobRunnerDeps(journal, async () => ({ ok: true, client })),
      args.id,
      args.keys,
      new Date(),
    );
    output.set("outcome", outcome);
    logger.info(formatAccept(outcome));
    return;
  }
  if (args.action === "run") {
    const summary = await runDue(
      jobRunnerDeps(journal, async () => ({ ok: true, client })),
      new Date(),
      { onlyJobId: args.id, dryRun: args.dryRun },
    );
    output.set("summary", summary);
    logger.info(formatRunSummary(summary));
    return;
  }
  if (args.action !== "create") {
    return;
  }

  const definition: Record<string, unknown> = { ...args.definition };
  if (args.artistQueries.length > 0) {
    const found: { id: ArtistId; name: string }[] = [];
    const problems: string[] = [];
    for (const query of args.artistQueries) {
      const match = await lookUpArtist(client, query);
      if ("problem" in match) {
        problems.push(match.problem);
      } else {
        found.push({ id: match.artist.id, name: match.artist.name });
        logger.info(`  ${query} -> ${match.artist.name}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`No Qobuz artist found for: ${problems.join(", ")}`);
    }
    const field = args.kind === "discovery" ? "seeds" : "artists";
    definition["source"] = { ...args.definition.source, [field]: { type: "list", artists: found } };
  }
  if (definition["name"] === undefined) {
    // A job on an existing playlist is named after it.
    const target = definition["target"] as { type: string; playlistId?: PlaylistId };
    definition["name"] =
      target.type === "favourites" || target.playlistId === undefined
        ? "Favourites"
        : (await client.getPlaylist(target.playlistId)).name;
  }
  const now = new Date();
  // Validate and preview the first refresh before saving anything.
  const draft: Job = validateJob({ ...definition, id: "00000000", createdAt: now.toISOString() });
  const { preview } = await runPass(client, draft, emptyJobState(), { now, dryRun: true });
  output.assign({ definition: draft, preview });
  logger.info(formatPreview(draft.name, preview));
  if (!args.apply) {
    logger.info(
      draft.target.type === "created"
        ? "\n(dry run -- pass --apply to save the job and make the playlist)"
        : "\n(dry run -- pass --apply to save the job and run it)",
    );
    return;
  }
  const job = service.create(definition, now);
  const summary = await runDue(
    jobRunnerDeps(journal, async () => ({ ok: true, client })),
    now,
    { onlyJobId: job.id },
  );
  output.assign({ job, summary });
  logger.info(`\nSaved job ${job.id}. ${formatRunSummary(summary)}`);
  logger.info("It refreshes on its schedule whenever run-due or serve runs (see qobuz-helper schedule print).");
}

/** The web UI's job routes, run with the UI's (recording) client. */
function jobsApi(deps: RunDueDeps, hub: ServiceHub): NonNullable<ApiDeps["jobs"]> {
  return {
    service: openJobsService(),
    runNow: (id, dryRun) => runDue(deps, new Date(), { onlyJobId: id, dryRun }),
    preview: async (input) => {
      const now = new Date();
      const job = validateJob({ ...(input as object), id: "00000000", createdAt: now.toISOString() });
      return (await runPass(hub.scoped(homeService(job)), job, emptyJobState(), { now, dryRun: true })).preview;
    },
    accept: (id, keys) => acceptNow(deps, id, keys, new Date()),
  };
}

/**
 * `serve`: the web UI plus a ticker that runs due jobs every minute, until
 * interrupted. Meant to stay up on an always-on machine.
 */
async function runServe(options: { open: boolean; port?: number }): Promise<void> {
  const journal = openJournal("web");
  const connections = openConnections(journal);
  const deps = jobRunnerDeps(journal, connectThrough(connections));
  const links = openLinks(journal, connections);
  await connections.accounts.resume();
  const server = await startUi(connections, journal, deps, options, links);
  logger.info(`\nWeb UI running at ${server.url}`);
  logConnected(connections.accounts);
  logger.info("Running due jobs every minute. Press Ctrl-C to stop.");
  if (options.open) {
    openInBrowser(server.url);
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const summary = await runDue(deps, new Date());
      if (summary.status !== "nothing-due") {
        logger.info(`${new Date().toISOString()} ${formatRunSummary(summary)}`);
      }
      await runLinksNow(links);
    } catch (error) {
      logger.warn(`job run failed: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  await waitForInterrupt();
  clearInterval(timer);
  logger.info("\nStopping...");
  connections.listener.close();
  await server.close();
}

/**
 * The linked playlists' service. With connections, they are synced with what
 * is connected; without, only what needs no service works (pausing, undo).
 */
function openLinks(journal: Journal, connections: Connections | undefined): LinksService {
  const dir = configDir();
  return linksService({
    links: fileLinkStore(dir),
    state: fileLinkStateStore(dir),
    runs: fileRunLog(dir),
    matches: fileMatches(dir),
    connect:
      connections === undefined
        ? async () => ({ ok: false, reason: "needs-sign-in", message: "not connected" })
        : linkConnect(connections),
    journalRun: (label, fn) => journal.run({ tool: "link", label }, fn),
    lock: async (fn) => {
      const lock = await acquireLockWithin(jobsLockPath(dir), WRITE_LOCK_WAIT_MS);
      if (lock === undefined) {
        throw new Error("A managed playlist is being refreshed; try again in a moment.");
      }
      try {
        return await fn();
      } finally {
        lock.release();
      }
    },
  });
}

/** Connect to the services a link joins, from what is saved. */
function linkConnect(connections: Connections): LinkConnect {
  const connect = connectThrough(connections);
  return async (services) => {
    const connected = await connect(services);
    return connected.ok
      ? { ok: true, clients: new Map(services.map((service) => [service, connections.hub.service(service)])) }
      : connected;
  };
}

/** Sync the links that are due; conflicts are reported and leave a non-zero exit. */
async function runLinksNow(links: LinksService, options: { all?: boolean } = {}): Promise<void> {
  const before = links.list().links.filter((view) => view.state.conflicts.length > 0).length;
  for (const view of links.list().links) {
    const due =
      view.link.enabled &&
      view.state.paused === undefined &&
      (options.all === true || view.state.nextRunAt === undefined || Date.parse(view.state.nextRunAt) <= Date.now());
    if (!due) {
      continue;
    }
    try {
      const summary = await links.run(view.link.id);
      for (const report of summary.reports) {
        logger.info(`${new Date().toISOString()} ${report.name}: ${describeResult(report.result)}`);
      }
      if (summary.blocked !== undefined) {
        logger.warn(`${labelOf(summary.blocked.service)}: ${summary.blocked.message}`);
      }
    } catch (error) {
      logger.warn(`${view.link.name}: ${errorMessage(error)}`);
    }
  }
  const conflicts = links.list().links.filter((view) => view.state.conflicts.length > 0);
  for (const view of conflicts) {
    logger.warn(`${view.link.name}: its copies disagree; nothing is written until you settle it in the web UI.`);
  }
  if (conflicts.length > 0 || before > 0) {
    process.exitCode = process.exitCode === undefined || process.exitCode === 0 ? EXIT_CONFLICT : process.exitCode;
  }
}

/** The exit code of a run that left linked playlists in conflict. */
const EXIT_CONFLICT = 3;

/** `accounts`: who is signed in to what, from what is saved (nothing is asked of the services). */
function showAccounts(): void {
  const store = fileAccountStore();
  const list = SERVICES.map((service) => {
    const account = store.account(service);
    return { service, label: labelOf(service), ...(account !== undefined && { displayName: account.displayName }) };
  });
  output.set("accounts", list);
  for (const { label, displayName } of list) {
    logger.info(`${label}: ${displayName ?? "not connected"}`);
  }
}

async function runCheck(client: QobuzClient): Promise<void> {
  logger.info("Fetching favourite tracks...");
  const favorites = (await client.getUserFavorites("tracks")) as {
    tracks?: { total?: number };
  };
  logger.info(`  favourite tracks: ${favorites.tracks?.total ?? "unknown"}`);
  output.set("favouriteTracks", favorites.tracks?.total ?? null);
  logger.info("\nOK: extraction -> OAuth sign-in -> authenticated call.");
}

/**
 * Validate the playlist command's arguments (and read any piped artist names)
 * up front, returning an executor to run once the client is signed in.
 */
function planPlaylistFromArtists(
  argv: string[],
): (client: MusicService) => Promise<void> {
  const parsed = parsePlaylistArgs(argv);
  const artists =
    parsed.artists.length > 0 ? parsed.artists : readLinesFromStdin();
  if (artists.length === 0) {
    throw new Error(
      "No artists given. Pass them as arguments or pipe them on stdin.",
    );
  }

  return async (client: MusicService): Promise<void> => {
    logger.info(
      `Building playlist "${parsed.playlistName}" from ${count(artists.length, "artist")}...`,
    );
    const result = await buildPlaylistFromArtists(client, {
      artists,
      playlistName: parsed.playlistName,
      isPublic: parsed.isPublic,
      ...(parsed.tracksPerArtist !== undefined && {
        tracksPerArtist: parsed.tracksPerArtist,
      }),
      ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
      ...parsed.plan,
    });
    output.assign({ applied: true, order: parsed.plan?.order ?? "by-artist", result });

    logger.info(
      `\nCreated "${result.playlist.name}" (id ${shortId(result.playlist.id)}) with ${count(result.trackCount, "track")} (${formatDuration(result.durationSeconds)}):`,
    );
    for (const resolved of result.resolvedArtists) {
      logger.info(
        `  ${resolved.artist.name}: ${count(resolved.trackCount, "track")}${excludedNote(resolved.excludedCount)}`,
      );
    }
    logFitNote(result.droppedToFit, parsed.plan?.fitMinutes);
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
): (client: MusicService) => Promise<void> {
  const parsed = parseAlbumArgs(argv);
  const { discography } = parsed;
  if (discography !== undefined) {
    return async (client: MusicService): Promise<void> => {
      const versions = discography.allVersions
        ? "every version"
        : `one version each, preferring ${parsed.preference}`;
      logger.info(
        `Building playlist "${parsed.playlistName}" from ${discography.artist}'s discography (${discography.include.join(", ")}; ${versions})...`,
      );
      const result = await buildPlaylistFromDiscography(client, {
        artist: discography.artist,
        include: discography.include,
        oneVersion: !discography.allVersions,
        playlistName: parsed.playlistName,
        preference: parsed.preference,
        isPublic: parsed.isPublic,
        ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
        ...parsed.plan,
      });
      reportAlbumPlaylist(result, parsed.plan?.fitMinutes);
      if (result.truncated) {
        logger.warn(
          `${result.artist.name} has more releases than were fetched; the oldest may be missing.`,
        );
      }
    };
  }
  const lines = parsed.entries.length > 0 ? parsed.entries : readLinesFromStdin();
  if (lines.length === 0) {
    throw new Error(
      "No albums given. Pass them as arguments or pipe them on stdin.",
    );
  }

  // Split each "Artist - Album" line (or album link) up front so bad input
  // fails before sign-in.
  const entries: (AlbumEntry | AlbumLinkEntry)[] = [];
  const malformed: string[] = [];
  for (const line of lines) {
    const parsed = parseAlbumLine(line);
    if ("problem" in parsed) {
      malformed.push(parsed.problem);
    } else {
      entries.push(parsed.entry);
    }
  }
  if (entries.length === 0) {
    throw new Error(
      'No albums in the expected "Artist - Album" format, or album links, were given.',
    );
  }

  return async (client: MusicService): Promise<void> => {
    if (malformed.length > 0) {
      logger.warn(`ignored (not "Artist - Album" or an album link): ${malformed.join(", ")}`);
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
      ...parsed.plan,
    });
    reportAlbumPlaylist(result, parsed.plan?.fitMinutes);
  };
}

/** Log the outcome of an album playlist build (from album lines or a discography). */
function reportAlbumPlaylist(result: BuildAlbumPlaylistResult, fitMinutes?: number): void {
  output.assign({ applied: true, result });
  logger.info(
    `\nCreated "${result.playlist.name}" (id ${shortId(result.playlist.id)}) with ${count(result.trackCount, "track")} (${formatDuration(result.durationSeconds)}):`,
  );
  for (const resolved of result.resolvedAlbums) {
    const version =
      resolved.album.version === undefined ? "" : ` [${resolved.album.version}]`;
    logger.info(
      `  ${resolved.album.artist} - ${resolved.album.title}${version}: ${count(resolved.trackCount, "track")}${excludedNote(resolved.excludedCount)}`,
    );
  }
  logFitNote(result.droppedToFit, fitMinutes);
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
}

/**
 * Validate the similar-artists command's arguments (and read any piped artist
 * names) up front, returning an executor to run once the client is signed in.
 */
function planSimilarArtists(
  argv: string[],
): (client: MusicService) => Promise<void> {
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
    maxArtists: parsed.maxArtists,
    replaceRepeats: parsed.replaceRepeats,
    ...(parsed.filter !== undefined && { filter: compileTrackFilter(parsed.filter) }),
  };

  // Size the run before signing in, and refuse a very large one unless asked.
  const estimate = estimateSimilar({
    ...walk,
    seedCount: source.type === "artists" ? artists.length : source.maxSeeds,
    tracksPerSeed: source.type === "artists" ? source.tracksPerSeed : 0,
  });
  if (estimate.large && !parsed.yes) {
    throw new Error(
      `This run could add ${describeEstimate(estimate)}. Lower --similar, --depth, --tracks or --max-artists, or pass --yes to go ahead.`,
    );
  }

  return async (client: MusicService): Promise<void> => {
    if (estimate.large) {
      logger.warn(`large run: ${describeEstimate(estimate)}`);
    }
    logger.info(
      `Finding ${parsed.similarPerArtist} similar artist${parsed.similarPerArtist === 1 ? "" : "s"} per artist, ${parsed.depth} level${parsed.depth === 1 ? "" : "s"} deep (${describeEstimate(estimate)})...`,
    );
    const picker = await createSongPicker(client, parsed.plan ?? {});
    const extras = {
      picker,
      ...(parsed.skipFavouriteArtists === true && {
        skipArtistIds: await favouriteArtistIds(client),
      }),
    };
    const plan =
      source.type === "artists"
        ? await planFromArtists(client, {
            ...walk,
            ...extras,
            artists,
            tracksPerSeed: source.tracksPerSeed,
          })
        : await planFromPlaylist(client, {
            ...walk,
            ...extras,
            playlistId: source.playlistId,
            maxSeeds: source.maxSeeds,
          });
    const shaped = shapeArtistGroups(
      similarTrackGroups(plan.seeds, plan.similar, plan.appearances),
      parsed.plan ?? {},
    );
    const trackIds = shaped.ordered.map((track) => track.id);
    output.assign({
      source,
      plan,
      trackIds,
      order: parsed.plan?.order ?? "by-artist",
      durationSeconds: shaped.seconds,
      droppedToFit: shaped.dropped.length,
      applied: false,
    });
    reportSimilarPlan(
      plan,
      source.type === "artists" && source.tracksPerSeed > 0,
      parsed.maxArtists,
    );
    logFitNote(shaped.dropped.length, parsed.plan?.fitMinutes);
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
      output.assign({ applied: true, result: { playlist, trackCount: trackIds.length } });
      logger.info(
        `\nCreated "${playlist.name}" (id ${shortId(playlist.id)}) with ${count(trackIds.length, "track")} (${formatDuration(shaped.seconds)}).`,
      );
      return;
    }
    if (!source.apply) {
      logger.info(
        `\n(dry run -- pass --apply to add up to ${count(trackIds.length, "track")}, ${formatDuration(shaped.seconds)}, to the playlist)`,
      );
      return;
    }
    const { added, skipped } = await addTracksToExistingPlaylist(client, {
      playlistId: source.playlistId,
      trackIds,
    });
    output.assign({ applied: true, result: { playlistId: source.playlistId, added, skipped } });
    logger.info(
      `\nAdded ${count(added.length, "track")} to the playlist${skipped.length > 0 ? ` (${skipped.length} already present, skipped)` : ""}.`,
    );
  };
}

/** Log a similar-artists plan: per seed, its tracks and the similar artists found. */
function reportSimilarPlan(
  plan: SimilarPlan,
  showSeedTracks: boolean,
  maxArtists: number,
): void {
  const byArtist = new Map(plan.similar.map((entry) => [entry.artist.id, entry]));
  const shown = new Set<ArtistId>();
  for (const seed of plan.seeds) {
    logger.info(
      showSeedTracks
        ? `  ${seed.artist.name}: ${count(seed.tracks.length, "track")}${excludedNote(seed.excluded.length)}`
        : `  ${seed.artist.name}`,
    );
    const listed = new Set<ArtistId>();
    for (const appearance of plan.appearances.filter((a) => a.seed.id === seed.artist.id)) {
      const entry = byArtist.get(appearance.artist.id);
      if (entry === undefined) {
        continue; // no tracks; reported below
      }
      const repeat = shown.has(appearance.artist.id) || listed.has(appearance.artist.id);
      listed.add(appearance.artist.id);
      logger.info(
        repeat
          ? `    = ${entry.artist.name} (similar to ${appearance.via.name}; already listed, added once)`
          : `    + ${entry.artist.name} (similar to ${entry.similarTo.map((a) => a.name).join(", ")}): ${count(entry.tracks.length, "track")}${excludedNote(entry.excluded.length)}`,
      );
    }
    for (const id of listed) {
      shown.add(id);
    }
  }
  if (plan.seeds.length === 0) {
    logger.warn("no artists to start from (the playlist has no tracks with an artist id)");
  }
  if (plan.truncated) {
    logger.warn(
      `stopped at ${maxArtists} similar artists; raise --max-artists, or lower --similar or --depth for a fuller walk`,
    );
  }
  if (plan.excludedArtists.length > 0) {
    logger.info(
      `  Left out (--exclude-artist): ${plan.excludedArtists.map((a) => a.name).join(", ")}`,
    );
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

/** Say how many tracks were dropped to fit the length asked for, if any. */
function logFitNote(dropped: number, fitMinutes: number | undefined): void {
  if (fitMinutes !== undefined && dropped > 0) {
    logger.info(
      `  (${dropped} track${dropped === 1 ? "" : "s"} left out to fit about ${fitMinutes} minutes)`,
    );
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
): (client: MusicService) => Promise<void> {
  const { source, keep, apply, includeVersions } = parseDedupeArgs(argv);
  if (source.type === "all-playlists") {
    return planDeduplicateAllPlaylists(keep, apply, includeVersions);
  }

  return async (client: MusicService): Promise<void> => {
    const where =
      source.type === "playlist"
        ? `playlist ${shortId(source.playlistId)}`
        : "your favourites";
    logger.info(`Fetching tracks from ${where}...`);
    const tracks =
      source.type === "playlist"
        ? await client.getPlaylistTracks(source.playlistId)
        : await client.getFavoriteTracks();
    logger.info(`  ${count(tracks.length, "track")} fetched`);

    let groups = deduplicateTracks(tracks, { includeVersions });
    if (strategyNeedsReleaseDates(keep) && groups.length > 0) {
      logger.info("  looking up release dates...");
      groups = await enrichReleaseDates(groups, (albumId) =>
        client.getAlbumReleaseDate(albumId),
      );
    }

    const resolved = resolveDuplicateGroups(groups, keep);
    logger.info(`  keeping the ${keep.join(", then ")} copy of each duplicate\n`);
    logger.info(formatResolutionReport(resolved));
    const versions = otherVersions(tracks, { includeVersions }, resolved);
    if (versions.length > 0) {
      logger.info(`\n${formatOtherVersions(versions)}`);
    }

    const removals = tracksToRemove(resolved);
    output.assign({ source, keep, groups: resolved, versions, toRemove: removals.length, applied: false });
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

/**
 * Executor for `deduplicate --all-playlists`: report each playlist's own
 * duplicates (removed with --apply) and the songs saved in more than one
 * playlist (report only).
 */
function planDeduplicateAllPlaylists(
  keep: readonly KeepStrategy[],
  apply: boolean,
  includeVersions: boolean,
): (client: MusicService) => Promise<void> {
  return async (client: MusicService): Promise<void> => {
    logger.info("Fetching all your playlists...");
    const scan = await scanAllPlaylists(client, keep, { includeVersions });
    output.assign({
      source: { type: "all-playlists" },
      keep,
      playlistCount: scan.playlistCount,
      within: scan.within,
      across: scan.across,
    });
    logger.info(
      `  ${scan.playlistCount} playlists scanned; keeping the ${keep.join(", then ")} copy of each duplicate\n`,
    );
    const removals: PlaylistEntry[] = [];
    if (scan.within.every((entry) => entry.groups.length === 0)) {
      logger.info("No duplicates within any playlist.");
    }
    for (const { playlist, groups, versions } of scan.within) {
      logger.info(`"${playlist.name}" (id ${shortId(playlist.id)}):`);
      logger.info(`${formatResolutionReport(groups)}\n`);
      if (versions.length > 0) {
        logger.info(`${formatOtherVersions(versions)}\n`);
      }
      for (const track of tracksToRemove(groups)) {
        if (track.playlistTrackId !== undefined) {
          removals.push({ playlistId: playlist.id, playlistTrackId: track.playlistTrackId });
        }
      }
    }
    logger.info(`\n${formatAcrossPlaylistsReport(scan.across)}`);
    output.assign({ toRemove: removals.length, applied: false });
    if (scan.across.length > 0) {
      logger.info("(nothing is removed for these; choose where each stays in the web UI)");
    }

    if (!apply) {
      if (removals.length > 0) {
        logger.info(
          `\n(dry run -- pass --apply to remove the ${removals.length} 'drop' track${removals.length === 1 ? "" : "s"})`,
        );
      }
      return;
    }
    if (removals.length === 0) {
      output.assign({ applied: true, removed: 0 });
      logger.info("\nNothing to remove.");
      return;
    }
    logger.info(`\nRemoving ${removals.length} track(s)...`);
    await removePlaylistEntries(client, removals);
    output.assign({ applied: true, removed: removals.length });
    logger.info("  done.");
  };
}

/** `remove-artists`: report (or, with --apply, remove) artists' songs from playlists. */
async function runRemoveArtists(
  client: MusicService,
  account: Account,
  args: RemoveArtistsArgs,
): Promise<void> {
  const { artists } = args;
  const mine = await client.getUserPlaylists();
  const isMine = (ownerId: UserId | undefined): boolean => ownerId === undefined || ownerId === account.id;
  let playlists: Array<{ id: PlaylistId; name: string }>;
  if (args.playlists.type === "all") {
    playlists = mine.filter((p) => isMine(p.ownerId));
    for (const other of mine.filter((p) => !isMine(p.ownerId))) {
      logger.info(`Skipping "${other.name}": it belongs to someone else.`);
    }
  } else {
    playlists = args.playlists.ids.map((id) => {
      const known = mine.find((p) => p.id === id);
      if (known === undefined || !isMine(known.ownerId)) {
        throw new Error(`${known === undefined ? `Playlist ${shortId(id)}` : `"${known.name}"`} is not one of your playlists`);
      }
      return known;
    });
  }
  const refs = playlists.map(({ id, name }) => ({ id, name }));
  logger.info(`Looking in ${count(refs.length, "playlist")}...\n`);
  const plan = await resolveRemoveArtists(client, refs, artists);
  logger.info(formatRemoveArtists(plan, args.includeGuests));
  const removals = removalsOf(plan, args.includeGuests);
  const total = removals.reduce((n, removal) => n + removal.entries.length, 0);
  output.assign({ ...plan, includeGuests: args.includeGuests, toRemove: total, applied: false });
  // A playlist that could not be read may well hold some of their songs.
  if (plan.playlists.some((entry) => entry.error !== undefined)) {
    process.exitCode = 1;
  }
  if (total === 0) {
    logger.info("\nNothing to remove.");
    return;
  }
  if (!args.apply) {
    logger.info(`\n(dry run -- pass --apply to remove the ${total} 'drop' song${total === 1 ? "" : "s"})`);
    return;
  }
  const lock = await acquireLockWithin(jobsLockPath(), WRITE_LOCK_WAIT_MS);
  if (lock === undefined) {
    throw new Error("A managed playlist is being refreshed, or another change is being saved. Try again in a moment.");
  }
  try {
    const reports = await commitRemovals(client, removals);
    const removed = reports.reduce((n, report) => n + report.removed, 0);
    output.assign({ applied: true, removed, reports });
    for (const { playlistId, error } of reports) {
      if (error !== undefined) {
        logger.warn(`Playlist ${shortId(playlistId)}: ${error}`);
      }
    }
    logger.info(`\nRemoved ${count(removed, "song")}. (qobuz-helper undo puts them back)`);
    if (reports.some((report) => report.error !== undefined)) {
      process.exitCode = 1;
    }
  } finally {
    lock.release();
  }
}

/** Execute the removals for an --apply run, using the id each source needs. */
async function applyRemovals(
  client: MusicService,
  source: Exclude<DedupeSource, { type: "all-playlists" }>,
  removals: readonly DedupTrack[],
): Promise<void> {
  if (removals.length === 0) {
    output.assign({ applied: true, removed: 0 });
    logger.info("\nNothing to remove.");
    return;
  }
  logger.info(`\nRemoving ${removals.length} track(s)...`);
  if (source.type === "playlist") {
    const ids = removals
      .map((track) => track.playlistTrackId)
      .filter((id) => id !== undefined);
    const skipped = removals.length - ids.length;
    if (skipped > 0) {
      logger.warn(`skipped ${skipped} track(s) with no playlist-track id`);
    }
    await client.removeTracksFromPlaylist(source.playlistId, ids);
    output.assign({ applied: true, removed: ids.length });
  } else {
    await client.removeFavoriteTracks(removals.map((track) => track.id));
    output.assign({ applied: true, removed: removals.length });
  }
  logger.info("  done.");
}

/**
 * Validate the upgrade command's arguments up front, returning an executor that
 * resolves the plan, reports it, and (with --apply) writes it.
 */
function planUpgrade(argv: string[]): (client: MusicService) => Promise<void> {
  const args = parseUpgradeArgs(argv);

  return async (client: MusicService): Promise<void> => {
    const where =
      args.source.type === "playlist"
        ? `playlist ${shortId(args.source.playlistId)}`
        : args.source.type === "all-playlists"
          ? "all your playlists"
          : "your favourites";
    logger.info(`Checking ${where} for upgrades and unplayable tracks...`);
    const plan = await resolveUpgrades(client, args.source, {
      allowSignatureMatch: args.allowSignatureMatch,
      removeUnplayable: args.removeUnplayable,
    });
    logger.info(`\n${formatUpgradeReport(plan)}`);

    const changes = planChanges(plan.items);
    output.assign({ source: args.source, plan, changes, applied: false });
    if (!args.apply) {
      if (changes.length > 0) {
        logger.info(
          `\n(dry run -- pass --apply to make the ${changes.length} change${changes.length === 1 ? "" : "s"})`,
        );
      }
      return;
    }
    if (changes.length === 0) {
      logger.info("\nNothing to change.");
      return;
    }
    logger.info(`\nApplying ${changes.length} change(s)...`);
    const result = await commitUpgrades(client, changes);
    output.assign({ applied: true, result });
    logger.info(`  replaced ${result.replaced}, removed ${result.removed}.`);
    if (result.movedToEnd > 0) {
      logger.warn(
        `${result.movedToEnd} replacement(s) could not be moved into place and are at the end of their playlist`,
      );
    }
    for (const failure of result.failed) {
      logger.warn(`track ${shortId(failure.change.trackId)}: ${failure.reason}`);
    }
  };
}

/**
 * Validate the export command's arguments up front, returning an executor that
 * reads the chosen source and writes it to a file (`--out`) or stdout.
 *
 * When streaming to stdout the content is the only thing written there, so it
 * pipes cleanly; progress notes are shown only when writing to a file.
 */
function planExport(argv: string[]): (client: MusicService) => Promise<void> {
  const args = parseExportArgs(argv);
  const { source } = args;
  if (output.json && args.out === undefined && args.outDir === undefined) {
    throw new Error(
      "--json prints a summary of what was exported: give --out <file> (without it the export itself goes to stdout)",
    );
  }
  output.set("source", source);
  if (source.type === "all-playlists") {
    return planExportAllPlaylists(args.format ?? "json", args.outDir!);
  }
  const toFile = args.out !== undefined;
  const note = (message: string): void => {
    if (toFile) logger.info(message);
  };

  return async (client: MusicService): Promise<void> => {
    let content: string;
    if (source.type === "account") {
      note("Backing up your account...");
      const backup = await buildBackup(client);
      content = serializeBackup(backup);
      output.assign({
        format: "json",
        favourites: {
          tracks: backup.favourites.tracks.length,
          albums: backup.favourites.albums.length,
          artists: backup.favourites.artists.length,
        },
        playlists: backup.playlists.length,
      });
      note(
        `  ${backup.favourites.tracks.length} favourite tracks, ` +
          `${backup.favourites.albums.length} albums, ` +
          `${count(backup.favourites.artists.length, "artist")}, ` +
          `${backup.playlists.length} playlists`,
      );
    } else {
      const format = resolveExportFormat(args);
      const collection = await collectCollection(client, source);
      if (format === "m3u" && collection.kind !== "tracks") {
        throw new Error("M3U can only hold tracks; choose another format");
      }
      content = serializeCollection(collection, format);
      output.assign({ format, kind: collection.kind, count: collection.items.length });
      note(`  ${collection.items.length} ${collection.kind}`);
    }

    if (args.out !== undefined) {
      writeFileSync(args.out, content);
      output.set("out", args.out);
      logger.info(`Wrote ${args.out}`);
    } else {
      process.stdout.write(content);
    }
  };
}

/** Executor for `export --all-playlists`: one file per playlist in `outDir`. */
function planExportAllPlaylists(
  format: Format,
  outDir: string,
): (client: MusicService) => Promise<void> {
  return async (client: MusicService): Promise<void> => {
    logger.info(`Exporting every playlist as ${format}...`);
    const files = await exportAllPlaylists(client, format);
    mkdirSync(outDir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(outDir, file.filename), file.content);
      logger.info(`  ${file.filename} (${count(file.trackCount, "track")})`);
    }
    output.assign({
      format,
      outDir,
      files: files.map(({ filename, playlist, trackCount }) => ({ filename, playlist, trackCount })),
    });
    logger.info(`Wrote ${files.length} playlist file${files.length === 1 ? "" : "s"} to ${outDir}`);
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
function planImport(argv: string[]): (client: MusicService) => Promise<void> {
  const args = parseImportArgs(argv);
  const content = readFileSync(args.file, "utf8");
  output.assign({ file: args.file, target: args.target });

  if (args.target.type === "account") {
    return planRestore(content, args.apply);
  }
  if (looksLikeBackup(content)) {
    throw new Error(
      "This looks like a full-account backup; restore it with `import --account`.",
    );
  }

  const format = effectiveImportFormat(content, resolveImportFormat(args));
  const kind = kindForTarget(args.target);
  const target = toImportTarget(args.target, args.isPublic);
  // Parse before signing in, so a malformed file fails fast.
  const parsed = parseCollection(content, format, kind);

  return async (client: MusicService): Promise<void> => {
    if (format === "spotify") {
      logger.info("Reading a Spotify (Exportify) export: matching by ISRC first.");
    }
    logger.info(`Resolving ${parsed.items.length} ${kind} from ${args.file}...`);
    const plan = await resolveImport(client, parsed);
    const counts = countMatchMethods(plan);
    output.assign({ format, plan, counts, applied: false });
    const how = describeMatchCounts(counts);
    logger.info(
      `  matched ${plan.matched.length} of ${parsed.items.length}${how.length > 0 ? ` (${how})` : ""}`,
    );
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
    output.assign({ applied: true, result });
    if (result.playlist !== undefined) {
      logger.info(
        `\nCreated "${result.playlist.name}" (id ${shortId(result.playlist.id)}) with ${count(result.written, "track")}.`,
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
): (client: MusicService) => Promise<void> {
  const backup = parseBackup(content);
  return async (client: MusicService): Promise<void> => {
    const counts =
      `${backup.favourites.tracks.length} favourite tracks, ` +
      `${backup.favourites.albums.length} albums, ` +
      `${count(backup.favourites.artists.length, "artist")}, ` +
      `${backup.playlists.length} playlists`;
    output.assign({
      backup: {
        exportedAt: backup.exportedAt,
        favouriteTracks: backup.favourites.tracks.length,
        favouriteAlbums: backup.favourites.albums.length,
        favouriteArtists: backup.favourites.artists.length,
        playlists: backup.playlists.length,
      },
      applied: false,
    });
    if (!apply) {
      logger.info(`Backup contains ${counts}.`);
      logger.info("\n(dry run -- pass --apply to restore it)");
      return;
    }
    logger.info(`Restoring ${counts}...`);
    const result = await restoreBackup(client, backup);
    output.assign({ applied: true, result });
    logger.info(
      `\nRestored ${result.favouriteTracks} favourite tracks, ` +
        `${result.favouriteAlbums} albums, ${count(result.favouriteArtists, "artist")}, ` +
        `and recreated ${result.playlists.length} playlists.`,
    );
  };
}

/** Format for an import: an explicit `--format`, else inferred from the filename. */
function resolveImportFormat(args: ImportArgs): ImportFormat {
  if (args.format !== undefined) {
    return args.format;
  }
  const inferred = formatFromFilename(args.file);
  if (inferred === undefined) {
    throw new Error(
      "Could not infer the format from the filename; pass --format <json|csv|text|m3u|spotify>",
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

/**
 * Validate the combine command's arguments up front, returning an executor that
 * reports the combined result and (with `--apply`) saves it as a new playlist.
 */
function planCombine(argv: string[]): (client: MusicService) => Promise<void> {
  const args = parseCombineArgs(argv);
  return async (client: MusicService): Promise<void> => {
    logger.info(`Fetching ${args.sources.length} track lists...`);
    const plan = await resolveCombine(client, args.sources, {
      mode: args.mode,
      order: args.order,
      keep: args.keep,
      matchSongs: args.matchSongs,
    });
    logger.info(formatCombineReport(plan, args.mode));

    const trackIds = combinedTrackIds(plan);
    const name = args.playlistName ?? plan.suggestedName;
    output.assign({ plan, name, trackIds, applied: false });
    if (trackIds.length === 0) {
      logger.warn("Nothing to save: the result is empty.");
      return;
    }
    if (!args.apply) {
      logger.info(
        `\n(dry run -- pass --apply to create "${name}" with ${trackIds.length} track${trackIds.length === 1 ? "" : "s"})`,
      );
      return;
    }
    const playlist = await createPlaylistWithTracks(client, {
      name,
      trackIds,
      isPublic: args.isPublic,
    });
    output.assign({ applied: true, result: { playlist, trackCount: trackIds.length } });
    logger.info(`\nCreated "${playlist.name}" (id ${shortId(playlist.id)}) with ${count(trackIds.length, "track")}.`);
  };
}

/**
 * Validate the stats command's arguments up front, returning an executor that
 * prints the stats (a report, or JSON on stdout) and, with --decade-playlist,
 * makes a playlist of one decade's tracks (only with --apply).
 */
function planStats(argv: string[]): (client: MusicService) => Promise<void> {
  const args = parseStatsArgs(argv);
  return async (client: MusicService): Promise<void> => {
    const stats = computeStats(await collectLibrary(client, args.source));
    // The stats are the document's top-level fields (as `stats --json` has
    // always printed them); the buckets' track ids are for making playlists,
    // so they are left out. (`--json` is taken by the global option before
    // parseStatsArgs sees it, so output.json is what decides.)
    output.assign(omitKeys(stats, ["trackIds"]) as Record<string, unknown>);
    if (!output.json) {
      logger.info(formatStatsReport(stats));
    }

    const request = args.decadePlaylist;
    if (request === undefined) {
      return;
    }
    const bucket = findDecade(stats, request.decade);
    if (bucket === undefined || bucket.count === 0) {
      logger.warn(`No tracks from the ${request.decade}.`);
      return;
    }
    const name = request.name ?? bucket.suggestedName;
    const decadePlaylist = { decade: request.decade, name, trackCount: bucket.count };
    output.set("decadePlaylist", { ...decadePlaylist, applied: false });
    if (!request.apply) {
      logger.info(
        `\n(dry run -- pass --apply to create "${name}" with ${bucket.count} track${bucket.count === 1 ? "" : "s"})`,
      );
      return;
    }
    const playlist = await createPlaylistWithTracks(client, {
      name,
      trackIds: bucket.trackIds,
      isPublic: request.isPublic,
    });
    output.set("decadePlaylist", { ...decadePlaylist, applied: true, playlist });
    logger.info(`\nCreated "${playlist.name}" (id ${shortId(playlist.id)}) with ${count(bucket.count, "track")}.`);
  };
}

/**
 * Validate the new-releases command's arguments up front, returning an
 * executor that reports the new releases and, with --apply, writes them.
 */
function planNewReleases(argv: string[]): (client: MusicService) => Promise<void> {
  const parsed = parseNewReleasesArgs(argv);
  const filter = parsed.filter === undefined ? undefined : compileTrackFilter(parsed.filter);

  return async (client: MusicService): Promise<void> => {
    const now = new Date();
    const since = parsed.since ?? daysBefore(now, parsed.days ?? DEFAULT_WINDOW_DAYS);
    logger.info(
      `Looking for releases since ${since} by ${parsed.source.type === "favourites" ? "your favourite artists" : "the playlist's artists"}...`,
    );
    const plan = await findNewReleases(client, {
      source: parsed.source,
      since,
      now,
      include: parsed.include,
      ...(filter !== undefined && { filter }),
    });

    output.assign({ plan, applied: false });
    if (plan.totalArtists === 0) {
      logger.warn(
        parsed.source.type === "favourites"
          ? "You have no favourite artists yet. Use --playlist <id> to check a playlist's artists instead."
          : "That playlist has no artists to check.",
      );
      return;
    }
    const artists = new Set(plan.releases.map((release) => release.artist)).size;
    logger.info(
      `\n${count(plan.releases.length, "release")} from ${count(artists, "artist")} since ${plan.since} (${count(plan.totalArtists, "artist")} checked):`,
    );
    for (const release of plan.releases) {
      const version = release.version === undefined ? "" : ` [${release.version}]`;
      const details = [
        release.releaseType,
        release.trackCount === undefined ? undefined : `${count(release.trackCount, "track")}`,
        release.bitDepth === undefined || release.samplingRate === undefined
          ? undefined
          : `${release.bitDepth}/${release.samplingRate}`,
      ].filter((part) => part !== undefined);
      logger.info(
        `  ${release.releaseDate ?? "?"}  ${release.artist} - ${release.title}${version} (${details.join(", ")})`,
      );
    }
    const { favourites, reissues } = plan.hidden;
    if (favourites + reissues > 0) {
      logger.info(
        `  (hidden: ${favourites} already in your favourite albums, ${reissues} reissues of older albums)`,
      );
    }
    if (plan.capped) {
      logger.warn(
        `checked only the first ${plan.checkedArtists} of ${count(plan.totalArtists, "artist")}`,
      );
    }
    if (plan.excludedArtists.length > 0) {
      logger.info(`  (left out: ${plan.excludedArtists.join(", ")})`);
    }
    if (plan.failedArtists.length > 0) {
      logger.warn(`could not fetch releases for: ${plan.failedArtists.join(", ")}`);
    }

    const { target } = parsed;
    if (target === undefined || plan.releases.length === 0) {
      return;
    }
    const where =
      target.type === "playlist" ? `a new playlist "${target.name}"` : "your favourite albums";
    if (!parsed.apply) {
      logger.info(`\n(dry run -- pass --apply to add these releases to ${where})`);
      return;
    }
    const result = await commitNewReleases(client, {
      albumIds: plan.releases.map((release) => release.id),
      target,
      ...(filter !== undefined && { filter }),
    });
    output.assign({ applied: true, result });
    if (result.type === "favourite-albums") {
      logger.info(`\nAdded ${count(result.added, "release")} to your favourite albums.`);
      return;
    }
    logger.info(
      `\nCreated "${result.playlist.name}" (id ${shortId(result.playlist.id)}) with ${count(result.trackCount, "track")}${excludedNote(result.excludedCount)}.`,
    );
    if (result.failedAlbumIds.length > 0) {
      logger.warn(`could not fetch tracks for releases: ${result.failedAlbumIds.map(shortId).join(", ")}`);
    }
  };
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

/**
 * Validate the word-play command's arguments up front, returning an executor
 * that resolves the plan, reports it, and writes it only with --apply.
 */
function planWordPlay(argv: string[]): (client: MusicService) => Promise<void> {
  const parsed = parseWordPlayArgs(argv);
  const filter =
    parsed.filter === undefined ? undefined : compileTrackFilter(parsed.filter);

  return async (client: MusicService): Promise<void> => {
    logger.info("Finding songs...");
    const plan = await resolveWordPlay(client, parsed.request, {
      match: parsed.match,
      ...(filter !== undefined && { filter }),
    });
    const split = plan.splits[0]!;
    reportWordPlay(plan, split);

    const trackIds = splitTrackIds(split);
    output.assign({ plan, name: parsed.name ?? plan.suggestedName, trackIds, applied: false });
    if (trackIds.length === 0) {
      logger.warn("No songs found to add.");
      return;
    }
    const name = parsed.name ?? plan.suggestedName;
    if (!parsed.apply) {
      logger.info(
        parsed.addTo === undefined
          ? `\n(dry run -- pass --apply to create "${name}" with ${count(trackIds.length, "song")})`
          : `\n(dry run -- pass --apply to add ${count(trackIds.length, "song")} to playlist ${shortId(parsed.addTo)})`,
      );
      return;
    }
    const result = await commitWordPlay(client, {
      target:
        parsed.addTo === undefined
          ? { type: "new", name, isPublic: parsed.isPublic }
          : { type: "existing", playlistId: parsed.addTo },
      trackIds,
    });
    output.assign({ applied: true, result });
    logger.info(
      result.playlist === undefined
        ? `\nAdded ${count(result.added.length, "song")} to the playlist${result.skipped.length > 0 ? ` (${result.skipped.length} already present, skipped)` : ""}.`
        : `\nCreated "${result.playlist.name}" (id ${shortId(result.playlist.id)}) with ${count(result.added.length, "song")}.`,
    );
  };
}

/** Log a word-play plan: each slot and its song, then other splits and gaps. */
function reportWordPlay(plan: WordPlayPlan, split: WordPlaySplit): void {
  const numbered = plan.mode === "contains" || plan.mode === "exact";
  logger.info(`\n${split.songCount} song${split.songCount === 1 ? "" : "s"}:`);
  split.slots.forEach((slot, index) => {
    const label = numbered ? `${index + 1}.` : slot.label;
    logger.info(`  ${label}  ->  ${describeSlot(slot)}`);
  });
  if (plan.requested !== undefined && split.songCount < plan.requested) {
    logger.warn(`only ${split.songCount} of ${count(plan.requested, "song")} found`);
  }
  if (split.unmatched.length > 0) {
    logger.warn(`nothing found for: ${split.unmatched.join(", ")}`);
  }
  if (plan.splits.length > 1) {
    logger.info("\nOther ways to split it:");
    for (const other of plan.splits.slice(1)) {
      const gaps =
        other.unmatched.length > 0 ? `; nothing for: ${other.unmatched.join(", ")}` : "";
      logger.info(
        `  ${other.slots.map((slot) => slot.label).join(" / ")}  (${count(other.songCount, "song")}${gaps})`,
      );
    }
  }
  if (plan.skippedSearches > 0) {
    logger.warn(
      `searched ${plan.searches} phrases; ${plan.skippedSearches} longer ones were not searched (lower --max-span or shorten the sentence)`,
    );
  }
  if (plan.excludedCount > 0) {
    logger.info(`(${plan.excludedCount} matching tracks left out by the filters)`);
  }
}

function describeSlot(slot: WordPlaySlot): string {
  if (slot.chosen === undefined) {
    return "(nothing found)";
  }
  const { track } = slot.chosen;
  const notes = [
    slot.chosen.closeForm ? "close form" : undefined,
    slot.chosen.punctuationIgnored ? "punctuation ignored" : undefined,
    `${slot.matchCount} match${slot.matchCount === 1 ? "" : "es"}`,
  ].filter((note): note is string => note !== undefined);
  return `${track.artist ?? "?"} - ${track.title}${track.version === undefined ? "" : ` (${track.version})`}  [${notes.join(", ")}]`;
}

function printUsage(): void {
  logger.info(
    [
      "Usage:",
      "  qobuz-helper login",
      "  qobuz-helper logout",
      "  qobuz-helper ui",
      "  qobuz-helper check",
      '  qobuz-helper playlist-from-artists --name "<name>" [--tracks N] [--public] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [plan options] "Artist" ...',
      '  qobuz-helper playlist-from-albums --name "<name>" [--prefer <preference>] [--public] [--discs <list>] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [plan options] "Artist - Album" ...',
      '  qobuz-helper playlist-from-albums --name "<name>" --discography "<artist>" [--include albums,eps,live,compilations] [--all-versions] [--prefer <preference>] [--public] [--discs <list>] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [plan options]',
      '  qobuz-helper similar-artists --name "<name>" [--similar N] [--depth D] [--tracks M] [--max-artists A] [--seed-tracks K] [--public] [--yes] [--replace-repeats] [--skip-favourite-artists] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [plan options] "Artist" ...',
      "  qobuz-helper similar-artists --playlist <id> [--seeds S] [--similar N] [--depth D] [--tracks M] [--max-artists A] [--yes] [--replace-repeats] [--skip-favourite-artists] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [plan options] [--apply]",
      "  qobuz-helper deduplicate (--playlist <id> | --favourites | --all-playlists) [--keep <strategy>[,<strategy>...]] [--include-versions] [--apply]",
      '  qobuz-helper new-releases [--since YYYY-MM-DD | --days N] [--playlist <id>] [--include albums,eps,live,compilations] [--exclude-artist <name>]... [--exclude-album <term>]... [--exclude-track <term>]... [--name "<name>" [--public] --apply | --favourite-albums --apply]',
      "  qobuz-helper remove-artists (--playlist <id>... | --all-playlists) [--include-guests] [--apply] <artist>...",
      "  qobuz-helper upgrade (--favourites | --playlist <id> | --all-playlists) [--allow-signature-match] [--remove-unplayable] [--apply]",
      "  qobuz-helper export (--favourites | --favourite-albums | --favourite-artists | --playlist <id> | --account) [--format <json|csv|text|m3u>] [--out <file>]",
      "  qobuz-helper export --all-playlists --out-dir <dir> [--format <json|csv|text|m3u>]",
      "  qobuz-helper import (--favourites | --favourite-albums | --favourite-artists | --playlist <id> | --new-playlist <name> | --account) [--format <json|csv|text|m3u|spotify>] [--public] [--apply] <file>",
      "  qobuz-helper combine --playlist <id> --playlist <id> [...] [--favourites] [--mode merge|only-first|common] [--order sequential|interleave|shuffle] [--keep highest-quality|first] [--exact-ids-only] [--name <name>] [--public] [--apply]",
      "  qobuz-helper stats (--favourites | --playlist <id> | --everything) [--json] [--decade-playlist <decade> [--name <name>] [--public] [--apply]]",
      "  qobuz-helper history [--limit N]",
      "  qobuz-helper undo [<id>] [--apply]",
      "  qobuz-helper jobs [list | show <id> | pause <id> | resume <id> | run <id> [--dry-run] | remove <id> [--delete-playlist]]",
      "  qobuz-helper jobs [suggestions <id> | accept <id> <key...>|--all | ignore <id> <key...>|--all]",
      '  qobuz-helper jobs create new-releases ("Artist" ... | --favourites | --playlist <id>) --name "<name>" [--similar N] [--window last-days:N|since:YYYY-MM-DD|latest:N] [--include albums,eps,live,compilations] [--max-releases N] [--hide-favourites] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [shared options]',
      '  qobuz-helper jobs create combined <playlist|favourites>... --name "<name>" [--mode merge|only-first|common] [--order sequential|interleave|shuffle] [--keep highest-quality|first] [--exact-ids-only] [shared options]',
      '  qobuz-helper jobs create follow <playlist> --name "<name>" [--archive] [shared options]',
      '  qobuz-helper jobs create smart <playlist|favourites>... --name "<name>" [--hires|--cd] [--decades 1990s,2000s] [--genres jazz,soul] [--favourited-within DAYS] [--min-length M:SS] [--max-length M:SS] [--order as-listed|newest-favourited|newest-release|by-artist|shuffle] [shared options]',
      '  qobuz-helper jobs create discovery ("Artist" ... | --favourites | --playlist <id>) --name "<name>" [--similar N] [--artists-per-rotation M] [--tracks-per-artist K] [--rotation day|week] [--avoid-repeats N] [--keep-favourite-tracks] [shared options]',
      "  qobuz-helper jobs create tidy <playlist|favourites> (--dedupe | --upgrade | --repair)... [shared options]",
      "    shared options: [--into <playlist>] [--edits respect|mirror] [--every hour|day|week] [--at HH:MM] [--weekday mon..sun] [--dedupe[=every-pass|weekly|monthly]] [--upgrade[=...]] [--repair[=...]] [--repair-remove] [--dedupe-keep <chain>] [--suggest] [--max-tracks N] [--fit <minutes>] [--public] [--apply]",
      "  qobuz-helper run-due [--dry-run]",
      "  qobuz-helper serve [--no-open] [--port N]",
      "  qobuz-helper schedule print (--cron | --systemd | --launchd | --windows)",
      "  qobuz-helper login --print-url",
      '  qobuz-helper word-play (--sentence "<text>" [--split fewest|words|any] [--max-span K] | --contains <word> [--count N] | --exact <word> [--count N] | --acrostic <word> (--favourites | --playlist <id>) | --a-to-z (--favourites | --playlist <id>)) [--close-forms] [--keep-punctuation] [--keep-versions] [--allow-repeat-artists] [--prefer-hires] [--name <name>] [--public] [--add-to <id>] [--exclude-track <term>]... [--exclude-album <term>]... [--exclude-artist <name>]... [--apply]',
      "",
      "Global options:",
      "  --loglevel <silent|error|warn|info|debug>   how much to log (default info)",
      "  --json                                      print the plan or result as one JSON document on stdout (logs go to stderr)",
      "",
      "The session is saved after first sign-in and resumed automatically; use logout to clear it.",
      "Artist names (playlist-from-artists) and 'Artist - Album' lines (playlist-from-albums) may also be piped on stdin, one per line.",
      "Qobuz links work wherever a list is typed: artist links for artists (also --discography), album links for albums (that exact release), and a playlist link wherever --playlist (or --add-to) takes an id.",
      "Album version preferences: highest-quality (default), newest, oldest.",
      "--discography takes an artist's studio albums, oldest first, one version of each (per --prefer); --include widens the kinds (albums, eps, live, compilations), --all-versions keeps every edition.",
      "Exclude terms match whole words, ignoring case (\"live\" skips \"Live at Leeds\", not \"Alive\"); write /pattern/ for a regex. Repeat the flag for more terms.",
      "--exclude-artist matches the whole artist name, ignoring case and accents (\"Drake\" skips Drake, not Nick Drake); /pattern/ is a regex on the name. similar-artists never walks to an excluded artist.",
      "--discs keeps only the listed discs of each album, e.g. 1 or 1,3-4.",
      "Plan options (playlist-from-artists, similar-artists, playlist-from-albums): --order by-artist|take-turns|shuffle (albums: as-listed|shuffle; default by-artist/as-listed), --skip-favourites (leave out tracks already in your favourites), --one-copy (one copy of each song, remasters included), --fit <minutes> (trim to at most about that length).",
      "similar-artists defaults: --similar 3, --depth 1, --max-artists 100 (no upper limits), --tracks 3 (1-30), --seed-tracks 5 (0-100), --seeds 10 (1-50); --playlist adds only with --apply; very large runs need --yes.",
      "Keep strategies: first-added (default), last-added, highest-quality, oldest, newest; join several with commas to break ties (e.g. highest-quality,oldest).",
      "deduplicate reports only unless --apply is given; songs held in other versions (live, acoustic, remixes) are listed and kept, unless --include-versions counts them as duplicates.",
      "remove-artists reports only unless --apply is given; it takes names, Qobuz artist links and /patterns/, also on stdin. Songs where they are only a guest are kept unless --include-guests is given.",
      "new-releases defaults: the last 30 days, albums and eps, your favourite artists; it reports only unless --apply is given with --name or --favourite-albums.",
      "upgrade reports only unless --apply is given; it matches by ISRC unless --allow-signature-match is given.",
      "export writes to stdout unless --out is given; --account writes a full JSON backup; --all-playlists writes one file per playlist into --out-dir.",
      "import resolves and reports only unless --apply is given; --account restores a backup; a Spotify playlist exported with Exportify (CSV) is recognised and matched by ISRC first.",
      'combine reports only unless --apply is given; the new playlist is named "A + B" unless --name is given.',
      'stats --decade-playlist takes a decade such as 1990s (or unknown); it creates "Favourites: 1990s" (or --name) only with --apply.',
      "Every change is recorded in history.jsonl beside the session (the last 200, up to 90 days); history lists them (--limit, default 20).",
      "undo shows how the latest change not yet undone (or the entry <id>) would be reversed, and reverses it only with --apply.",
      "jobs create previews the first pass and saves (and runs) the job only with --apply; defaults: --window last-days:30, albums and eps, --edits respect (tracks you remove stay out, tracks you add stay), --every day --at 06:00. --into manages one of your playlists instead of making one (respect edits only). Tidy-ups default to: repair weekly, upgrade monthly, dedupe every pass; they apply their changes (undoable in history) unless --suggest, which leaves them for jobs accept/ignore.",
      "Jobs run whenever run-due (from your OS scheduler: see schedule print) or serve (web UI + a ticker, for an always-on machine) runs; missed runs catch up once.",
      "login --print-url signs in on a machine without a browser: open the printed link anywhere and paste back the address you end up on.",
      "word-play reports only unless --apply is given; --split defaults to fewest, --max-span to 6 (1-8), --count to 25 (1-100); the playlist is named after the text unless --name is given.",
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
