/**
 * Managed playlists view.
 *
 * Lists the jobs (managed playlists) with their schedule, last run and next
 * run, with Run now, Preview, Pause/Resume, Edit and Delete; and a form to
 * create or edit one, with a preview of its next refresh. The New releases and
 * Similar artists views open this form prefilled ("Keep this updated...").
 * This is DOM glue; the jobs live in src/jobs/ (the wording in format.ts).
 */

import {
  describeResult,
  describeSchedule,
  describeWindow,
  formatPreview,
  formatRunSummary,
} from "../../jobs/format.js";
import type { ArtistRef, Job, JobState } from "../../jobs/model.js";
import type { RefreshPreview } from "../../jobs/refresh.js";
import type { RunSummary } from "../../jobs/run-due.js";
import type { JobView } from "../../jobs/service.js";
import type { GlobalFlags, RunRecord } from "../../jobs/stores.js";
import { api, type Playlist } from "../api.js";
import { el, showError } from "../dom.js";
import { storePrefill } from "../prefill.js";
import { readTerms } from "../tracks.js";

interface JobsList {
  jobs: JobView[];
  invalid: { index: number; id?: string; error: string }[];
  flags: GlobalFlags;
}

/** The job being edited, or undefined for a new one. */
let editing: Job | undefined;
/** The resolved artists of the job being edited, and the text they came from. */
let editingArtists: { text: string; artists: ArtistRef[] } | undefined;
let playlistsLoaded = false;
let request = 0;

/** Wire up the managed playlists view. Call once on load. */
export function initManagedView(): void {
  window.addEventListener("hashchange", () => {
    if (isShown()) {
      void load();
    }
  });
  if (isShown()) {
    void load();
  }
  el("managed-new").addEventListener("click", () => openForm(undefined));
  el("managed-cancel").addEventListener("click", closeForm);
  el("managed-preview").addEventListener("click", () => void onPreview());
  el("managed-save").addEventListener("click", () => void onSave());
  el("managed-source").addEventListener("change", syncForm);
  el("managed-window-type").addEventListener("change", syncForm);
  el("managed-every").addEventListener("change", syncForm);
  // A prefill from another view ends by setting this field: show the form.
  el("managed-prefilled").addEventListener("change", () => {
    const include = el<HTMLInputElement>("managed-prefill-include").value;
    if (include !== "") {
      const kinds = new Set(include.split(","));
      for (const box of document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]')) {
        box.checked = kinds.has(box.value);
      }
    }
    showForm("New managed playlist");
  });
}

/**
 * Open the form here, prefilled from another view: the New releases view
 * (source, window, kinds, filters) or the Similar view (artists and similar).
 */
export function keepUpdated(fields: Record<string, string>, include?: readonly string[]): void {
  openForm(undefined);
  // Always set (even empty), so kinds from an earlier prefill do not linger.
  fields = { ...fields, "managed-prefill-include": include?.join(",") ?? "" };
  storePrefill({ view: "managed", fields: { ...fields, "managed-prefilled": String(Date.now()) } });
  location.hash = "#/managed";
}

