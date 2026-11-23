/**
 * Library-stats view.
 *
 * Flow: choose what to show (favourites, everything, or one playlist); the
 * stats load when the view is first opened and whenever the choice changes.
 * Each decade and top artist has a "Playlist" button, which opens the save bar
 * with that bucket's tracks and a suggested name; saving creates the playlist.
 * Bars are plain CSS. This is DOM glue; the aggregation lives in
 * src/features/stats.ts.
 */

import type { PlaylistId, TrackId } from "../../services/ids.js";
import { api, type Playlist } from "../api.js";
import { el, showError } from "../dom.js";

interface Bucket {
  key: string;
  label: string;
  count: number;
  trackIds: TrackId[];
  suggestedName: string;
}

interface LibraryStats {
  label: string;
  trackCount: number;
  artistCount: number;
  totalDuration: number;
  quality: { hires: number; cd: number; unknown: number };
  decades: Bucket[];
  topArtists: Bucket[];
  topArtistsShare: number;
  headline: string;
}

type Source = { type: "favourites" | "everything" } | { type: "playlist"; playlistId: PlaylistId };

let loadedFor: string | undefined;
let chosen: Bucket | undefined;
let request = 0;

/** Wire up the stats view. Call once on load. */
export function initStatsView(): void {
  el("stats-source").addEventListener("change", () => void load());
  el("stats-commit").addEventListener("click", () => void onCommit());
  window.addEventListener("hashchange", loadIfShown);
  loadIfShown();
  void loadPlaylists();
}

/** Load the stats the first time the view is shown (not on every page load). */
function loadIfShown(): void {
  if (location.hash.replace(/^#\/?/, "") === "stats" && loadedFor === undefined) {
    void load();
  }
}

async function loadPlaylists(): Promise<void> {
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    if (playlists.length === 0) {
      return;
    }
    const group = document.createElement("optgroup");
    group.label = "Playlists";
    for (const playlist of playlists) {
      group.appendChild(new Option(playlist.name, String(playlist.id)));
    }
    el("stats-source").appendChild(group);
  } catch {
    // Favourites and everything still work; the playlists are just not offered.
  }
}

function currentSource(): Source {
  const value = el<HTMLSelectElement>("stats-source").value;
  return value === "favourites" || value === "everything"
    ? { type: value }
    : { type: "playlist", playlistId: value as PlaylistId };
}

async function load(): Promise<void> {
  const select = el<HTMLSelectElement>("stats-source");
  const errorNode = el("stats-error");
  const headline = el("stats-headline");
  showError(errorNode, undefined);
  closeSaveBar();
  loadedFor = select.value;
  const mine = (request += 1);
  headline.textContent = "Counting...";
  el("stats-body").setAttribute("aria-busy", "true");
  try {
    const stats = await api<LibraryStats>("POST", "/api/stats", { source: currentSource() });
    if (mine === request) {
      render(stats);
    }
  } catch (error) {
    if (mine === request) {
      headline.textContent = "";
      el("stats-body").hidden = true;
      showError(errorNode, (error as Error).message);
      loadedFor = undefined;
    }
  } finally {
    if (mine === request) {
      el("stats-body").removeAttribute("aria-busy");
    }
  }
}

function render(stats: LibraryStats): void {
  el("stats-headline").textContent = stats.headline;
  el("stats-body").hidden = stats.trackCount === 0;
  if (stats.trackCount === 0) {
    return;
  }
  renderQuality(stats.quality);
  renderDecades(stats.decades);
  renderArtists(stats);
}

function renderQuality(quality: LibraryStats["quality"]): void {
  const bar = el("stats-quality-bar");
  bar.textContent = "";
  const parts = [
    { key: "hires", label: "Hi-res", count: quality.hires, describe: "in hi-res" },
    { key: "cd", label: "CD quality", count: quality.cd, describe: "in CD quality" },
    { key: "unknown", label: "Unknown", count: quality.unknown, describe: "of unknown quality" },
  ].filter((part) => part.count > 0);
  bar.setAttribute(
    "aria-label",
    parts.map((part) => `${number(part.count)} tracks ${part.describe}`).join(", "),
  );
  for (const part of parts) {
    const segment = document.createElement("span");
    segment.className = `quality-segment ${part.key}`;
    segment.style.flexGrow = String(part.count);
    segment.textContent = `${part.label} ${number(part.count)}`;
    segment.title = segment.textContent;
    bar.appendChild(segment);
  }
}

