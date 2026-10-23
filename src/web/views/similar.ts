/**
 * Similar-artists view.
 *
 * Drives the resolve -> preview -> commit flow: send the seeds (typed artists
 * or a playlist) and walk settings to the server, show each seed with the
 * similar artists found from it (indented, labelled with who they were found
 * from), let the user untick or re-tick tracks, choose a destination, then
 * commit. This is DOM glue; the walk and the filtering live in the tested
 * server modules.
 */

import { api, type Artist, type Exclusion, type Playlist, type Track } from "../api.js";
import { el, showError } from "../dom.js";
import { readTerms, trackRow } from "../tracks.js";

interface SeedGroup {
  query: string;
  artist: Artist;
  tracks: Track[];
  excluded: { track: Track; exclusion: Exclusion }[];
}

interface SimilarGroup {
  artist: Artist;
  seed: Artist;
  via: Artist;
  level: number;
  tracks: Track[];
  excluded: { track: Track; exclusion: Exclusion }[];
}

interface UnderfilledArtist {
  artist: Artist;
  trackCount: number;
  requested: number;
}

interface PlanResponse {
  seeds: SeedGroup[];
  similar: SimilarGroup[];
  unresolvedArtists: string[];
  emptyArtists: UnderfilledArtist[];
  partialArtists: UnderfilledArtist[];
  truncated: boolean;
}

type CommitTarget =
  | { type: "new"; name: string; isPublic: boolean }
  | { type: "existing"; playlistId: number };

let playlistsLoaded = false;

/** Wire up the similar-artists view. Call once on load. */
export function initSimilarView(): void {
  el("resolve-similar").addEventListener("click", () => void onResolve());
  el("commit-similar").addEventListener("click", () => void onCommit());
  for (const radio of document.querySelectorAll('input[name="similar-source"]')) {
    radio.addEventListener("change", onSourceChange);
  }
  for (const radio of document.querySelectorAll('input[name="similar-target"]')) {
    radio.addEventListener("change", onTargetChange);
  }
}

function checkedValue(name: string, fallback: string): string {
  return (
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? fallback
  );
}

function numberInput(id: string): number {
  return Number(el<HTMLInputElement>(id).value);
}

function onSourceChange(): void {
  const fromPlaylist = checkedValue("similar-source", "artists") === "playlist";
  el("similar-artists-fields").hidden = fromPlaylist;
  el("similar-playlist-fields").hidden = !fromPlaylist;
  if (fromPlaylist) {
    void loadPlaylists();
  }
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("resolve-similar");
  const errorNode = el("resolve-similar-error");
  showError(errorNode, undefined);

  const fromPlaylist = checkedValue("similar-source", "artists") === "playlist";
  let source: unknown;
  if (fromPlaylist) {
    const playlistId = el<HTMLSelectElement>("similar-source-playlist").value;
    if (playlistId === "") {
      showError(errorNode, "Choose a playlist.");
      return;
    }
    source = {
      type: "playlist",
      playlistId: Number(playlistId),
      maxSeeds: numberInput("similar-max-seeds"),
    };
  } else {
    const artists = readTerms("similar-artists");
    if (artists.length === 0) {
      showError(errorNode, "Enter at least one artist.");
      return;
    }
    source = { type: "artists", artists, tracksPerSeed: numberInput("similar-seed-tracks") };
  }

  button.disabled = true;
  button.textContent = "Searching...";
  try {
    const plan = await api<PlanResponse>("POST", "/api/similar/resolve", {
      source,
      similarPerArtist: numberInput("similar-per-artist"),
      depth: numberInput("similar-depth"),
      tracksPerSimilar: numberInput("similar-tracks"),
      filter: {
        excludeTracks: readTerms("similar-exclude-tracks"),
        excludeAlbums: readTerms("similar-exclude-albums"),
      },
    });
    renderPreview(plan, fromPlaylist);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Find similar artists";
  }
}

function renderPreview(plan: PlanResponse, fromPlaylist: boolean): void {
  const names = (list: UnderfilledArtist[]): string => list.map((a) => a.artist.name).join(", ");
  showError(
    el("similar-unresolved"),
    plan.unresolvedArtists.length > 0
      ? `Could not find: ${plan.unresolvedArtists.join(", ")}`
      : plan.seeds.length === 0
        ? "No artists to start from: the playlist has no tracks with an artist."
        : undefined,
  );
  showError(
    el("similar-truncated"),
    plan.truncated
      ? "Stopped at 100 similar artists. Lower the depth or the similar artists per artist for a fuller walk."
      : undefined,
  );
  showError(
    el("similar-empty"),
    plan.emptyArtists.length > 0
      ? `No tracks found (skipped): ${names(plan.emptyArtists)}`
      : undefined,
  );
  showError(
    el("similar-partial"),
    plan.partialArtists.length > 0
      ? `Fewer tracks than requested: ${plan.partialArtists
          .map((a) => `${a.artist.name} (${a.trackCount} of ${a.requested})`)
          .join(", ")}`
      : undefined,
  );

  const groups = el("similar-groups");
  groups.textContent = "";
  for (const seed of plan.seeds) {
    groups.appendChild(
      renderSeed(
        seed,
        plan.similar.filter((entry) => entry.seed.id === seed.artist.id),
        fromPlaylist,
      ),
    );
  }

  // Expanding a playlist most naturally adds back into it.
  if (fromPlaylist) {
    void preselectExisting(Number(el<HTMLSelectElement>("similar-source-playlist").value));
  }

  el("similar-preview").hidden = false;
  showError(el("commit-similar-error"), undefined);
  showError(el("commit-similar-result"), undefined);
  updateSelectedCount();
}

