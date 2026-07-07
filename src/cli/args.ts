/**
 * Argument parsing for CLI commands.
 */

import { KEEP_STRATEGIES, type KeepStrategy } from "../features/deduplicate.js";
import { FORMATS, type Format } from "../features/import-export.js";
import {
  ALBUM_PREFERENCES,
  DEFAULT_ALBUM_PREFERENCE,
  type AlbumPreference,
} from "../features/playlist-from-albums.js";
import { DEFAULT_LOG_LEVEL, parseLogLevel, type LogLevel } from "./logger.js";

export interface ExtractedLogLevel {
  level: LogLevel;
  /** The arguments with the `--loglevel` option removed. */
  rest: string[];
}

/**
 * Pull the global `--loglevel <level>` (or `--loglevel=<level>`) option out of
 * an argument list, returning the chosen level and the remaining arguments.
 *
 * The option is global -- it may appear anywhere, before or after the command
 * and its own options -- so it is stripped here before per-command parsing.
 * Defaults to `info` when absent.
 *
 * @throws {Error} if the value is missing or not a valid level name.
 */
export function extractLogLevel(argv: readonly string[]): ExtractedLogLevel {
  let level: LogLevel = DEFAULT_LOG_LEVEL;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--loglevel") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined) {
        throw new Error("--loglevel requires a value");
      }
      level = parseLogLevel(raw);
    } else if (arg !== undefined && arg.startsWith("--loglevel=")) {
      level = parseLogLevel(arg.slice("--loglevel=".length));
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }

  return { level, rest };
}

export interface PlaylistArgs {
  playlistName: string;
  artists: string[];
  tracksPerArtist?: number;
  isPublic: boolean;
}

export interface AlbumPlaylistArgs {
  playlistName: string;
  /** Raw "Artist - Album" lines, parsed later into entries. */
  entries: string[];
  preference: AlbumPreference;
  isPublic: boolean;
}

/** Where the deduplicator should look for tracks. */
export type DedupeSource =
  | { type: "playlist"; playlistId: number }
  | { type: "favourites" };

export interface DedupeOptions {
  source: DedupeSource;
  keep: KeepStrategy;
  /** Whether to actually remove duplicates (otherwise report only). */
  apply: boolean;
}

const DEFAULT_KEEP: KeepStrategy = "first-added";

/**
 * Parse the arguments for the `deduplicate` command.
 *
 * Exactly one source must be given: `--playlist <id>` or `--favourites`
 * (`--favorites` is accepted too). `--keep <strategy>` chooses which copy to
 * keep (default `first-added`). `--apply` performs the removal; without it the
 * command only reports.
 *
 * @throws {Error} if the source or the keep strategy is missing/invalid.
 */
export function parseDedupeArgs(argv: readonly string[]): DedupeOptions {
  let playlistId: number | undefined;
  let favourites = false;
  let keep: KeepStrategy = DEFAULT_KEEP;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playlist") {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--playlist must be a numeric id, got "${raw}"`);
      }
      playlistId = value;
    } else if (arg === "--favourites" || arg === "--favorites") {
      favourites = true;
    } else if (arg === "--keep") {
      const raw = argv[i + 1];
      i += 1;
      if (!isKeepStrategy(raw)) {
        throw new Error(
          `--keep must be one of: ${KEEP_STRATEGIES.join(", ")} (got "${raw}")`,
        );
      }
      keep = raw;
    } else if (arg === "--apply") {
      apply = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (playlistId !== undefined && favourites) {
    throw new Error("Give only one of --playlist or --favourites");
  }
  const source: DedupeSource =
    playlistId !== undefined
      ? { type: "playlist", playlistId }
      : favourites
        ? { type: "favourites" }
        : (() => {
            throw new Error(
              "A source is required: --playlist <id> or --favourites",
            );
          })();

  return { source, keep, apply };
}

