/**
 * Playlist-from-artists view.
 *
 * Drives the resolve -> preview -> commit flow: resolve artist names to their
 * top tracks (minus any the filters exclude, which the server replaces with the
 * next most popular and reports so they are listed unticked), let the user
 * untick or re-tick tracks, choose a destination (a new playlist or an
 * existing one), then commit. This is DOM glue; the logic it drives lives
 * in the tested server modules.
 */

import { api, type ExcludedTrack, type Playlist, type Track } from "../api.js";
import { el, showError } from "../dom.js";
import { inRankOrder, readTerms, trackRow } from "../tracks.js";

interface Artist {
  id: number;
  name: string;
}

interface ResolvedArtist {
  query: string;
  artist: Artist;
  tracks: Track[];
  excluded: ExcludedTrack[];
}

interface UnderfilledArtist {
  query: string;
  artist: Artist;
  trackCount: number;
  requested: number;
}

interface ResolveResponse {
  resolvedArtists: ResolvedArtist[];
  unresolvedArtists: string[];
  emptyArtists: UnderfilledArtist[];
  partialArtists: UnderfilledArtist[];
}

type CommitTarget =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: number };

let playlistsLoaded = false;

/** Wire up the playlist view. Call once on load. */
export function initPlaylistView(): void {
  el("resolve").addEventListener("click", () => void onResolve());
  el("commit").addEventListener("click", () => void onCommit());
  for (const radio of document.querySelectorAll('input[name="target"]')) {
    radio.addEventListener("change", onTargetChange);
  }
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("resolve");
  const errorNode = el("resolve-error");
  showError(errorNode, undefined);

  const artists = el<HTMLTextAreaElement>("artists")
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (artists.length === 0) {
    showError(errorNode, "Enter at least one artist.");
    return;
  }
  const tracksPerArtist = Number(el<HTMLInputElement>("per-artist").value);

  button.disabled = true;
  button.textContent = "Loading...";
  try {
    const result = await api<ResolveResponse>("POST", "/api/resolve", {
      artists,
      tracksPerArtist,
      filter: {
        excludeTracks: readTerms("exclude-tracks"),
        excludeAlbums: readTerms("exclude-albums"),
      },
    });
    renderPreview(result);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Preview tracks";
  }
}

function renderPreview(result: ResolveResponse): void {
  const unresolvedNode = el("unresolved");
  if (result.unresolvedArtists.length > 0) {
    unresolvedNode.hidden = false;
    unresolvedNode.textContent = `Could not find: ${result.unresolvedArtists.join(", ")}`;
  } else {
    unresolvedNode.hidden = true;
  }

  const emptyNode = el("empty-artists");
  if (result.emptyArtists.length > 0) {
    emptyNode.hidden = false;
    emptyNode.textContent = `No tracks found (skipped): ${result.emptyArtists
      .map(artistLabel)
      .join(", ")}`;
  } else {
    emptyNode.hidden = true;
  }

  const partialNode = el("partial-artists");
  if (result.partialArtists.length > 0) {
    partialNode.hidden = false;
    partialNode.textContent = `Fewer tracks than requested: ${result.partialArtists
      .map((a) => `${artistLabel(a)} (${a.trackCount} of ${a.requested})`)
      .join(", ")}`;
  } else {
    partialNode.hidden = true;
  }

  const groups = el("artist-groups");
  groups.textContent = "";
  for (const resolvedArtist of result.resolvedArtists) {
    groups.appendChild(renderArtistGroup(resolvedArtist));
  }

  el("preview").hidden = false;
  showError(el("commit-error"), undefined);
  showError(el("commit-result"), undefined);
  updateSelectedCount();
}

/** The artist's name, noting the typed query when it differs from the match. */
function artistLabel(a: { artist: Artist; query: string }): string {
  if (a.artist.name.toLowerCase() === a.query.toLowerCase()) {
    return a.artist.name;
  }
  return `${a.artist.name} (matched "${a.query}")`;
}

