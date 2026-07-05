/**
 * Argument parsing for CLI commands.
 */

export interface PlaylistArgs {
  playlistName: string;
  artists: string[];
  tracksPerArtist?: number;
  isPublic: boolean;
}

/** Where the deduplicator should look for tracks. */
export type DedupeSource =
  | { type: "playlist"; playlistId: number }
  | { type: "favourites" };

/**
 * Parse the arguments for the `deduplicate` command.
 *
 * Exactly one source must be given: `--playlist <id>` or `--favourites`
 * (`--favorites` is accepted too).
 *
 * @throws {Error} if neither or both sources are given, or the id is invalid.
 */
export function parseDedupeArgs(argv: readonly string[]): DedupeSource {
  let playlistId: number | undefined;
  let favourites = false;

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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (playlistId !== undefined && favourites) {
    throw new Error("Give only one of --playlist or --favourites");
  }
  if (playlistId !== undefined) {
    return { type: "playlist", playlistId };
  }
  if (favourites) {
    return { type: "favourites" };
  }
  throw new Error("A source is required: --playlist <id> or --favourites");
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