function isKeepStrategy(value: string | undefined): value is KeepStrategy {
  return value !== undefined && (KEEP_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Parse the arguments for the `playlist-from-artists` command.
 *
 * Recognised options: `--name <name>` (required), `--tracks <n>` (positive
 * integer), and `--public`. All remaining positional arguments are artist names.
 *
 * @throws {Error} if `--name` is missing or `--tracks` is not a positive integer.
 */
export function parsePlaylistArgs(argv: readonly string[]): PlaylistArgs {
  let playlistName: string | undefined;
  let tracksPerArtist: number | undefined;
  let isPublic = false;
  const artists: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--name":
        playlistName = argv[i + 1];
        i += 1;
        break;
      case "--tracks": {
        const raw = argv[i + 1];
        i += 1;
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--tracks must be a positive integer, got "${raw}"`);
        }
        tracksPerArtist = value;
        break;
      }
      case "--public":
        isPublic = true;
        break;
      default:
        if (arg !== undefined) {
          artists.push(arg);
        }
    }
  }

  if (playlistName === undefined || playlistName.length === 0) {
    throw new Error("--name <playlist name> is required");
  }

  return {
    playlistName,
    artists,
    isPublic,
    ...(tracksPerArtist !== undefined && { tracksPerArtist }),
  };
}

/**
 * Parse the arguments for the `playlist-from-albums` command.
 *
 * Recognised options: `--name <name>` (required), `--prefer <preference>` (which
 * version to pick when an album has several; default `highest-quality`), and
 * `--public`. All remaining positional arguments are "Artist - Album" lines.
 *
 * @throws {Error} if `--name` is missing or `--prefer` is not a valid preference.
 */
export function parseAlbumArgs(argv: readonly string[]): AlbumPlaylistArgs {
  let playlistName: string | undefined;
  let preference: AlbumPreference = DEFAULT_ALBUM_PREFERENCE;
  let isPublic = false;
  const entries: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--name":
        playlistName = argv[i + 1];
        i += 1;
        break;
      case "--prefer": {
        const raw = argv[i + 1];
        i += 1;
        if (!isAlbumPreference(raw)) {
          throw new Error(
            `--prefer must be one of: ${ALBUM_PREFERENCES.join(", ")} (got "${raw}")`,
          );
        }
        preference = raw;
        break;
      }
      case "--public":
        isPublic = true;
        break;
      default:
        if (arg !== undefined) {
          entries.push(arg);
        }
    }
  }

  if (playlistName === undefined || playlistName.length === 0) {
    throw new Error("--name <playlist name> is required");
  }

  return { playlistName, entries, preference, isPublic };
}

function isAlbumPreference(value: string | undefined): value is AlbumPreference {
  return value !== undefined && (ALBUM_PREFERENCES as readonly string[]).includes(value);
}

/** What the `export` command should read from Qobuz. */
export type ExportSourceArg =
  | { type: "favourite-tracks" }
  | { type: "favourite-albums" }
  | { type: "favourite-artists" }
  | { type: "playlist"; playlistId: number }
  | { type: "account" };

export interface ExportArgs {
  source: ExportSourceArg;
  /** Chosen output format; undefined lets the caller infer or default it. */
  format?: Format;
  /** Output file; undefined writes to stdout. */
  out?: string;
}

/**
 * Parse the arguments for the `export` command.
 *
 * Exactly one source is required: `--favourites`, `--favourite-albums`,
 * `--favourite-artists`, `--playlist <id>`, or `--account` (a full backup).
 * `--format <json|csv|text|m3u>` chooses the format (a backup is always JSON);
 * `--out <file>` writes to a file instead of stdout.
 *
 * @throws {Error} if no source, more than one source, or an invalid format is given.
 */
export function parseExportArgs(argv: readonly string[]): ExportArgs {
  const sources: ExportSourceArg[] = [];
  let format: Format | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--favourites":
      case "--favorites":
        sources.push({ type: "favourite-tracks" });
        break;
      case "--favourite-albums":
      case "--favorite-albums":
        sources.push({ type: "favourite-albums" });
        break;
      case "--favourite-artists":
      case "--favorite-artists":
        sources.push({ type: "favourite-artists" });
        break;
      case "--account":
        sources.push({ type: "account" });
        break;
      case "--playlist": {
        const raw = argv[i + 1];
        i += 1;
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--playlist must be a numeric id, got "${raw}"`);
        }
        sources.push({ type: "playlist", playlistId: value });
        break;
      }
      case "--format": {
        const raw = argv[i + 1];
        i += 1;
        if (!isFormat(raw)) {
          throw new Error(
            `--format must be one of: ${FORMATS.join(", ")} (got "${raw}")`,
          );
        }
        format = raw;
        break;
      }
      case "--out":
        out = argv[i + 1];
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (sources.length === 0) {
    throw new Error(
      "A source is required: --favourites, --favourite-albums, --favourite-artists, --playlist <id>, or --account",
    );
  }
  if (sources.length > 1) {
    throw new Error("Give only one export source");
  }
  return { source: sources[0]!, ...(format !== undefined && { format }), ...(out !== undefined && { out }) };
}

