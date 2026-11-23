/**
 * New releases view.
 *
 * Choose whose releases to look at (favourite artists or a playlist's), since
 * when and which kinds; the server finds the recent releases (hiding favourites
 * and reissues), shown here as a grid of tickable cards, newest first. The
 * ticked releases then go into a new playlist or the favourite albums. This is
 * DOM glue; the finding and writing live in src/features/new-releases.ts.
 */

import type { PlaylistId } from "../../services/ids.js";
import { api, type Album, type FilterInput, type Playlist } from "../api.js";
import { coverSlot } from "../artwork.js";
import { el, showError } from "../dom.js";
import { qualityPill, readTerms } from "../tracks.js";
import { keepUpdated } from "./managed.js";

interface Release extends Album {
  releaseType: "album" | "ep-single" | "live" | "compilation" | "other";
}

interface NewReleasesPlan {
  since: string;
  until: string;
  releases: Release[];
  checkedArtists: number;
  totalArtists: number;
  capped: boolean;
  hidden: { favourites: number; reissues: number };
  excludedArtists: string[];
  failedArtists: string[];
}

type CommitResult =
  | { type: "playlist"; playlist: Playlist; trackCount: number; failedAlbumIds: string[] }
  | { type: "favourite-albums"; added: number };

/** The releases on show, in display order. */
let releases: Release[] = [];

/** The filter as it stood when the releases were found; the commit reuses it. */
let activeFilter: FilterInput = { excludeTracks: [], excludeAlbums: [], excludeArtists: [] };

let playlistsLoaded = false;

/** Wire up the new releases view. Call once on load. */
export function initNewReleasesView(): void {
  el<HTMLInputElement>("releases-since").value = isoDaysAgo(30);
  el("releases-source").addEventListener("change", onSourceChange);
  el("releases-target").addEventListener("change", onTargetChange);
  el("find-releases").addEventListener("click", () => void onFind());
  el("commit-releases").addEventListener("click", () => void onCommit());
  el("releases-keep-updated").addEventListener("click", onKeepUpdated);
}

/** Open the Managed view with a feed of these artists, since this date, of these kinds. */
function onKeepUpdated(): void {
  const include = new Set(
    [...document.querySelectorAll<HTMLInputElement>('input[name="releases-include"]:checked')].map((box) => box.value),
  );
  const fields: Record<string, string> = {
    "managed-source": fromPlaylist() ? "playlist" : "favourites",
    // A managed feed rolls: "since <date>" becomes "the last <days since then> days".
    "managed-window-type": "last-days",
    "managed-window-days": String(daysSince(el<HTMLInputElement>("releases-since").value)),
    "managed-exclude-artists": el<HTMLTextAreaElement>("releases-exclude-artists").value,
    "managed-exclude-albums": el<HTMLTextAreaElement>("releases-exclude-albums").value,
    "managed-exclude-tracks": el<HTMLTextAreaElement>("releases-exclude-tracks").value,
    "managed-name": fromPlaylist() ? "New from a playlist's artists" : "New from my artists",
  };
  const playlist = el<HTMLSelectElement>("releases-playlist").value;
  keepUpdated(fields, {
    include: [...include],
    ...(fromPlaylist() && playlist !== "" && { playlistId: playlist as PlaylistId }),
  });
}

/** Whole days from a YYYY-MM-DD date to today (UTC), at least 1 (30 if unset). */
function daysSince(date: string): number {
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) {
    return 30;
  }
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.min(3650, Math.max(1, Math.round((today - then) / 86_400_000)));
}

/** Today minus `days`, as YYYY-MM-DD (UTC, like the server). */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function fromPlaylist(): boolean {
  return el<HTMLSelectElement>("releases-source").value === "playlist";
}

function onSourceChange(): void {
  el("releases-playlist-field").hidden = !fromPlaylist();
  if (fromPlaylist()) {
    void loadPlaylists();
  }
}

