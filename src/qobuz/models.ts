/**
 * Lightweight domain models and defensive parsers for Qobuz JSON responses.
 *
 * The API returns large, loosely-typed objects; these parsers pull out just the
 * fields the tools need and tolerate missing or malformed entries rather than
 * trusting the shape.
 */

import { QobuzError } from "./errors.js";

export interface Artist {
  id: number;
  name: string;
}

export interface Track {
  id: number;
  title: string;
  /** Track artist (performer) name, when present. */
  artist?: string;
  /** International Standard Recording Code, when present. */
  isrc?: string;
  /** Album title the track appears on, when present. */
  album?: string;
  /** Album id, used to look up release dates. */
  albumId?: string;
  /** Id of this track *within a playlist*, needed to remove it from that playlist. */
  playlistTrackId?: number;
  /** Maximum bit depth (e.g. 16, 24), a quality signal. */
  bitDepth?: number;
  /** Maximum sampling rate in kHz (e.g. 44.1, 96), a quality signal. */
  samplingRate?: number;
  /** Whether the track is hi-res. */
  hires?: boolean;
  /** Original release date (YYYY-MM-DD) when available on the embedded album. */
  releaseDate?: string;
}

/** A page of tracks plus the total available, for paginated fetches. */
export interface TracksPage {
  tracks: Track[];
  total: number;
}

export interface Playlist {
  id: number;
  name: string;
  /** Number of tracks in the playlist, when the response carries it. */
  trackCount?: number;
}

