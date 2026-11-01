/**
 * Playlist-from-albums view.
 *
 * Drives the resolve -> pick versions -> review tracks -> commit flow: resolve
 * "Artist - Album" lines -- or an artist's discography, grouped by album the
 * same way -- to their matching Qobuz releases (minus any the album
 * filter excludes), let the user pick which version of each to use (defaulting
 * to a global preference), fetch the chosen versions' tracks for review --
 * tracks on unwanted discs or matching a track filter start unticked -- then
 * write the ticked tracks to a new or existing playlist. This is DOM glue; the
 * matching, filtering and commit logic lives in the tested server modules. The
 * version ranking is mirrored here only so the preview can show and send the
 * chosen release.
 */

import {
  api,
  type Album,
  type Exclusion,
  type FilterInput,
  type Playlist,
  type Track,
} from "../api.js";
import { el, setStep, showError } from "../dom.js";
import { coverSlot, setCover } from "../artwork.js";
import { groupHead, readTerms, trackRow } from "../tracks.js";

type Preference = "newest" | "oldest" | "highest-quality";

interface ResolvedAlbum {
  query: string;
  artist: string;
  album: string;
  versions: Album[];
}

interface ResolveResponse {
  resolvedAlbums: ResolvedAlbum[];
  unresolvedAlbums: string[];
  excludedAlbums: string[];
  /** Discography only: the artist the name matched, if any. */
  artist?: { id: number; name: string };
  /** Discography only: the artist has more releases than were fetched. */
  truncated?: boolean;
}

interface FetchResponse {
  fetched: { albumId: string; tracks: { track: Track; exclusion?: Exclusion }[] }[];
  failedAlbumIds?: string[];
}

type CommitTarget =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: number };

let resolvedAlbums: ResolvedAlbum[] = [];
let playlistsLoaded = false;

/**
 * Entries that could not be matched to any Qobuz release in the resolve step,
 * kept so the final summary can list them alongside albums skipped at fetch.
 */
let unresolvedAlbums: string[] = [];

/**
 * The filter as it stood when "Find albums" was pressed. The server validated
 * it then, and track fetches reuse it so the whole review applies one filter.
 */
let activeFilter: FilterInput = { excludeTracks: [], excludeAlbums: [], excludeArtists: [] };

/** True once any fetch has run in this cycle (changes the button wording). */
let fetchAttempted = false;

/** True once the final write has succeeded, so the cycle is complete. */
let committed = false;

/** Wire up the albums view. Call once on load. */
export function initAlbumsView(): void {
  el("resolve-albums").addEventListener("click", () => void onResolve());
  el("commit-albums").addEventListener("click", () => void onCommit());
  el("album-prefer").addEventListener("change", onPreferChange);
  for (const radio of document.querySelectorAll('input[name="album-target"]')) {
    radio.addEventListener("change", onTargetChange);
  }
  for (const radio of document.querySelectorAll('input[name="album-source"]')) {
    radio.addEventListener("change", onSourceChange);
  }
}

/** Whether the albums come from an artist's discography rather than a list. */
function fromDiscography(): boolean {
  return (
    document.querySelector<HTMLInputElement>('input[name="album-source"]:checked')?.value ===
    "discography"
  );
}

function onSourceChange(): void {
  el("album-list-fields").hidden = fromDiscography();
  el("album-discography-fields").hidden = !fromDiscography();
}

/**
 * The resolve request for the chosen source: the album lines, or the
 * discography's artist and kinds of release. Undefined (with the reason shown)
 * when the input is incomplete.
 */
