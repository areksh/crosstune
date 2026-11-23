/**
 * Deduplicator view.
 *
 * Flow: pick a source (a playlist, your favourites, or all your playlists) and
 * a keep strategy (optionally a second one to break ties), scan for duplicate
 * groups, review each group -- the kept copy is green, the rest red -- and
 * change which copy is kept (or mark a group "not a duplicate" to keep all),
 * then apply the removals. Scanning all playlists also lists the songs saved
 * in more than one playlist, kept everywhere until a playlist is unticked. This
 * is DOM glue; the matching, resolving and removal logic lives in the tested
 * server modules.
 */

import type { EntryId, PlaylistId, TrackId } from "../../services/ids.js";
import { api, type Playlist } from "../api.js";
import { el, setStep, showError } from "../dom.js";
import { coverSlot } from "../artwork.js";
import { groupHead, qualityPill, titleOf, trackText } from "../tracks.js";

interface DedupTrack {
  id: TrackId;
  title: string;
  version?: string;
  artist: string;
  album?: string;
  playlistTrackId?: EntryId;
  bitDepth?: number;
  samplingRate?: number;
  releaseDate?: string;
  image?: string;
}

interface ResolvedGroup {
  tracks: DedupTrack[];
  /** The copy kept; absent for a song in several versions, all kept by default. */
  keepId?: TrackId;
}

interface PlaylistRef {
  id: PlaylistId;
  name: string;
}

/** A song saved in more than one playlist (all-playlists scans). */
interface AcrossSong {
  track: DedupTrack;
  playlists: Array<{ playlist: PlaylistRef; tracks: DedupTrack[] }>;
}

/** `/api/deduplicate/scan`: `groups` for one source, the rest for all playlists. */
interface ScanResponse {
  groups?: ResolvedGroup[];
  /** Songs held in several versions (live, acoustic...): not duplicates. */
  versions?: DedupTrack[][];
  within?: Array<{ playlist: PlaylistRef; groups: ResolvedGroup[]; versions?: DedupTrack[][] }>;
  across?: AcrossSong[];
  playlistCount?: number;
}

type Source =
  | { type: "playlist"; playlistId: PlaylistId }
  | { type: "favourites" }
  | { type: "all-playlists" };

interface Removal {
  id: TrackId;
  playlistTrackId?: EntryId;
  playlistId?: PlaylistId;
}

/** Scanned groups, each with its playlist when scanning all playlists. */
let scannedGroups: Array<{ group: ResolvedGroup; playlistId?: PlaylistId }> = [];
let scannedSongs: AcrossSong[] = [];
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
  el("dedup-across-hint").hidden = selectedSourceType() !== "all-playlists";
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
  const type = selectedSourceType();
  if (type === "favourites" || type === "all-playlists") {
    return { type };
  }
  const value = el<HTMLSelectElement>("dedup-playlist-select").value;
  if (value === "") {
    return undefined;
  }
  return { type: "playlist", playlistId: value as PlaylistId };
}

/** The keep strategy, then the tie-breaker when one is chosen. */
function keepChain(): string[] {
  const keep = el<HTMLSelectElement>("dedup-keep").value;
  const then = el<HTMLSelectElement>("dedup-keep-then").value;
  return then === "" || then === keep ? [keep] : [keep, then];
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

  button.disabled = true;
  button.textContent = "Scanning...";
  try {
    const scan = await api<ScanResponse>("POST", "/api/deduplicate/scan", {
      source,
      keep: keepChain(),
      includeVersions: el<HTMLInputElement>("dedup-versions").checked,
    });
    scannedSource = source;
    if (source.type === "all-playlists") {
      scannedGroups = (scan.within ?? []).flatMap(({ playlist, groups, versions }) =>
        [...groups, ...versionGroups(versions)].map((group) => ({ group, playlistId: playlist.id })),
      );
      scannedSongs = scan.across ?? [];
      renderAllPlaylists(scan);
    } else {
      const versions = versionGroups(scan.versions);
      scannedGroups = [...(scan.groups ?? []), ...versions].map((group) => ({ group }));
      scannedSongs = [];
      renderGroups(scan.groups ?? [], versions);
    }
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Scan for duplicates";
  }
}

function versionGroups(versions: DedupTrack[][] | undefined): ResolvedGroup[] {
  return (versions ?? []).map((tracks) => ({ tracks }));
}

/** A section of songs held in several versions, numbered from `firstIndex`. */
function renderVersions(groups: ResolvedGroup[], firstIndex: number): HTMLElement {
  const section = document.createElement("section");
  section.className = "dedup-section";
  section.appendChild(
    groupHead("h3", "Other versions", {
      note: "Live, acoustic, remixed and so on. All kept; untick any you do not want.",
      count: String(groups.length),
    }),
  );
  groups.forEach((group, i) => section.appendChild(renderGroup(group, firstIndex + i)));
  return section;
}