function isShown(): boolean {
  return location.hash.replace(/^#\/?/, "") === "managed";
}

async function load(): Promise<void> {
  const mine = ++request;
  const status = el("managed-status");
  showError(el("managed-error"), undefined);
  let list: JobsList;
  try {
    list = await api<JobsList>("GET", "/api/jobs");
  } catch (error) {
    if (mine === request) {
      status.hidden = true;
      showError(el("managed-error"), (error as Error).message);
    }
    return;
  }
  if (mine !== request) {
    return;
  }
  renderFlags(list);
  const container = el("managed-list");
  container.textContent = "";
  for (const view of list.jobs) {
    container.appendChild(renderJob(view));
  }
  status.hidden = list.jobs.length > 0;
  status.textContent = "No managed playlists yet. Make one with New managed playlist.";
}

function renderFlags(list: JobsList): void {
  const lines = [
    ...(list.flags.needsSignIn !== undefined
      ? ["Managed playlists are stopped: the Qobuz session expired. Sign in again with qobuz-helper login."]
      : []),
    ...(list.flags.bundleBroken !== undefined
      ? [`Managed playlists are stopped: Qobuz changed its web player (${list.flags.bundleBroken.message}). Update qobuz-helper.`]
      : []),
    ...list.invalid.map(
      (bad) => `A job in jobs.json (${bad.id ?? `#${bad.index + 1}`}) is invalid and skipped: ${bad.error}`,
    ),
  ];
  const node = el("managed-flags");
  node.hidden = lines.length === 0;
  node.textContent = lines.join(" ");
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function button(label: string, onClick: () => void, secondary = true): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (secondary) {
    node.className = "secondary";
  }
  node.addEventListener("click", onClick);
  return node;
}

function describeArtists(job: Job): string {
  const { artists, similar } = job.recipe;
  const base =
    artists.type === "list"
      ? artists.artists.map((artist) => artist.name).join(", ")
      : artists.type === "favourites"
        ? "Your favourite artists"
        : "The artists of a playlist";
  return similar === undefined ? base : `${base}, and ${similar.perArtist} similar artists each`;
}

function describeStatus(job: Job, state: JobState): { text: string; attention: boolean } {
  if (!job.enabled) {
    return { text: "Paused.", attention: false };
  }
  if (state.paused !== undefined) {
    return { text: "Paused: its playlist was deleted. Resume to make a new one.", attention: true };
  }
  const last =
    state.lastResult === undefined
      ? "Not run yet"
      : `Last run ${new Date(state.lastResult.at).toLocaleString()}: ${describeResult(state.lastResult)}`;
  const next =
    state.nextRunAt === undefined ? "next: as soon as possible" : `next ${new Date(state.nextRunAt).toLocaleString()}`;
  const failing = state.consecutiveFailures >= 3;
  return { text: `${last}; ${next}.`, attention: failing || state.lastResult?.status === "failed" };
}

function renderJob({ job, state, recentRuns }: JobView): HTMLElement {
  const card = document.createElement("article");
  card.className = `managed-job${job.enabled ? "" : " disabled"}`;
  card.appendChild(text("h3", "", job.name));
  card.appendChild(text("p", "managed-meta", describeArtists(job)));
  card.appendChild(
    text(
      "p",
      "managed-meta",
      `${describeSchedule(job.schedule)} · ${describeWindow(job.recipe.window)} · ${job.edits === "respect" ? "respects your edits" : "strict mirror"}`,
    ),
  );
  const status = describeStatus(job, state);
  card.appendChild(text("p", `managed-status${status.attention ? " attention" : ""}`, status.text));
  const note = el("managed-error");

  const actions = document.createElement("div");
  actions.className = "managed-actions";
  const runNow = button("Run now", () => void run(job, false, runNow, card), false);
  actions.appendChild(runNow);
  const previewButton = button("Preview", () => void run(job, true, previewButton, card));
  actions.appendChild(previewButton);
  actions.appendChild(
    button(job.enabled ? "Pause" : "Resume", () =>
      void call(note, () =>
        state.paused !== undefined && job.enabled
          ? api("POST", `/api/jobs/${job.id}/resume`, {})
          : api("POST", `/api/jobs/${job.id}/enabled`, { enabled: !job.enabled }),
      ),
    ),
  );
  if (state.paused !== undefined && job.enabled) {
    (actions.lastChild as HTMLButtonElement).textContent = "Resume";
  }
  actions.appendChild(button("Edit", () => openForm(job)));
  actions.appendChild(button("Delete...", () => confirmDelete(job, state, actions)));
  if (recentRuns.length > 0) {
    actions.appendChild(button("Runs", () => toggleRuns(card, recentRuns)));
  }
  card.appendChild(actions);
  return card;
}

function toggleRuns(card: HTMLElement, runs: readonly RunRecord[]): void {
  const existing = card.querySelector(".managed-runs");
  if (existing !== null) {
    existing.remove();
    return;
  }
  const list = document.createElement("ul");
  list.className = "managed-runs";
  for (const record of runs) {
    list.appendChild(
      text("li", "", `${new Date(record.at).toLocaleString()}: ${describeResult(record.result)}`),
    );
  }
  card.appendChild(list);
}

function confirmDelete(job: Job, state: JobState, actions: HTMLElement): void {
  actions.textContent = "";
  actions.appendChild(text("span", "managed-meta", `Delete "${job.name}"?`));
  const note = el("managed-error");
  actions.appendChild(
    button("Delete the job only", () => void call(note, () => api("DELETE", `/api/jobs/${job.id}`, {}))),
  );
  if (state.playlistId !== undefined) {
    actions.appendChild(
      button(
        "Delete the job and its playlist",
        () => void call(note, () => api("DELETE", `/api/jobs/${job.id}`, { deletePlaylist: true })),
        false,
      ),
    );
  }
  actions.appendChild(button("Cancel", () => void load()));
}

/** Run an action, then reload the list (or show its error). */
async function call(errorNode: HTMLElement, action: () => Promise<unknown>): Promise<void> {
  showError(errorNode, undefined);
  try {
    await action();
  } catch (error) {
    showError(errorNode, (error as Error).message);
  }
  await load();
}

async function run(job: Job, dryRun: boolean, trigger: HTMLButtonElement, card: HTMLElement): Promise<void> {
  const label = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = dryRun ? "Checking..." : "Running...";
  card.querySelector(".managed-outcome")?.remove();
  try {
    const { summary } = await api<{ summary: RunSummary }>("POST", `/api/jobs/${job.id}/run`, { dryRun });
    const report = summary.reports[0];
    if (dryRun || report === undefined) {
      const wording =
        dryRun && report !== undefined
          ? `Next refresh: ${describeResult(report.result).replace(/^\w+: /, "")}`
          : formatRunSummary(summary);
      card.appendChild(text("p", "managed-outcome result", wording));
      return;
    }
    await load();
  } catch (error) {
    card.appendChild(text("p", "managed-outcome error", (error as Error).message));
  } finally {
    trigger.disabled = false;
    trigger.textContent = label;
  }
}

// --- the form -----------------------------------------------------------------

function showForm(title: string): void {
  el("managed-form-title").textContent = title;
  el("managed-form-panel").hidden = false;
  showError(el("managed-form-error"), undefined);
  el("managed-preview-result").hidden = true;
  syncForm();
  el("managed-form-panel").scrollIntoView({ block: "start" });
}

function closeForm(): void {
  el("managed-form-panel").hidden = true;
  editing = undefined;
  editingArtists = undefined;
}

function setValue(id: string, value: string): void {
  el<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id).value = value;
}

