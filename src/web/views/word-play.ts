/**
 * Word play view: playlists made out of song titles.
 *
 * Drives resolve -> review -> commit: the server builds the plan (one reading
 * per split, each slot with its chosen song and alternatives); the view shows
 * the chosen reading as cards in order, lets the user swap a song for one of
 * its alternatives or pick another split, then writes the chosen songs in
 * order. This is DOM glue; the matching and splitting live in the tested
 * src/features/word-play.ts.
 */

import { formatDuration, totalSeconds } from "../../features/playlist-shape.js";
import { api, type Playlist, type Track } from "../api.js";
import { coverSlot } from "../artwork.js";
import { el, setStep, showError } from "../dom.js";
import { qualityPill, readTerms, titleOf, trackText } from "../tracks.js";

type Mode = "contains" | "exact" | "sentence" | "acrostic" | "a-to-z";

interface Candidate {
  track: Track;
  closeForm: boolean;
  punctuationIgnored: boolean;
}

interface Slot {
  label: string;
  chosen?: Candidate;
  alternatives: Candidate[];
  matchCount: number;
}

interface Split {
  slots: Slot[];
  songCount: number;
  unmatched: string[];
  closeForms: number;
  objective?: "fewest" | "words" | "any";
}

interface Plan {
  mode: Mode;
  text: string;
  suggestedName: string;
  splits: Split[];
  requested?: number;
  searches: number;
  skippedSearches: number;
  sourceSize?: number;
  excludedCount: number;
}

type CommitTarget =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: number };

const TEXT_LABELS: Record<Mode, { label: string; placeholder: string }> = {
  contains: { label: "Word or phrase", placeholder: "night" },
  exact: { label: "Word or phrase", placeholder: "Home" },
  sentence: { label: "Sentence", placeholder: "A quick brown fox jumped over the lazy dog" },
  acrostic: { label: "Word to spell", placeholder: "QOBUZ" },
  "a-to-z": { label: "", placeholder: "" },
};

let plan: Plan | undefined;
let splitIndex = 0;
/** Per split, per slot: 0 for the chosen song, n for alternative n-1. */
let picks: number[][] = [];
let playlists: Promise<Playlist[]> | undefined;

/** Wire up the word play view. Call once on load. */
export function initWordPlayView(): void {
  for (const radio of document.querySelectorAll('input[name="wp-mode"]')) {
    radio.addEventListener("change", onModeChange);
  }
  for (const radio of document.querySelectorAll('input[name="wp-source"]')) {
    radio.addEventListener("change", onSourceChange);
  }
  for (const radio of document.querySelectorAll('input[name="wp-target"]')) {
    radio.addEventListener("change", onTargetChange);
  }
  el("wp-find").addEventListener("click", () => void onFind());
  el("wp-commit").addEventListener("click", () => void onCommit());
  el<HTMLInputElement>("wp-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void onFind();
    }
  });
  onModeChange();
}

function checkedValue(name: string): string | undefined {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
}

function currentMode(): Mode {
  return (checkedValue("wp-mode") ?? "sentence") as Mode;
}

function onModeChange(): void {
  const mode = currentMode();
  const text = TEXT_LABELS[mode];
  el("wp-text-field").hidden = mode === "a-to-z";
  el("wp-text-label").textContent = text.label;
  el<HTMLInputElement>("wp-text").placeholder = text.placeholder;
  el("wp-count-field").hidden = mode !== "contains" && mode !== "exact";
  el("wp-split-field").hidden = mode !== "sentence";
  el("wp-source-field").hidden = mode !== "acrostic" && mode !== "a-to-z";
}

function onSourceChange(): void {
  const usePlaylist = checkedValue("wp-source") === "playlist";
  el("wp-source-playlist-fields").hidden = !usePlaylist;
  if (usePlaylist) {
    void fillPlaylistSelect(el<HTMLSelectElement>("wp-source-playlist"), el("wp-find-error"));
  }
}

function onTargetChange(): void {
  const existing = checkedValue("wp-target") === "existing";
  el("wp-new-fields").hidden = existing;
  el("wp-existing-fields").hidden = !existing;
  el("wp-commit").textContent = existing ? "Add to playlist" : "Create playlist";
  if (existing) {
    void fillPlaylistSelect(el<HTMLSelectElement>("wp-playlist-select"), el("wp-commit-error"));
  }
}