function resolveRequest(
  filter: FilterInput,
  errorNode: HTMLElement,
): { path: string; body: unknown } | undefined {
  if (fromDiscography()) {
    const artist = el<HTMLInputElement>("album-discography-artist").value.trim();
    const include = [
      ...document.querySelectorAll<HTMLInputElement>('input[name="album-include"]:checked'),
    ].map((box) => box.value);
    if (artist.length === 0) {
      showError(errorNode, "Enter an artist.");
      return undefined;
    }
    if (include.length === 0) {
      showError(errorNode, "Include at least one kind of release.");
      return undefined;
    }
    return {
      path: "/api/resolve-discography",
      body: {
        artist,
        include,
        oneVersion: el<HTMLInputElement>("album-one-version").checked,
        filter,
      },
    };
  }
  const entries = el<HTMLTextAreaElement>("albums")
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (entries.length === 0) {
    showError(errorNode, "Enter at least one album.");
    return undefined;
  }
  return { path: "/api/resolve-albums", body: { entries, filter } };
}

function globalPreference(): Preference {
  return el<HTMLSelectElement>("album-prefer").value as Preference;
}

function readFilter(): FilterInput {
  const discs = el<HTMLInputElement>("album-discs").value.trim();
  return {
    excludeTracks: readTerms("album-exclude-tracks"),
    excludeAlbums: readTerms("album-exclude-albums"),
    excludeArtists: readTerms("album-exclude-artists"),
    ...(discs.length > 0 && { discs }),
  };
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("resolve-albums");
  const errorNode = el("resolve-albums-error");
  showError(errorNode, undefined);

  const filter = readFilter();
  const request = resolveRequest(filter, errorNode);
  if (request === undefined) {
    return;
  }
  button.disabled = true;
  button.textContent = "Loading...";
  try {
    const result = await api<ResolveResponse>("POST", request.path, request.body);
    resolvedAlbums = result.resolvedAlbums;
    activeFilter = filter;
    renderPreview(result);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Find albums";
  }
}

function renderPreview(result: ResolveResponse): void {
  unresolvedAlbums = result.unresolvedAlbums;
  const notes: string[] = [];
  if (result.unresolvedAlbums.length > 0) {
    notes.push(`Could not find: ${result.unresolvedAlbums.join(", ")}.`);
  }
  if (result.artist !== undefined && result.resolvedAlbums.length === 0) {
    notes.push(`No releases of the chosen kinds for ${result.artist.name}.`);
  }
  if (result.truncated === true) {
    notes.push("This artist has more releases than were fetched; the oldest may be missing.");
  }
  showError(el("albums-unresolved"), notes.length > 0 ? notes.join(" ") : undefined);
  showError(
    el("albums-excluded"),
    result.excludedAlbums.length > 0
      ? `Every release excluded by your album filter (skipped): ${result.excludedAlbums.join(", ")}`
      : undefined,
  );

  const groups = el("album-groups");
  groups.textContent = "";
  result.resolvedAlbums.forEach((resolved, index) => {
    groups.appendChild(renderAlbumGroup(resolved, index));
  });

  // A fresh preview starts a new cycle: nothing fetched or written yet.
  fetchAttempted = false;
  committed = false;

  el("albums-preview").hidden = false;
  showError(el("commit-albums-error"), undefined);
  showError(el("commit-albums-result"), undefined);
  updateSelectedCount();
  updateCommitButton();
}

function renderAlbumGroup(resolved: ResolvedAlbum, index: number): HTMLElement {
  const group = document.createElement("div");
  group.className = "album-group";
  group.dataset["index"] = String(index);

  const count = resolved.versions.length;
  const head = groupHead("h3", resolved.query, {
    count: `${count} version${count === 1 ? "" : "s"}`,
  });
  group.appendChild(head);

  // The dropdown lists the actual releases; the global preference just chooses
  // which one is selected by default. The user can pick a specific version.
  const select = document.createElement("select");
  select.className = "album-version-select";
  for (const version of resolved.versions) {
    select.appendChild(new Option(versionLabel(version), version.id));
  }
  const preferred = selectVersion(resolved.versions, globalPreference());
  if (preferred !== undefined) {
    select.value = preferred.id;
  }
  select.disabled = resolved.versions.length < 2;
  select.addEventListener("change", () => syncCover(group));
  head.prepend(coverSlot(preferred?.image));

  group.appendChild(select);
  return group;
}