function openForm(job: Job | undefined): void {
  editing = job;
  editingArtists = undefined;
  const recipe = job?.recipe;
  setValue("managed-name", job?.name ?? "");
  setValue("managed-source", recipe?.artists.type ?? "list");
  const listed = recipe?.artists.type === "list" ? recipe.artists.artists : [];
  const artistText = listed.map((artist) => artist.name).join("\n");
  setValue("managed-artists", artistText);
  if (recipe?.artists.type === "list") {
    editingArtists = { text: artistText, artists: recipe.artists.artists };
  }
  if (recipe?.artists.type === "playlist") {
    void loadPlaylists().then(() => setValue("managed-playlist", String(recipe.artists.type === "playlist" ? recipe.artists.playlistId : "")));
  }
  setValue("managed-similar", String(recipe?.similar?.perArtist ?? 0));
  const window = recipe?.window ?? { type: "last-days", days: 30 };
  setValue("managed-window-type", window.type);
  setValue("managed-window-days", String(window.type === "last-days" ? window.days : 30));
  setValue("managed-window-date", window.type === "since" ? window.date : "");
  setValue("managed-window-count", String(window.type === "latest-per-artist" ? window.count : 1));
  const include = new Set<string>(recipe?.include ?? ["album", "ep-single"]);
  for (const box of document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]')) {
    box.checked = include.has(box.value);
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="managed-edits"]')) {
    radio.checked = radio.value === (job?.edits ?? "respect");
  }
  const schedule = job?.schedule ?? { every: "day", at: "06:00" };
  setValue("managed-every", schedule.every);
  setValue("managed-weekday", String(schedule.every === "week" ? schedule.weekday : 1));
  setValue("managed-at", schedule.every === "hour" ? "06:00" : schedule.at);
  setValue("managed-max-releases", String(job?.shape?.maxReleases ?? ""));
  setValue("managed-max-tracks", String(job?.shape?.maxTracks ?? ""));
  setValue("managed-max-minutes", String(job?.shape?.maxMinutes ?? ""));
  setValue("managed-exclude-artists", (recipe?.exclude?.excludeArtists ?? []).join("\n"));
  setValue("managed-exclude-albums", (recipe?.exclude?.excludeAlbums ?? []).join("\n"));
  setValue("managed-exclude-tracks", (recipe?.exclude?.excludeTracks ?? []).join("\n"));
  el<HTMLInputElement>("managed-hide-favourites").checked = recipe?.hideFavourites ?? false;
  el<HTMLInputElement>("managed-public").checked = job?.isPublic ?? false;
  showForm(job === undefined ? "New managed playlist" : `Edit "${job.name}"`);
}

