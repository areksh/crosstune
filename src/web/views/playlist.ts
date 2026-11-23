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

import type { ArtistId, PlaylistId, TrackId } from "../../services/ids.js";
import { api, type ExcludedTrack, type Playlist, type Track } from "../api.js";
import { el, setStep, showError } from "../dom.js";
import { PlanControls } from "../plan.js";
import { Destination } from "../transfer.js";
import { parseMusicLink } from "../../features/music-links.js";
import {
  groupHead,
  inRankOrder,
  readTerms,
  trackCountLabel,
  trackRow,
  trackSubline,
} from "../tracks.js";

interface Artist {
  id: ArtistId;
  name: string;
}

interface ResolvedArtist {
  query: string;
  artist: Artist;
  /** The line was an artist link. */
  fromLink?: boolean;
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
  | { type: "existing"; playlistId: PlaylistId };

let controls: PlanControls;
let destination: Destination;
/** The listed tracks, to send to another service. */
let listed = new Map<TrackId, Track>();

/** Wire up the playlist view. Call once on load. */
export function initPlaylistView(): void {
  controls = new PlanControls({
    prefix: "playlist",
    countId: "selected-count",
    groups: () =>
      [...document.querySelectorAll<HTMLElement>("#artist-groups .artist-group")].map((group) => [
        ...group.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
      ]),
    fit: "fair",
    onUpdate: () => {
      el<HTMLButtonElement>("commit").disabled = controls.count() === 0;
    },
  });
  destination = new Destination({ field: "playlist-on-field", playlists: "playlist-select", onChange: onTargetChange });
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
      skipFavourites: el<HTMLInputElement>("skip-favourites").checked,
      oneCopy: el<HTMLInputElement>("one-copy").checked,
      filter: {
        excludeTracks: readTerms("exclude-tracks"),
        excludeAlbums: readTerms("exclude-albums"),
        excludeArtists: readTerms("exclude-artists"),
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

  listed = new Map(
    result.resolvedArtists.flatMap((a) => [...a.tracks, ...a.excluded.map((e) => e.track)].map((t) => [t.id, t])),
  );
  destination.show();
  el("preview").hidden = false;
  setStep("playlist-steps", 1);
  showError(el("commit-error"), undefined);
  showError(el("commit-result"), undefined);
  controls.reset();
}

/** The artist's name, noting the typed query when it differs from the match. */
function artistLabel(a: { artist: Artist; query: string }): string {
  if (a.artist.name.toLowerCase() === a.query.toLowerCase() || isLink(a.query)) {
    return a.artist.name;
  }
  return `${a.artist.name} (matched "${a.query}")`;
}

function renderArtistGroup(resolvedArtist: ResolvedArtist): HTMLElement {
  const group = document.createElement("div");
  group.className = "artist-group";

  const renamed =
    resolvedArtist.artist.name.toLowerCase() !== resolvedArtist.query.toLowerCase();
  const note =
    resolvedArtist.fromLink === true
      ? "from a link"
      : renamed
        ? `matched "${resolvedArtist.query}"`
        : undefined;
  group.appendChild(
    groupHead("h3", resolvedArtist.artist.name, {
      ...(note !== undefined && { note }),
      count: trackCountLabel(resolvedArtist),
    }),
  );

  // In popularity order, the excluded tracks unticked where they ranked.
  for (const { track, exclusion } of inRankOrder(resolvedArtist.tracks, resolvedArtist.excluded)) {
    group.appendChild(
      trackRow(track, { ...rowOptions(track), ...(exclusion !== undefined && { exclusion }) }),
    );
  }
  return group;
}

function rowOptions(track: Track): { meta?: string; onChange: () => void } {
  const meta = trackSubline(track);
  return { ...(meta !== undefined && { meta }), onChange: updateSelectedCount };
}

function updateSelectedCount(): void {
  controls.refresh();
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
  try {
    await destination.loadPlaylists();
  } catch (error) {
    showError(el("commit-error"), (error as Error).message);
  }
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit");
  const errorNode = el("commit-error");
  const resultNode = el("commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  // The ticked tracks, each once, in the chosen play order.
  const trackIds = controls.orderedTrackIds();
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
    const across = destination.across;
    if (across !== undefined) {
      const text = await destination.commitAcross(across, trackIds.flatMap((id) => listed.get(id) ?? []), target);
      if (text !== undefined) {
        showError(resultNode, text);
        setStep("playlist-steps", 3);
      }
      return;
    }
    const result = await api<{
      playlist?: Playlist;
      added: TrackId[];
      skipped: TrackId[];
    }>("POST", "/api/commit", { tool: "playlist-from-artists", target, trackIds });
    showResult(resultNode, target, result);
    setStep("playlist-steps", 3);
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
  return { type: "existing", playlistId: value as PlaylistId };
}

function showResult(
  node: HTMLElement,
  target: CommitTarget,
  result: { playlist?: Playlist; added: TrackId[]; skipped: TrackId[] },
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

/** True when a typed line is a link (shown by name, not as typed). */
function isLink(query: string): boolean {
  return parseMusicLink(query) !== undefined;
}
