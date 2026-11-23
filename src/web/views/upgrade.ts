/**
 * Upgrade & repair view.
 *
 * Flow: pick a source (favourites, a playlist, or all playlists), check it, and
 * review two lists -- tracks with a better-quality release of the same
 * recording (tick to swap, pick among candidates) and tracks Qobuz no longer
 * plays (replace, remove or leave each) -- then apply. This is DOM glue; the
 * matching, planning and writing live in src/features/upgrade.ts.
 */

import type { EntryId, PlaylistId, TrackId } from "../../services/ids.js";
import { api, type Playlist, type Track } from "../api.js";
import { coverSlot } from "../artwork.js";
import { el, setStep, showError } from "../dom.js";
import { qualityPill, titleOf, trackText } from "../tracks.js";

type Source =
  | { type: "favourites" }
  | { type: "playlist"; playlistId: PlaylistId }
  | { type: "all-playlists" };

type Location =
  | { type: "favourites" }
  | { type: "playlist"; playlistId: PlaylistId; playlistName?: string; playlistTrackId: EntryId };

interface Candidate {
  track: Track;
  match: "isrc" | "signature";
}

interface Item {
  kind: "upgrade" | "unplayable";
  track: Track;
  location: Location;
  candidates: Candidate[];
  action: "replace" | "remove" | "leave";
  replacementId?: TrackId;
}

interface Plan {
  items: Item[];
  scanned: number;
  skippedNoIsrc: number;
  skippedUnknownQuality: number;
  unchecked: number;
  failed: number;
}

type Change =
  | { action: "replace"; location: Location; trackId: TrackId; newTrackId: TrackId }
  | { action: "remove"; location: Location; trackId: TrackId };

interface CommitResult {
  replaced: number;
  removed: number;
  failed: Array<{ change: Change; reason: string }>;
  movedToEnd: number;
}

/** The current plan's items; each row edits its item's action in place. */
let items: Item[] = [];
let playlistsLoaded = false;

/** Wire up the upgrade view. Call once on load. */
export function initUpgradeView(): void {
  el("upgrade-check").addEventListener("click", () => void onCheck());
  el("upgrade-apply").addEventListener("click", () => void onApply());
  const loadWhenShown = (): void => {
    if (location.hash.replace(/^#\/?/, "") === "upgrade") {
      void loadPlaylists();
    }
  };
  window.addEventListener("hashchange", loadWhenShown);
  loadWhenShown();
}

/** Fill the source select's playlist group (once). */
async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  playlistsLoaded = true;
  const group = el("upgrade-playlists");
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    group.textContent = "";
    for (const playlist of playlists) {
      const label =
        playlist.trackCount === undefined
          ? playlist.name
          : `${playlist.name} (${playlist.trackCount} tracks)`;
      group.appendChild(new Option(label, `playlist:${playlist.id}`));
    }
  } catch (error) {
    playlistsLoaded = false;
    showError(el("upgrade-check-error"), `Could not load playlists: ${(error as Error).message}`);
  }
}

function currentSource(): Source {
  const value = el<HTMLSelectElement>("upgrade-source").value;
  if (value.startsWith("playlist:")) {
    return { type: "playlist", playlistId: value.slice("playlist:".length) as PlaylistId };
  }
  return value === "all-playlists" ? { type: "all-playlists" } : { type: "favourites" };
}

async function onCheck(): Promise<void> {
  const button = el<HTMLButtonElement>("upgrade-check");
  const errorNode = el("upgrade-check-error");
  showError(errorNode, undefined);
  showError(el("upgrade-apply-error"), undefined);
  showError(el("upgrade-apply-result"), undefined);

  button.disabled = true;
  button.textContent = "Checking...";
  try {
    const plan = await api<Plan>("POST", "/api/upgrade/resolve", {
      source: currentSource(),
      allowSignatureMatch: !el<HTMLInputElement>("upgrade-same-recording").checked,
      removeUnplayable: el<HTMLInputElement>("upgrade-remove-unplayable").checked,
    });
    items = plan.items;
    render(plan);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Check";
  }
}

