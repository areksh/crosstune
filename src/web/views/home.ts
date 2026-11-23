/**
 * Home view: the paste box.
 *
 * As the user pastes links or a list, the (tested, pure) classifier sorts the
 * lines into artist, album, playlist and track links, "Artist - Album" lines
 * and plain names; the view says what it found and offers a button for each
 * tool that fits. A button stores the input for that tool (see ../prefill.ts)
 * and opens it. Nothing is sent to the server until the tool runs.
 */

import { classifyPaste, type PasteSummary } from "../../features/music-links.js";
import { el } from "../dom.js";
import { storePrefill, type Prefill } from "../prefill.js";
import { routeHash } from "../../ui/routes.js";

interface Suggestion {
  label: string;
  /** Where the tool opens. */
  hash: string;
  /** What to fill in it, when the address does not say. */
  prefill?: Prefill;
  /** The main suggestion is drawn as the primary button. */
  primary?: boolean;
}

/** Wire up the home view. Call once on load. */
export function initHomeView(): void {
  const paste = el<HTMLTextAreaElement>("home-paste");
  paste.addEventListener("input", () => render(classifyPaste(paste.value)));
  render(classifyPaste(paste.value));
}

function render(found: PasteSummary): void {
  el("home-found").textContent = found.summary;
  const tools = el("home-tools");
  tools.textContent = "";
  for (const suggestion of suggestionsFor(found)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = suggestion.label;
    if (suggestion.primary !== true) {
      button.className = "secondary";
    }
    button.addEventListener("click", () => {
      if (suggestion.prefill !== undefined) {
        storePrefill(suggestion.prefill);
      }
      location.hash = suggestion.hash;
    });
    tools.appendChild(button);
  }

  const notes: string[] = [];
  if (found.playlists.length > 0) {
    notes.push(
      "Upgrade & repair, Library stats and the Deduplicator open on the playlist when it is one of yours.",
    );
  }
  if (found.playlists.length > 1) {
    notes.push("Only the first playlist link is used.");
  }
  if (found.tracks.length > 0 || found.other.length > 0) {
    notes.push("Track and label links are not used by a tool yet.");
  }
  const note = el("home-note");
  note.hidden = notes.length === 0;
  note.textContent = notes.join(" ");
}

/** The tools that fit what was pasted, the likeliest first. */
function suggestionsFor(found: PasteSummary): Suggestion[] {
  const suggestions: Suggestion[] = [];
  if (found.artists.length > 0) {
    const artists = found.artists.join("\n");
    suggestions.push(
      {
        label: "Build a playlist from these artists",
        hash: routeHash({ kind: "new", tool: "artists" }),
        prefill: { view: "playlist", fields: { artists } },
        primary: true,
      },
      {
        label: "Find similar artists",
        hash: routeHash({ kind: "new", tool: "similar" }),
        prefill: {
          view: "similar",
          radios: { "similar-source": "artists" },
          fields: { "similar-artists": artists },
        },
      },
    );
  }
  if (found.albums.length > 0) {
    suggestions.push({
      label: "Build a playlist from these albums",
      hash: routeHash({ kind: "new", tool: "albums" }),
      prefill: {
        view: "albums",
        radios: { "album-source": "list" },
        fields: { albums: found.albums.join("\n") },
      },
      primary: found.artists.length === 0,
    });
  }
  const playlist = found.playlists[0];
  if (playlist !== undefined) {
    const id = String(playlist.id);
    suggestions.push(
      {
        label: "Similar artists from this playlist",
        hash: routeHash({ kind: "new", tool: "similar" }),
        prefill: {
          view: "similar",
          radios: { "similar-source": "playlist" },
          fields: { "similar-source-link": playlist.line },
        },
        primary: suggestions.length === 0,
      },
      // Any playlist can be read; these three open on it as one of the user's.
      { label: "Upgrade & repair", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "upgrade" }) },
      { label: "Library stats", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "stats" }) },
      { label: "Find duplicates", hash: routeHash({ kind: "playlist", id: playlist.id, tool: "repeats" }) },
    );
  }
  return suggestions;
}