/** Show the cover of the version an album group has selected. */
function syncCover(group: HTMLElement): void {
  const slot = group.querySelector<HTMLElement>(".group-head > .cover");
  if (slot !== null) {
    const id = selectOf(group).value;
    setCover(slot, versionsOf(group).find((version) => version.id === id)?.image);
  }
}

/** A one-line description of a single release for a dropdown option. */
function versionLabel(album: Album): string {
  const parts: string[] = [
    album.version === undefined ? album.title : `${album.title} (${album.version})`,
  ];
  if (album.bitDepth !== undefined && album.samplingRate !== undefined) {
    parts.push(`${album.bitDepth}-bit/${album.samplingRate}kHz`);
  } else if (album.hires === true) {
    parts.push("hi-res");
  }
  if (album.releaseDate !== undefined) {
    parts.push(album.releaseDate);
  }
  if (album.trackCount !== undefined) {
    parts.push(`${album.trackCount} track${album.trackCount === 1 ? "" : "s"}`);
  }
  return parts.join("  |  ");
}

/**
 * Choose which version to use, mirroring the server's ranking so the preview
 * shows (and commits) the same release the strategy would pick.
 */
function selectVersion(
  versions: readonly Album[],
  preference: Preference,
): Album | undefined {
  if (versions.length === 0) {
    return undefined;
  }
  const compare =
    preference === "highest-quality"
      ? compareQuality
      : (a: Album, b: Album): number => compareByDate(a, b, preference === "oldest");
  let best = versions[0]!;
  for (let i = 1; i < versions.length; i += 1) {
    if (compare(versions[i]!, best) > 0) {
      best = versions[i]!;
    }
  }
  return best;
}

function compareQuality(a: Album, b: Album): number {
  return (
    (a.bitDepth ?? 0) - (b.bitDepth ?? 0) ||
    (a.samplingRate ?? 0) - (b.samplingRate ?? 0)
  );
}

function compareByDate(a: Album, b: Album, wantOldest: boolean): number {
  const da = a.releaseDate;
  const db = b.releaseDate;
  if (da === undefined && db === undefined) return 0;
  if (da === undefined) return -1;
  if (db === undefined) return 1;
  if (da === db) return 0;
  const aIsEarlier = da < db;
  return wantOldest ? (aIsEarlier ? 1 : -1) : aIsEarlier ? -1 : 1;
}

/**
 * Re-select each still-pending album's version to match the global preference.
 * Locked albums (already fetched, added, or with no version left) are left
 * untouched, and versions that already failed to fetch (disabled options) are
 * not re-chosen.
 */
function onPreferChange(): void {
  const preference = globalPreference();
  for (const group of pendingGroups()) {
    const select = selectOf(group);
    const preferred = selectVersion(enabledVersions(group), preference);
    if (preferred !== undefined) {
      select.value = preferred.id;
      syncCover(group);
    }
  }
}

/** The version `<select>` of an album group. */
function selectOf(group: HTMLElement): HTMLSelectElement {
  return group.querySelector<HTMLSelectElement>(".album-version-select")!;
}

/** The resolved versions of an album group, in relevance order. */
function versionsOf(group: HTMLElement): Album[] {
  return resolvedAlbums[Number(group.dataset["index"])]?.versions ?? [];
}

/** The "Artist - Album" line for an album group, for reporting. */
function groupName(group: HTMLElement): string {
  return resolvedAlbums[Number(group.dataset["index"])]?.query ?? "unknown album";
}

/** Versions of a group whose dropdown option has not been disabled (not yet tried and failed). */
function enabledVersions(group: HTMLElement): Album[] {
  const options = [...selectOf(group).options];
  return versionsOf(group).filter(
    (version) => !options.some((option) => option.value === version.id && option.disabled),
  );
}

