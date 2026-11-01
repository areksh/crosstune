/**
 * Combine-playlists view.
 *
 * Flow: choose two or more playlists (your favourites can be one) and what to
 * keep (everything, only what the first has, or only what all share); combine
 * to see how they overlap and the resulting track list; change the order or
 * which copy of a shared song to keep (each re-combines); untick tracks; save
 * to a new or existing playlist. This is DOM glue; the matching, counting and
 * ordering live in src/features/combine.ts.
 */

import { api, type Playlist, type Track } from "../api.js";
import { el, setStep, showError } from "../dom.js";
import { trackRow } from "../tracks.js";

type Source = { type: "favourites" } | { type: "playlist"; playlistId: number };

interface CombinePlan {
  labels: string[];
  tracks: { track: Track; inputs: number[] }[];
  counts: {
    perInput: number[];
    onlyIn: number[];
    shared: number;
    inAll: number;
    songs: number;
    result: number;
  };
  suggestedName: string;
}

type CommitTarget =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: number };

const FAVOURITES = "favourites";

let playlists: Playlist[] | undefined;
let lastSuggestedName = "";
let plan: CombinePlan | undefined;

/** Wire up the combine view. Call once on load. */
export function initCombineView(): void {
  addSourceRow();
  addSourceRow();
  el("combine-add").addEventListener("click", () => addSourceRow());
  el("combine-resolve").addEventListener("click", () => void onResolve());
  el("combine-commit").addEventListener("click", () => void onCommit());
  // Once there is a result, changing how to combine re-combines.
  const recombine = (): void => {
    if (plan !== undefined) {
      void onResolve();
    }
  };
  for (const radio of document.querySelectorAll('input[name="combine-mode"]')) {
    radio.addEventListener("change", recombine);
  }
  el("combine-match-songs").addEventListener("change", recombine);
  el("combine-order").addEventListener("change", recombine);
  el("combine-keep").addEventListener("change", recombine);
  for (const radio of document.querySelectorAll('input[name="combine-target"]')) {
    radio.addEventListener("change", onTargetChange);
  }
  void loadPlaylists();
}

/** Add a numbered playlist picker; rows past the second can be removed. */
function addSourceRow(): void {
  const list = el("combine-source-list");
  const index = list.children.length;
  const row = document.createElement("div");
  row.className = "source-row";

  const number = document.createElement("span");
  number.className = "source-number";
  number.setAttribute("aria-hidden", "true");
  row.appendChild(number);

  const select = document.createElement("select");
  select.className = "combine-source";
  fillSourceSelect(select, index);
  row.appendChild(select);

  if (index >= 2) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary remove-row";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      row.remove();
      renumberRows();
    });
    row.appendChild(remove);
  }
  list.appendChild(row);
  renumberRows();
}

/** Number the rows 1, 2, ... and label each select for screen readers. */
function renumberRows(): void {
  el("combine-source-list")
    .querySelectorAll<HTMLElement>(".source-row")
    .forEach((row, i) => {
      row.querySelector(".source-number")!.textContent = String(i + 1);
      row.querySelector("select")!.setAttribute("aria-label", `Playlist ${i + 1}`);
    });
}

/**
 * Offer favourites and every playlist, keeping the current choice; the first
 * two rows start on the first two playlists, later ones on "Choose...".
 */
function fillSourceSelect(select: HTMLSelectElement, index: number): void {
  const previous = select.value;
  select.textContent = "";
  if (playlists === undefined) {
    select.appendChild(new Option("Loading...", ""));
    return;
  }
  select.appendChild(new Option("Choose...", ""));
  select.appendChild(new Option("Your favourite tracks", FAVOURITES));
  for (const playlist of playlists) {
    select.appendChild(new Option(playlistLabel(playlist), String(playlist.id)));
  }
  const initial = index < 2 ? String(playlists[index]?.id ?? "") : "";
  select.value = previous !== "" ? previous : initial;
}

