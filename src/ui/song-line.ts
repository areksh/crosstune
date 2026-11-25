/** How the page names a song in a list of songs to choose from. */

export interface SongLineFields {
  title: string;
  version?: string;
  artist?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  /** YYYY-MM-DD, or as much of it as is known. */
  releaseDate?: string;
}

/** "Roads (Live) – Portishead". */
export function songLine(track: SongLineFields): string {
  const title = track.version === undefined ? track.title : `${track.title} (${track.version})`;
  return track.artist === undefined ? title : `${title} – ${track.artist}`;
}

/**
 * A song offered as a choice, with what tells it from the other songs of its
 * title: "Yesterday – The Beatles, Help!, 1965 (2:05)".
 */
export function optionLine(track: SongLineFields): string {
  const length =
    track.duration === undefined
      ? ""
      : ` (${Math.floor(track.duration / 60)}:${String(Math.round(track.duration % 60)).padStart(2, "0")})`;
  const album = track.album === undefined ? "" : `, ${track.album}`;
  const year = track.releaseDate === undefined ? "" : `, ${track.releaseDate.slice(0, 4)}`;
  return `${songLine(track)}${album}${year}${length}`;
}