/** Where the `import` command should write the resolved items. */
export type ImportTargetArg =
  | { type: "favourites" }
  | { type: "favourite-albums" }
  | { type: "favourite-artists" }
  | { type: "playlist-existing"; playlistId: number }
  | { type: "playlist-new"; name: string }
  | { type: "account" };

export interface ImportArgs {
  target: ImportTargetArg;
  /** Path to the file to import. */
  file: string;
  /** Chosen input format; undefined lets the caller infer it from the filename. */
  format?: Format;
  /** Whether a new playlist should be public. */
  isPublic: boolean;
  /** Whether to actually write (otherwise resolve and report only). */
  apply: boolean;
}

/**
 * Parse the arguments for the `import` command.
 *
 * Exactly one target is required: `--favourites`, `--favourite-albums`,
 * `--favourite-artists`, `--playlist <id>` (an existing playlist), or
 * `--new-playlist <name>`. One positional file argument is required.
 * `--format` overrides the format inferred from the filename; `--public` marks
 * a new playlist public; `--apply` performs the write (otherwise it is a dry run).
 *
 * @throws {Error} if the target, the file, or a given format is missing/invalid.
 */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const targets: ImportTargetArg[] = [];
  const files: string[] = [];
  let format: Format | undefined;
  let isPublic = false;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--favourites":
      case "--favorites":
        targets.push({ type: "favourites" });
        break;
      case "--favourite-albums":
      case "--favorite-albums":
        targets.push({ type: "favourite-albums" });
        break;
      case "--favourite-artists":
      case "--favorite-artists":
        targets.push({ type: "favourite-artists" });
        break;
      case "--playlist": {
        const raw = argv[i + 1];
        i += 1;
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--playlist must be a numeric id, got "${raw}"`);
        }
        targets.push({ type: "playlist-existing", playlistId: value });
        break;
      }
      case "--new-playlist": {
        const name = argv[i + 1];
        i += 1;
        if (name === undefined || name.length === 0) {
          throw new Error("--new-playlist requires a name");
        }
        targets.push({ type: "playlist-new", name });
        break;
      }
      case "--account":
        targets.push({ type: "account" });
        break;
      case "--format": {
        const raw = argv[i + 1];
        i += 1;
        if (!isFormat(raw)) {
          throw new Error(
            `--format must be one of: ${FORMATS.join(", ")} (got "${raw}")`,
          );
        }
        format = raw;
        break;
      }
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        if (arg !== undefined) {
          files.push(arg);
        }
    }
  }

  if (targets.length === 0) {
    throw new Error(
      "A target is required: --favourites, --favourite-albums, --favourite-artists, --playlist <id>, --new-playlist <name>, or --account",
    );
  }
  if (targets.length > 1) {
    throw new Error("Give only one import target");
  }
  if (files.length === 0) {
    throw new Error("A file to import is required");
  }
  if (files.length > 1) {
    throw new Error("Give only one file to import");
  }
  return {
    target: targets[0]!,
    file: files[0]!,
    isPublic,
    apply,
    ...(format !== undefined && { format }),
  };
}

function isFormat(value: string | undefined): value is Format {
  return value !== undefined && (FORMATS as readonly string[]).includes(value);
}