async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>("releases-playlist");
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    select.textContent = "";
    if (playlists.length === 0) {
      select.appendChild(new Option("You have no playlists", ""));
      return;
    }
    for (const playlist of playlists) {
      select.appendChild(new Option(playlist.name, String(playlist.id)));
    }
    playlistsLoaded = true;
  } catch (error) {
    select.textContent = "";
    select.appendChild(new Option("Could not load playlists", ""));
    showError(el("find-releases-error"), (error as Error).message);
  }
}

function readFilter(): FilterInput {
  return {
    excludeTracks: readTerms("releases-exclude-tracks"),
    excludeAlbums: readTerms("releases-exclude-albums"),
    excludeArtists: readTerms("releases-exclude-artists"),
  };
}

async function onFind(): Promise<void> {
  const button = el<HTMLButtonElement>("find-releases");
  const errorNode = el("find-releases-error");
  showError(errorNode, undefined);

  let source: unknown = { type: "favourites" };
  if (fromPlaylist()) {
    const id = el<HTMLSelectElement>("releases-playlist").value;
    if (id === "") {
      showError(errorNode, "Choose a playlist.");
      return;
    }
    source = { type: "playlist", playlistId: id as PlaylistId };
  }
  const since = el<HTMLInputElement>("releases-since").value;
  if (since === "") {
    showError(errorNode, "Choose a date.");
    return;
  }
  const include = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="releases-include"]:checked'),
  ].map((box) => box.value);
  if (include.length === 0) {
    showError(errorNode, "Include at least one kind of release.");
    return;
  }

  const filter = readFilter();
  button.disabled = true;
  button.textContent = "Looking...";
  try {
    const plan = await api<NewReleasesPlan>("POST", "/api/new-releases", {
      source,
      since,
      include,
      filter,
    });
    activeFilter = filter;
    render(plan);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Find new releases";
  }
}

function render(plan: NewReleasesPlan): void {
  releases = plan.releases;
  const artists = new Set(plan.releases.map((release) => release.artist)).size;
  let summary = `${plural(plan.releases.length, "release")} from ${plural(artists, "artist")} since ${longDate(plan.since)}.`;
  const hidden: string[] = [];
  if (plan.hidden.favourites > 0) {
    hidden.push(`${plan.hidden.favourites} already in your favourite albums`);
  }
  if (plan.hidden.reissues > 0) {
    hidden.push(`${plural(plan.hidden.reissues, "reissue")} of older albums`);
  }
  if (hidden.length > 0) {
    summary += ` Hidden: ${hidden.join(", ")}.`;
  }
  el("releases-summary").textContent = summary;

  const notes: string[] = [];
  if (plan.capped) {
    notes.push(
      `Checked the first ${plan.checkedArtists} of ${plan.totalArtists} artists; the rest were skipped to keep this quick.`,
    );
  }
  if (plan.excludedArtists.length > 0) {
    notes.push(`Left out: ${plan.excludedArtists.join(", ")}.`);
  }
  showError(el("releases-notes"), notes.length > 0 ? notes.join(" ") : undefined);
  showError(
    el("releases-failed"),
    plan.failedArtists.length > 0
      ? `Could not fetch the releases of: ${plan.failedArtists.join(", ")}.`
      : undefined,
  );

  const grid = el("release-grid");
  grid.textContent = "";
  for (const release of plan.releases) {
    grid.appendChild(releaseCard(release));
  }
  if (el<HTMLInputElement>("releases-playlist-name").value.trim() === "") {
    el<HTMLInputElement>("releases-playlist-name").value = `New releases since ${plan.since}`;
  }

  el("releases-review").hidden = false;
  el("releases-commit-bar").hidden = plan.releases.length === 0;
  showError(el("commit-releases-error"), undefined);
  showError(el("commit-releases-result"), undefined);
  updateCount();
}

/** A tickable card: cover, artist, title, kind/tracks/date, quality pill. */
function releaseCard(release: Release): HTMLElement {
  const card = document.createElement("label");
  card.className = "release-card";
  card.appendChild(coverSlot(release.image));

  const text = document.createElement("span");
  text.className = "release-text";
  const line = (className: string, content: string): void => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = content;
    text.appendChild(span);
  };
  line("release-artist", release.artist);
  line(
    "release-title",
    release.version === undefined ? release.title : `${release.title} (${release.version})`,
  );
  line("release-meta", releaseMeta(release));

  const foot = document.createElement("span");
  foot.className = "release-foot";
  const pill = qualityPill(release);
  if (pill !== undefined) {
    foot.appendChild(pill);
  }
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.dataset["albumId"] = release.id;
  checkbox.setAttribute("aria-label", `Include ${release.title}`);
  checkbox.addEventListener("change", updateCount);
  foot.appendChild(checkbox);
  text.appendChild(foot);

  card.appendChild(text);
  return card;
}

