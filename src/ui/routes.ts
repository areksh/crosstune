/**
 * The page's addresses: what each URL hash shows, and where old ones now live.
 *
 * The library is home ("#/"), a playlist is "#/p/<id>" (Qobuz ids in the short
 * form they always had) and a tool on it "#/p/<id>/<tool>"; Favourites and All
 * playlists are per service ("#/favourites/<service>[/<tool>]"); tools that
 * start a new playlist are "#/new/<tool>". Pure, so the web page's router
 * stays thin glue (src/web/main.ts).
 */

import { readId, shortId, type PlaylistId } from "../services/ids.js";
import { isServiceName, type ServiceName } from "../services/names.js";
import { isNewTool, isSourceTool, newToolView, sourceToolView, toolsFor, type NewTool, type SourceTool } from "./tools.js";

export type Route =
  | { kind: "home" }
  | { kind: "playlist"; id: PlaylistId; tool?: SourceTool }
  | { kind: "favourites"; service: ServiceName; tool?: SourceTool }
  | { kind: "all"; service: ServiceName; tool?: SourceTool }
  | { kind: "new"; tool: NewTool }
  | { kind: "jobs" }
  | { kind: "settings" }
  /** A page of its own: History, New releases, Import & export. */
  | { kind: "view"; view: string };

const HOME: Route = { kind: "home" };

/** The pages that keep an address of their own. */
const OWN_VIEWS = ["history", "new-releases", "import-export"];

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

/** The tool, when the source offers it. */
function toolOn(source: "playlist" | "favourites" | "all", word: string | undefined): { tool?: SourceTool } {
  return isSourceTool(word) && toolsFor(source).includes(word) ? { tool: word } : {};
}

export function parseRoute(hash: string): Route {
  const [head = "", arg, tool] = parts(hash);
  switch (head) {
    case "":
      return HOME;
    case "p": {
      const id = playlistIn(arg);
      return id === undefined ? HOME : { kind: "playlist", id, ...toolOn("playlist", tool) };
    }
    case "favourites":
    case "all":
      return isServiceName(arg) ? { kind: head, service: arg, ...toolOn(head, tool) } : HOME;
    case "new":
      return isNewTool(arg) ? { kind: "new", tool: arg } : HOME;
    case "jobs":
      return { kind: "jobs" };
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
      return `#/p/${encodeURIComponent(shortId(route.id))}${route.tool === undefined ? "" : `/${route.tool}`}`;
    case "favourites":
    case "all":
      return `#/${route.kind}/${route.service}${route.tool === undefined ? "" : `/${route.tool}`}`;
    case "new":
      return `#/new/${route.tool}`;
    case "jobs":
      return "#/jobs";
    case "settings":
      return "#/settings";
    case "view":
      return `#/${route.view}`;
  }
}

/** The page section (`view-<name>`) a route shows. */
export function viewOf(route: Route): string {
  switch (route.kind) {
    case "home":
      return "home";
    case "playlist":
    case "all":
      return route.tool === undefined ? "playlists" : sourceToolView(route.tool);
    case "favourites":
      return route.tool === undefined ? "favourites" : sourceToolView(route.tool);
    case "new":
      return newToolView(route.tool);
    case "jobs":
      return "managed";
    case "settings":
      return "accounts";
    case "view":
      return OWN_VIEWS.includes(route.view) ? route.view : "home";
  }
}

/** Old tool addresses that start a new playlist. */
const OLD_NEW: Record<string, NewTool> = {
  playlist: "artists",
  albums: "albums",
  similar: "similar",
  "word-play": "word-play",
  combine: "combine",
};

/** Old tool addresses that had a source to choose: they open on Favourites. */
const OLD_SOURCE: Record<string, SourceTool> = {
  deduplicate: "repeats",
  upgrade: "upgrade",
  stats: "stats",
};

/**
 * The hash an old address now lives at, or undefined if it is current.
 * `service` is where the old tools with a source go (that service's Favourites).
 */
export function redirectFor(hash: string, service?: ServiceName): string | undefined {
  const [head = "", arg] = parts(hash);
  switch (head) {
    case "home":
      return "#/";
    case "accounts":
      return "#/settings";
    case "managed":
      return "#/jobs";
    case "playlists": {
      const id = playlistIn(arg);
      return id === undefined ? "#/" : routeHash({ kind: "playlist", id });
    }
  }
  const fresh = OLD_NEW[head];
  if (fresh !== undefined) {
    return routeHash({ kind: "new", tool: fresh });
  }
  const tool = OLD_SOURCE[head];
  if (tool !== undefined) {
    return service === undefined ? "#/" : routeHash({ kind: "favourites", service, tool });
  }
  return undefined;
}