/** Fill a playlist picker (the list is fetched once and shared). */
async function fillPlaylistSelect(select: HTMLSelectElement, errorNode: HTMLElement): Promise<void> {
  if (select.dataset["loaded"] === "true") {
    return;
  }
  playlists ??= api<{ playlists: Playlist[] }>("GET", "/api/playlists").then((r) => r.playlists);
  try {
    const list = await playlists;
    select.textContent = "";
    if (list.length === 0) {
      select.appendChild(new Option("You have no playlists", ""));
      return;
    }
    for (const playlist of list) {
      const label =
        playlist.trackCount === undefined
          ? playlist.name
          : `${playlist.name} (${playlist.trackCount} tracks)`;
      select.appendChild(new Option(label, String(playlist.id)));
    }
    select.dataset["loaded"] = "true";
  } catch (error) {
    playlists = undefined;
    select.textContent = "";
    select.appendChild(new Option("Could not load playlists", ""));
    showError(errorNode, (error as Error).message);
  }
}

/** The resolve request for the current form, or an error message. */
function buildRequest(): Record<string, unknown> | string {
  const mode = currentMode();
  const text = el<HTMLInputElement>("wp-text").value.trim();
  const body: Record<string, unknown> = {
    mode,
    match: {
      ignorePunctuation: el<HTMLInputElement>("wp-ignore-punctuation").checked,
      ignoreVersions: el<HTMLInputElement>("wp-ignore-versions").checked,
      closeForms: el<HTMLInputElement>("wp-close-forms").checked,
      onePerArtist: el<HTMLInputElement>("wp-one-per-artist").checked,
      preferHires: el<HTMLInputElement>("wp-prefer-hires").checked,
    },
    filter: {
      excludeTracks: readTerms("wp-exclude-tracks"),
      excludeAlbums: readTerms("wp-exclude-albums"),
      excludeArtists: readTerms("wp-exclude-artists"),
    },
  };
  if (mode !== "a-to-z") {
    if (text.length === 0) {
      return mode === "sentence" ? "Enter a sentence." : "Enter a word.";
    }
    body["text"] = text;
  }
  if (mode === "contains" || mode === "exact") {
    body["count"] = Number(el<HTMLInputElement>("wp-count").value);
  }
  if (mode === "sentence") {
    body["split"] = checkedValue("wp-split") ?? "fewest";
  }
  if (mode === "acrostic" || mode === "a-to-z") {
    if (checkedValue("wp-source") === "playlist") {
      const id = el<HTMLSelectElement>("wp-source-playlist").value;
      if (id === "") {
        return "Choose a playlist to pick songs from.";
      }
      body["source"] = { type: "playlist", playlistId: Number(id) };
    } else {
      body["source"] = { type: "favourites" };
    }
  }
  return body;
}

async function onFind(): Promise<void> {
  const button = el<HTMLButtonElement>("wp-find");
  const errorNode = el("wp-find-error");
  showError(errorNode, undefined);
  const request = buildRequest();
  if (typeof request === "string") {
    showError(errorNode, request);
    return;
  }
  button.disabled = true;
  button.textContent = "Finding songs...";
  try {
    plan = await api<Plan>("POST", "/api/word-play/resolve", request);
    splitIndex = 0;
    picks = plan.splits.map((split) => split.slots.map(() => 0));
    el<HTMLInputElement>("wp-playlist-name").value = plan.suggestedName;
    renderPlan();
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Find songs";
  }
}

function renderPlan(): void {
  if (plan === undefined) {
    return;
  }
  const split = plan.splits[splitIndex]!;
  el("wp-heading").textContent = heading(plan, split);
  el("wp-summary").textContent = summary(plan);

  const unmatched = el("wp-unmatched");
  const gaps = gapNotice(plan, split);
  unmatched.hidden = gaps === undefined;
  unmatched.textContent = gaps ?? "";

  const cards = el("wp-cards");
  cards.textContent = "";
  split.slots.forEach((_, index) => cards.appendChild(renderCard(index)));

  renderSplitOptions();
  el("wp-review").hidden = false;
  setStep("wp-steps", 1);
  showError(el("wp-commit-error"), undefined);
  showError(el("wp-commit-result"), undefined);
  updateCount();
}

function heading(current: Plan, split: Split): string {
  const songs = `${split.songCount} song${split.songCount === 1 ? "" : "s"}`;
  switch (current.mode) {
    case "sentence":
      return `Read as ${songs}`;
    case "acrostic":
      return `${current.text.toUpperCase()} in ${songs}`;
    case "a-to-z":
      return `${split.songCount} of 26 letters`;
    case "contains":
      return `${songs} with "${current.text}"`;
    case "exact":
      return `${songs} called "${current.text}"`;
  }
}

