/**
 * The page's addresses: what each URL hash shows, and where old ones now live.
 *
 * The library is home ("#/"), a playlist is "#/p/<id>" (Qobuz ids in the short
 * form they always had), Favourites and All playlists are per service, and the
 * tools not yet hosted inside a playlist keep their own hash ("#/upgrade").
 * Pure, so the web page's router stays thin glue (src/web/main.ts).
 */

import { readId, shortId, type PlaylistId } from "../services/ids.js";
import { isServiceName, type ServiceName } from "../services/names.js";

export type Route =
  | { kind: "home" }
  | { kind: "playlist"; id: PlaylistId }
  | { kind: "favourites"; service: ServiceName }
  | { kind: "all"; service: ServiceName }
  | { kind: "settings" }
  /** A tool's own view, not yet moved into a playlist. */
  | { kind: "view"; view: string };

const HOME: Route = { kind: "home" };

function parts(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/");
}

function playlistIn(text: string | undefined): PlaylistId | undefined {
  if (text === undefined || text === "") {
    return undefined;
  }
  try {
    return readId<PlaylistId>(decodeURIComponent(text));
  } catch {
    return undefined;
  }
}

export function parseRoute(hash: string): Route {
  const [head = "", arg] = parts(hash);
  switch (head) {
    case "":
      return HOME;
    case "p": {
      const id = playlistIn(arg);
      return id === undefined ? HOME : { kind: "playlist", id };
    }
    case "favourites":
    case "all":
      return isServiceName(arg) ? { kind: head, service: arg } : HOME;
    case "settings":
      return { kind: "settings" };
    default:
      return { kind: "view", view: head };
  }
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case "home":
      return "#/";
    case "playlist":
      return `#/p/${encodeURIComponent(shortId(route.id))}`;
    case "favourites":
    case "all":
      return `#/${route.kind}/${route.service}`;
    case "settings":
      return "#/settings";
    case "view":
      return `#/${route.view}`;
  }
}

/** The hash an old address now lives at, or undefined if it is current. */
export function redirectFor(hash: string): string | undefined {
  const [head = "", arg] = parts(hash);
  switch (head) {
    case "home":
      return "#/";
    case "accounts":
      return "#/settings";
    case "playlists": {
      const id = playlistIn(arg);
      return id === undefined ? "#/" : routeHash({ kind: "playlist", id });
    }
    default:
      return undefined;
  }
}