/** "Album, 11 tracks, 24 Oct". */
function releaseMeta(release: Release): string {
  const parts = [kindLabel(release)];
  if (release.trackCount !== undefined) {
    parts.push(plural(release.trackCount, "track"));
  }
  if (release.releaseDate !== undefined) {
    parts.push(shortDate(release.releaseDate));
  }
  return parts.join(", ");
}

function kindLabel(release: Release): string {
  switch (release.releaseType) {
    case "album":
      return "Album";
    case "ep-single":
      return release.trackCount !== undefined && release.trackCount <= 3 ? "Single" : "EP";
    case "live":
      return "Live album";
    case "compilation":
      return "Compilation";
    case "other":
      return "Release";
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "1 October" (with the year when it is not this year). */
function longDate(iso: string): string {
  return formatDate(iso, "long");
}

/** "24 Oct" (with the year when it is not this year). */
function shortDate(iso: string): string {
  return formatDate(iso, "short");
}

function formatDate(iso: string, month: "long" | "short"): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const thisYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month,
    ...(!thisYear && { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The ticked releases, in display order. */
function tickedReleases(): Release[] {
  const ticked = new Set(
    [...document.querySelectorAll<HTMLInputElement>("#release-grid input:checked")].map(
      (box) => box.dataset["albumId"],
    ),
  );
  return releases.filter((release) => ticked.has(release.id));
}

function onTargetChange(): void {
  el("releases-new-fields").hidden = el<HTMLSelectElement>("releases-target").value !== "playlist";
  updateCount();
}

/** Update the count in the save bar and the button's label and state. */
function updateCount(): void {
  const ticked = tickedReleases();
  const tracks = ticked.reduce((sum, release) => sum + (release.trackCount ?? 0), 0);
  const known = ticked.every((release) => release.trackCount !== undefined);
  el("releases-selected-count").textContent =
    ticked.length > 0 && known
      ? `${plural(ticked.length, "release")}, ${plural(tracks, "track")}`
      : plural(ticked.length, "release");
  const button = el<HTMLButtonElement>("commit-releases");
  button.textContent =
    el<HTMLSelectElement>("releases-target").value === "playlist"
      ? "Create playlist"
      : "Add to favourites";
  button.disabled = ticked.length === 0;
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit-releases");
  const errorNode = el("commit-releases-error");
  const resultNode = el("commit-releases-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const albumIds = tickedReleases().map((release) => release.id);
  if (albumIds.length === 0) {
    showError(errorNode, "Tick at least one release.");
    return;
  }
  let target: unknown = { type: "favourite-albums" };
  if (el<HTMLSelectElement>("releases-target").value === "playlist") {
    const name = el<HTMLInputElement>("releases-playlist-name").value.trim();
    if (name.length === 0) {
      showError(errorNode, "Name the playlist.");
      return;
    }
    target = {
      type: "playlist",
      name,
      isPublic: el<HTMLInputElement>("releases-playlist-public").checked,
    };
  }

  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const result = await api<CommitResult>("POST", "/api/new-releases/commit", {
      albumIds,
      target,
      filter: activeFilter,
    });
    if (result.type === "favourite-albums") {
      showError(resultNode, `Added ${plural(result.added, "release")} to your favourite albums.`);
    } else {
      let text = `Created "${result.playlist.name}" with ${plural(result.trackCount, "track")}.`;
      if (result.failedAlbumIds.length > 0) {
        text += ` ${plural(result.failedAlbumIds.length, "release")} could not be fetched and ${result.failedAlbumIds.length === 1 ? "was" : "were"} left out.`;
      }
      showError(resultNode, text);
    }
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    updateCount();
  }
}