function summary(current: Plan): string {
  const parts = ["Pick another song from a card's list to swap it."];
  if (current.searches > 0) {
    parts.push(
      `Searched ${current.searches} ${current.mode === "sentence" ? "phrase" : "page"}${current.searches === 1 ? "" : "s"}` +
        (current.skippedSearches > 0
          ? ` (${current.skippedSearches} longer phrases were not searched; shorten the sentence to try them).`
          : "."),
    );
  }
  if (current.sourceSize !== undefined) {
    parts.push(`Picked from ${current.sourceSize} tracks.`);
  }
  if (current.excludedCount > 0) {
    parts.push(`${current.excludedCount} matching tracks were left out by the filters.`);
  }
  return parts.join(" ");
}

/** The amber notice for what could not be matched, if anything. */
function gapNotice(current: Plan, split: Split): string | undefined {
  if (current.mode === "contains" || current.mode === "exact") {
    const wanted = current.requested ?? 0;
    if (split.songCount === 0) {
      return `No titles found for "${current.text}".`;
    }
    return split.songCount < wanted ? `Only ${split.songCount} of ${wanted} songs found.` : undefined;
  }
  if (split.unmatched.length === 0) {
    return undefined;
  }
  if (current.mode === "sentence") {
    return `Nothing found for: ${split.unmatched.join(", ")}. These words are left out of the playlist.`;
  }
  return `No song starts with: ${split.unmatched.join(", ")}.`;
}

/** The candidate currently picked for a slot of the current split. */
function pickedCandidate(slotIndex: number): Candidate | undefined {
  const slot = plan?.splits[splitIndex]?.slots[slotIndex];
  if (slot?.chosen === undefined) {
    return undefined;
  }
  const pick = picks[splitIndex]?.[slotIndex] ?? 0;
  return pick === 0 ? slot.chosen : slot.alternatives[pick - 1] ?? slot.chosen;
}

function renderCard(slotIndex: number): HTMLElement {
  const slot = plan!.splits[splitIndex]!.slots[slotIndex]!;
  const numbered = plan!.mode === "contains" || plan!.mode === "exact";
  const card = document.createElement("li");
  card.className = "wp-card";

  const phrase = document.createElement("span");
  phrase.className = "wp-phrase";
  phrase.textContent = numbered ? String(slotIndex + 1) : slot.label;
  card.appendChild(phrase);
  const bar = document.createElement("span");
  bar.className = "wp-bar";
  bar.setAttribute("aria-hidden", "true");
  card.appendChild(bar);

  const candidate = pickedCandidate(slotIndex);
  if (slot.chosen === undefined || candidate === undefined) {
    card.classList.add("wp-gap");
    const none = document.createElement("span");
    none.className = "wp-none";
    none.textContent = "Nothing found";
    card.appendChild(none);
    return card;
  }

  const song = document.createElement("div");
  song.className = "wp-song";
  song.appendChild(coverSlot(candidate.track.image));
  const by = [candidate.track.artist, candidate.track.album].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  song.appendChild(trackText(titleOf(candidate.track), by.length > 0 ? by.join(", ") : undefined));
  const pill = qualityPill(candidate.track);
  if (pill !== undefined) {
    song.appendChild(pill);
  }
  card.appendChild(song);

  const badges = [
    candidate.closeForm ? "Close form" : undefined,
    candidate.punctuationIgnored ? "Punctuation ignored" : undefined,
  ].filter((badge): badge is string => badge !== undefined);
  if (badges.length > 0) {
    const row = document.createElement("span");
    row.className = "wp-badges";
    for (const text of badges) {
      const badge = document.createElement("span");
      badge.className = "wp-badge";
      badge.textContent = text;
      row.appendChild(badge);
    }
    card.appendChild(row);
  }

  const swap = document.createElement("label");
  swap.className = "wp-swap";
  swap.append(`${slot.matchCount} match${slot.matchCount === 1 ? "" : "es"}`);
  const select = document.createElement("select");
  [slot.chosen, ...slot.alternatives].forEach((option, index) => {
    const artist = option.track.artist === undefined ? "" : ` -- ${option.track.artist}`;
    select.appendChild(new Option(`${titleOf(option.track)}${artist}`, String(index)));
  });
  select.value = String(picks[splitIndex]?.[slotIndex] ?? 0);
  select.disabled = slot.alternatives.length === 0;
  select.addEventListener("change", () => {
    picks[splitIndex]![slotIndex] = Number(select.value);
    const fresh = renderCard(slotIndex);
    card.replaceWith(fresh);
    fresh.querySelector("select")?.focus();
    updateCount();
  });
  swap.appendChild(select);
  card.appendChild(swap);
  return card;
}