/** A page of playlists plus the total available, for paginated fetches. */
export interface PlaylistsPage {
  playlists: Playlist[];
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function itemsOf(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const container = value[key];
  if (!isRecord(container) || !Array.isArray(container["items"])) {
    return [];
  }
  return container["items"];
}

/** Parse the `artists.items` list of an artist search response. */
export function parseArtists(response: unknown): Artist[] {
  const artists: Artist[] = [];
  for (const item of itemsOf(response, "artists")) {
    if (isRecord(item) && typeof item["id"] === "number" && typeof item["name"] === "string") {
      artists.push({ id: item["id"], name: item["name"] });
    }
  }
  return artists;
}

/** Parse the `tracks.items` list of a tracks container (e.g. artist/get?extra=tracks). */
export function parseTracks(response: unknown): Track[] {
  const tracks: Track[] = [];
  for (const item of itemsOf(response, "tracks")) {
    const track = parseTrack(item);
    if (track !== undefined) {
      tracks.push(track);
    }
  }
  return tracks;
}

/**
 * Parse the `top_tracks` of an `/artist/page` response.
 *
 * These are ordered by popularity (the "Popular tracks" the Qobuz web player
 * shows), which is what the playlist tool wants. Their JSON differs from the
 * `artist/get` track shape: the performer is nested under `artist.name.display`
 * and quality lives in `audio_info`.
 */
export function parseArtistPageTracks(response: unknown): Track[] {
  if (!isRecord(response) || !Array.isArray(response["top_tracks"])) {
    return [];
  }
  const tracks: Track[] = [];
  for (const item of response["top_tracks"]) {
    const track = parseArtistPageTrack(item);
    if (track !== undefined) {
      tracks.push(track);
    }
  }
  return tracks;
}

/** Parse a single `/artist/page` top track. */
function parseArtistPageTrack(item: unknown): Track | undefined {
  if (!isRecord(item) || typeof item["id"] !== "number" || typeof item["title"] !== "string") {
    return undefined;
  }
  const track: Track = { id: item["id"], title: item["title"] };

  const artist = item["artist"];
  if (isRecord(artist)) {
    const name = artist["name"];
    if (isRecord(name) && typeof name["display"] === "string") {
      track.artist = name["display"];
    }
  }
  if (typeof item["isrc"] === "string") {
    track.isrc = item["isrc"];
  }
  const album = item["album"];
  if (isRecord(album)) {
    if (typeof album["title"] === "string") {
      track.album = album["title"];
    }
    if (typeof album["id"] === "string") {
      track.albumId = album["id"];
    }
  }
  const audio = item["audio_info"];
  if (isRecord(audio)) {
    if (typeof audio["maximum_bit_depth"] === "number") {
      track.bitDepth = audio["maximum_bit_depth"];
    }
    if (typeof audio["maximum_sampling_rate"] === "number") {
      track.samplingRate = audio["maximum_sampling_rate"];
    }
  }
  return track;
}

/** Parse a tracks container into its tracks plus the total count (for pagination). */
export function parseTracksPage(response: unknown): TracksPage {
  const container =
    isRecord(response) && isRecord(response["tracks"]) ? response["tracks"] : {};
  const total = typeof container["total"] === "number" ? container["total"] : 0;
  return { tracks: parseTracks(response), total };
}

/** Parse a single track object, pulling artist, ISRC and album when present. */
function parseTrack(item: unknown): Track | undefined {
  if (!isRecord(item) || typeof item["id"] !== "number" || typeof item["title"] !== "string") {
    return undefined;
  }
  const track: Track = { id: item["id"], title: item["title"] };

  const performer = item["performer"];
  if (isRecord(performer) && typeof performer["name"] === "string") {
    track.artist = performer["name"];
  }
  if (typeof item["isrc"] === "string") {
    track.isrc = item["isrc"];
  }
  const album = item["album"];
  if (isRecord(album)) {
    if (typeof album["title"] === "string") {
      track.album = album["title"];
    }
    if (typeof album["id"] === "string") {
      track.albumId = album["id"];
    }
    const embeddedDate = releaseDateOf(album);
    if (embeddedDate !== undefined) {
      track.releaseDate = embeddedDate;
    }
  }
  if (typeof item["playlist_track_id"] === "number") {
    track.playlistTrackId = item["playlist_track_id"];
  }
  if (typeof item["maximum_bit_depth"] === "number") {
    track.bitDepth = item["maximum_bit_depth"];
  }
  if (typeof item["maximum_sampling_rate"] === "number") {
    track.samplingRate = item["maximum_sampling_rate"];
  }
  if (typeof item["hires"] === "boolean") {
    track.hires = item["hires"];
  }
  return track;
}

/** Read a release date (YYYY-MM-DD) from an album object, if present. */
function releaseDateOf(album: Record<string, unknown>): string | undefined {
  const original = album["release_date_original"];
  if (typeof original === "string" && original.length > 0) {
    return original.slice(0, 10);
  }
  const releasedAt = album["released_at"];
  if (typeof releasedAt === "number") {
    return new Date(releasedAt * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** Parse an album/get response for its original release date (YYYY-MM-DD). */
export function parseAlbumReleaseDate(response: unknown): string | undefined {
  return isRecord(response) ? releaseDateOf(response) : undefined;
}

/**
 * Parse a playlist object (e.g. from playlist/create).
 *
 * @throws {QobuzError} kind `api-response` if the response carries no numeric id.
 */
export function parsePlaylist(response: unknown): Playlist {
  if (!isRecord(response) || typeof response["id"] !== "number") {
    throw new QobuzError("api-response", "Playlist response has no id");
  }
  return toPlaylist(response) as Playlist;
}

/** Parse a single playlist object, or undefined if it lacks a numeric id. */
function toPlaylist(item: unknown): Playlist | undefined {
  if (!isRecord(item) || typeof item["id"] !== "number") {
    return undefined;
  }
  const name = typeof item["name"] === "string" ? item["name"] : "";
  const playlist: Playlist = { id: item["id"], name };
  if (typeof item["tracks_count"] === "number") {
    playlist.trackCount = item["tracks_count"];
  }
  return playlist;
}

/** Parse the `playlists.items` list of a getUserPlaylists response. */
export function parsePlaylists(response: unknown): Playlist[] {
  const playlists: Playlist[] = [];
  for (const item of itemsOf(response, "playlists")) {
    const playlist = toPlaylist(item);
    if (playlist !== undefined) {
      playlists.push(playlist);
    }
  }
  return playlists;
}

/** Parse a playlists container into its playlists plus the total (for pagination). */
export function parsePlaylistsPage(response: unknown): PlaylistsPage {
  const container =
    isRecord(response) && isRecord(response["playlists"])
      ? response["playlists"]
      : {};
  const total = typeof container["total"] === "number" ? container["total"] : 0;
  return { playlists: parsePlaylists(response), total };
}
