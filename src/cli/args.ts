/**
 * Argument parsing for CLI commands.
 */

import {
  COMBINE_KEEPS,
  COMBINE_MODES,
  COMBINE_ORDERS,
  sourcesProblem,
  type CombineKeep,
  type CombineMode,
  type CombineOrder,
  type CombineSource,
} from "../features/combine.js";
import { KEEP_STRATEGIES, type KeepStrategy } from "../features/deduplicate.js";
import { DEFAULT_DISCOGRAPHY_INCLUDE, parseIncludeList } from "../features/discography.js";
import {
  FORMATS,
  IMPORT_FORMATS,
  type Format,
  type ImportFormat,
} from "../features/import-export.js";
import {
  DEFAULT_NEW_RELEASE_INCLUDE,
  isIsoDate,
  type ArtistSource,
  type NewReleasesTarget,
} from "../features/new-releases.js";
import {
  ALBUM_PREFERENCES,
  DEFAULT_ALBUM_PREFERENCE,
  type AlbumPreference,
} from "../features/playlist-from-albums.js";
import {
  ALBUM_ORDERS,
  parseFitMinutes,
  PLAYLIST_ORDERS,
  type AlbumOrder,
  type PlaylistOrder,
} from "../features/playlist-shape.js";
import { playlistIdOf } from "../features/qobuz-links.js";
import { SIMILAR_SETTINGS, type SettingBounds } from "../features/similar-artists.js";
import type { StatsSource } from "../features/stats.js";
import type { UpgradeSource } from "../features/upgrade.js";
import {
  compileArtistTerm,
  compileTerm,
  parseDiscList,
  type TrackFilterSpec,
} from "../features/track-filter.js";
import {
  DEFAULT_MATCH_OPTIONS,
  SPLIT_OBJECTIVES,
  WORD_PLAY_COUNT,
  WORD_PLAY_MAX_SPAN,
  type MatchOptions,
  type SplitObjective,
  type WordPlayRequest,
  type WordPlaySource,
} from "../features/word-play.js";
import type { ReleaseType } from "../qobuz/index.js";
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
  /** Present only when an exclude flag was given. */
  filter?: TrackFilterSpec;
  /** Present only when a plan flag (`--order`, `--fit`, ...) was given. */
  plan?: PlanArgs;
}

export interface AlbumPlaylistArgs {
  playlistName: string;
  /** Raw "Artist - Album" lines, parsed later into entries. */
  entries: string[];
  /** Start from this artist's discography instead of album lines. */
  discography?: {
    artist: string;
    /** Kinds of release to include (default studio albums). */
    include: ReleaseType[];
    /** Every release on its own, rather than one version of each album. */
    allVersions: boolean;
  };
  preference: AlbumPreference;
  isPublic: boolean;
  /** Present only when an exclude or `--discs` flag was given. */
  filter?: TrackFilterSpec;
  /** Present only when a plan flag (`--order`, `--fit`, ...) was given. */
  plan?: PlanArgs<AlbumOrder>;
}

/** Accumulates the filter flags shared by the playlist commands. */
class FilterFlags {
  readonly #excludeTracks: string[] = [];
  readonly #excludeAlbums: string[] = [];
  readonly #excludeArtists: string[] = [];
  #discs: number[] | undefined;
  #given = false;
  readonly #allowDiscs: boolean;

  constructor(allowDiscs: boolean) {
    this.#allowDiscs = allowDiscs;
  }