/** Every album group, in the order the user entered them. */
function allGroups(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".album-group")];
}

/**
 * Album groups that still need fetching: not yet fetched ("ready"), written
 * ("added") or exhausted of versions ("unavailable"). Order follows the DOM,
 * which is the order the user entered.
 */
function pendingGroups(): HTMLElement[] {
  const done = new Set(["ready", "added", "unavailable"]);
  return allGroups().filter((group) => !done.has(group.dataset["state"] ?? "pending"));
}

/** Album groups currently in the given state. */
function groupsWithState(state: string): HTMLElement[] {
  return allGroups().filter((group) => group.dataset["state"] === state);
}

/** The unique, ticked track ids across all fetched albums, in display order. */
function selectedTrackIds(): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const box of document.querySelectorAll<HTMLInputElement>(
    "#album-groups .album-tracks input[type=checkbox]:checked",
  )) {
    const id = Number(box.dataset["trackId"]);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function updateSelectedCount(): void {
  const node = el("albums-selected-count");
  if (groupsWithState("ready").length > 0) {
    const count = selectedTrackIds().length;
    node.textContent = `${count} track${count === 1 ? "" : "s"} ticked.`;
  } else {
    const count = resolvedAlbums.length;
    node.textContent = `${count} album${count === 1 ? "" : "s"} selected.`;
  }
  updateCommitButton();
}

function onTargetChange(): void {
  const target = selectedTarget();
  el("album-new-fields").hidden = target !== "new";
  el("album-existing-fields").hidden = target !== "existing";
  updateCommitButton();
  if (target === "existing") {
    void loadPlaylists();
  }
}

function selectedTarget(): string {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="album-target"]:checked',
  );
  return checked?.value ?? "new";
}

async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>("album-playlist-select");
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
    showError(el("commit-albums-error"), (error as Error).message);
  }
}

/**
 * Fetch the pending albums' tracks for review, or -- once nothing is left to
 * fetch -- write the ticked tracks.
 *
 * Nothing is written to Qobuz until every album has been fetched and the user
 * presses the button again. Successful albums show their tracks and lock their
 * version; failed ones drop to their next-best version for the user to retry.
 * The final write takes the ticked tracks in the user's original album order,
 * so a retried album keeps its place.
 */
async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit-albums");
  const errorNode = el("commit-albums-error");
  const resultNode = el("commit-albums-result");
  showError(errorNode, undefined);

  button.disabled = true;
  try {
    if (pendingGroups().length > 0) {
      await fetchPending(button, resultNode);
    } else {
      await writePlaylist(resultNode);
    }
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    updateSelectedCount();
  }
}

/** Fetch every pending album's chosen version and show its tracks for review. */
async function fetchPending(button: HTMLButtonElement, resultNode: HTMLElement): Promise<void> {
  const toFetch = pendingGroups()
    .map((group) => ({ group, id: selectOf(group).value }))
    .filter((item) => item.id !== "");
  if (toFetch.length === 0) {
    return;
  }

  button.textContent = "Fetching...";
  fetchAttempted = true;
  const result = await api<FetchResponse>("POST", "/api/album-tracks", {
    albumIds: toFetch.map((item) => item.id),
    filter: activeFilter,
  });

  const byAlbum = new Map(result.fetched.map((f) => [f.albumId, f.tracks]));
  for (const { group, id } of toFetch) {
    const tracks = byAlbum.get(id);
    if (tracks !== undefined) {
      markGroupReady(group, tracks);
    } else {
      // Not returned means it failed: grey out the version and advance.
      markGroupFailed(group, id);
    }
  }
  reportFetchProgress(resultNode);
}

