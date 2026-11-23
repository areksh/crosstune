/**
 * The music model every service is read into and every tool works on.
 *
 * Small on purpose: only the fields the tools need. Ids carry their service
 * (./ids.ts); a field a service does not give is absent, never guessed.
 */

import type { AlbumId, ArtistId, EntryId, PlaylistId, TrackId, UserId } from "./ids.js";
import type { ReleaseType } from "./releases.js";

export type { AlbumId, ArtistId, EntryId, PlaylistId, TrackId, UserId } from "./ids.js";
export { ServiceError } from "./errors.js";
export { classifyRelease, RELEASE_TYPES, type ReleaseType } from "./releases.js";

/** How good a track sounds, as services that give no bit depth grade it. */
export type QualityTier = "lossy" | "lossless" | "hires";

export interface Artist {
  id: ArtistId;
  name: string;
}

export interface Track {
  id: TrackId;
  title: string;
  /** Track variant label ("Live", "2011 Remaster", ...), when present. */
  version?: string;
  /** Disc (medium) number within its album, when present (album/get tracks). */
  discNumber?: number;
  /** Track number on its disc, when present. */
  trackNumber?: number;
  /** Track artist (performer) name, when present. */
  artist?: string;
  /**
   * Id of the track's main (performer) artist, when present. Used to tell an
   * artist's own recordings apart from covers on an artist page, and to find a
   * playlist's artists.
   */
  artistId?: ArtistId;
  /** Other artists credited as a main artist (see {@link parseCredits}); absent when none. */
  jointArtists?: string[];
  /** Artists credited as featured (see {@link parseCredits}); absent when none. */
  guestArtists?: string[];
  /** International Standard Recording Code, when present. */
  isrc?: string;
  /** Album title the track appears on, when present. */
  album?: string;
  /** Album id, used to look up release dates. */
  albumId?: AlbumId;
  /** Id of this track *within a playlist*, needed to remove it from that playlist. */
  playlistTrackId?: EntryId;
  /** Maximum bit depth (e.g. 16, 24), a quality signal. */
  bitDepth?: number;
  /** Maximum sampling rate in kHz (e.g. 44.1, 96), a quality signal. */
  samplingRate?: number;
  /** Whether the track is hi-res. */
  hires?: boolean;
  /** Original release date (YYYY-MM-DD) when available on the embedded album. */
  releaseDate?: string;
  /** Album cover URL (https, about 230px), when known.  */
  image?: string;
  /** Length in seconds, when present. */
  duration?: number;
  /** How good it sounds, where a service says only that and not {@link bitDepth}. */
  quality?: QualityTier;
  /** A link to it on its service. */
  url?: string;
  /** Not a song (a podcast episode, a video, a local file): shown, never matched. */
  other?: "episode" | "video" | "local";
  /**
   * Whether the service can currently stream the track, when the response says.
   * `false` marks a track that has gone unplayable (rights withdrawn), which
   * the upgrade tool repairs; absent means unknown, not unplayable.
   */
  streamable?: boolean;
  /** The album's genre name ("Jazz"), when the embedded album carries one. */
  genre?: string;
  /** When the track was added to the favourites (ISO), on favourite tracks only. */
  favouritedAt?: string;
  /** When the track was added to the playlist (ISO), on playlist tracks only. */
  addedAt?: string;
}

export interface Album {
  id: AlbumId;
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
  /** Cover URL (https, about 230px), when known.  */
  image?: string;
  /** Whether the service can currently stream the album, when the response says. */
  streamable?: boolean;
  /** How good it sounds, where a service says only that. */
  quality?: QualityTier;
  /** Its barcode (UPC or EAN), when the service gives it. */
  upc?: string;
  /** A link to it on its service. */
  url?: string;
}

export interface Playlist {
  id: PlaylistId;
  name: string;
  /** Number of tracks in the playlist, when the response carries it. */
  trackCount?: number;
  description?: string;
  isPublic?: boolean;
  isCollaborative?: boolean;
  /** Total length in seconds. */
  duration?: number;
  /** When it last changed (ISO). */
  updatedAt?: string;
  /** Id of the user it belongs to. */
  ownerId?: UserId;
  /** A link to it on its service. */
  url?: string;
  /** Its cover (https), when the service has one; loaded only if artwork is on (ADR-0004). */
  image?: string;
}

/** An album release of an artist, with its type and (when known) its main artist id. */
export interface Release extends Album {
  releaseType: ReleaseType;
  /** Id of the release's main artist, when present. */
  artistId?: ArtistId;
}

/** An artist's releases as fetched, and whether a cap cut the list short. */
export interface ArtistReleases {
  releases: Release[];
  truncated: boolean;
}