function render(plan: Plan): void {
  el("upgrade-results").hidden = false;
  setStep("upgrade-steps", 1);

  const upgrades = items.filter((item) => item.kind === "upgrade");
  const broken = items.filter((item) => item.kind === "unplayable");
  el("upgrade-count").textContent = String(upgrades.length);
  el("upgrade-broken-count").textContent = String(broken.length);

  const upgradeList = el("upgrade-list");
  upgradeList.textContent = "";
  for (const item of upgrades) {
    upgradeList.appendChild(upgradeRow(item));
  }
  if (upgrades.length === 0) {
    upgradeList.appendChild(emptyNote("No better-quality releases found."));
  }
  const brokenList = el("upgrade-broken-list");
  brokenList.textContent = "";
  for (const item of broken) {
    brokenList.appendChild(brokenRow(item));
  }
  if (broken.length === 0) {
    brokenList.appendChild(emptyNote("Every track is playable."));
  }

  el("upgrade-summary").textContent = summaryOf(plan);
  el("upgrade-bar").hidden = items.length === 0;
  el<HTMLButtonElement>("upgrade-apply").hidden = false;
  updateBar();
}

/** What was checked, and what was skipped and why. */
function summaryOf(plan: Plan): string {
  const parts = [`Checked ${plan.scanned} track${plan.scanned === 1 ? "" : "s"}.`];
  const skipped: string[] = [];
  if (plan.skippedNoIsrc > 0) skipped.push(`${plan.skippedNoIsrc} without an ISRC`);
  if (plan.skippedUnknownQuality > 0) skipped.push(`${plan.skippedUnknownQuality} of unknown quality`);
  if (plan.unchecked > 0) skipped.push(`${plan.unchecked} not checked (search limit reached)`);
  if (plan.failed > 0) skipped.push(`${plan.failed} whose search failed`);
  if (skipped.length > 0) {
    parts.push(`Skipped ${skipped.join(", ")}.`);
  }
  return parts.join(" ");
}

function emptyNote(text: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = text;
  return note;
}

/** "Artist, Album, in Playlist", plus a flag for a signature-only match. */
function subline(track: Track, location: Location): string {
  const parts = [track.artist, track.album];
  if (location.type === "playlist" && location.playlistName !== undefined) {
    parts.push(`in ${location.playlistName}`);
  }
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(", ");
}

/**
 * "24/96 Blue Lines (2012)" for a candidate; `flagged` adds a short note for a
 * signature-only match (unplayable rows say it in their note instead).
 */
function candidateLabel(candidate: Candidate, flagged: boolean): string {
  const { track } = candidate;
  const quality =
    track.bitDepth === undefined ? "" : `${track.bitDepth}/${track.samplingRate ?? "?"} `;
  const year = track.releaseDate === undefined ? "" : ` (${track.releaseDate.slice(0, 4)})`;
  const flag = flagged && candidate.match === "signature" ? " (maybe another recording)" : "";
  return `${quality}${track.album ?? titleOf(track)}${year}${flag}`;
}

function chosen(item: Item): Candidate | undefined {
  return item.candidates.find((c) => c.track.id === item.replacementId) ?? item.candidates[0];
}

/** A better-quality row: tick to swap, old pill -> new pill, candidate picker. */
function upgradeRow(item: Item): HTMLElement {
  const row = document.createElement("label");
  row.className = "track upgrade-row";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = item.action === "replace";
  box.addEventListener("change", () => {
    item.action = box.checked ? "replace" : "leave";
    row.classList.toggle("upgrade-off", !box.checked);
    updateBar();
  });
  row.appendChild(box);
  row.appendChild(coverSlot(item.track.image));
  const text = trackText(titleOf(item.track), subline(item.track, item.location));
  const note = document.createElement("span");
  note.className = "match-note";
  text.appendChild(note);
  row.appendChild(text);

  const pills = document.createElement("span");
  pills.className = "upgrade-pills";
  row.appendChild(pills);
  const showChoice = (): void => {
    const candidate = chosen(item);
    pills.textContent = "";
    const from = qualityPill(item.track);
    if (from !== undefined) pills.appendChild(from);
    pills.appendChild(arrow());
    const to = candidate === undefined ? undefined : qualityPill(candidate.track);
    if (to !== undefined) pills.appendChild(to);
    note.textContent =
      candidate?.match === "signature" ? "Same song, maybe a different recording." : "";
    note.hidden = note.textContent === "";
  };
  showChoice();

  if (item.candidates.length > 1) {
    const select = document.createElement("select");
    select.className = "upgrade-choice";
    select.setAttribute("aria-label", `Which release replaces ${item.track.title}`);
    for (const candidate of item.candidates) {
      select.appendChild(new Option(candidateLabel(candidate, true), String(candidate.track.id)));
    }
    select.value = String(item.replacementId ?? item.candidates[0]!.track.id);
    select.addEventListener("change", () => {
      item.replacementId = select.value as TrackId;
      showChoice();
    });
    row.appendChild(select);
  }
  return row;
}