/** Write the ticked tracks of every fetched album to the chosen destination. */
async function writePlaylist(node: HTMLElement): Promise<void> {
  if (groupsWithState("ready").length === 0) {
    showError(el("commit-albums-error"), "None of the albums could be fetched.");
    return;
  }
  const trackIds = selectedTrackIds();
  if (trackIds.length === 0) {
    showError(el("commit-albums-error"), "Tick at least one track.");
    return;
  }
  const target = buildTarget();
  if (target === undefined) {
    showError(el("commit-albums-error"), "Choose a destination.");
    return;
  }

  el<HTMLButtonElement>("commit-albums").textContent = "Saving...";
  const result = await api<{ playlist?: Playlist; added: number[]; skipped: number[] }>(
    "POST",
    "/api/commit",
    { target, trackIds },
  );
  committed = true;
  for (const group of groupsWithState("ready")) {
    group.dataset["state"] = "added";
    group.classList.add("album-added");
    for (const box of group.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      box.disabled = true;
    }
    setGroupStatus(group, "Added");
  }
  reportWrite(node, target, result);
}

/** Lock a fetched album's version and list its tracks, grouped by disc. */
function markGroupReady(
  group: HTMLElement,
  tracks: readonly { track: Track; exclusion?: Exclusion }[],
): void {
  group.dataset["state"] = "ready";
  selectOf(group).disabled = true;
  group.classList.remove("album-failed");
  group.classList.add("album-ready");

  const list = document.createElement("div");
  list.className = "album-tracks";
  const discs = new Set(tracks.map(({ track }) => track.discNumber));
  let currentDisc: number | undefined;
  for (const { track, exclusion } of tracks) {
    if (discs.size > 1 && track.discNumber !== currentDisc) {
      currentDisc = track.discNumber;
      const heading = document.createElement("div");
      heading.className = "disc-heading";
      heading.textContent = currentDisc === undefined ? "Other" : `Disc ${currentDisc}`;
      list.appendChild(heading);
    }
    list.appendChild(
      // The album's cover heads the group, so its rows leave theirs out.
      trackRow(track, {
        ...(exclusion !== undefined && { exclusion }),
        onChange: updateSelectedCount,
        noCover: true,
      }),
    );
  }
  group.appendChild(list);

  const excluded = tracks.filter((t) => t.exclusion !== undefined).length;
  setGroupStatus(
    group,
    excluded > 0
      ? `Fetched ${tracks.length} tracks; ${excluded} excluded by your filters (unticked)`
      : `Fetched ${tracks.length} tracks`,
  );
}

/**
 * Handle an album whose tracks could not be fetched: grey out (disable) the
 * version just tried so it cannot be picked again, then select the next-best
 * remaining version per the current preference. If none remain, the album is
 * marked unavailable and locked.
 */
function markGroupFailed(group: HTMLElement, triedId: string): void {
  const select = selectOf(group);
  const tried = [...select.options].find((option) => option.value === triedId);
  if (tried !== undefined) {
    tried.disabled = true;
  }

  const next = selectVersion(enabledVersions(group), globalPreference());
  if (next !== undefined) {
    select.value = next.id;
    syncCover(group);
    select.disabled = false;
    group.dataset["state"] = "pending";
    group.classList.add("album-failed");
    setGroupStatus(group, "Could not fetch - trying another version");
  } else {
    select.disabled = true;
    group.dataset["state"] = "unavailable";
    group.classList.remove("album-failed");
    group.classList.add("album-unavailable");
    setGroupStatus(group, "Could not fetch - no other version available");
  }
}

/** Show or update a short status line under an album's version picker. */
function setGroupStatus(group: HTMLElement, text: string): void {
  let status = group.querySelector<HTMLElement>(".album-status");
  if (status === null) {
    status = document.createElement("div");
    status.className = "album-status";
    selectOf(group).insertAdjacentElement("afterend", status);
  }
  status.textContent = text;
}

/** The default label for the write, per the chosen destination. */
function writeLabel(): string {
  return selectedTarget() === "new" ? "Create playlist" : "Add to playlist";
}

