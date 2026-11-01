/**
 * Deduplicator view.
 *
 * Flow: pick a source (a playlist or your favourites) and a keep strategy, scan
 * for duplicate groups, review each group -- the kept copy is green, the rest
 * red -- and change which copy is kept (or mark a group "not a duplicate" to
 * keep all), then apply the removals. This is DOM glue; the matching, resolving
 * and removal logic lives in the tested server modules.
 */

import { api, type Playlist } from "../api.js";
import { el, setStep, showError } from "../dom.js";
import { qualityPill, trackText } from "../tracks.js";

interface DedupTrack {
  id: number;
  title: string;
  artist: string;
  album?: string;
  playlistTrackId?: number;
  bitDepth?: number;
  samplingRate?: number;
  releaseDate?: string;
}

interface ResolvedGroup {
  tracks: DedupTrack[];
  keepId: number;
}

interface ScanResponse {
  groups: ResolvedGroup[];
}

type Source =
  | { type: "playlist"; playlistId: number }
  | { type: "favourites" };

let scannedGroups: ResolvedGroup[] = [];
let scannedSource: Source | undefined;
let playlistsLoaded = false;

/** Wire up the deduplicator view. Call once on load. */
export function initDeduplicateView(): void {
  el("dedup-scan").addEventListener("click", () => void onScan());
  el("dedup-apply").addEventListener("click", () => void onApply());
  for (const radio of document.querySelectorAll('input[name="dedup-source"]')) {
    radio.addEventListener("change", onSourceChange);
  }
}

function selectedSourceType(): string {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="dedup-source"]:checked',
  );
  return checked?.value ?? "favourites";
}

function onSourceChange(): void {
  const isPlaylist = selectedSourceType() === "playlist";
  el("dedup-playlist-fields").hidden = !isPlaylist;
  if (isPlaylist) {
    void loadPlaylists();
  }
}

async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>("dedup-playlist-select");
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
    showError(el("dedup-scan-error"), (error as Error).message);
  }
}

function currentSource(): Source | undefined {
  if (selectedSourceType() === "favourites") {
    return { type: "favourites" };
  }
  const value = el<HTMLSelectElement>("dedup-playlist-select").value;
  if (value === "") {
    return undefined;
  }
  return { type: "playlist", playlistId: Number(value) };
}

async function onScan(): Promise<void> {
  const button = el<HTMLButtonElement>("dedup-scan");
  const errorNode = el("dedup-scan-error");
  showError(errorNode, undefined);
  showError(el("dedup-apply-result"), undefined);

  const source = currentSource();
  if (source === undefined) {
    showError(errorNode, "Choose a playlist to scan.");
    return;
  }
  const keep = el<HTMLSelectElement>("dedup-keep").value;

  button.disabled = true;
  button.textContent = "Scanning...";
  try {
    const { groups } = await api<ScanResponse>("POST", "/api/deduplicate/scan", {
      source,
      keep,
    });
    scannedGroups = groups;
    scannedSource = source;
    renderGroups(groups);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Scan for duplicates";
  }
}

function renderGroups(groups: ResolvedGroup[]): void {
  const summary = el("dedup-summary");
  const container = el("dedup-groups");
  container.textContent = "";
  el("dedup-results").hidden = false;
  el("dedup-bar").hidden = groups.length === 0;
  setStep("dedup-steps", 1);

  if (groups.length === 0) {
    summary.textContent = "No duplicates found.";
    el<HTMLButtonElement>("dedup-apply").hidden = true;
    return;
  }

  summary.textContent = `Found ${groups.length} duplicate group${groups.length === 1 ? "" : "s"}. Ticked copies are kept; the rest are removed when you apply.`;

  groups.forEach((group, index) => {
    container.appendChild(renderGroup(group, index));
  });
  el<HTMLButtonElement>("dedup-apply").hidden = false;
  updateApplyButton();
}