/** A small right arrow between the old and new quality pills. */
function arrow(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M5 12h14M13 6l6 6-6 6");
  svg.appendChild(path);
  return svg;
}

/** An unplayable row: what was found, and a replace/remove/leave select. */
function brokenRow(item: Item): HTMLElement {
  const row = document.createElement("div");
  row.className = "track upgrade-broken";

  const icon = document.createElement("span");
  icon.className = "cover broken-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⊘"; // circled slash
  row.appendChild(icon);

  const best = item.candidates[0];
  const text = trackText(titleOf(item.track), subline(item.track, item.location));
  const note = document.createElement("span");
  note.className = best === undefined ? "match-note" : "meta";
  note.textContent =
    best === undefined
      ? "No other release found."
      : best.match === "isrc"
        ? "The same recording is on another release."
        : "Only the same song was found, maybe a different recording.";
  text.appendChild(note);
  row.appendChild(text);

  const select = document.createElement("select");
  select.setAttribute("aria-label", `What to do with ${item.track.title}`);
  for (const candidate of item.candidates) {
    select.appendChild(
      new Option(`Replace with ${candidateLabel(candidate, false)}`, `replace:${candidate.track.id}`),
    );
  }
  select.appendChild(new Option("Remove it", "remove"));
  select.appendChild(new Option("Leave it", "leave"));
  select.value =
    item.action === "replace" && item.replacementId !== undefined
      ? `replace:${item.replacementId}`
      : item.action;
  select.addEventListener("change", () => {
    if (select.value.startsWith("replace:")) {
      item.action = "replace";
      item.replacementId = select.value.slice("replace:".length) as TrackId;
    } else {
      item.action = select.value === "remove" ? "remove" : "leave";
    }
    updateBar();
  });
  row.appendChild(select);
  return row;
}

/** The changes the review asks for (mirrors planChanges on the server). */
function collectChanges(): Change[] {
  const changes: Change[] = [];
  for (const item of items) {
    if (item.action === "remove") {
      changes.push({ action: "remove", location: item.location, trackId: item.track.id });
    } else if (item.action === "replace") {
      const candidate = chosen(item);
      if (candidate !== undefined) {
        changes.push({
          action: "replace",
          location: item.location,
          trackId: item.track.id,
          newTrackId: candidate.track.id,
        });
      }
    }
  }
  return changes;
}

function updateBar(): void {
  const upgrades = items.filter((i) => i.kind === "upgrade" && i.action === "replace").length;
  const replaces = items.filter((i) => i.kind === "unplayable" && i.action === "replace").length;
  const removes = items.filter((i) => i.action === "remove").length;
  const total = upgrades + replaces + removes;
  el("upgrade-commit-count").textContent =
    `Upgrade ${upgrades}, replace ${replaces}, remove ${removes}`;
  const button = el<HTMLButtonElement>("upgrade-apply");
  button.disabled = total === 0;
  button.textContent =
    total === 0 ? "Nothing to change" : `Apply ${total} change${total === 1 ? "" : "s"}`;
}

async function onApply(): Promise<void> {
  const button = el<HTMLButtonElement>("upgrade-apply");
  const errorNode = el("upgrade-apply-error");
  const resultNode = el("upgrade-apply-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);
  const changes = collectChanges();
  if (changes.length === 0) {
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Applying...";
  try {
    const result = await api<CommitResult>("POST", "/api/upgrade/commit", { changes });
    const lines = [`Replaced ${result.replaced}, removed ${result.removed}.`];
    if (result.movedToEnd > 0) {
      lines.push(
        `${result.movedToEnd} replacement${result.movedToEnd === 1 ? "" : "s"} could not be moved into place and ${result.movedToEnd === 1 ? "is" : "are"} at the end of the playlist.`,
      );
    }
    if (result.failed.length > 0) {
      lines.push(`${result.failed.length} not changed: ${result.failed[0]!.reason}${result.failed.length > 1 ? " (and others)" : ""}.`);
    }
    showError(resultNode, lines.join(" "));
    setStep("upgrade-steps", 3);
    // The plan is now stale; check again before applying more.
    items = [];
    el("upgrade-list").textContent = "";
    el("upgrade-broken-list").textContent = "";
    el("upgrade-summary").textContent = "Check again to see what is left.";
    button.hidden = true;
  } catch (error) {
    showError(errorNode, (error as Error).message);
    button.disabled = false;
    button.textContent = original;
  }
}