function playlistLabel(playlist: Playlist): string {
  return playlist.trackCount === undefined
    ? playlist.name
    : `${playlist.name} (${playlist.trackCount} tracks)`;
}

async function loadPlaylists(): Promise<void> {
  const target = el<HTMLSelectElement>("combine-playlist-select");
  try {
    ({ playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists"));
  } catch (error) {
    showError(el("combine-resolve-error"), (error as Error).message);
    playlists = [];
  }
  document.querySelectorAll<HTMLSelectElement>(".combine-source").forEach(fillSourceSelect);
  target.textContent = "";
  if (playlists.length === 0) {
    target.appendChild(new Option("You have no playlists", ""));
  }
  for (const playlist of playlists) {
    target.appendChild(new Option(playlistLabel(playlist), String(playlist.id)));
  }
}

function chosenSources(): Source[] | string {
  const values = [...document.querySelectorAll<HTMLSelectElement>(".combine-source")]
    .map((select) => select.value)
    .filter((value) => value !== "");
  if (values.length < 2) {
    return "Choose at least two playlists.";
  }
  if (new Set(values).size !== values.length) {
    return "Choose each playlist only once.";
  }
  return values.map((value) =>
    value === FAVOURITES ? { type: "favourites" } : { type: "playlist", playlistId: Number(value) },
  );
}

function radioValue(name: string, fallback: string): string {
  return (
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? fallback
  );
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("combine-resolve");
  const errorNode = el("combine-resolve-error");
  showError(errorNode, undefined);
  const sources = chosenSources();
  if (typeof sources === "string") {
    showError(errorNode, sources);
    return;
  }

  button.disabled = true;
  button.textContent = "Combining...";
  try {
    plan = await api<CombinePlan>("POST", "/api/combine/resolve", {
      sources,
      mode: radioValue("combine-mode", "merge"),
      order: el<HTMLSelectElement>("combine-order").value,
      keep: el<HTMLSelectElement>("combine-keep").value,
      matchSongs: el<HTMLInputElement>("combine-match-songs").checked,
    });
    render(plan);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Combine";
  }
}

function render(result: CombinePlan): void {
  renderOverlap(result);
  const list = el("combine-tracks");
  list.textContent = "";
  for (const { track, inputs } of result.tracks) {
    list.appendChild(trackRow(track, { meta: trackMeta(track, inputs, result.labels), onChange: updateCount }));
  }

  const name = el<HTMLInputElement>("combine-playlist-name");
  if (name.value.trim() === "" || name.value === lastSuggestedName) {
    name.value = result.suggestedName;
  }
  lastSuggestedName = result.suggestedName;

  el("combine-review").hidden = false;
  showError(el("combine-commit-error"), undefined);
  showError(el("combine-commit-result"), undefined);
  setStep("combine-steps", 1);
  updateCount();
}

/** The artist and album, and which playlists share the song when more than one. */
function trackMeta(track: Track, inputs: number[], labels: string[]): string {
  const parts = [track.artist, track.album].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (inputs.length > 1) {
    parts.push(`in ${inputs.map((i) => labels[i]).join(", ")}`);
  }
  return parts.join(" · ");
}

/** The headline, the stacked only-first / shared / only-others bar and its legend. */
function renderOverlap(result: CombinePlan): void {
  const { labels, counts } = result;
  const mode = radioValue("combine-mode", "merge");
  const first = labels[0] ?? "the first";
  const total = el("combine-total");
  total.textContent =
    mode === "only-first"
      ? `${tracks(counts.result)} only in ${first}`
      : mode === "common"
        ? `${tracks(counts.result)} in all of them`
        : tracks(counts.result);
  el("combine-overlap-note").textContent =
    counts.shared === 0
      ? "No song is in more than one."
      : `${songs(counts.shared)} ${counts.shared === 1 ? "is" : "are"} in ${labels.length === 2 ? "both" : "more than one"}${mode === "merge" ? ", and added once" : ""}.`;

  const onlyFirst = counts.onlyIn[0] ?? 0;
  const others = counts.songs - onlyFirst - counts.shared;
  const two = labels.length === 2;
  const segments = [
    { key: "first", count: onlyFirst, label: `Only in ${first}` },
    { key: "shared", count: counts.shared, label: two ? "In both" : "In more than one" },
    { key: "others", count: others, label: two ? `Only in ${labels[1]}` : "Only in the others" },
  ];

  const bar = el("combine-overlap-bar");
  bar.textContent = "";
  bar.setAttribute("aria-label", segments.map((s) => `${s.label}: ${s.count}`).join(", "));
  const legend = el("combine-overlap-legend");
  legend.textContent = "";
  for (const segment of segments) {
    if (segment.count > 0) {
      const part = document.createElement("span");
      part.className = `overlap-${segment.key}`;
      part.style.flexGrow = String(segment.count);
      bar.appendChild(part);
    }
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = `swatch overlap-${segment.key}`;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, `${segment.label}: ${segment.count}`);
    legend.appendChild(item);
  }
}

function tracks(count: number): string {
  return `${count} track${count === 1 ? "" : "s"}`;
}

function songs(count: number): string {
  return `${count} song${count === 1 ? "" : "s"}`;
}

/** The ticked track ids, in list order. */
function selectedTrackIds(): number[] {
  return [
    ...document.querySelectorAll<HTMLInputElement>("#combine-tracks input[type=checkbox]:checked"),
  ].map((box) => Number(box.dataset["trackId"]));
}

function updateCount(): void {
  const ids = selectedTrackIds();
  const durations = new Map(plan?.tracks.map(({ track }) => [track.id, track.duration ?? 0]));
  const seconds = ids.reduce((sum, id) => sum + (durations.get(id) ?? 0), 0);
  el("combine-count").textContent =
    seconds > 0 ? `${tracks(ids.length)}, ${runningTime(seconds)}` : tracks(ids.length);
  el<HTMLButtonElement>("combine-commit").disabled = ids.length === 0;
}

/** "3 h 41 min", or "41 min" under an hour. */
function runningTime(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function onTargetChange(): void {
  const target = radioValue("combine-target", "new");
  el("combine-new-fields").hidden = target !== "new";
  el("combine-existing-fields").hidden = target !== "existing";
  el("combine-commit").textContent = target === "new" ? "Create playlist" : "Add to playlist";
}

function buildTarget(): CommitTarget | string {
  if (radioValue("combine-target", "new") === "new") {
    const name = el<HTMLInputElement>("combine-playlist-name").value.trim();
    if (name.length === 0) {
      return "Enter a name for the new playlist.";
    }
    return {
      type: "new",
      name,
      isPublic: el<HTMLInputElement>("combine-playlist-public").checked,
    };
  }
  const value = el<HTMLSelectElement>("combine-playlist-select").value;
  return value === "" ? "Choose a playlist." : { type: "existing", playlistId: Number(value) };
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("combine-commit");
  const errorNode = el("combine-commit-error");
  const resultNode = el("combine-commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const trackIds = selectedTrackIds();
  const target = buildTarget();
  if (typeof target === "string") {
    showError(errorNode, target);
    return;
  }
  if (trackIds.length === 0) {
    showError(errorNode, "Select at least one track.");
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Saving...";
  try {
    const result = await api<{ playlist?: Playlist; added: number[]; skipped: number[] }>(
      "POST",
      "/api/commit",
      { target, trackIds },
    );
    const skipped =
      result.skipped.length > 0 ? ` (${result.skipped.length} already present, skipped)` : "";
    showError(
      resultNode,
      target.type === "new"
        ? `Created "${result.playlist?.name ?? target.name}" with ${tracks(result.added.length)}.`
        : `Added ${tracks(result.added.length)} to the playlist${skipped}.`,
    );
    setStep("combine-steps", 3);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