/** Show the fields that apply to the chosen source, window and schedule. */
function syncForm(): void {
  const source = el<HTMLSelectElement>("managed-source").value;
  el("managed-artists-field").hidden = source !== "list";
  el("managed-playlist-field").hidden = source !== "playlist";
  if (source === "playlist") {
    void loadPlaylists();
  }
  const window = el<HTMLSelectElement>("managed-window-type").value;
  el("managed-window-days-field").hidden = window !== "last-days";
  el("managed-window-date-field").hidden = window !== "since";
  el("managed-window-count-field").hidden = window !== "latest-per-artist";
  const every = el<HTMLSelectElement>("managed-every").value;
  el("managed-weekday-field").hidden = every !== "week";
  el("managed-at-field").hidden = every === "hour";
}

async function loadPlaylists(): Promise<void> {
  if (playlistsLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>("managed-playlist");
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    select.textContent = "";
    for (const playlist of playlists) {
      select.appendChild(new Option(playlist.name, String(playlist.id)));
    }
    playlistsLoaded = true;
  } catch (error) {
    showError(el("managed-form-error"), (error as Error).message);
  }
}

function optionalNumber(id: string): number | undefined {
  const raw = el<HTMLInputElement>(id).value.trim();
  return raw === "" ? undefined : Number(raw);
}

/** The artists typed in the form, looked up (reusing an edited job's when unchanged). */
async function listedArtists(): Promise<ArtistRef[]> {
  const typed = el<HTMLTextAreaElement>("managed-artists").value;
  if (editingArtists !== undefined && editingArtists.text === typed) {
    return editingArtists.artists;
  }
  const queries = readTerms("managed-artists");
  if (queries.length === 0) {
    throw new Error("List at least one artist.");
  }
  const { artists, problems } = await api<{ artists: ArtistRef[]; problems: string[] }>(
    "POST",
    "/api/jobs/artists",
    { queries },
  );
  if (problems.length > 0) {
    throw new Error(`No Qobuz artist found for: ${problems.join(", ")}`);
  }
  editingArtists = { text: typed, artists };
  return artists;
}