function renderGroup(group: ResolvedGroup, index: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "dedup-group";
  wrapper.dataset["index"] = String(index);

  const keepAllLabel = document.createElement("label");
  keepAllLabel.className = "keep-all";
  const keepAll = document.createElement("input");
  keepAll.type = "checkbox";
  keepAll.className = "dedup-keep-all";
  keepAll.addEventListener("change", () => {
    for (const box of wrapper.querySelectorAll<HTMLInputElement>(
      ".dedup-keep-box",
    )) {
      box.disabled = keepAll.checked;
      if (keepAll.checked) {
        box.checked = true;
      }
    }
    updateGroupStyling(wrapper);
    updateApplyButton();
  });
  keepAllLabel.appendChild(keepAll);
  keepAllLabel.appendChild(document.createTextNode(" Keep all"));

  for (const track of group.tracks) {
    wrapper.appendChild(renderGroupTrack(track, group.keepId));
  }
  wrapper.appendChild(keepAllLabel);
  updateGroupStyling(wrapper);
  return wrapper;
}

function renderGroupTrack(track: DedupTrack, keepId: number): HTMLElement {
  const row = document.createElement("label");
  row.className = "track dedup-track";
  row.dataset["trackId"] = String(track.id);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "dedup-keep-box";
  checkbox.checked = track.id === keepId;
  checkbox.addEventListener("change", () => {
    updateGroupStyling(row.closest(".dedup-group") as HTMLElement);
    updateApplyButton();
  });
  row.appendChild(checkbox);

  row.appendChild(
    trackText(`${track.artist ? `${track.artist} - ` : ""}${track.title}`, trackMeta(track)),
  );
  const pill = qualityPill(track);
  if (pill !== undefined) {
    row.appendChild(pill);
  }
  return row;
}

/** The copy's album and release date, which tell the copies apart. */
function trackMeta(track: DedupTrack): string | undefined {
  const parts = [track.album, track.releaseDate].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Mark each track row keep/drop from its checkbox (green when kept, red when not). */
function updateGroupStyling(wrapper: HTMLElement): void {
  for (const row of wrapper.querySelectorAll<HTMLElement>(".dedup-track")) {
    const box = row.querySelector<HTMLInputElement>(".dedup-keep-box");
    const kept = box?.checked ?? false;
    row.classList.toggle("keep", kept);
    row.classList.toggle("drop", !kept);
  }
}

/** Track ids to remove (the unticked copies), with their playlist-track ids. */
function collectRemovals(): Array<{ id: number; playlistTrackId?: number }> {
  const removals: Array<{ id: number; playlistTrackId?: number }> = [];
  document.querySelectorAll<HTMLElement>(".dedup-group").forEach((wrapper) => {
    const index = Number(wrapper.dataset["index"]);
    const group = scannedGroups[index];
    if (group === undefined) {
      return;
    }
    for (const row of wrapper.querySelectorAll<HTMLElement>(".dedup-track")) {
      const box = row.querySelector<HTMLInputElement>(".dedup-keep-box");
      if (box === null || box.checked) {
        continue;
      }
      const id = Number(row.dataset["trackId"]);
      const track = group.tracks.find((t) => t.id === id);
      removals.push({
        id,
        ...(track?.playlistTrackId !== undefined && {
          playlistTrackId: track.playlistTrackId,
        }),
      });
    }
  });
  return removals;
}

function updateApplyButton(): void {
  const count = collectRemovals().length;
  const button = el<HTMLButtonElement>("dedup-apply");
  button.disabled = count === 0;
  button.textContent =
    count === 0
      ? "Nothing to remove"
      : `Remove ${count} track${count === 1 ? "" : "s"}`;
}

async function onApply(): Promise<void> {
  const button = el<HTMLButtonElement>("dedup-apply");
  const errorNode = el("dedup-apply-error");
  const resultNode = el("dedup-apply-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  if (scannedSource === undefined) {
    return;
  }
  const removals = collectRemovals();
  if (removals.length === 0) {
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Removing...";
  try {
    const result = await api<{ removed: number }>(
      "POST",
      "/api/deduplicate/apply",
      { source: scannedSource, removals },
    );
    resultNode.hidden = false;
    resultNode.textContent = `Removed ${result.removed} track${result.removed === 1 ? "" : "s"}. Re-scan to confirm.`;
    setStep("dedup-steps", 3);
    // The scan is now stale; make the user re-scan before applying again.
    scannedGroups = [];
    el("dedup-groups").textContent = "";
    el("dedup-summary").textContent = "";
    button.hidden = true;
  } catch (error) {
    showError(errorNode, (error as Error).message);
    button.disabled = false;
    button.textContent = original;
  }
}
