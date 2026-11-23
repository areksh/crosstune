/**
 * What the ask box in the top bar suggests for what is typed or pasted.
 *
 * Several lines, links, or "Artist - Album" lines are read as the home paste
 * box read them (`classifyPaste`): the tools that fit, the likeliest first.
 * One plain line is first looked for among the playlists and the tools ("tech"
 * opens Techno, "repeats" finds repeats), and only then taken as an artist.
 */

import { classifyPaste, type PasteSummary } from "../features/music-links.js";
import type { PlaylistId } from "../services/ids.js";
import type { ServiceName } from "../services/names.js";
import { routeHash, type Route } from "./routes.js";
import { toolLabel, type Fill, type NewTool, type SourceTool } from "./tools.js";

export interface AskContext {
  playlists: readonly { id: PlaylistId; name: string; owned: boolean }[];
  /** The playlist whose page is open, if any: tools on it come first. */
  open?: PlaylistId;
  /** The service whose Favourites a tool goes to when no playlist is open. */
  service?: ServiceName;
}

export interface AskSuggestion {
  label: string;
  /** Where it goes; none for a note that cannot be picked. */
  hash?: string;
  /** What to fill in the tool, when its address does not say. */
  fill?: Fill;
}

const MOST = 8;

/** A tool or page the box can open, and the words that find it. */
interface Destination {
  words: string[];
  label: string;
  route: (context: AskContext) => Route | undefined;
}

function onSource(tool: SourceTool, fallback?: NewTool): Destination["route"] {
  return (context) =>
    context.open !== undefined
      ? { kind: "playlist", id: context.open, tool }
      : fallback !== undefined
        ? { kind: "new", tool: fallback }
        : context.service !== undefined
          ? { kind: "favourites", service: context.service, tool }
          : undefined;
}

const DESTINATIONS: Destination[] = [
  { words: ["find repeats", "repeats", "duplicates", "dedupe"], label: toolLabel("repeats"), route: onSource("repeats") },
  { words: ["upgrade", "repair"], label: "Upgrade", route: onSource("upgrade") },
  { words: ["stats", "statistics"], label: toolLabel("stats"), route: onSource("stats") },
  { words: ["export"], label: toolLabel("export"), route: onSource("export") },
  { words: ["similar artists", "similar"], label: toolLabel("similar"), route: onSource("similar", "similar") },
  { words: ["combine", "merge"], label: toolLabel("combine"), route: onSource("combine", "combine") },
  { words: ["playlist from artists", "artists"], label: toolLabel("artists"), route: () => ({ kind: "new", tool: "artists" }) },
  { words: ["playlist from albums", "albums"], label: toolLabel("albums"), route: () => ({ kind: "new", tool: "albums" }) },
  { words: ["word play", "wordplay"], label: toolLabel("word-play"), route: () => ({ kind: "new", tool: "word-play" }) },
  { words: ["import"], label: toolLabel("import"), route: () => ({ kind: "new", tool: "import" }) },
  { words: ["new releases", "releases"], label: "New releases", route: () => ({ kind: "view", view: "new-releases" }) },
  { words: ["jobs", "managed playlists", "managed", "links"], label: "Jobs", route: () => ({ kind: "jobs" }) },
  { words: ["history", "undo"], label: "History", route: () => ({ kind: "view", view: "history" }) },
  { words: ["settings", "accounts", "artwork", "covers"], label: "Settings", route: () => ({ kind: "settings" }) },
];

/** The tools that fit what was pasted, the likeliest first. */
function pasteSuggestions(found: PasteSummary, context: AskContext): AskSuggestion[] {
  const suggestions: AskSuggestion[] = [];
  if (found.artists.length > 0) {
    const artists = found.artists.join("\n");
    suggestions.push(
      {
        label:
          found.artists.length > 1
            ? "Build a playlist from these artists"
            : /^https?:\/\//.test(found.artists[0] ?? "")
              ? "Build a playlist from this artist"
              : `Build a playlist from ${found.artists[0]}`,
        hash: routeHash({ kind: "new", tool: "artists" }),
        fill: { view: "playlist", fields: { artists } },
      },
      {
        label: "Find similar artists",
        hash: routeHash({ kind: "new", tool: "similar" }),
        fill: { view: "similar", radios: { "similar-source": "artists" }, fields: { "similar-artists": artists } },
      },
    );
  }
  if (found.albums.length > 0) {
    suggestions.push({
      label: "Build a playlist from these albums",
      hash: routeHash({ kind: "new", tool: "albums" }),
      fill: { view: "albums", radios: { "album-source": "list" }, fields: { albums: found.albums.join("\n") } },
    });
  }
  const playlist = found.playlists[0];
  if (playlist !== undefined) {
    suggestions.push({
      label: "Similar artists from this playlist",
      hash: routeHash({ kind: "new", tool: "similar" }),
      fill: { view: "similar", radios: { "similar-source": "playlist" }, fields: { "similar-source-link": playlist.line } },
    });
    // These work on the user's own playlists only.
    if (context.playlists.some((known) => known.id === playlist.id && known.owned)) {
      suggestions.push(
        { label: "Open it", hash: routeHash({ kind: "playlist", id: playlist.id }) },
        { label: "Find repeats in it", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "repeats" }) },
        { label: "Upgrade it", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "upgrade" }) },
        { label: "Its stats", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "stats" }) },
      );
    }
  }
  if (suggestions.length === 0 && (found.tracks.length > 0 || found.other.length > 0)) {
    suggestions.push({ label: "Track and label links are not used by a tool yet" });
  }
  return suggestions;
}

export function askSuggestions(text: string, context: AskContext): AskSuggestion[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  const found = classifyPaste(trimmed);
  const oneLine = !trimmed.includes("\n");
  // One line that is not a link: looked for by name first ("Chill - Evening" may be an album too).
  const plain = oneLine && !/https?:\/\//.test(trimmed);
  if (!plain) {
    return pasteSuggestions(found, context).slice(0, MOST);
  }
  const query = trimmed.toLowerCase();
  const playlists = context.playlists
    .filter((playlist) => playlist.name.toLowerCase().includes(query))
    .slice(0, 5)
    .map((playlist): AskSuggestion => ({ label: `Open ${playlist.name}`, hash: routeHash({ kind: "playlist", id: playlist.id }) }));
  const tools = query.length < 2
    ? []
    : DESTINATIONS.flatMap((destination): AskSuggestion[] => {
        const matches = destination.words.some((word) => word.startsWith(query) || (query.length >= 4 && word.includes(query)));
        const route = matches ? destination.route(context) : undefined;
        return route === undefined ? [] : [{ label: destination.label, hash: routeHash(route) }];
      });
  // A word that names a tool is the tool; any other line may be an artist.
  return [...tools, ...playlists, ...(tools.length > 0 ? [] : pasteSuggestions(found, context))].slice(0, MOST);
}