function renderSeed(seed: SeedGroup, similar: SimilarGroup[], fromPlaylist: boolean): HTMLElement {
  const group = document.createElement("div");
  group.className = "artist-group";

  const heading = document.createElement("h4");
  heading.textContent = seed.artist.name;
  const note = document.createElement("span");
  note.className = "matched";
  note.textContent = fromPlaylist
    ? " (in the playlist)"
    : seed.tracks.length === 0 && seed.excluded.length === 0
      ? " (none of its own tracks)"
      : "";
  heading.appendChild(note);
  group.appendChild(heading);
  appendTracks(group, seed);

  for (const entry of similar) {
    const sub = document.createElement("div");
    sub.className = "similar-group";
    const title = document.createElement("h5");
    title.textContent = entry.artist.name;
    const from = document.createElement("span");
    from.className = "matched";
    from.textContent =
      entry.level === 1
        ? ` -- similar to ${entry.via.name}`
        : ` -- similar to ${entry.via.name} (via ${entry.seed.name})`;
    title.appendChild(from);
    sub.appendChild(title);
    appendTracks(sub, entry);
    group.appendChild(sub);
  }
  return group;
}

/** Kept tracks ticked, then the excluded ones the filters passed over, unticked. */
function appendTracks(
  parent: HTMLElement,
  entry: { tracks: Track[]; excluded: { track: Track; exclusion: Exclusion }[] },
): void {
  for (const track of entry.tracks) {
    parent.appendChild(trackRow(track, rowOptions(track)));
  }
  for (const { track, exclusion } of entry.excluded) {
    parent.appendChild(trackRow(track, { ...rowOptions(track), exclusion }));
  }
}

function rowOptions(track: Track): { meta?: string; onChange: () => void } {
  return {
    ...(track.album !== undefined && { meta: track.album }),
    onChange: updateSelectedCount,
  };
}

/** The unique, ticked track ids in display order (seed, then its similar artists). */
function selectedTrackIds(): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const box of document.querySelectorAll<HTMLInputElement>(
    "#similar-groups input[type=checkbox]:checked",
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
  const count = selectedTrackIds().length;
  el("similar-selected-count").textContent = `${count} track${count === 1 ? "" : "s"} selected.`;
  el<HTMLButtonElement>("commit-similar").disabled = count === 0;
}

function onTargetChange(): void {
  const target = checkedValue("similar-target", "new");
  el("similar-new-fields").hidden = target !== "new";
  el("similar-existing-fields").hidden = target !== "existing";
  el<HTMLButtonElement>("commit-similar").textContent =
    target === "new" ? "Create playlist" : "Add to playlist";
  if (target === "existing") {
    void loadPlaylists();
  }
}

/** Switch the destination to "existing" with the given playlist selected. */
async function preselectExisting(playlistId: number): Promise<void> {
  const radio = document.querySelector<HTMLInputElement>(
    'input[name="similar-target"][value="existing"]',
  );
  if (radio !== null) {
    radio.checked = true;
    onTargetChange();
  }
  await loadPlaylists();
  el<HTMLSelectElement>("similar-playlist-select").value = String(playlistId);
}

/** Fill both playlist pickers (source and destination) once. */
async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const selects = [
    el<HTMLSelectElement>("similar-source-playlist"),
    el<HTMLSelectElement>("similar-playlist-select"),
  ];
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    for (const select of selects) {
      select.textContent = "";
      if (playlists.length === 0) {
        select.appendChild(new Option("You have no playlists", ""));
        continue;
      }
      for (const playlist of playlists) {
        const label =
          playlist.trackCount === undefined
            ? playlist.name
            : `${playlist.name} (${playlist.trackCount} tracks)`;
        select.appendChild(new Option(label, String(playlist.id)));
      }
    }
    playlistsLoaded = playlists.length > 0;
  } catch (error) {
    for (const select of selects) {
      select.textContent = "";
      select.appendChild(new Option("Could not load playlists", ""));
    }
    showError(el("resolve-similar-error"), (error as Error).message);
  }
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("commit-similar");
  const errorNode = el("commit-similar-error");
  const resultNode = el("commit-similar-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const trackIds = selectedTrackIds();
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
    const result = await api<{ playlist?: Playlist; added: number[]; skipped: number[] }>(
      "POST",
      "/api/commit",
      { target, trackIds },
    );
    resultNode.hidden = false;
    const added = `${result.added.length} track${result.added.length === 1 ? "" : "s"}`;
    resultNode.textContent =
      target.type === "new"
        ? `Created "${result.playlist?.name ?? target.name}" with ${added}.`
        : `Added ${added} to the playlist${
            result.skipped.length > 0
              ? ` (${result.skipped.length} already present, skipped)`
              : ""
          }.`;
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function buildTarget(): CommitTarget | undefined {
  if (checkedValue("similar-target", "new") === "new") {
    const name = el<HTMLInputElement>("similar-playlist-name").value.trim();
    if (name.length === 0) {
      return undefined;
    }
    return {
      type: "new",
      name,
      isPublic: el<HTMLInputElement>("similar-playlist-public").checked,
    };
  }
  const value = el<HTMLSelectElement>("similar-playlist-select").value;
  return value === "" ? undefined : { type: "existing", playlistId: Number(value) };
}
