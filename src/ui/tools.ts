/**
 * The tools a page offers: those that act on a source (a playlist, a service's
 * Favourites, all its playlists) and those that start a new playlist. Each tool
 * is today's view (`view-<name>` in the page), filled in for its source the way
 * the home paste box fills it (src/web/prefill.ts).
 */

import { serviceOf, shortId, type PlaylistId } from "../services/ids.js";

export const SOURCE_TOOLS = ["repeats", "upgrade", "stats", "export", "similar", "combine"] as const;
export type SourceTool = (typeof SOURCE_TOOLS)[number];

export const NEW_TOOLS = ["artists", "albums", "similar", "word-play", "combine", "import"] as const;
export type NewTool = (typeof NEW_TOOLS)[number];

export type Source = { kind: "playlist"; id: PlaylistId } | { kind: "favourites" } | { kind: "all" };

/** What to fill in a view: the same shape as the page's Prefill. */
export interface Fill {
  view: string;
  fields?: Record<string, string>;
  radios?: Record<string, string>;
}

const VIEWS: Record<SourceTool, string> = {
  repeats: "deduplicate",
  upgrade: "upgrade",
  stats: "stats",
  export: "import-export",
  similar: "similar",
  combine: "combine",
};

const NEW_VIEWS: Record<NewTool, string> = {
  artists: "playlist",
  albums: "albums",
  similar: "similar",
  "word-play": "word-play",
  combine: "combine",
  import: "import-export",
};

const LABELS: Record<SourceTool | NewTool, string> = {
  repeats: "Find repeats",
  upgrade: "Upgrade",
  stats: "Stats",
  export: "Export",
  similar: "Similar artists",
  combine: "Combine",
  artists: "Playlist from artists",
  albums: "Playlist from albums",
  "word-play": "Word play",
  import: "Import a file",
};

const ALL_LABELS: Partial<Record<SourceTool, string>> = {
  repeats: "Find repeats across them",
  upgrade: "Upgrade all",
  // Favourites and every playlist: the whole library.
  stats: "Library stats",
  export: "Export all",
};

export function isSourceTool(value: unknown): value is SourceTool {
  return (SOURCE_TOOLS as readonly unknown[]).includes(value);
}

export function isNewTool(value: unknown): value is NewTool {
  return (NEW_TOOLS as readonly unknown[]).includes(value);
}

export function toolsFor(source: Source["kind"]): SourceTool[] {
  return source === "playlist" ? [...SOURCE_TOOLS] : ["repeats", "upgrade", "stats", "export"];
}

export function toolLabel(tool: SourceTool | NewTool, source?: Source["kind"]): string {
  return (source === "all" && isSourceTool(tool) ? ALL_LABELS[tool] : undefined) ?? LABELS[tool];
}

export function newToolView(tool: NewTool): string {
  return NEW_VIEWS[tool];
}

export function sourceToolView(tool: SourceTool): string {
  return VIEWS[tool];
}

/** A playlist as a tool's link box reads it: Qobuz's as a link, others as the tagged id. */
export function playlistLink(id: PlaylistId): string {
  return serviceOf(id) === "qobuz" ? `https://play.qobuz.com/playlist/${shortId(id)}` : String(id);
}

function playlistFill(tool: SourceTool, id: PlaylistId): Omit<Fill, "view"> {
  const text = String(id);
  switch (tool) {
    case "repeats":
      return { radios: { "dedup-source": "playlist" }, fields: { "dedup-playlist-select": text } };
    case "upgrade":
      return { fields: { "upgrade-source": `playlist:${text}` } };
    case "stats":
      return { fields: { "stats-source": text } };
    case "export":
      return { radios: { "ie-source": "playlist" }, fields: { "ie-export-playlist-select": text } };
    case "similar":
      return { fields: { "similar-source-link": playlistLink(id) }, radios: { "similar-source": "playlist" } };
    case "combine":
      return { fields: { "combine-source-first": text } };
  }
}

const COLLECTION_FILLS: Record<"favourites" | "all", Partial<Record<SourceTool, Omit<Fill, "view">>>> = {
  favourites: {
    repeats: { radios: { "dedup-source": "favourites" } },
    upgrade: { fields: { "upgrade-source": "favourites" } },
    stats: { fields: { "stats-source": "favourites" } },
    export: { radios: { "ie-source": "favourite-tracks" } },
  },
  all: {
    repeats: { radios: { "dedup-source": "all-playlists" } },
    upgrade: { fields: { "upgrade-source": "all-playlists" } },
    stats: { fields: { "stats-source": "everything" } },
    export: { radios: { "ie-source": "all-playlists" } },
  },
};

/** How to fill a tool for a source; undefined when that source does not offer it. */
export function sourceToolFill(tool: SourceTool, source: Source): Fill | undefined {
  const fill = source.kind === "playlist" ? playlistFill(tool, source.id) : COLLECTION_FILLS[source.kind][tool];
  return fill === undefined ? undefined : { view: VIEWS[tool], ...fill };
}
