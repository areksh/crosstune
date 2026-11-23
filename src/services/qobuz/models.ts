/**
 * Lightweight domain models and defensive parsers for Qobuz JSON responses.
 *
 * The API returns large, loosely-typed objects; these parsers pull out just the
 * fields the tools need and tolerate missing or malformed entries rather than
 * trusting the shape.
 */

import type * as Neutral from "../model.js";
import { QobuzError } from "./errors.js";

/** Qobuz's own ids: numbers, except an album's. The neutral model tags them (../ids.ts). */
export interface Artist extends Omit<Neutral.Artist, "id"> {
  id: number;
}

export interface Track extends Omit<Neutral.Track, "id" | "artistId" | "albumId" | "playlistTrackId"> {
  id: number;
  artistId?: number;
  albumId?: string;
  playlistTrackId?: number;
}

export interface Album extends Omit<Neutral.Album, "id"> {
  id: string;
}

export interface Playlist extends Omit<Neutral.Playlist, "id" | "ownerId"> {
  id: number;
  ownerId?: number;
}

/** A page of tracks plus the total available, for paginated fetches. */
export interface TracksPage {
  tracks: Track[];
  total: number;
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
  if (typeof item["streamable"] === "boolean") {
    album.streamable = item["streamable"];
  }
  const image = imageOf(item["image"]);
  if (image !== undefined) {
    album.image = image;
  }
  return album;
}

/** Parse a single album object (e.g. an album/get response), or undefined if it is not one. */
export function parseAlbumDetails(response: unknown): Album | undefined {
  return parseAlbum(response);
}

/**
 * Parse the artist an `/artist/page` response describes: its `id` and
 * `name.display` (the page nests the name, unlike search results).
 */
export function parseArtistPage(response: unknown): Artist | undefined {
  if (!isRecord(response) || typeof response["id"] !== "number") {
    return undefined;
  }
  const name = response["name"];
  const display = isRecord(name) ? name["display"] : name;
  return typeof display === "string" && display.length > 0
    ? { id: response["id"], name: display }
    : undefined;
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
  readDuration(item, track);

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
  readDuration(item, track);
  if (typeof item["media_number"] === "number") {
    track.discNumber = item["media_number"];
  }
  if (typeof item["track_number"] === "number") {
    track.trackNumber = item["track_number"];
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
  if (typeof item["performers"] === "string") {
    const { joint, guests } = parseCredits(item["performers"], track.artist);
    if (joint.length > 0) {
      track.jointArtists = joint;
    }
    if (guests.length > 0) {
      track.guestArtists = guests;
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
    const genre = album["genre"];
    if (isRecord(genre) && typeof genre["name"] === "string" && genre["name"].length > 0) {
      track.genre = genre["name"];
    }
  }
  const favourited = item["favorited_at"];
  if (typeof favourited === "number" && Number.isFinite(favourited) && favourited > 0) {
    track.favouritedAt = new Date(favourited * 1000).toISOString();
  }
  if (typeof item["playlist_track_id"] === "number") {
    track.playlistTrackId = item["playlist_track_id"];
    const addedAt = isoFromSeconds(item["created_at"]);
    if (addedAt !== undefined) {
      track.addedAt = addedAt;
    }
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
  if (typeof item["streamable"] === "boolean") {
    track.streamable = item["streamable"];
  }
  return track;
}

/** A unix time in seconds as an ISO string, or undefined when it is not one. */
function isoFromSeconds(value: unknown): string | undefined {
  // Beyond this, Date cannot represent it and toISOString would throw.
  return typeof value === "number" && value > 0 && value < 8.64e12
    ? new Date(value * 1000).toISOString()
    : undefined;
}

/**
 * The artists a `performers` credits string names besides the main one: joint
 * main artists, and featured guests. The string is "Name, Role, Role - Name,
 * Role - ..." with stray carriage returns. Only the main and featured roles
 * matter here: any other credit, and one without a role, is passed over.
 */
export function parseCredits(
  performers: string,
  mainArtist?: string,
): { joint: string[]; guests: string[] } {
  const joint: string[] = [];
  const guests: string[] = [];
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const add = (list: string[], name: string): void => {
    const isMain = mainArtist !== undefined && same(name, mainArtist.trim());
    if (name.length > 0 && !isMain && !list.some((known) => same(known, name))) {
      list.push(name);
    }
  };
  for (const credit of performers.replace(/[\r\n]+/g, " ").split(" - ")) {
    const pieces = credit.split(",").map((piece) => piece.trim());
    const firstRole = pieces.findIndex((piece, i) => i > 0 && creditRole(piece) !== undefined);
    if (firstRole === -1) {
      continue;
    }
    const roles = pieces.slice(firstRole).map(creditRole);
    const name = nameBeforeRoles(pieces.slice(0, firstRole));
    if (roles.includes("main")) {
      add(joint, name);
    } else {
      add(guests, name);
    }
  }
  return { joint, guests: guests.filter((guest) => !joint.some((name) => same(name, guest))) };
}

function creditRole(piece: string): "main" | "featured" | undefined {
  const role = piece.replace(/\s+/g, "").toLowerCase();
  return role === "mainartist" ? "main" : role === "featuredartist" ? "featured" : undefined;
}

/**
 * The name at the start of a credit, given the pieces before its main or
 * featured role. A second piece belongs to the name only when it reads like
 * the rest of one ("Tyler, The Creator"; "Crosby, Stills & Nash"), as other
 * roles may come first too ("Juelz Santana, Composer, FeaturedArtist").
 */
function nameBeforeRoles(pieces: readonly string[]): string {
  const [first = "", second] = pieces;
  return second !== undefined && (/^(the|jr|sr|ii|iii)\b/i.test(second) || second.includes("&"))
    ? `${first}, ${second}`
    : first;
}

/** Copy a track's non-empty `version` label (Qobuz sends null when there is none). */
function readVersion(item: Record<string, unknown>, track: Track): void {
  if (typeof item["version"] === "string" && item["version"].length > 0) {
    track.version = item["version"];
  }
}

/** Copy a `duration` (seconds) when it is a non-negative number. */
function readDuration(item: Record<string, unknown>, track: { duration?: number }): void {
  const duration = item["duration"];
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
    track.duration = duration;
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
  if (typeof item["description"] === "string" && item["description"].length > 0) {
    playlist.description = item["description"];
  }
  if (typeof item["is_public"] === "boolean") {
    playlist.isPublic = item["is_public"];
  }
  if (typeof item["is_collaborative"] === "boolean") {
    playlist.isCollaborative = item["is_collaborative"];
  }
  readDuration(item, playlist);
  const updatedAt = isoFromSeconds(item["updated_at"]);
  if (updatedAt !== undefined) {
    playlist.updatedAt = updatedAt;
  }
  const owner = item["owner"];
  if (isRecord(owner) && typeof owner["id"] === "number") {
    playlist.ownerId = owner["id"];
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