function renderDecades(decades: Bucket[]): void {
  const list = el("stats-decades");
  list.textContent = "";
  const max = Math.max(1, ...decades.map((d) => d.count));
  for (const decade of decades) {
    const row = document.createElement("div");
    row.className = "decade-row";

    const label = document.createElement("span");
    label.className = "decade-label";
    label.textContent = decade.label;

    const track = document.createElement("span");
    track.className = "bar-track";
    track.setAttribute("role", "img");
    track.setAttribute("aria-label", `${decade.label}: ${tracks(decade.count)}`);
    const fill = document.createElement("span");
    fill.className = decade.count === max ? "bar-fill largest" : "bar-fill";
    fill.style.width = `${(decade.count / max) * 100}%`;
    track.appendChild(fill);

    const count = document.createElement("span");
    count.className = "decade-count";
    count.textContent = number(decade.count);
    count.setAttribute("aria-hidden", "true");

    const button = playlistButton(
      decade,
      decade.key === "unknown"
        ? "Make a playlist of the tracks with no release year"
        : `Make a playlist of the ${decade.label}`,
    );
    row.append(label, track, count, button);
    list.appendChild(row);
  }
}

function renderArtists(stats: LibraryStats): void {
  const list = el("stats-artists");
  list.textContent = "";
  stats.topArtists.forEach((artist, i) => {
    const row = document.createElement("li");
    row.className = "artist-rank";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(i + 1);
    rank.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "artist-name";
    name.textContent = artist.label;
    const count = document.createElement("span");
    count.className = "artist-count";
    count.textContent = tracks(artist.count);
    row.append(rank, name, count, playlistButton(artist, `Make a playlist of ${artist.label}`));
    list.appendChild(row);
  });
  const share = Math.round(stats.topArtistsShare * 100);
  const n = stats.topArtists.length;
  el("stats-artist-share").textContent =
    n === 0
      ? ""
      : `${n === 1 ? "This artist makes" : `These ${n} artists make`} up ${share}% of ${whose(stats)}.`;
}

/** "your favourites", "Road Trip" or "your library", for the share sentence. */
function whose(stats: LibraryStats): string {
  const source = currentSource();
  return source.type === "favourites"
    ? "your favourites"
    : source.type === "everything"
      ? "your library"
      : stats.label;
}

function playlistButton(bucket: Bucket, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary small";
  button.textContent = "Playlist";
  button.setAttribute("aria-label", label);
  button.disabled = bucket.count === 0;
  button.addEventListener("click", () => openSaveBar(bucket));
  return button;
}

/** Offer to save a bucket as a new playlist, under its suggested name. */
function openSaveBar(bucket: Bucket): void {
  chosen = bucket;
  el("stats-save").hidden = false;
  el("stats-save-count").textContent = `${bucket.label}: ${tracks(bucket.count)}`;
  const name = el<HTMLInputElement>("stats-playlist-name");
  name.value = bucket.suggestedName;
  showError(el("stats-commit-error"), undefined);
  showError(el("stats-commit-result"), undefined);
  name.focus();
}

function closeSaveBar(): void {
  chosen = undefined;
  el("stats-save").hidden = true;
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("stats-commit");
  const errorNode = el("stats-commit-error");
  const resultNode = el("stats-commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);
  if (chosen === undefined) {
    return;
  }
  const name = el<HTMLInputElement>("stats-playlist-name").value.trim();
  if (name.length === 0) {
    showError(errorNode, "Enter a name for the new playlist.");
    return;
  }

  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const result = await api<{ playlist?: Playlist; added: TrackId[] }>("POST", "/api/commit", {
      tool: "stats",
      target: {
        type: "new",
        name,
        isPublic: el<HTMLInputElement>("stats-playlist-public").checked,
      },
      trackIds: chosen.trackIds,
    });
    showError(
      resultNode,
      `Created "${result.playlist?.name ?? name}" with ${tracks(result.added.length)}.`,
    );
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Create playlist";
  }
}

function tracks(count: number): string {
  return `${number(count)} track${count === 1 ? "" : "s"}`;
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}