function renderArtistGroup(resolvedArtist: ResolvedArtist): HTMLElement {
  const group = document.createElement("div");
  group.className = "artist-group";

  const heading = document.createElement("h4");
  heading.textContent = resolvedArtist.artist.name;
  if (
    resolvedArtist.artist.name.toLowerCase() !==
    resolvedArtist.query.toLowerCase()
  ) {
    const matched = document.createElement("span");
    matched.className = "matched";
    matched.textContent = ` (matched "${resolvedArtist.query}")`;
    heading.appendChild(matched);
  }
  group.appendChild(heading);

  // In popularity order, the excluded tracks unticked where they ranked.
  for (const { track, exclusion } of inRankOrder(resolvedArtist.tracks, resolvedArtist.excluded)) {
    group.appendChild(
      trackRow(track, { ...rowOptions(track), ...(exclusion !== undefined && { exclusion }) }),
    );
  }
  return group;
}

function rowOptions(track: Track): { meta?: string; onChange: () => void } {
  return {
    ...(track.album !== undefined && { meta: track.album }),
    onChange: updateSelectedCount,
  };
}

/** The unique, ticked track ids in display order. */
function selectedTrackIds(): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const boxes = document.querySelectorAll<HTMLInputElement>(
    "#artist-groups input[type=checkbox]:checked",
  );
  boxes.forEach((box) => {
    const id = Number(box.dataset["trackId"]);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

function updateSelectedCount(): void {
  const count = selectedTrackIds().length;
  el("selected-count").textContent = `${count} track${count === 1 ? "" : "s"} selected.`;
  el<HTMLButtonElement>("commit").disabled = count === 0;
}

function onTargetChange(): void {
  const target = selectedTarget();
  el("new-fields").hidden = target !== "new";
  el("existing-fields").hidden = target !== "existing";
  el<HTMLButtonElement>("commit").textContent =
    target === "new" ? "Create playlist" : "Add to playlist";
  if (target === "existing") {
    void loadPlaylists();
  }
}

function selectedTarget(): string {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="target"]:checked',
  );
  return checked?.value ?? "new";
}

async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>("playlist-select");
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>(
      "GET",
      "/api/playlists",
    );
    select.textContent = "";
    if (playlists.length === 0) {
      select.appendChild(new Option("You have no playlists", ""));
      return;
    }
    for (const playlist of playlists) {
      const label =
        playlist.trackCount === undefined
          ? playlist.name
          : `${playlist.name} (${playlist.trackCount} tracks)`;
      select.appendChild(new Option(label, String(playlist.id)));
    }
    playlistsLoaded = true;
  } catch (error) {
    select.textContent = "";
    select.appendChild(new Option("Could not load playlists", ""));
    showError(el("commit-error"), (error as Error).message);
  }
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit");
  const errorNode = el("commit-error");
  const resultNode = el("commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const trackIds = selectedTrackIds();
  if (trackIds.length === 0) {
    showError(errorNode, "Select at least one track.");
    return;
  }

  const target = buildTarget();
  if (target === undefined) {
    showError(errorNode, "Choose a destination.");
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Working...";
  try {
    const result = await api<{
      playlist?: Playlist;
      added: number[];
      skipped: number[];
    }>("POST", "/api/commit", { target, trackIds });
    showResult(resultNode, target, result);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function buildTarget(): CommitTarget | undefined {
  if (selectedTarget() === "new") {
    const name = el<HTMLInputElement>("playlist-name").value.trim();
    if (name.length === 0) {
      return undefined;
    }
    return {
      type: "new",
      name,
      isPublic: el<HTMLInputElement>("playlist-public").checked,
    };
  }
  const value = el<HTMLSelectElement>("playlist-select").value;
  if (value === "") {
    return undefined;
  }
  return { type: "existing", playlistId: Number(value) };
}

function showResult(
  node: HTMLElement,
  target: CommitTarget,
  result: { playlist?: Playlist; added: number[]; skipped: number[] },
): void {
  node.hidden = false;
  if (target.type === "new") {
    node.textContent = `Created "${result.playlist?.name ?? target.name}" with ${result.added.length} tracks.`;
  } else {
    const skipped =
      result.skipped.length > 0
        ? ` (${result.skipped.length} already present, skipped)`
        : "";
    node.textContent = `Added ${result.added.length} tracks to the playlist${skipped}.`;
  }
}