  /**
   * Consume the filter flag at `argv[i]`, if it is one, returning how many
   * arguments it used (0 when `argv[i]` is not a filter flag). Terms and disc
   * lists are validated here so a typo fails before sign-in.
   *
   * @throws {Error} if the flag has no value, or the value is invalid.
   */
  take(argv: readonly string[], i: number): number {
    const flag = argv[i];
    if (
      flag !== "--exclude-track" &&
      flag !== "--exclude-album" &&
      flag !== "--exclude-artist" &&
      !(flag === "--discs" && this.#allowDiscs)
    ) {
      return 0;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    this.#given = true;
    if (flag === "--discs") {
      this.#discs = parseDiscList(value);
    } else if (flag === "--exclude-artist") {
      compileArtistTerm(value);
      this.#excludeArtists.push(value);
    } else {
      compileTerm(value);
      (flag === "--exclude-track" ? this.#excludeTracks : this.#excludeAlbums).push(value);
    }
    return 2;
  }

  /** The spec, or undefined if no filter flag was given. */
  spec(): TrackFilterSpec | undefined {
    if (!this.#given) {
      return undefined;
    }
    return {
      excludeTracks: this.#excludeTracks,
      excludeAlbums: this.#excludeAlbums,
      excludeArtists: this.#excludeArtists,
      ...(this.#discs !== undefined && { discs: this.#discs }),
    };
  }
}

/**
 * The plan-shaping flags shared by the playlist builders: `--order`,
 * `--skip-favourites`, `--one-copy` and `--fit <minutes>`. `O` is the order
 * type the command takes.
 */
export interface PlanArgs<O extends string = PlaylistOrder> {
  order?: O;
  skipFavourites: boolean;
  oneCopy: boolean;
  fitMinutes?: number;
}

/** Accumulates the plan flags of a playlist builder. */
class PlanFlags<O extends string> {
  readonly #orders: readonly O[];
  #order: O | undefined;
  #skipFavourites = false;
  #oneCopy = false;
  #fitMinutes: number | undefined;
  #given = false;

  constructor(orders: readonly O[]) {
    this.#orders = orders;
  }

  /**
   * Consume the plan flag at `argv[i]`, if it is one, returning how many
   * arguments it used (0 when it is not a plan flag).
   *
   * @throws {Error} if a flag's value is missing or invalid.
   */
  take(argv: readonly string[], i: number): number {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--skip-favourites":
        this.#given = true;
        this.#skipFavourites = true;
        return 1;
      case "--one-copy":
        this.#given = true;
        this.#oneCopy = true;
        return 1;
      case "--order":
        if (value === undefined || !(this.#orders as readonly string[]).includes(value)) {
          throw new Error(
            `--order must be one of: ${this.#orders.join(", ")}${value === undefined ? "" : ` (got "${value}")`}`,
          );
        }
        this.#given = true;
        this.#order = value as O;
        return 2;
      case "--fit":
        if (value === undefined) {
          throw new Error("--fit requires a number of minutes");
        }
        this.#given = true;
        this.#fitMinutes = parseFitMinutes(value);
        return 2;
      default:
        return 0;
    }
  }

  /** The plan, or undefined if no plan flag was given. */
  args(): PlanArgs<O> | undefined {
    if (!this.#given) {
      return undefined;
    }
    return {
      ...(this.#order !== undefined && { order: this.#order }),
      skipFavourites: this.#skipFavourites,
      oneCopy: this.#oneCopy,
      ...(this.#fitMinutes !== undefined && { fitMinutes: this.#fitMinutes }),
    };
  }
}

/** Arguments for the `similar-artists` command. */
export interface SimilarArgs {
  source:
    | {
        type: "artists";
        playlistName: string;
        /** Seed names; empty means read them from stdin. */
        artists: string[];
        tracksPerSeed: number;
        isPublic: boolean;
      }
    | { type: "playlist"; playlistId: number; maxSeeds: number; apply: boolean };
  similarPerArtist: number;
  depth: number;
  tracksPerSimilar: number;
  maxArtists: number;
  /** Go ahead even when the run is estimated to be very large. */
  yes: boolean;
  /** Replace artists that already came up with the next most similar. */
  replaceRepeats: boolean;
  /** Never suggest the user's favourite artists. */
  skipFavouriteArtists?: boolean;
  /** Present only when an exclude flag was given. */
  filter?: TrackFilterSpec;
  /** Present only when a plan flag (`--order`, `--fit`, ...) was given. */
  plan?: PlanArgs;
}

/** Where the deduplicator should look for tracks. */
export type DedupeSource =
  | { type: "playlist"; playlistId: number }
  | { type: "favourites" }
  | { type: "all-playlists" };

export interface DedupeOptions {
  source: DedupeSource;
  /** Keep strategies in order; later ones break the earlier ones' ties. */
  keep: KeepStrategy[];
  /** Whether to actually remove duplicates (otherwise report only). */
  apply: boolean;
}

const DEFAULT_KEEP: KeepStrategy = "first-added";

/**
 * Parse a `--keep` value: one strategy, or a comma-separated chain where each
 * later strategy breaks the ties of the earlier ones
 * (`highest-quality,oldest`).
 *
 * @throws {Error} if any part is not a known strategy.
 */
export function parseKeepChain(raw: string | undefined): KeepStrategy[] {
  const parts = (raw ?? "").split(",").map((part) => part.trim());
  const chain: KeepStrategy[] = [];
  for (const part of parts) {
    if (!isKeepStrategy(part)) {
      throw new Error(
        `--keep must be one of: ${KEEP_STRATEGIES.join(", ")}, or several joined by commas (got "${raw}")`,
      );
    }
    chain.push(part);
  }
  return chain;
}

/**
 * Parse the arguments for the `deduplicate` command.
 *
 * Exactly one source must be given: `--playlist <id>`, `--favourites`
 * (`--favorites` is accepted too) or `--all-playlists`. `--keep <strategy>`
 * chooses which copy to keep (default `first-added`); a comma-separated chain
 * breaks ties in order. `--apply` performs the removal; without it the command
 * only reports.
 *
 * @throws {Error} if the source or the keep strategy is missing/invalid.
 */
export function parseDedupeArgs(argv: readonly string[]): DedupeOptions {
  let playlistId: number | undefined;
  let favourites = false;
  let allPlaylists = false;
  let keep: KeepStrategy[] = [DEFAULT_KEEP];
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playlist") {
      const raw = argv[i + 1];
      i += 1;
      const value = playlistIdOf(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--playlist must be a numeric id or a playlist link, got "${raw}"`);
      }
      playlistId = value;
    } else if (arg === "--favourites" || arg === "--favorites") {
      favourites = true;
    } else if (arg === "--all-playlists") {
      allPlaylists = true;
    } else if (arg === "--keep") {
      keep = parseKeepChain(argv[i + 1]);
      i += 1;
    } else if (arg === "--apply") {
      apply = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const sources: DedupeSource[] = [
    ...(playlistId !== undefined ? [{ type: "playlist" as const, playlistId }] : []),
    ...(favourites ? [{ type: "favourites" as const }] : []),
    ...(allPlaylists ? [{ type: "all-playlists" as const }] : []),
  ];
  if (sources.length > 1) {
    throw new Error("Give only one of --playlist, --favourites or --all-playlists");
  }
  const source = sources[0];
  if (source === undefined) {
    throw new Error("A source is required: --playlist <id>, --favourites or --all-playlists");
  }
  return { source, keep, apply };
}

function isKeepStrategy(value: string | undefined): value is KeepStrategy {
  return value !== undefined && (KEEP_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Parse the arguments for the `playlist-from-artists` command.
 *
 * Recognised options: `--name <name>` (required), `--tracks <n>` (positive
 * integer), `--public`, and the repeatable `--exclude-track <term>`,
 * `--exclude-album <term>` and `--exclude-artist <name>`. All remaining
 * positional arguments are artist names. The plan flags (`--order`,
 * `--skip-favourites`, `--one-copy`, `--fit <minutes>`) are {@link PlanFlags}.
 *
 * @throws {Error} if `--name` is missing, `--tracks` is not a positive integer,
 *   or an exclude term is missing or an invalid `/regex/`.
 */
export function parsePlaylistArgs(argv: readonly string[]): PlaylistArgs {
  let playlistName: string | undefined;
  let tracksPerArtist: number | undefined;
  let isPublic = false;
  const artists: string[] = [];
  const filter = new FilterFlags(false);
  const plan = new PlanFlags(PLAYLIST_ORDERS);

  for (let i = 0; i < argv.length; i += 1) {
    const used = filter.take(argv, i) || plan.take(argv, i);
    if (used > 0) {
      i += used - 1;
      continue;
    }
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

  const spec = filter.spec();
  const planArgs = plan.args();
  return {
    playlistName,
    artists,
    isPublic,
    ...(tracksPerArtist !== undefined && { tracksPerArtist }),
    ...(spec !== undefined && { filter: spec }),
    ...(planArgs !== undefined && { plan: planArgs }),
  };
}

/**
 * Parse the arguments for the `playlist-from-albums` command.
 *
 * Recognised options: `--name <name>` (required), `--prefer <preference>` (which
 * version to pick when an album has several; default `highest-quality`),
 * `--public`, `--discs <list>` (e.g. "1" or "1,3-4"), and the repeatable
 * `--exclude-track <term>`, `--exclude-album <term>` and
 * `--exclude-artist <name>`. All remaining positional arguments are
 * "Artist - Album" lines -- unless `--discography <artist>` is given, which
 * takes that artist's releases instead (no lines then), narrowed by
 * `--include <kinds>` (comma-separated albums, eps, live, compilations;
 * default albums) and, with `--all-versions`, listing every edition of an
 * album rather than one. The plan flags are {@link PlanFlags}, with
 * `--order as-listed|shuffle`.
 *
 * @throws {Error} if `--name` is missing, `--prefer` is not a valid preference,
 *   a filter flag is missing its value or invalid, `--include` is invalid, or
 *   the discography flags are mixed with album lines (or given without it).
 */
export function parseAlbumArgs(argv: readonly string[]): AlbumPlaylistArgs {
  let playlistName: string | undefined;
  let preference: AlbumPreference = DEFAULT_ALBUM_PREFERENCE;
  let isPublic = false;
  let discographyArtist: string | undefined;
  let include: ReleaseType[] | undefined;
  let allVersions = false;
  const entries: string[] = [];
  const filter = new FilterFlags(true);
  const plan = new PlanFlags(ALBUM_ORDERS);

  for (let i = 0; i < argv.length; i += 1) {
    const used = filter.take(argv, i) || plan.take(argv, i);
    if (used > 0) {
      i += used - 1;
      continue;
    }
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
      case "--discography": {
        const raw = argv[i + 1]?.trim();
        i += 1;
        if (raw === undefined || raw.length === 0) {
          throw new Error("--discography requires an artist name");
        }
        discographyArtist = raw;
        break;
      }
      case "--include":
        include = parseIncludeList(argv[i + 1] ?? "");
        i += 1;
        break;
      case "--all-versions":
        allVersions = true;
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
  if (discographyArtist === undefined && (include !== undefined || allVersions)) {
    throw new Error("--include and --all-versions only apply with --discography <artist>");
  }
  if (discographyArtist !== undefined && entries.length > 0) {
    throw new Error('Give either --discography <artist> or "Artist - Album" lines, not both');
  }

  const spec = filter.spec();
  const planArgs = plan.args();
  return {
    playlistName,
    entries,
    preference,
    isPublic,
    ...(planArgs !== undefined && { plan: planArgs }),
    ...(discographyArtist !== undefined && {
      discography: {
        artist: discographyArtist,
        include: include ?? [...DEFAULT_DISCOGRAPHY_INCLUDE],
        allVersions,
      },
    }),
    ...(spec !== undefined && { filter: spec }),
  };
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
  | { type: "account" }
  | { type: "all-playlists" };

export interface ExportArgs {
  source: ExportSourceArg;
  /** Chosen output format; undefined lets the caller infer or default it. */
  format?: Format;
  /** Output file; undefined writes to stdout. */
  out?: string;
  /** Output directory for `--all-playlists` (one file per playlist). */
  outDir?: string;
}

/**
 * Parse the arguments for the `export` command.
 *
 * Exactly one source is required: `--favourites`, `--favourite-albums`,
 * `--favourite-artists`, `--playlist <id>`, `--account` (a full backup), or
 * `--all-playlists` (each playlist to its own file).
 * `--format <json|csv|text|m3u>` chooses the format (a backup is always JSON);
 * `--out <file>` writes to a file instead of stdout; `--all-playlists` needs
 * `--out-dir <dir>` instead.
 *
 * @throws {Error} if no source, more than one source, or an invalid format is
 *   given, or `--out-dir` is missing with `--all-playlists` or given without it.
 */
export function parseExportArgs(argv: readonly string[]): ExportArgs {
  const sources: ExportSourceArg[] = [];
  let format: Format | undefined;
  let out: string | undefined;
  let outDir: string | undefined;

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
      case "--all-playlists":
        sources.push({ type: "all-playlists" });
        break;
      case "--out-dir": {
        const raw = argv[i + 1];
        i += 1;
        if (raw === undefined || raw.length === 0) {
          throw new Error("--out-dir requires a directory");
        }
        outDir = raw;
        break;
      }
      case "--playlist": {
        const raw = argv[i + 1];
        i += 1;
        const value = playlistIdOf(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${raw}"`);
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
      "A source is required: --favourites, --favourite-albums, --favourite-artists, --playlist <id>, --all-playlists, or --account",
    );
  }
  if (sources.length > 1) {
    throw new Error("Give only one export source");
  }
  const source = sources[0]!;
  if (source.type === "all-playlists" && (outDir === undefined || out !== undefined)) {
    throw new Error("--all-playlists writes one file per playlist: give --out-dir <dir> (not --out)");
  }
  if (source.type !== "all-playlists" && outDir !== undefined) {
    throw new Error("--out-dir is only for --all-playlists; use --out <file>");
  }
  return {
    source,
    ...(format !== undefined && { format }),
    ...(out !== undefined && { out }),
    ...(outDir !== undefined && { outDir }),
  };
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
  format?: ImportFormat;
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
 * `--format` (one of the export formats, or `spotify` for an Exportify CSV)
 * overrides the format inferred from the filename; `--public` marks
 * a new playlist public; `--apply` performs the write (otherwise it is a dry run).
 *
 * @throws {Error} if the target, the file, or a given format is missing/invalid.
 */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const targets: ImportTargetArg[] = [];
  const files: string[] = [];
  let format: ImportFormat | undefined;
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
        const value = playlistIdOf(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${raw}"`);
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
        if (!isImportFormat(raw)) {
          throw new Error(
            `--format must be one of: ${IMPORT_FORMATS.join(", ")} (got "${raw}")`,
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

function isImportFormat(value: string | undefined): value is ImportFormat {
  return value !== undefined && (IMPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Parse `raw` as an integer within `bounds` (`max` absent: no upper bound),
 * naming `flag` in the error.
 */
function boundedInt(flag: string, raw: string | undefined, bounds: SettingBounds): number {
  const value = Number(raw);
  if (
    raw === undefined ||
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    (bounds.max !== undefined && value > bounds.max)
  ) {
    const range =
      bounds.max === undefined
        ? `an integer of at least ${bounds.min}`
        : `an integer between ${bounds.min} and ${bounds.max}`;
    throw new Error(`${flag} must be ${range}, got "${raw}"`);
  }
  return value;
}

/** Flags of `similar-artists` that only make sense for one source. */
const ARTISTS_ONLY_FLAGS = ["--seed-tracks", "--public"] as const;
const PLAYLIST_ONLY_FLAGS = ["--seeds", "--apply"] as const;

/**
 * Parse the arguments for the `similar-artists` command.
 *
 * Exactly one source: `--name <name>` (seed from the positional artist names,
 * creating a new playlist) or `--playlist <id>` (seed from that playlist's
 * artists and add to it, report-only unless `--apply`). Shared options:
 * `--similar N`, `--depth D`, `--tracks M`, `--max-artists A`, `--yes` (run
 * even when estimated to be very large), `--replace-repeats` (replace artists
 * that already came up with the next most similar), and the repeatable
 * `--exclude-track`/`--exclude-album`/`--exclude-artist` (an excluded artist is
 * also never walked to), `--skip-favourite-artists` (never suggest your
 * favourite artists) and the plan flags ({@link PlanFlags}). Artists source
 * only: `--seed-tracks K`
 * (0 for none) and `--public`. Playlist source only: `--seeds S` and `--apply`.
 * Ranges and defaults are {@link SIMILAR_SETTINGS}.
 *
 * @throws {Error} on a missing or doubled source, an out-of-range number, an
 *   option for the other source, or an unknown option.
 */
export function parseSimilarArgs(argv: readonly string[]): SimilarArgs {
  let playlistName: string | undefined;
  let playlistId: number | undefined;
  const settings = {
    similarPerArtist: SIMILAR_SETTINGS.similarPerArtist.fallback as number,
    depth: SIMILAR_SETTINGS.depth.fallback as number,
    tracksPerSimilar: SIMILAR_SETTINGS.tracksPerSimilar.fallback as number,
    maxArtists: SIMILAR_SETTINGS.maxArtists.fallback as number,
    tracksPerSeed: SIMILAR_SETTINGS.tracksPerSeed.fallback as number,
    maxSeeds: SIMILAR_SETTINGS.maxSeeds.fallback as number,
  };
  let isPublic = false;
  let apply = false;
  let yes = false;
  let replaceRepeats = false;
  let skipFavouriteArtists = false;
  const used = new Set<string>();
  const positional: string[] = [];
  const filter = new FilterFlags(false);
  const plan = new PlanFlags(PLAYLIST_ORDERS);

  for (let i = 0; i < argv.length; i += 1) {
    const consumed = filter.take(argv, i) || plan.take(argv, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    const arg = argv[i]!;
    const value = argv[i + 1];
    used.add(arg);
    switch (arg) {
      case "--name":
        playlistName = value;
        i += 1;
        break;
      case "--playlist": {
        const id = playlistIdOf(value);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${value}"`);
        }
        playlistId = id;
        i += 1;
        break;
      }
      case "--similar":
        settings.similarPerArtist = boundedInt(arg, value, SIMILAR_SETTINGS.similarPerArtist);
        i += 1;
        break;
      case "--depth":
        settings.depth = boundedInt(arg, value, SIMILAR_SETTINGS.depth);
        i += 1;
        break;
      case "--tracks":
        settings.tracksPerSimilar = boundedInt(arg, value, SIMILAR_SETTINGS.tracksPerSimilar);
        i += 1;
        break;
      case "--max-artists":
        settings.maxArtists = boundedInt(arg, value, SIMILAR_SETTINGS.maxArtists);
        i += 1;
        break;
      case "--yes":
        yes = true;
        break;
      case "--replace-repeats":
        replaceRepeats = true;
        break;
      case "--skip-favourite-artists":
        skipFavouriteArtists = true;
        break;
      case "--seed-tracks":
        settings.tracksPerSeed = boundedInt(arg, value, SIMILAR_SETTINGS.tracksPerSeed);
        i += 1;
        break;
      case "--seeds":
        settings.maxSeeds = boundedInt(arg, value, SIMILAR_SETTINGS.maxSeeds);
        i += 1;
        break;
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (playlistName !== undefined && playlistId !== undefined) {
    throw new Error("Give only one of --name or --playlist");
  }
  const spec = filter.spec();
  const planArgs = plan.args();
  const shared = {
    similarPerArtist: settings.similarPerArtist,
    depth: settings.depth,
    tracksPerSimilar: settings.tracksPerSimilar,
    maxArtists: settings.maxArtists,
    yes,
    replaceRepeats,
    ...(skipFavouriteArtists && { skipFavouriteArtists }),
    ...(spec !== undefined && { filter: spec }),
    ...(planArgs !== undefined && { plan: planArgs }),
  };

  if (playlistId !== undefined) {
    const wrong = ARTISTS_ONLY_FLAGS.find((flag) => used.has(flag));
    if (wrong !== undefined) {
      throw new Error(`${wrong} only applies with --name (seeding from artists)`);
    }
    if (positional.length > 0) {
      throw new Error(
        `Artist names cannot be combined with --playlist (got "${positional.join(", ")}")`,
      );
    }
    return {
      source: { type: "playlist", playlistId, maxSeeds: settings.maxSeeds, apply },
      ...shared,
    };
  }
  if (playlistName === undefined || playlistName.length === 0) {
    throw new Error("A source is required: --name <playlist name> or --playlist <id>");
  }
  const wrong = PLAYLIST_ONLY_FLAGS.find((flag) => used.has(flag));
  if (wrong !== undefined) {
    throw new Error(`${wrong} only applies with --playlist`);
  }
  return {
    source: {
      type: "artists",
      playlistName,
      artists: positional,
      tracksPerSeed: settings.tracksPerSeed,
      isPublic,
    },
    ...shared,
  };
}

/** Arguments for the `combine` command. */
export interface CombineArgs {
  /** The inputs, in the order given. */
  sources: CombineSource[];
  mode: CombineMode;
  order: CombineOrder;
  keep: CombineKeep;
  /** Match songs by the deduplicator's rules too (off with `--exact-ids-only`). */
  matchSongs: boolean;
  /** Name for the new playlist; undefined uses the suggested "A + B". */
  playlistName?: string;
  isPublic: boolean;
  /** Whether to create the playlist (otherwise report only). */
  apply: boolean;
}

/**
 * Parse the arguments for the `combine` command.
 *
 * Inputs are the repeatable `--playlist <id>` and `--favourites`, in the order
 * given (at least two, each once). Options: `--mode merge|only-first|common`
 * (default merge), `--order sequential|interleave|shuffle` (default
 * sequential), `--keep highest-quality|first` (default highest-quality),
 * `--exact-ids-only`, `--name <name>`, `--public`, and `--apply` to create the
 * playlist (otherwise it only reports).
 *
 * @throws {Error} on fewer than two inputs, a repeated input, an invalid value,
 *   or an unknown argument.
 */
export function parseCombineArgs(argv: readonly string[]): CombineArgs {
  const sources: CombineSource[] = [];
  let mode: CombineMode = "merge";
  let order: CombineOrder = "sequential";
  let keep: CombineKeep = "highest-quality";
  let matchSongs = true;
  let playlistName: string | undefined;
  let isPublic = false;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--playlist": {
        const id = playlistIdOf(value);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${value}"`);
        }
        sources.push({ type: "playlist", playlistId: id });
        i += 1;
        break;
      }
      case "--favourites":
      case "--favorites":
        sources.push({ type: "favourites" });
        break;
      case "--mode":
        mode = oneOf(arg, value, COMBINE_MODES);
        i += 1;
        break;
      case "--order":
        order = oneOf(arg, value, COMBINE_ORDERS);
        i += 1;
        break;
      case "--keep":
        keep = oneOf(arg, value, COMBINE_KEEPS);
        i += 1;
        break;
      case "--exact-ids-only":
        matchSongs = false;
        break;
      case "--name":
        if (value === undefined || value.trim().length === 0) {
          throw new Error("--name requires a playlist name");
        }
        playlistName = value;
        i += 1;
        break;
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const problem = sourcesProblem(sources);
  if (problem !== undefined) {
    throw new Error(`combine: ${problem} (--playlist <id>, repeatable, and/or --favourites)`);
  }
  return {
    sources,
    mode,
    order,
    keep,
    matchSongs,
    isPublic,
    apply,
    ...(playlistName !== undefined && { playlistName }),
  };
}

/** Arguments for the `stats` command. */
export interface StatsArgs {
  source: StatsSource;
  /** Print the stats as JSON instead of a report. */
  json: boolean;
  /** Make a playlist of this decade ("1990s" or "unknown"), when given. */
  decadePlaylist?: {
    decade: string;
    /** Undefined uses the suggested name, e.g. "Favourites: 1990s". */
    name?: string;
    isPublic: boolean;
    /** Whether to create it (otherwise report only). */
    apply: boolean;
  };
}

/** Flags of `stats` that only make sense with `--decade-playlist`. */
const DECADE_PLAYLIST_FLAGS = ["--name", "--public", "--apply"] as const;

/**
 * Parse the arguments for the `stats` command.
 *
 * Exactly one source: `--favourites`, `--playlist <id>` or `--everything`.
 * `--json` prints JSON. `--decade-playlist <decade>` (e.g. `1990s`, or
 * `unknown`) makes a playlist of that decade's tracks, named by `--name` or
 * after the source and decade, public with `--public`, and only created with
 * `--apply`.
 *
 * @throws {Error} on a missing or doubled source, a malformed decade, a
 *   playlist flag without `--decade-playlist`, or an unknown argument.
 */
export function parseStatsArgs(argv: readonly string[]): StatsArgs {
  const sources: StatsSource[] = [];
  let json = false;
  let decade: string | undefined;
  let name: string | undefined;
  let isPublic = false;
  let apply = false;
  const used = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    used.add(arg);
    switch (arg) {
      case "--favourites":
      case "--favorites":
        sources.push({ type: "favourites" });
        break;
      case "--everything":
        sources.push({ type: "everything" });
        break;
      case "--playlist": {
        const id = playlistIdOf(value);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${value}"`);
        }
        sources.push({ type: "playlist", playlistId: id });
        i += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--decade-playlist":
        if (value === undefined || !/^(\d{3}0s|unknown)$/i.test(value)) {
          throw new Error(`--decade-playlist must be a decade such as 1990s, or unknown (got "${value}")`);
        }
        decade = value.toLowerCase();
        i += 1;
        break;
      case "--name":
        if (value === undefined || value.trim().length === 0) {
          throw new Error("--name requires a playlist name");
        }
        name = value;
        i += 1;
        break;
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (sources.length === 0) {
    throw new Error("A source is required: --favourites, --playlist <id> or --everything");
  }
  if (sources.length > 1) {
    throw new Error("Give only one of --favourites, --playlist or --everything");
  }
  if (decade === undefined) {
    const wrong = DECADE_PLAYLIST_FLAGS.find((flag) => used.has(flag));
    if (wrong !== undefined) {
      throw new Error(`${wrong} only applies with --decade-playlist`);
    }
  }
  return {
    source: sources[0]!,
    json,
    ...(decade !== undefined && {
      decadePlaylist: { decade, isPublic, apply, ...(name !== undefined && { name }) },
    }),
  };
}

/** `value` if it is one of `allowed`, else an error naming `flag`. */
function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

/** Arguments for the `word-play` command. */
export interface WordPlayArgs {
  request: WordPlayRequest;
  match: MatchOptions;
  /** Name for a new playlist; absent uses the plan's suggested name. */
  name?: string;
  /** Add to this existing playlist instead of creating one. */
  addTo?: number;
  isPublic: boolean;
  /** Whether to actually write (otherwise resolve and report only). */
  apply: boolean;
  /** Present only when an exclude flag was given. */
  filter?: TrackFilterSpec;
}

/** Flags of `word-play` that only make sense in some modes. */
const WORD_PLAY_MODE_FLAGS: Record<string, readonly string[]> = {
  "--split": ["sentence"],
  "--max-span": ["sentence"],
  "--count": ["contains", "exact"],
  "--favourites": ["acrostic", "a-to-z"],
  "--playlist": ["acrostic", "a-to-z"],
};

/**
 * Parse the arguments for the `word-play` command.
 *
 * Exactly one mode: `--sentence <text>`, `--contains <word>`, `--exact <word>`,
 * `--acrostic <word>` or `--a-to-z`. Sentence only: `--split
 * fewest|words|any` and `--max-span K` (1-8, default 6). Contains/exact only:
 * `--count N` (1-100, default 25). Acrostic and A-to-Z need a source:
 * `--favourites` (or `--favorites`) or `--playlist <id>`. Matching:
 * `--close-forms`, `--keep-punctuation`, `--keep-versions`,
 * `--allow-repeat-artists`, `--prefer-hires`. Writing: `--name <name>` (default:
 * the text, title-cased) and `--public` for a new playlist, or `--add-to <id>`
 * for an existing one; nothing is written without `--apply`. The repeatable
 * `--exclude-track`/`--exclude-album`/`--exclude-artist` filter candidates.
 *
 * @throws {Error} on a missing or doubled mode or source, a flag for another
 *   mode, an out-of-range number, or an unknown argument.
 */
export function parseWordPlayArgs(argv: readonly string[]): WordPlayArgs {
  const modes: { mode: WordPlayRequest["mode"]; text: string }[] = [];
  const sources: WordPlaySource[] = [];
  const used = new Set<string>();
  const match: MatchOptions = { ...DEFAULT_MATCH_OPTIONS };
  let split: SplitObjective | undefined;
  let maxSpan: number | undefined;
  let count: number | undefined;
  let name: string | undefined;
  let addTo: number | undefined;
  let isPublic = false;
  let apply = false;
  const filter = new FilterFlags(false);

  const textOf = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  const idOf = (flag: string, value: string | undefined): number => {
    const id = playlistIdOf(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${flag} must be a numeric id or a playlist link, got "${value}"`);
    }
    return id;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const consumed = filter.take(argv, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    const arg = argv[i]!;
    const value = argv[i + 1];
    used.add(arg === "--favorites" ? "--favourites" : arg);
    switch (arg) {
      case "--sentence":
      case "--contains":
      case "--exact":
      case "--acrostic":
        modes.push({ mode: arg.slice(2) as WordPlayRequest["mode"], text: textOf(arg, value) });
        i += 1;
        break;
      case "--a-to-z":
        modes.push({ mode: "a-to-z", text: "" });
        break;
      case "--split":
        if (value === undefined || !(SPLIT_OBJECTIVES as readonly string[]).includes(value)) {
          throw new Error(`--split must be one of: ${SPLIT_OBJECTIVES.join(", ")} (got "${value}")`);
        }
        split = value as SplitObjective;
        i += 1;
        break;
      case "--max-span":
        maxSpan = boundedInt(arg, value, WORD_PLAY_MAX_SPAN);
        i += 1;
        break;
      case "--count":
        count = boundedInt(arg, value, WORD_PLAY_COUNT);
        i += 1;
        break;
      case "--favourites":
      case "--favorites":
        sources.push({ type: "favourites" });
        break;
      case "--playlist":
        sources.push({ type: "playlist", playlistId: idOf(arg, value) });
        i += 1;
        break;
      case "--close-forms":
        match.closeForms = true;
        break;
      case "--keep-punctuation":
        match.ignorePunctuation = false;
        break;
      case "--keep-versions":
        match.ignoreVersions = false;
        break;
      case "--allow-repeat-artists":
        match.onePerArtist = false;
        break;
      case "--prefer-hires":
        match.preferHires = true;
        break;
      case "--name":
        name = textOf(arg, value);
        i += 1;
        break;
      case "--add-to":
        addTo = idOf(arg, value);
        i += 1;
        break;
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (modes.length !== 1) {
    throw new Error(
      modes.length === 0
        ? "A mode is required: --sentence <text>, --contains <word>, --exact <word>, --acrostic <word> or --a-to-z"
        : "Give only one of --sentence, --contains, --exact, --acrostic or --a-to-z",
    );
  }
  const { mode, text } = modes[0]!;
  for (const [flag, allowed] of Object.entries(WORD_PLAY_MODE_FLAGS)) {
    if (used.has(flag) && !allowed.includes(mode)) {
      throw new Error(`${flag} does not apply to --${mode}`);
    }
  }
  if (addTo !== undefined && (name !== undefined || isPublic)) {
    throw new Error("--add-to cannot be combined with --name or --public");
  }

  let request: WordPlayRequest;
  if (mode === "acrostic" || mode === "a-to-z") {
    if (sources.length !== 1) {
      throw new Error(
        sources.length === 0
          ? `--${mode} needs a source: --favourites or --playlist <id>`
          : "Give only one of --favourites or --playlist",
      );
    }
    const source = sources[0]!;
    request = mode === "acrostic" ? { mode, text, source } : { mode, source };
  } else if (mode === "sentence") {
    request = {
      mode,
      text,
      ...(split !== undefined && { split }),
      ...(maxSpan !== undefined && { maxSpan }),
    };
  } else {
    request = { mode, text, ...(count !== undefined && { count }) };
  }

  const spec = filter.spec();
  return {
    request,
    match,
    isPublic,
    apply,
    ...(name !== undefined && { name }),
    ...(addTo !== undefined && { addTo }),
    ...(spec !== undefined && { filter: spec }),
  };
}

// --- new-releases -----------------------------------------------------------

/** Arguments for the `new-releases` command. */
export interface NewReleasesArgs {
  /** Whose releases: favourite artists, or a playlist's artists. */
  source: ArtistSource;
  /** First day of the window (YYYY-MM-DD), when given with --since. */
  since?: string;
  /** Days back from today, when given with --days (else the default window). */
  days?: number;
  include: ReleaseType[];
  /** Where to put the releases; absent means report only. */
  target?: NewReleasesTarget;
  /** Write to the target (otherwise a dry run). */
  apply: boolean;
  /** Present only when an exclude flag was given. */
  filter?: TrackFilterSpec;
}

/**
 * Parse the arguments for the `new-releases` command.
 *
 * Recognised options: `--since <YYYY-MM-DD>` or `--days <n>` (the window;
 * default the last 30 days), `--playlist <id>` (that playlist's artists rather
 * than your favourite artists), `--include <kinds>` (default `albums,eps`),
 * the repeatable `--exclude-artist`, `--exclude-album` and `--exclude-track`,
 * and a destination -- `--name <name>` (a new playlist, `--public` optional)
 * or `--favourite-albums` -- which is only written with `--apply`.
 *
 * @throws {Error} on an invalid or conflicting option, or `--apply` without a
 *   destination.
 */
export function parseNewReleasesArgs(argv: readonly string[]): NewReleasesArgs {
  let since: string | undefined;
  let days: number | undefined;
  let playlistId: number | undefined;
  let include: ReleaseType[] | undefined;
  let playlistName: string | undefined;
  let favouriteAlbums = false;
  let isPublic = false;
  let apply = false;
  const filter = new FilterFlags(false);

  for (let i = 0; i < argv.length; i += 1) {
    const used = filter.take(argv, i);
    if (used > 0) {
      i += used - 1;
      continue;
    }
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--since":
        i += 1;
        if (value === undefined || !isIsoDate(value)) {
          throw new Error(`--since must be a date as YYYY-MM-DD, got "${value}"`);
        }
        since = value;
        break;
      case "--days": {
        i += 1;
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--days must be a positive integer, got "${value}"`);
        }
        days = n;
        break;
      }
      case "--playlist": {
        i += 1;
        const id = playlistIdOf(value);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${value}"`);
        }
        playlistId = id;
        break;
      }
      case "--include":
        i += 1;
        include = parseIncludeList(value ?? "");
        break;
      case "--name":
        i += 1;
        if (value === undefined || value.trim().length === 0) {
          throw new Error("--name requires a playlist name");
        }
        playlistName = value;
        break;
      case "--favourite-albums":
      case "--favorite-albums":
        favouriteAlbums = true;
        break;
      case "--public":
        isPublic = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (since !== undefined && days !== undefined) {
    throw new Error("Give only one of --since or --days");
  }
  if (playlistName !== undefined && favouriteAlbums) {
    throw new Error("Give only one destination: --name <name> or --favourite-albums");
  }
  if (isPublic && playlistName === undefined) {
    throw new Error("--public only applies with --name");
  }
  if (apply && playlistName === undefined && !favouriteAlbums) {
    throw new Error("--apply needs a destination: --name <name> or --favourite-albums");
  }

  const target: NewReleasesTarget | undefined =
    playlistName !== undefined
      ? { type: "playlist", name: playlistName, isPublic }
      : favouriteAlbums
        ? { type: "favourite-albums" }
        : undefined;
  const spec = filter.spec();
  return {
    source: playlistId === undefined ? { type: "favourites" } : { type: "playlist", playlistId },
    include: include ?? [...DEFAULT_NEW_RELEASE_INCLUDE],
    apply,
    ...(since !== undefined && { since }),
    ...(days !== undefined && { days }),
    ...(target !== undefined && { target }),
    ...(spec !== undefined && { filter: spec }),
  };
}

/** Arguments for the `upgrade` command. */
export interface UpgradeArgs {
  source: UpgradeSource;
  /** Also propose upgrades matched by artist+title only (maybe a different recording). */
  allowSignatureMatch: boolean;
  /** Remove unplayable tracks that have no replacement (otherwise leave them). */
  removeUnplayable: boolean;
  /** Whether to write the changes (otherwise report only). */
  apply: boolean;
}

/**
 * Parse the arguments for the `upgrade` command.
 *
 * Exactly one source: `--favourites` (or `--favorites`), `--playlist <id>`, or
 * `--all-playlists`. `--allow-signature-match` also proposes upgrades matched
 * by normalised artist+title; `--remove-unplayable` removes unplayable tracks
 * with no replacement; `--apply` writes the plan (otherwise it only reports).
 *
 * @throws {Error} on a missing or doubled source, a bad playlist id, or an
 *   unknown argument.
 */
export function parseUpgradeArgs(argv: readonly string[]): UpgradeArgs {
  const sources: UpgradeSource[] = [];
  let allowSignatureMatch = false;
  let removeUnplayable = false;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--favourites":
      case "--favorites":
        sources.push({ type: "favourites" });
        break;
      case "--all-playlists":
        sources.push({ type: "all-playlists" });
        break;
      case "--playlist": {
        const raw = argv[i + 1];
        i += 1;
        const value = playlistIdOf(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--playlist must be a numeric id or a playlist link, got "${raw}"`);
        }
        sources.push({ type: "playlist", playlistId: value });
        break;
      }
      case "--allow-signature-match":
        allowSignatureMatch = true;
        break;
      case "--remove-unplayable":
        removeUnplayable = true;
        break;
      case "--apply":
        apply = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (sources.length === 0) {
    throw new Error("A source is required: --favourites, --playlist <id>, or --all-playlists");
  }
  if (sources.length > 1) {
    throw new Error("Give only one of --favourites, --playlist or --all-playlists");
  }
  return { source: sources[0]!, allowSignatureMatch, removeUnplayable, apply };
}

export interface HistoryArgs {
  /** How many entries to list, newest first. */
  limit: number;
}

/** Entries `history` lists unless --limit says otherwise. */
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Parse `history` arguments: `--limit N` (1-200, default 20).
 *
 * @throws {Error} on a bad limit or an unknown argument.
 */
export function parseHistoryArgs(argv: readonly string[]): HistoryArgs {
  let limit = DEFAULT_HISTORY_LIMIT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== "--limit") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const raw = argv[i + 1];
    i += 1;
    const value = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      throw new Error(`--limit must be a whole number from 1 to 200, got "${raw}"`);
    }
    limit = value;
  }
  return { limit };
}

export interface UndoArgs {
  /** The entry to undo; the latest change when absent. */
  id?: string;
  apply: boolean;
}

/**
 * Parse `undo` arguments: an optional entry id (as `history` lists it) and
 * `--apply` (otherwise it only reports what would be reversed).
 *
 * @throws {Error} on two ids, a malformed id, or an unknown flag.
 */
export function parseUndoArgs(argv: readonly string[]): UndoArgs {
  let id: string | undefined;
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (id !== undefined) {
      throw new Error("Give only one entry id to undo");
    } else if (!/^[A-Za-z0-9]{1,40}$/.test(arg)) {
      throw new Error(`"${arg}" is not an entry id (see qobuz-helper history)`);
    } else {
      id = arg;
    }
  }
  return id === undefined ? { apply } : { id, apply };
}