/**
 * Show the step reached: albums, versions (some still to fetch), tracks (all
 * fetched, ready to review), or every step done once saved.
 */
function updateSteps(): void {
  let step = 0;
  if (committed) {
    step = 4;
  } else if (pendingGroups().length === 0 && groupsWithState("ready").length > 0) {
    step = 2;
  } else if (allGroups().length > 0) {
    step = 1;
  }
  setStep("albums-steps", step);
}

/** Set the commit button's label and enabled state from the remaining work. */
function updateCommitButton(): void {
  updateSteps();
  const button = el<HTMLButtonElement>("commit-albums");
  if (committed) {
    button.disabled = true;
    button.textContent = "All albums added";
    return;
  }
  if (allGroups().length === 0) {
    button.disabled = true;
    button.textContent = "Fetch tracks";
    return;
  }
  if (pendingGroups().length > 0) {
    button.disabled = false;
    button.textContent = fetchAttempted ? "Retry failed albums" : "Fetch tracks";
    return;
  }
  button.textContent = writeLabel();
  button.disabled = groupsWithState("ready").length > 0 && selectedTrackIds().length === 0;
}

function buildTarget(): CommitTarget | undefined {
  if (selectedTarget() === "new") {
    const name = el<HTMLInputElement>("album-playlist-name").value.trim();
    if (name.length === 0) {
      return undefined;
    }
    return {
      type: "new",
      name,
      isPublic: el<HTMLInputElement>("album-playlist-public").checked,
    };
  }
  const value = el<HTMLSelectElement>("album-playlist-select").value;
  if (value === "") {
    return undefined;
  }
  return { type: "existing", playlistId: Number(value) };
}

/**
 * Report a fetch round: nothing is written yet; some albums are ready for
 * review, some need another version, some have none.
 */
function reportFetchProgress(node: HTMLElement): void {
  node.hidden = false;
  const total = allGroups().length;
  const ready = groupsWithState("ready").length;
  const retry = pendingGroups().map(groupName);
  const unavailable = groupsWithState("unavailable").map(groupName);

  let text = `Fetched ${ready} of ${total}. Nothing is saved yet.`;
  if (retry.length > 0) {
    text += ` A different version is selected for ${retry.join(", ")} - press Retry.`;
  } else {
    text += " Review the tracks, then save.";
  }
  if (unavailable.length > 0) {
    text += ` No other version for ${unavailable.join(", ")} (will be skipped).`;
  }
  node.textContent = text;
}

/** Report the final write: what was added, and any albums skipped as unavailable. */
function reportWrite(
  node: HTMLElement,
  target: CommitTarget,
  result: { playlist?: Playlist; added: number[]; skipped: number[] },
): void {
  node.hidden = false;
  const added = result.added.length;
  const tracks = `${added} track${added === 1 ? "" : "s"}`;
  let text =
    target.type === "new"
      ? `Created "${result.playlist?.name ?? target.name}" with ${tracks}.`
      : `Added ${tracks} to the playlist${
          result.skipped.length > 0
            ? ` (${result.skipped.length} already present, skipped)`
            : ""
        }.`;
  const unavailable = groupsWithState("unavailable").map(groupName);
  if (unavailable.length > 0) {
    text += ` Skipped ${unavailable.length} album${
      unavailable.length === 1 ? "" : "s"
    } with no available version: ${unavailable.join(", ")}.`;
  }
  if (unresolvedAlbums.length > 0) {
    text += ` Could not find ${unresolvedAlbums.length} album${
      unresolvedAlbums.length === 1 ? "" : "s"
    }: ${unresolvedAlbums.join(", ")}.`;
  }
  if (unavailable.length > 0 || unresolvedAlbums.length > 0) {
    text +=
      " These may be restricted in your region; check them manually on Qobuz to see if they are available.";
  }
  node.textContent = text;
}
