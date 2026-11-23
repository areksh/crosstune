/**
 * The pages for one thing in the library: a playlist's header and action row
 * (over the editor), a service's Favourites, and All playlists. The actions
 * open today's tool views filled in for that source, on its service.
 */

import type { ServiceName } from "../services/names.js";

/** Wire up the Favourites page. Call once on load. */
export function initFavouritesView(): void {}

/** The action row over a service's list of playlists ("#/all/<service>"). */
export function showAllActions(_service: ServiceName): void {}
