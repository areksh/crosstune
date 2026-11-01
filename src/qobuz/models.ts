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
  /** Track variant label ("Live", "2011 Remaster", ...), when present. */
  version?: string;
  /** Disc (medium) number within its album, when present (album/get tracks). */
  discNumber?: number;
  /** Track artist (performer) name, when present. */
  artist?: string;
  /**
   * Id of the track's main (performer) artist, when present. Used to tell an
   * artist's own recordings apart from covers on an artist page, and to find a
   * playlist's artists.
   */
  artistId?: number;
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
  /** Album cover URL (https, about 230px), when known. See {@link imageOf}. */
  image?: string;
}

/** A page of tracks plus the total available, for paginated fetches. */
export interface TracksPage {
  tracks: Track[];
  total: number;
}

export interface Album {
  id: string;
  title: string;
  /** Primary artist (performer) name; empty string when the response omits it. */
  artist: string;
  /** Release variant label ("2017 Remaster", "Deluxe Edition", ...), when present. */
  version?: string;
  /** Original release date (YYYY-MM-DD), when present. */
  releaseDate?: string;
  /** Maximum bit depth (e.g. 16, 24), a quality signal. */
  bitDepth?: number;
  /** Maximum sampling rate in kHz (e.g. 44.1, 96), a quality signal. */
  samplingRate?: number;
  /** Whether the album is hi-res. */
  hires?: boolean;
  /** Number of tracks on the album, when the response carries it. */
  trackCount?: number;
  /** Cover URL (https, about 230px), when known. See {@link imageOf}. */
  image?: string;
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

/** A page of albums plus the total available, for paginated fetches. */
export interface AlbumsPage {
  albums: Album[];
  total: number;
}

/** A page of artists plus the total available, for paginated fetches. */
export interface ArtistsPage {
  artists: Artist[];
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The cover URL from a Qobuz image object (`{ small, thumbnail, large }`),
 * preferring `small` (about 230px, enough for a list) over `thumbnail` and
 * `large`. Only https URLs are accepted: the browser loads them directly.
 */
function imageOf(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const size of ["small", "thumbnail", "large"]) {
    const url = value[size];
    if (typeof url === "string" && url.startsWith("https://")) {
      return url;
    }
  }
  return undefined;
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

/** Parse the `albums.items` list of an album search response. */
export function parseAlbums(response: unknown): Album[] {
  const albums: Album[] = [];
  for (const item of itemsOf(response, "albums")) {
    const album = parseAlbum(item);
    if (album !== undefined) {
      albums.push(album);
    }
  }
  return albums;
}

/** Parse a single album object, pulling artist, version, quality and dates when present. */
function parseAlbum(item: unknown): Album | undefined {
  if (!isRecord(item) || typeof item["id"] !== "string" || typeof item["title"] !== "string") {
    return undefined;
  }
  const artistName =
    isRecord(item["artist"]) && typeof item["artist"]["name"] === "string"
      ? item["artist"]["name"]
      : "";
  const album: Album = { id: item["id"], title: item["title"], artist: artistName };

  if (typeof item["version"] === "string" && item["version"].length > 0) {
    album.version = item["version"];
  }
  const date = releaseDateOf(item);
  if (date !== undefined) {
    album.releaseDate = date;
  }
  if (typeof item["maximum_bit_depth"] === "number") {
    album.bitDepth = item["maximum_bit_depth"];
  }
  if (typeof item["maximum_sampling_rate"] === "number") {
    album.samplingRate = item["maximum_sampling_rate"];
  }
  // Qobuz labels an album's hi-res status as `hires` or `hires_streamable`.
  if (typeof item["hires"] === "boolean") {
    album.hires = item["hires"];
  } else if (typeof item["hires_streamable"] === "boolean") {
    album.hires = item["hires_streamable"];
  }
  if (typeof item["tracks_count"] === "number") {
    album.trackCount = item["tracks_count"];
  }
  const image = imageOf(item["image"]);
  if (image !== undefined) {
    album.image = image;
  }
  return album;
}

/** Parse an albums container into its albums plus the total (for pagination). */
export function parseAlbumsPage(response: unknown): AlbumsPage {
  const container =
    isRecord(response) && isRecord(response["albums"]) ? response["albums"] : {};
  const total = typeof container["total"] === "number" ? container["total"] : 0;
  return { albums: parseAlbums(response), total };
}

/** Parse an artists container into its artists plus the total (for pagination). */
export function parseArtistsPage(response: unknown): ArtistsPage {
  const container =
    isRecord(response) && isRecord(response["artists"]) ? response["artists"] : {};
  const total = typeof container["total"] === "number" ? container["total"] : 0;
  return { artists: parseArtists(response), total };
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
  readVersion(item, track);

  const artist = item["artist"];
  if (isRecord(artist)) {
    if (typeof artist["id"] === "number") {
      track.artistId = artist["id"];
    }
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
    const image = imageOf(album["image"]);
    if (image !== undefined) {
      track.image = image;
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

/**
 * Parse the tracks of an `album/get` response. Its tracks embed no album, so
 * each takes the parent album's cover unless it carries its own.
 */
export function parseAlbumTracks(response: unknown): Track[] {
  const tracks = parseTracks(response);
  const cover = isRecord(response) ? imageOf(response["image"]) : undefined;
  if (cover === undefined) {
    return tracks;
  }
  return tracks.map((track) => (track.image === undefined ? { ...track, image: cover } : track));
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
  readVersion(item, track);
  if (typeof item["media_number"] === "number") {
    track.discNumber = item["media_number"];
  }

  const performer = item["performer"];
  if (isRecord(performer)) {
    if (typeof performer["name"] === "string") {
      track.artist = performer["name"];
    }
    if (typeof performer["id"] === "number") {
      track.artistId = performer["id"];
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
    const embeddedDate = releaseDateOf(album);
    if (embeddedDate !== undefined) {
      track.releaseDate = embeddedDate;
    }
    const image = imageOf(album["image"]);
    if (image !== undefined) {
      track.image = image;
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

/** Copy a track's non-empty `version` label (Qobuz sends null when there is none). */
function readVersion(item: Record<string, unknown>, track: Track): void {
  if (typeof item["version"] === "string" && item["version"].length > 0) {
    track.version = item["version"];
  }
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