function showReview(hasAnything: boolean): void {
  el("dedup-results").hidden = false;
  el("dedup-bar").hidden = !hasAnything;
  el<HTMLButtonElement>("dedup-apply").hidden = !hasAnything;
  setStep("dedup-steps", 1);
}

function renderGroups(groups: ResolvedGroup[], versions: ResolvedGroup[]): void {
  const summary = el("dedup-summary");
  const container = el("dedup-groups");
  container.textContent = "";
  showReview(groups.length + versions.length > 0);
  el("dedup-bar-note").textContent = "Unticked copies are removed.";

  summary.textContent =
    groups.length === 0
      ? "No duplicates found."
      : `Found ${groups.length} duplicate group${groups.length === 1 ? "" : "s"}. Ticked copies are kept; the rest are removed when you apply.`;
  if (versions.length > 0) {
    summary.textContent += ` ${versions.length} song${versions.length === 1 ? " is" : "s are"} also here in other versions, which are kept.`;
  }

  groups.forEach((group, index) => {
    container.appendChild(renderGroup(group, index));
  });
  if (versions.length > 0) {
    container.appendChild(renderVersions(versions, groups.length));
  }
  updateApplyButton();
}

/**
 * All playlists: the songs in more than one playlist first, then each
 * playlist's own duplicate groups under its name.
 */
function renderAllPlaylists(scan: ScanResponse): void {
  const container = el("dedup-groups");
  container.textContent = "";
  const within = scan.within ?? [];
  const across = scan.across ?? [];
  showReview(across.length > 0 || within.length > 0);
  el("dedup-bar-note").textContent =
    "Unticked copies are removed, and songs from unticked playlists.";

  const groupCount = within.reduce((n, entry) => n + entry.groups.length, 0);
  el("dedup-summary").textContent =
    `Scanned ${scan.playlistCount ?? 0} playlists: ` +
    `${across.length} song${across.length === 1 ? " is" : "s are"} in more than one playlist, ` +
    `and ${groupCount} duplicate group${groupCount === 1 ? "" : "s"} within playlists.`;

  if (across.length > 0) {
    const section = document.createElement("section");
    section.className = "dedup-section";
    section.appendChild(
      groupHead("h3", "In more than one playlist", {
        note: "Kept everywhere; untick a playlist to remove the song from it.",
        count: String(across.length),
      }),
    );
    across.forEach((song, index) => section.appendChild(renderSong(song, index)));
    container.appendChild(section);
  }

  let index = 0;
  for (const { playlist, groups, versions } of within) {
    const section = document.createElement("section");
    section.className = "dedup-section";
    section.appendChild(
      groupHead("h3", playlist.name, {
        note: "Duplicates within this playlist",
        count: String(groups.length),
      }),
    );
    for (const group of groups) {
      section.appendChild(renderGroup(group, index));
      index += 1;
    }
    const others = versionGroups(versions);
    if (others.length > 0) {
      section.appendChild(renderVersions(others, index));
      index += others.length;
    }
    container.appendChild(section);
  }
  updateApplyButton();
}

/** A song across playlists: one ticked row per playlist holding it. */
function renderSong(song: AcrossSong, index: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "dedup-group dedup-song";
  wrapper.dataset["song"] = String(index);
  const title = `${song.track.artist ? `${song.track.artist} - ` : ""}${titleOf(song.track)}`;
  wrapper.appendChild(groupHead("h4", title));

  for (const { playlist, tracks } of song.playlists) {
    const row = document.createElement("label");
    row.className = "track dedup-track";
    row.dataset["playlistId"] = String(playlist.id);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "dedup-keep-box";
    box.checked = true;
    box.addEventListener("change", () => {
      updateGroupStyling(wrapper);
      updateApplyButton();
    });
    row.appendChild(box);
    row.appendChild(coverSlot(tracks[0]?.image ?? song.track.image, song.track.album ?? song.track.title));
    const copies = tracks.length > 1 ? `${tracks.length} copies` : undefined;
    row.appendChild(trackText(playlist.name, [copies, tracks[0]?.album].filter(Boolean).join(", ") || undefined));
    const pill = tracks[0] === undefined ? undefined : qualityPill(tracks[0]);
    if (pill !== undefined) {
      row.appendChild(pill);
    }
    wrapper.appendChild(row);
  }
  updateGroupStyling(wrapper);
  return wrapper;
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
        syncEntry(box);
      }
    }
    updateGroupStyling(wrapper);
    updateApplyButton();
  });
  keepAllLabel.appendChild(keepAll);
  keepAllLabel.appendChild(document.createTextNode(" Keep all"));

  // The same track can sit in a playlist twice: only the first entry with
  // the kept id is the keeper (as the server's plan counts it).
  const keep = group.tracks.findIndex((track) => track.id === group.keepId);
  group.tracks.forEach((track, position) => {
    wrapper.appendChild(
      renderGroupTrack(
        track,
        position,
        group.keepId === undefined || position === keep,
        scannedGroups[index]?.playlistId,
      ),
    );
  });
  if (group.keepId !== undefined) {
    wrapper.appendChild(keepAllLabel);
  }
  updateGroupStyling(wrapper);
  return wrapper;
}

