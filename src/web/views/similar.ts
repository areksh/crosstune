/**
 * Similar-artists view.
 *
 * Drives the estimate -> walk -> fetch tracks -> preview -> commit flow. As
 * the settings change, the server estimates the run's largest outcome and the
 * view shows it (a large run must be confirmed). The walk finds the similar
 * artists in one request; their tracks are then fetched in small batches, so
 * no single request runs long enough for the browser to abort it. The preview
 * shows each seed with the similar artists found from it (indented, labelled
 * with who they were found from); the user unticks or re-ticks tracks, chooses
 * a destination, then commits. This is DOM glue; the walk, the estimate and the
 * filtering live in the tested server modules.
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

type FoundArtist = Omit<SimilarGroup, "tracks" | "excluded">;

interface WalkResponse {
  seeds: SeedGroup[];
  found: FoundArtist[];
  unresolvedArtists: string[];
  emptyArtists: UnderfilledArtist[];
  partialArtists: UnderfilledArtist[];
  truncated: boolean;
}

interface TracksResponse {
  fetched: { artist: Artist; tracks: Track[]; excluded: SimilarGroup["excluded"] }[];
  emptyArtists: UnderfilledArtist[];
  partialArtists: UnderfilledArtist[];
}

interface EstimateResponse {
  large: boolean;
  summary: string;
}

/** Artists per `/api/similar/tracks` request: a few seconds of work each. */
const TRACK_BATCH = 25;

/** Inputs whose change alters the estimate. */
const ESTIMATE_INPUTS = [
  "similar-artists",
  "similar-seed-tracks",
  "similar-source-playlist",
  "similar-max-seeds",
  "similar-per-artist",
  "similar-depth",
  "similar-max-artists",
  "similar-tracks",
];

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
  for (const id of ESTIMATE_INPUTS) {
    el(id).addEventListener("input", scheduleEstimate);
    el(id).addEventListener("change", scheduleEstimate);
  }
  scheduleEstimate();
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
    void loadPlaylists().then(scheduleEstimate);
  }
  scheduleEstimate();
}

/**
 * The request body for the current settings, or a message saying what is
 * missing. Number fields are sent as typed; the server validates them.
 */
function settingsBody(): { body: Record<string, unknown> } | { missing: string } {
  let source: unknown;
  if (checkedValue("similar-source", "artists") === "playlist") {
    const playlistId = el<HTMLSelectElement>("similar-source-playlist").value;
    if (playlistId === "") {
      return { missing: "Choose a playlist." };
    }
    source = {
      type: "playlist",
      playlistId: Number(playlistId),
      maxSeeds: numberInput("similar-max-seeds"),
    };
  } else {
    const artists = readTerms("similar-artists");
    if (artists.length === 0) {
      return { missing: "Enter at least one artist." };
    }
    source = { type: "artists", artists, tracksPerSeed: numberInput("similar-seed-tracks") };
  }
  return {
    body: {
      source,
      similarPerArtist: numberInput("similar-per-artist"),
      depth: numberInput("similar-depth"),
      maxArtists: numberInput("similar-max-artists"),
      tracksPerSimilar: numberInput("similar-tracks"),
      filter: {
        excludeTracks: readTerms("similar-exclude-tracks"),
        excludeAlbums: readTerms("similar-exclude-albums"),
      },
    },
  };
}

let estimateTimer: ReturnType<typeof setTimeout> | undefined;
let estimateRequest = 0;

/** Refresh the estimate shortly after the settings stop changing. */
function scheduleEstimate(): void {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => void refreshEstimate(), 300);
}

/** Ask the server to size the current settings and show the result. */
async function refreshEstimate(): Promise<EstimateResponse | undefined> {
  const node = el("similar-estimate");
  const settings = settingsBody();
  if ("missing" in settings) {
    node.hidden = true;
    return undefined;
  }
  const request = (estimateRequest += 1);
  try {
    const estimate = await api<EstimateResponse>("POST", "/api/similar/estimate", settings.body);
    if (request === estimateRequest) {
      node.hidden = false;
      node.classList.toggle("large", estimate.large);
      node.textContent = estimate.large
        ? `This is a very large run: ${estimate.summary}. You will be asked to confirm.`
        : `This run could add ${estimate.summary}.`;
    }
    return estimate;
  } catch (error) {
    if (request === estimateRequest) {
      // Invalid settings: say why here, before the user presses the button.
      node.hidden = false;
      node.classList.add("large");
      node.textContent = (error as Error).message;
    }
    return undefined;
  }
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("resolve-similar");
  const errorNode = el("resolve-similar-error");
  showError(errorNode, undefined);

  const settings = settingsBody();
  if ("missing" in settings) {
    showError(errorNode, settings.missing);
    return;
  }
  const fromPlaylist = checkedValue("similar-source", "artists") === "playlist";

  button.disabled = true;
  button.textContent = "Searching...";
  try {
    const estimate = await refreshEstimate();
    if (
      estimate?.large === true &&
      !window.confirm(`This run could add ${estimate.summary}. Go ahead?`)
    ) {
      return;
    }
    const walk = await api<WalkResponse>("POST", "/api/similar/walk", settings.body);
    const plan = await fetchTracksInBatches(walk, settings.body, button);
    renderPreview(plan, fromPlaylist);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Find similar artists";
  }
}

/**
 * Fetch the walked artists' top tracks a batch at a time (showing progress on
 * the button), and join them into a plan. Artists with no tracks are dropped
 * and flagged, as the server does for a seed.
 */
async function fetchTracksInBatches(
  walk: WalkResponse,
  body: Record<string, unknown>,
  button: HTMLButtonElement,
): Promise<PlanResponse> {
  const byId = new Map<number, TracksResponse["fetched"][number]>();
  const emptyArtists = [...walk.emptyArtists];
  const partialArtists = [...walk.partialArtists];
  const total = walk.found.length;
  for (let start = 0; start < total; start += TRACK_BATCH) {
    button.textContent = `Fetching tracks ${start}/${total}...`;
    const batch = walk.found.slice(start, start + TRACK_BATCH).map((f) => f.artist);
    const result = await api<TracksResponse>("POST", "/api/similar/tracks", {
      artists: batch,
      tracksPerSimilar: body["tracksPerSimilar"],
      filter: body["filter"],
    });
    for (const entry of result.fetched) {
      byId.set(entry.artist.id, entry);
    }
    emptyArtists.push(...result.emptyArtists);
    partialArtists.push(...result.partialArtists);
  }
  const similar: SimilarGroup[] = [];
  for (const node of walk.found) {
    const entry = byId.get(node.artist.id);
    if (entry !== undefined) {
      similar.push({ ...node, tracks: entry.tracks, excluded: entry.excluded });
    }
  }
  return {
    seeds: walk.seeds,
    similar,
    unresolvedArtists: walk.unresolvedArtists,
    emptyArtists,
    partialArtists,
    truncated: walk.truncated,
  };
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
      ? `Stopped at ${numberInput("similar-max-artists")} similar artists. Raise that limit, or lower the depth or the similar artists per artist, for a fuller walk.`
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