/** The job definition the form describes (looking up typed artists). */
async function readForm(): Promise<Record<string, unknown>> {
  const name = el<HTMLInputElement>("managed-name").value.trim();
  if (name === "") {
    throw new Error("Give the playlist a name.");
  }
  const source = el<HTMLSelectElement>("managed-source").value;
  let artists: unknown;
  if (source === "list") {
    artists = { type: "list", artists: await listedArtists() };
  } else if (source === "playlist") {
    const id = el<HTMLSelectElement>("managed-playlist").value;
    if (id === "") {
      throw new Error("Choose a playlist.");
    }
    artists = { type: "playlist", playlistId: Number(id) };
  } else {
    artists = { type: "favourites" };
  }
  const windowType = el<HTMLSelectElement>("managed-window-type").value;
  const window =
    windowType === "since"
      ? { type: "since", date: el<HTMLInputElement>("managed-window-date").value }
      : windowType === "latest-per-artist"
        ? { type: "latest-per-artist", count: Number(el<HTMLInputElement>("managed-window-count").value) }
        : { type: "last-days", days: Number(el<HTMLInputElement>("managed-window-days").value) };
  const every = el<HTMLSelectElement>("managed-every").value;
  const at = el<HTMLInputElement>("managed-at").value || "06:00";
  const schedule =
    every === "hour"
      ? { every }
      : every === "week"
        ? { every, weekday: Number(el<HTMLSelectElement>("managed-weekday").value), at }
        : { every, at };
  const similar = Number(el<HTMLInputElement>("managed-similar").value);
  const exclude = {
    excludeArtists: readTerms("managed-exclude-artists"),
    excludeAlbums: readTerms("managed-exclude-albums"),
    excludeTracks: readTerms("managed-exclude-tracks"),
  };
  const shape = {
    maxReleases: optionalNumber("managed-max-releases"),
    maxTracks: optionalNumber("managed-max-tracks"),
    maxMinutes: optionalNumber("managed-max-minutes"),
  };
  const edits =
    document.querySelector<HTMLInputElement>('input[name="managed-edits"]:checked')?.value ?? "respect";
  return {
    name,
    kind: "managed-playlist",
    enabled: editing?.enabled ?? true,
    isPublic: el<HTMLInputElement>("managed-public").checked,
    edits,
    schedule,
    recipe: {
      type: "new-releases",
      artists,
      window,
      include: [
        ...document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]:checked'),
      ].map((box) => box.value),
      hideFavourites: el<HTMLInputElement>("managed-hide-favourites").checked,
      ...(similar > 0 && { similar: { perArtist: similar, refreshDays: 30 } }),
      exclude,
    },
    shape: Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined)),
  };
}

async function onPreview(): Promise<void> {
  const trigger = el<HTMLButtonElement>("managed-preview");
  const errorNode = el("managed-form-error");
  const result = el("managed-preview-result");
  showError(errorNode, undefined);
  result.hidden = true;
  trigger.disabled = true;
  trigger.textContent = "Checking...";
  try {
    const job = await readForm();
    const { preview } = await api<{ preview: RefreshPreview }>("POST", "/api/jobs/preview", { job });
    result.hidden = false;
    result.textContent = formatPreview(String(job["name"]), preview);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    trigger.disabled = false;
    trigger.textContent = "Preview";
  }
}

async function onSave(): Promise<void> {
  const trigger = el<HTMLButtonElement>("managed-save");
  const errorNode = el("managed-form-error");
  showError(errorNode, undefined);
  trigger.disabled = true;
  trigger.textContent = "Saving...";
  try {
    const definition = await readForm();
    const { job } = await (editing === undefined
      ? api<{ job: Job }>("POST", "/api/jobs", { job: definition })
      : api<{ job: Job }>("PUT", `/api/jobs/${editing.id}`, { job: definition }));
    trigger.textContent = "Refreshing...";
    await api<{ summary: RunSummary }>("POST", `/api/jobs/${job.id}/run`, {});
    closeForm();
    await load();
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    trigger.disabled = false;
    trigger.textContent = "Save and refresh now";
  }
}