/**
 * A copy can be listed among the duplicates and among the versions: its boxes
 * go together, so it is never shown as both kept and removed.
 */
function syncEntry(box: HTMLInputElement): void {
  const entry = box.closest<HTMLElement>(".dedup-track")?.dataset["entry"];
  if (entry === undefined) {
    return;
  }
  for (const row of document.querySelectorAll<HTMLElement>("#dedup-groups .dedup-track")) {
    const other = row.querySelector<HTMLInputElement>(".dedup-keep-box");
    const group = row.closest<HTMLElement>(".dedup-group");
    if (row.dataset["entry"] !== entry || other === null || other === box || group === null) {
      continue;
    }
    other.checked = box.checked;
    const keepAll = group.querySelector<HTMLInputElement>(".dedup-keep-all");
    if (!box.checked && keepAll !== null && keepAll.checked) {
      keepAll.checked = false;
      group.querySelectorAll<HTMLInputElement>(".dedup-keep-box").forEach((item) => (item.disabled = false));
    }
    updateGroupStyling(group);
  }
}

function renderGroupTrack(track: DedupTrack, position: number, keep: boolean, playlistId?: PlaylistId): HTMLElement {
  const row = document.createElement("label");
  row.className = "track dedup-track";
  row.dataset["entry"] = `${playlistId ?? ""}:${track.playlistTrackId ?? `t${track.id}`}`;
  row.dataset["trackId"] = String(track.id);
  row.dataset["position"] = String(position);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "dedup-keep-box";
  checkbox.checked = keep;
  checkbox.addEventListener("change", () => {
    syncEntry(checkbox);
    updateGroupStyling(row.closest(".dedup-group") as HTMLElement);
    updateApplyButton();
  });
  row.appendChild(checkbox);
  row.appendChild(coverSlot(track.image, track.album ?? track.title));

  row.appendChild(
    trackText(`${track.artist ? `${track.artist} - ` : ""}${titleOf(track)}`, trackMeta(track)),
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

/**
 * Entries to remove: the unticked copies of each group (with their
 * playlist-track ids, and playlist when scanning all playlists), and every copy
 * of a song in a playlist unticked for it.
 */
function collectRemovals(): Removal[] {
  const removals: Removal[] = [];
  document.querySelectorAll<HTMLElement>("#dedup-groups .dedup-group").forEach((wrapper) => {
    const songIndex = wrapper.dataset["song"];
    if (songIndex !== undefined) {
      const song = scannedSongs[Number(songIndex)];
      for (const row of wrapper.querySelectorAll<HTMLElement>(".dedup-track")) {
        const box = row.querySelector<HTMLInputElement>(".dedup-keep-box");
        const playlistId = (row.dataset["playlistId"] as PlaylistId);
        const entry = song?.playlists.find((p) => p.playlist.id === playlistId);
        if (box === null || box.checked || entry === undefined) {
          continue;
        }
        for (const track of entry.tracks) {
          if (track.playlistTrackId !== undefined) {
            removals.push({ id: track.id, playlistId, playlistTrackId: track.playlistTrackId });
          }
        }
      }
      return;
    }
    const scanned = scannedGroups[Number(wrapper.dataset["index"])];
    if (scanned === undefined) {
      return;
    }
    for (const row of wrapper.querySelectorAll<HTMLElement>(".dedup-track")) {
      const box = row.querySelector<HTMLInputElement>(".dedup-keep-box");
      if (box === null || box.checked) {
        continue;
      }
      const id = (row.dataset["trackId"] as TrackId);
      // By position, not id: two entries of the same track share an id.
      const track = scanned.group.tracks[Number(row.dataset["position"])];
      removals.push({
        id,
        ...(track?.playlistTrackId !== undefined && {
          playlistTrackId: track.playlistTrackId,
        }),
        ...(scanned.playlistId !== undefined && { playlistId: scanned.playlistId }),
      });
    }
  });
  // A copy can be both a duplicate and in an unticked playlist: remove it once.
  const seen = new Set<string>();
  return removals.filter((removal) => {
    const key = `${removal.playlistId ?? ""}:${removal.playlistTrackId ?? removal.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
    scannedSongs = [];
    el("dedup-groups").textContent = "";
    el("dedup-summary").textContent = "";
    button.hidden = true;
  } catch (error) {
    showError(errorNode, (error as Error).message);
    button.disabled = false;
    button.textContent = original;
  }
}
