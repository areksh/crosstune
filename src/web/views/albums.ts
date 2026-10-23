/**
 * Playlist-from-albums view.
 *
 * Drives the resolve -> preview -> commit flow: resolve "Artist - Album" lines
 * to their matching Qobuz releases, let the user pick which version of each to
 * use (defaulting to a global preference), choose a destination (a new playlist
 * or an existing one), then commit. This is DOM glue; the matching and commit
 * logic lives in the tested server modules. The version ranking is mirrored here
 * only so the preview can show and send the chosen release.
 */

import { api, type Album, type Playlist } from "../api.js";
import { el, showError } from "../dom.js";

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
 * The destination captured on the first commit click and kept for the whole
 * cycle, so retries after a failed fetch write to the same place. Nothing is
 * written until every album has been fetched, so the playlist is only created
 * once, at the end, in the user's original order.
 */
let commitTarget: CommitTarget | undefined;

/** Fetched track ids per album group (keyed by group index), for the final write. */
const fetchedTracks = new Map<number, number[]>();

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
}

function globalPreference(): Preference {
  return el<HTMLSelectElement>("album-prefer").value as Preference;
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("resolve-albums");
  const errorNode = el("resolve-albums-error");
  showError(errorNode, undefined);

  const entries = el<HTMLTextAreaElement>("albums")
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (entries.length === 0) {
    showError(errorNode, "Enter at least one album.");
    return;
  }

  button.disabled = true;
  button.textContent = "Loading...";
  try {
    const result = await api<ResolveResponse>("POST", "/api/resolve-albums", {
      entries,
    });
    resolvedAlbums = result.resolvedAlbums;
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
  const unresolvedNode = el("albums-unresolved");
  if (result.unresolvedAlbums.length > 0) {
    unresolvedNode.hidden = false;
    unresolvedNode.textContent = `Could not find: ${result.unresolvedAlbums.join(", ")}`;
  } else {
    unresolvedNode.hidden = true;
  }

  const groups = el("album-groups");
  groups.textContent = "";
  result.resolvedAlbums.forEach((resolved, index) => {
    groups.appendChild(renderAlbumGroup(resolved, index));
  });

  // A fresh preview starts a new commit cycle: the destination is choosable
  // again, nothing has been fetched or written yet.
  commitTarget = undefined;
  committed = false;
  fetchedTracks.clear();
  setDestinationEnabled(true);

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

  const heading = document.createElement("h4");
  heading.textContent = resolved.query;
  group.appendChild(heading);

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

  group.appendChild(select);
  return group;
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
 * Locked albums (already added, or with no version left) are left untouched, and
 * versions that already failed to fetch (disabled options) are not re-chosen.
 */
function onPreferChange(): void {
  const preference = globalPreference();
  for (const group of pendingGroups()) {
    const select = selectOf(group);
    const preferred = selectVersion(enabledVersions(group), preference);
    if (preferred !== undefined) {
      select.value = preferred.id;
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

/**
 * Album groups that still need fetching: not yet fetched ("ready"), written
 * ("added") or exhausted of versions ("unavailable"). Order follows the DOM,
 * which is the order the user entered.
 */
function pendingGroups(): HTMLElement[] {
  const done = new Set(["ready", "added", "unavailable"]);
  return [...document.querySelectorAll<HTMLElement>(".album-group")].filter(
    (group) => !done.has(group.dataset["state"] ?? "pending"),
  );
}

function updateSelectedCount(): void {
  const count = resolvedAlbums.length;
  el("albums-selected-count").textContent = `${count} album${count === 1 ? "" : "s"} selected.`;
  el<HTMLButtonElement>("commit-albums").disabled = count === 0;
}

function onTargetChange(): void {
  const target = selectedTarget();
  el("album-new-fields").hidden = target !== "new";
  el("album-existing-fields").hidden = target !== "existing";
  el<HTMLButtonElement>("commit-albums").textContent =
    target === "new" ? "Create playlist" : "Add to playlist";
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
 * Fetch the pending albums' tracks, and once nothing is left to retry, write the
 * whole playlist in one go.
 *
 * Nothing is written to Qobuz until *every* album has been fetched. Successful
 * albums are cached and locked; failed ones drop to their next-best version for
 * the user to retry. Only when no album is still pending do we assemble the
 * cached tracks in the user's original order and create/add the playlist, so a
 * retried album keeps its place instead of being appended after a partial write.
 */
async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit-albums");
  const errorNode = el("commit-albums-error");
  const resultNode = el("commit-albums-result");
  showError(errorNode, undefined);

  // Capture the destination on the first click and keep it for the whole cycle.
  if (commitTarget === undefined) {
    const target = buildTarget();
    if (target === undefined) {
      showError(errorNode, "Choose a destination.");
      return;
    }
    commitTarget = target;
  }

  button.disabled = true;
  try {
    const toFetch = pendingGroups()
      .map((group) => ({ group, id: selectOf(group).value }))
      .filter((item) => item.id !== "");

    if (toFetch.length > 0) {
      button.textContent = "Fetching...";
      const result = await api<{
        fetched: { albumId: string; tracks: { track: { id: number } }[] }[];
        failedAlbumIds?: string[];
      }>("POST", "/api/album-tracks", { albumIds: toFetch.map((item) => item.id) });

      // Once a fetch has run the destination is fixed for the rest of the cycle.
      setDestinationEnabled(false);

      const byAlbum = new Map(
        result.fetched.map((f) => [f.albumId, f.tracks.map((t) => t.track.id)]),
      );
      for (const { group, id } of toFetch) {
        const trackIds = byAlbum.get(id);
        if (trackIds !== undefined) {
          fetchedTracks.set(Number(group.dataset["index"]), trackIds);
          markGroupReady(group);
        } else {
          // Not returned means it failed: grey out the version and advance.
          markGroupFailed(group, id);
        }
      }
    }

    // Write only when nothing is left to retry (unavailable albums are skipped).
    if (pendingGroups().length === 0) {
      await writePlaylist(resultNode);
    } else {
      reportFetchProgress(resultNode);
    }
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    updateCommitButton();
  }
}

/**
 * Assemble the cached tracks of every fetched album, in the user's original
 * order, and create or add the playlist in a single write.
 */
async function writePlaylist(node: HTMLElement): Promise<void> {
  const target = commitTarget!;
  const trackIds: number[] = [];
  const seen = new Set<number>();
  for (const group of document.querySelectorAll<HTMLElement>(".album-group")) {
    const ids = fetchedTracks.get(Number(group.dataset["index"]));
    if (ids === undefined) {
      continue; // an unavailable album with no version that could be fetched
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        trackIds.push(id);
      }
    }
  }
  if (trackIds.length === 0) {
    showError(el("commit-albums-error"), "None of the albums could be fetched.");
    return;
  }

  el<HTMLButtonElement>("commit-albums").textContent = "Saving...";
  const result = await api<{ playlist?: Playlist; added: number[]; skipped: number[] }>(
    "POST",
    "/api/commit",
    { target, trackIds },
  );
  committed = true;
  for (const group of document.querySelectorAll<HTMLElement>(".album-group")) {
    if (group.dataset["state"] === "ready") {
      group.dataset["state"] = "added";
      group.classList.add("album-added");
      setGroupStatus(group, "Added");
    }
  }
  reportWrite(node, target, result);
}

/** Lock an album whose tracks were fetched (cached, awaiting the final write). */
function markGroupReady(group: HTMLElement): void {
  group.dataset["state"] = "ready";
  selectOf(group).disabled = true;
  group.classList.remove("album-failed");
  group.classList.add("album-ready");
  setGroupStatus(group, "Fetched");
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

/** Show or update a short status line under an album group. */
function setGroupStatus(group: HTMLElement, text: string): void {
  let status = group.querySelector<HTMLElement>(".album-status");
  if (status === null) {
    status = document.createElement("div");
    status.className = "album-status";
    group.appendChild(status);
  }
  status.textContent = text;
}

/** Enable or disable the destination controls (locked once a commit has run). */
function setDestinationEnabled(enabled: boolean): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="album-target"]',
  )) {
    radio.disabled = !enabled;
  }
  for (const id of ["album-playlist-name", "album-playlist-public", "album-playlist-select"]) {
    const node = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (node !== null) {
      node.disabled = !enabled;
    }
  }
}

/** The default commit-button label before any fetch has run. */
function defaultCommitLabel(): string {
  return selectedTarget() === "new" ? "Create playlist" : "Add to playlist";
}

/** Set the commit button's label and enabled state from the remaining work. */
function updateCommitButton(): void {
  const button = el<HTMLButtonElement>("commit-albums");
  const total = document.querySelectorAll(".album-group").length;
  if (committed) {
    button.disabled = true;
    button.textContent = "All albums added";
    return;
  }
  if (total === 0) {
    button.disabled = true;
    button.textContent = defaultCommitLabel();
    return;
  }
  button.disabled = false;
  if (pendingGroups().length > 0) {
    button.textContent =
      commitTarget !== undefined ? "Retry failed albums" : defaultCommitLabel();
  } else {
    // Everything fetched but the final write has not gone through yet.
    button.textContent = "Save to playlist";
  }
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

/** Album groups currently in the given state. */
function groupsWithState(state: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".album-group")].filter(
    (group) => group.dataset["state"] === state,
  );
}

/**
 * Report progress after a fetch round that still has albums to retry: nothing is
 * written yet, some albums are ready, some need another version, some have none.
 */
function reportFetchProgress(node: HTMLElement): void {
  node.hidden = false;
  const total = document.querySelectorAll(".album-group").length;
  const ready = groupsWithState("ready").length;
  const retry = pendingGroups().map(groupName);
  const unavailable = groupsWithState("unavailable").map(groupName);

  let text = `Fetched ${ready} of ${total}. Nothing is saved yet.`;
  if (retry.length > 0) {
    text += ` A different version is selected for ${retry.join(", ")} - press Retry.`;
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