/** The other ways to split a sentence, as radios (the current one checked). */
function renderSplitOptions(): void {
  const fieldset = el("wp-splits");
  const options = el("wp-split-options");
  options.textContent = "";
  if (plan === undefined || plan.mode !== "sentence" || plan.splits.length < 2) {
    fieldset.hidden = true;
    return;
  }
  fieldset.hidden = false;
  plan.splits.forEach((split, index) => {
    const label = document.createElement("label");
    label.className = "radio wp-split-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "wp-split-choice";
    radio.checked = index === splitIndex;
    radio.addEventListener("change", () => {
      splitIndex = index;
      renderPlan();
    });
    label.appendChild(radio);
    const text = document.createElement("span");
    text.textContent = split.slots.map((slot) => slot.label).join(" / ");
    label.appendChild(text);
    const notes = [
      `${split.songCount} song${split.songCount === 1 ? "" : "s"}`,
      split.closeForms > 0
        ? `${split.closeForms} close form${split.closeForms === 1 ? "" : "s"}`
        : undefined,
    ].filter((note): note is string => note !== undefined);
    const count = document.createElement("span");
    count.className = "wp-split-count";
    count.textContent = notes.join(", ");
    label.appendChild(count);
    if (split.unmatched.length > 0) {
      const gap = document.createElement("span");
      gap.className = "wp-split-gap";
      gap.textContent = `Nothing found for ${split.unmatched.join(", ")}`;
      label.appendChild(gap);
    }
    options.appendChild(label);
  });
}

/** The picked songs' track ids, in order, each once. */
function selectedTrackIds(): number[] {
  return selectedTracks().map((track) => track.id);
}

/** The picked songs, in order, each once. */
function selectedTracks(): Track[] {
  const tracks: Track[] = [];
  const seen = new Set<number>();
  plan?.splits[splitIndex]?.slots.forEach((_, index) => {
    const track = pickedCandidate(index)?.track;
    if (track !== undefined && !seen.has(track.id)) {
      seen.add(track.id);
      tracks.push(track);
    }
  });
  return tracks;
}

function updateCount(): void {
  const tracks = selectedTracks();
  const count = tracks.length;
  const length = formatDuration(totalSeconds(tracks, (track) => track.duration));
  const order =
    plan?.mode === "sentence"
      ? ", in sentence order"
      : plan?.mode === "acrostic" || plan?.mode === "a-to-z"
        ? ", in letter order"
        : "";
  el("wp-selected-count").textContent = `${count} song${count === 1 ? "" : "s"}, ${length}${order}`;
  el<HTMLButtonElement>("wp-commit").disabled = count === 0;
}

function buildTarget(): CommitTarget | undefined {
  if (checkedValue("wp-target") === "existing") {
    const value = el<HTMLSelectElement>("wp-playlist-select").value;
    return value === "" ? undefined : { type: "existing", playlistId: Number(value) };
  }
  const name = el<HTMLInputElement>("wp-playlist-name").value.trim();
  if (name.length === 0) {
    return undefined;
  }
  return { type: "new", name, isPublic: el<HTMLInputElement>("wp-playlist-public").checked };
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("wp-commit");
  const errorNode = el("wp-commit-error");
  const resultNode = el("wp-commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);
  const trackIds = selectedTrackIds();
  if (trackIds.length === 0) {
    showError(errorNode, "There are no songs to save.");
    return;
  }
  const target = buildTarget();
  if (target === undefined) {
    showError(
      errorNode,
      checkedValue("wp-target") === "existing" ? "Choose a playlist." : "Enter a playlist name.",
    );
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Working...";
  try {
    const result = await api<{ playlist?: Playlist; added: number[]; skipped: number[] }>(
      "POST",
      "/api/word-play/commit",
      { target, trackIds },
    );
    resultNode.hidden = false;
    if (target.type === "new") {
      resultNode.textContent = `Created "${result.playlist?.name ?? target.name}" with ${result.added.length} songs.`;
    } else {
      const skipped =
        result.skipped.length > 0 ? ` (${result.skipped.length} already present, skipped)` : "";
      resultNode.textContent = `Added ${result.added.length} songs to the playlist${skipped}.`;
    }
    setStep("wp-steps", 3);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
