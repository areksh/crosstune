/**
 * Managed playlists view: a card per playlist, then what manages it -- its
 * source, its tidy-ups, its schedule -- with Run now, Preview, Pause/Resume,
 * Edit, Delete, the run log and any suggestions waiting (accept or ignore).
 * The form manages a new playlist, one of the user's, or the favourites. The
 * New releases, Similar and Combine views open it prefilled ("Keep this
 * updated..."). This is DOM glue; the jobs live in src/jobs/ (the wording in
 * format.ts).
 */

import { shortId, type PlaylistId } from "../../services/ids.js";
import {
  describeResult,
  describeSchedule,
  describeSource,
  describeTidy,
  formatPreview,
  formatRunSummary,
} from "../../jobs/format.js";
import type { ArtistRef, Job, JobState, PlaylistInput, Suggestion } from "../../jobs/model.js";
import type { RefreshPreview } from "../../jobs/refresh.js";
import type { AcceptOutcome, RunSummary } from "../../jobs/run-due.js";
import type { JobView } from "../../jobs/service.js";
import type { GlobalFlags, RunRecord } from "../../jobs/stores.js";
import { parsePlaylistId } from "../../features/qobuz-links.js";
import { api, type Playlist } from "../api.js";
import { el, showError } from "../dom.js";
import { storePrefill } from "../prefill.js";
import { readTerms } from "../tracks.js";

interface JobsList {
  jobs: JobView[];
  invalid: { index: number; id?: string; error: string }[];
  flags: GlobalFlags;
}

type Kind = "none" | NonNullable<Job["source"]>["type"];
type TargetType = Job["target"]["type"];

/** The job being edited, or undefined for a new one. */
let editing: Job | undefined;
/** The resolved artists of the job being edited, and the text they came from. */
let editingArtists: { text: string; artists: ArtistRef[] } | undefined;
/** The user's playlists, loaded once (one shared request, however many ask). */
let playlists: Playlist[] = [];
let playlistsLoad: Promise<void> | undefined;
/** The inputs of a combined or smart source, in the order they were ticked ("favourites" or "p<id>"). */
let chosenInputs: string[] = [];
/** True while Save runs: the form must not change under it. */
let saving = false;
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
  for (const id of ["managed-source", "managed-window-type", "managed-every", "managed-kind", "managed-target-playlist"]) {
    el(id).addEventListener("change", syncForm);
  }
  for (const radio of document.querySelectorAll('input[name="managed-target"]')) {
    radio.addEventListener("change", syncForm);
  }
  for (const kind of ["repair", "upgrade", "dedupe"]) {
    el(`managed-tidy-${kind}`).addEventListener("change", syncForm);
  }
  // A prefill from another view ends by setting this field: show the form.
  el("managed-prefilled").addEventListener("change", () => {
    const include = el<HTMLInputElement>("managed-prefill-include").value;
    if (include !== "") {
      const kinds = new Set(include.split(","));
      for (const box of document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]')) {
        box.checked = kinds.has(box.value);
      }
    }
    const playlist = el<HTMLInputElement>("managed-prefill-playlist").value;
    if (playlist !== "") {
      void selectIn("managed-playlist", playlist as PlaylistId);
    }
    const inputs = el<HTMLInputElement>("managed-prefill-inputs").value;
    if (inputs !== "") {
      chosenInputs = inputs.split(",");
      void renderInputs();
    }
    showForm("Manage a new playlist");
  });
}

/**
 * Open the form here, prefilled from another view: New releases (source,
 * window, kinds, filters), Similar (artists and similar) or Combine (inputs
 * and how to combine them). Fields default to a new releases source.
 */
export function keepUpdated(
  fields: Record<string, string>,
  options: { include?: readonly string[]; playlistId?: PlaylistId; inputs?: readonly PlaylistInput[] } = {},
): void {
  if (saving) {
    return;
  }
  openForm(undefined);
  // Always set (even empty), so values from an earlier prefill do not linger.
  fields = {
    "managed-kind": "new-releases",
    ...fields,
    "managed-prefill-include": options.include?.join(",") ?? "",
    "managed-prefill-playlist": options.playlistId === undefined ? "" : String(options.playlistId),
    "managed-prefill-inputs": (options.inputs ?? []).map(inputKey).join(","),
  };
  storePrefill({ view: "managed", fields: { ...fields, "managed-prefilled": String(Date.now()) } });
  location.hash = "#/managed";
}

function isShown(): boolean {
  return location.hash.replace(/^#\/?/, "") === "managed";
}

function inputKey(input: PlaylistInput): string {
  return input.type === "favourites" ? "favourites" : `p${input.playlistId}`;
}

function inputOfKey(key: string): PlaylistInput {
  return key === "favourites" ? { type: "favourites" } : { type: "playlist", playlistId: key.slice(1) as PlaylistId };
}

function names(): Map<PlaylistId, string> {
  return new Map(playlists.map((playlist) => [playlist.id, playlist.name]));
}

function loadPlaylists(): Promise<void> {
  playlistsLoad ??= (async () => {
    try {
      ({ playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists"));
      for (const id of ["managed-playlist", "managed-target-playlist"]) {
        const select = el<HTMLSelectElement>(id);
        const keep = select.value;
        select.textContent = "";
        select.appendChild(new Option("Choose a playlist", ""));
        for (const playlist of playlists) {
          select.appendChild(new Option(playlist.name, String(playlist.id)));
        }
        select.value = keep;
      }
      void renderInputs();
    } catch (error) {
      playlistsLoad = undefined; // try again next time
      showError(el("managed-form-error"), (error as Error).message);
    }
  })();
  return playlistsLoad;
}

/** Choose a playlist once the list is loaded, adding it when it is not one of yours. */
async function selectIn(selectId: string, playlistId: PlaylistId): Promise<void> {
  await loadPlaylists();
  const select = el<HTMLSelectElement>(selectId);
  const value = String(playlistId);
  if (![...select.options].some((option) => option.value === value)) {
    select.appendChild(new Option(`Playlist ${value}`, value));
  }
  select.value = value;
  syncForm();
}

// --- the list -------------------------------------------------------------------

async function load(): Promise<void> {
  const mine = ++request;
  const status = el("managed-status");
  let list: JobsList;
  try {
    [list] = await Promise.all([api<JobsList>("GET", "/api/jobs"), loadPlaylists()]);
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
  status.textContent = "No managed playlists yet. Start one with Manage a playlist.";
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

function button(label: string, onClick: (event: MouseEvent) => void, secondary = true): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (secondary) {
    node.className = "secondary";
  }
  node.addEventListener("click", onClick);
  return node;
}

/** What the card is titled: the playlist's own name where known. */
function playlistTitle(job: Job, state: JobState): string {
  if (job.target.type === "favourites") {
    return "Favourites";
  }
  const id = job.target.type === "adopted" ? job.target.playlistId : state.playlistId;
  return (id === undefined ? undefined : names().get(id)) ?? job.name;
}

const BADGES: Record<TargetType, string> = {
  created: "made by qobuz-helper",
  adopted: "your playlist",
  favourites: "your favourites",
};

function describeStatus(job: Job, state: JobState): { text: string; attention: boolean } {
  if (!job.enabled) {
    return { text: "Paused.", attention: false };
  }
  if (state.paused !== undefined) {
    return {
      text:
        job.target.type === "adopted"
          ? "Paused: the playlist was deleted or cannot be read. Resume to try again."
          : "Paused: its playlist was deleted. Resume to make a new one.",
      attention: true,
    };
  }
  const last =
    state.lastResult === undefined
      ? "Not run yet"
      : `Last pass ${new Date(state.lastResult.at).toLocaleString()}: ${describeResult(state.lastResult)}`;
  const next =
    state.nextRunAt === undefined ? "next: as soon as possible" : `next ${new Date(state.nextRunAt).toLocaleString()}`;
  const failing = state.consecutiveFailures >= 3;
  return { text: `${last}; ${next}.`, attention: failing || state.lastResult?.status === "failed" };
}

function row(label: string, value: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "managed-fact";
  wrap.appendChild(text("dt", "", label));
  wrap.appendChild(text("dd", "", value));
  return wrap;
}

function renderJob({ job, state, recentRuns, stateError }: JobView): HTMLElement {
  const card = document.createElement("article");
  card.className = `managed-job${job.enabled ? "" : " disabled"}`;
  const head = document.createElement("div");
  head.className = "managed-job-head";
  head.appendChild(text("h3", "", playlistTitle(job, state)));
  head.appendChild(text("span", `managed-badge ${job.target.type}`, BADGES[job.target.type]));
  card.appendChild(head);

  const facts = document.createElement("dl");
  facts.className = "managed-facts";
  facts.appendChild(row("Source", describeSource(job.source, names())));
  facts.appendChild(row("Tidy-ups", describeTidy(job.tidy)));
  facts.appendChild(
    row(
      "Runs",
      `${describeSchedule(job.schedule)}${job.source === undefined ? "" : ` · ${job.edits === "respect" ? "respects your edits" : "strict mirror"}`}`,
    ),
  );
  card.appendChild(facts);

  const status =
    stateError === undefined ? describeStatus(job, state) : { text: `Skipped: ${stateError}.`, attention: true };
  card.appendChild(text("p", `managed-status${status.attention ? " attention" : ""}`, status.text));
  if (state.suggestions.length > 0) {
    card.appendChild(renderSuggestions(job, state.suggestions));
  }
  const note = el("managed-error");

  const actions = document.createElement("div");
  actions.className = "managed-actions";
  const runNow = button("Run now", () => void run(job, false, runNow, card), false);
  actions.appendChild(runNow);
  const previewButton = button("Preview", () => void run(job, true, previewButton, card));
  actions.appendChild(previewButton);
  actions.appendChild(
    button(job.enabled && state.paused === undefined ? "Pause" : "Resume", (event) =>
      void call(note, event, () =>
        // Resume also clears a pause (and enables a job paused by the user).
        state.paused !== undefined || !job.enabled
          ? api("POST", `/api/jobs/${job.id}/resume`, {})
          : api("POST", `/api/jobs/${job.id}/enabled`, { enabled: false }),
      ),
    ),
  );
  actions.appendChild(button("Edit", () => openForm(job)));
  actions.appendChild(button("Delete...", () => confirmDelete(job, state, actions)));
  if (recentRuns.length > 0) {
    actions.appendChild(button("Runs", () => toggleRuns(card, recentRuns)));
  }
  card.appendChild(actions);
  return card;
}

function renderSuggestions(job: Job, suggestions: readonly Suggestion[]): HTMLElement {
  const box = document.createElement("details");
  box.className = "managed-suggestions";
  box.appendChild(
    text("summary", "", `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} waiting`),
  );
  const list = document.createElement("ul");
  const note = el("managed-error");
  for (const suggestion of suggestions) {
    const item = document.createElement("li");
    item.appendChild(text("span", "managed-suggestion-text", suggestion.summary));
    const buttons = document.createElement("span");
    buttons.className = "managed-suggestion-actions";
    buttons.appendChild(button("Accept", (event) => void decide(note, event, job, { accept: [suggestion.key] }), false));
    buttons.appendChild(button("Ignore", (event) => void decide(note, event, job, { ignore: [suggestion.key] })));
    item.appendChild(buttons);
    list.appendChild(item);
  }
  box.appendChild(list);
  if (suggestions.length > 1) {
    const all = document.createElement("div");
    all.className = "managed-actions";
    all.appendChild(button("Accept all", (event) => void decide(note, event, job, { accept: "all" }), false));
    all.appendChild(button("Ignore all", (event) => void decide(note, event, job, { ignore: "all" })));
    box.appendChild(all);
  }
  return box;
}

async function decide(
  errorNode: HTMLElement,
  event: MouseEvent,
  job: Job,
  body: { accept?: string[] | "all"; ignore?: string[] | "all" },
): Promise<void> {
  await call(errorNode, event, async () => {
    const result = await api<{ outcome?: AcceptOutcome }>("POST", `/api/jobs/${job.id}/suggestions`, body);
    const outcome = result.outcome;
    if (outcome !== undefined && outcome.status !== "accepted") {
      throw new Error(outcome.message);
    }
    if (outcome?.status === "accepted" && outcome.stale > 0) {
      throw new Error(`${outcome.stale} suggestion(s) no longer applied and were dropped.`);
    }
  });
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
    list.appendChild(text("li", "", `${new Date(record.at).toLocaleString()}: ${describeResult(record.result)}`));
  }
  card.appendChild(list);
}

function confirmDelete(job: Job, state: JobState, actions: HTMLElement): void {
  actions.textContent = "";
  actions.appendChild(
    text(
      "span",
      "managed-meta",
      job.target.type === "created" ? `Stop managing "${job.name}"?` : `Stop managing it? The playlist itself stays.`,
    ),
  );
  const note = el("managed-error");
  actions.appendChild(
    button("Stop managing", (event) => void call(note, event, () => api("DELETE", `/api/jobs/${job.id}`, {}))),
  );
  if (job.target.type === "created" && state.playlistId !== undefined) {
    actions.appendChild(
      button(
        "Stop and delete the playlist",
        (event) => void call(note, event, () => api("DELETE", `/api/jobs/${job.id}`, { deletePlaylist: true })),
        false,
      ),
    );
  }
  actions.appendChild(button("Cancel", () => void load()));
}

/** Run a card's action (its buttons off meanwhile), reload the list, then show any error. */
async function call(errorNode: HTMLElement, event: MouseEvent, action: () => Promise<unknown>): Promise<void> {
  showError(errorNode, undefined);
  const buttons = (event.currentTarget as HTMLElement | null)?.parentElement?.querySelectorAll("button") ?? [];
  for (const node of buttons) {
    node.disabled = true;
  }
  let failure: string | undefined;
  try {
    await action();
  } catch (error) {
    failure = (error as Error).message;
  }
  await load();
  showError(errorNode, failure);
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
          ? [`Next pass: ${describeResult(report.result).replace(/^\w+: /, "")}`, ...report.result.notes].join("\n")
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

function setChecked(id: string, checked: boolean): void {
  el<HTMLInputElement>(id).checked = checked;
}

function radio(name: string): string {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";
}

function setRadio(name: string, value: string): void {
  for (const node of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    node.checked = node.value === value;
  }
}

function minutes(seconds: number | undefined): string {
  return seconds === undefined ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function openForm(job: Job | undefined): void {
  if (saving) {
    return;
  }
  editing = job;
  editingArtists = undefined;
  void loadPlaylists();
  const source = job?.source;
  const target = job?.target ?? { type: "created", isPublic: false };
  setRadio("managed-target", target.type);
  if (target.type === "adopted") {
    void selectIn("managed-target-playlist", target.playlistId);
  } else {
    setValue("managed-target-playlist", "");
  }
  setValue("managed-name", job?.name ?? "");
  setChecked("managed-public", target.type === "created" && target.isPublic);
  setValue("managed-kind", source?.type ?? (target.type === "created" ? "new-releases" : "none"));

  // Artists (new releases, discovery).
  const artists = source?.type === "new-releases" ? source.artists : source?.type === "discovery" ? source.seeds : undefined;
  setValue("managed-source", artists?.type ?? "list");
  const listed = artists?.type === "list" ? artists.artists : [];
  const artistText = listed.map((artist) => artist.name).join("\n");
  setValue("managed-artists", artistText);
  if (artists?.type === "list") {
    editingArtists = { text: artistText, artists: artists.artists };
  }
  if (artists?.type === "playlist") {
    void selectIn("managed-playlist", artists.playlistId);
  }
  const similar = source?.type === "new-releases" || source?.type === "discovery" ? source.similar?.perArtist : undefined;
  setValue("managed-similar", String(similar ?? (source?.type === "discovery" ? 10 : 0)));

  // New releases.
  const feed = source?.type === "new-releases" ? source : undefined;
  const window = feed?.window ?? { type: "last-days", days: 30 };
  setValue("managed-window-type", window.type);
  setValue("managed-window-days", String(window.type === "last-days" ? window.days : 30));
  setValue("managed-window-date", window.type === "since" ? window.date : "");
  setValue("managed-window-count", String(window.type === "latest-per-artist" ? window.count : 1));
  const include = new Set<string>(feed?.include ?? ["album", "ep-single"]);
  for (const box of document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]')) {
    box.checked = include.has(box.value);
  }
  setChecked("managed-hide-favourites", feed?.hideFavourites ?? false);

  // Combined and smart inputs.
  chosenInputs =
    source?.type === "combined" ? source.inputs.map(inputKey) : source?.type === "smart" ? source.from.map(inputKey) : [];
  void renderInputs();
  const combined = source?.type === "combined" ? source : undefined;
  setValue("managed-combine-mode", combined?.mode ?? "merge");
  setValue("managed-combine-order", combined?.order ?? "sequential");
  setValue("managed-combine-keep", combined?.keep ?? "highest-quality");
  setChecked("managed-combine-match", combined?.matchSongs ?? true);

  // Follow.
  setValue("managed-follow", source?.type === "follow" ? String(source.playlistId) : "");
  setChecked("managed-follow-archive", source?.type === "follow" && source.keepRemoved);

  // Smart.
  const rules = source?.type === "smart" ? source.rules : [];
  const rule = <T extends (typeof rules)[number]["type"]>(type: T) =>
    rules.find((r): r is Extract<(typeof rules)[number], { type: T }> => r.type === type);
  setValue("managed-smart-quality", rule("quality")?.quality ?? "");
  setValue("managed-smart-days", String(rule("favourited-within")?.days ?? ""));
  setValue("managed-smart-decades", (rule("decades")?.decades ?? []).join(", "));
  setValue("managed-smart-genres", (rule("genres")?.genres ?? []).join(", "));
  setValue("managed-smart-min", minutes(rule("duration")?.minSeconds));
  setValue("managed-smart-max", minutes(rule("duration")?.maxSeconds));
  setValue("managed-smart-exclude", (rule("artists")?.exclude ?? []).map((artist) => artist.name).join("\n"));
  setValue("managed-smart-order", source?.type === "smart" ? source.order : "as-listed");

  // Discovery.
  const discovery = source?.type === "discovery" ? source : undefined;
  setValue("managed-discovery-artists", String(discovery?.artistsPerRotation ?? 10));
  setValue("managed-discovery-tracks", String(discovery?.tracksPerArtist ?? 3));
  setValue("managed-discovery-rotation", discovery?.rotation ?? "week");
  setValue("managed-discovery-avoid", String(discovery?.avoidRepeatsFor ?? 8));
  setChecked("managed-discovery-skip-favourites", discovery?.skipFavouriteTracks ?? true);

  // Filters and caps.
  const exclude =
    source?.type === "new-releases" || source?.type === "combined" || source?.type === "discovery"
      ? source.exclude
      : undefined;
  setValue("managed-exclude-artists", (exclude?.excludeArtists ?? []).join("\n"));
  setValue("managed-exclude-albums", (exclude?.excludeAlbums ?? []).join("\n"));
  setValue("managed-exclude-tracks", (exclude?.excludeTracks ?? []).join("\n"));
  setValue("managed-max-releases", String(job?.shape?.maxReleases ?? ""));
  setValue("managed-max-tracks", String(job?.shape?.maxTracks ?? ""));
  setValue("managed-max-minutes", String(job?.shape?.maxMinutes ?? ""));
  setRadio("managed-edits", job?.edits ?? "respect");

  // Tidy-ups.
  const tidy = job?.tidy ?? {};
  setChecked("managed-tidy-repair", tidy.repair !== undefined);
  setValue("managed-tidy-repair-action", tidy.repair?.action ?? "replace");
  setValue("managed-tidy-repair-cadence", tidy.repair?.cadence ?? "weekly");
  setValue("managed-tidy-repair-mode", tidy.repair?.mode ?? "apply");
  setChecked("managed-tidy-upgrade", tidy.upgrade !== undefined);
  setChecked("managed-tidy-upgrade-signature", tidy.upgrade?.allowSignatureMatch ?? false);
  setValue("managed-tidy-upgrade-cadence", tidy.upgrade?.cadence ?? "monthly");
  setValue("managed-tidy-upgrade-mode", tidy.upgrade?.mode ?? "apply");
  setChecked("managed-tidy-dedupe", tidy.dedupe !== undefined);
  const keep = tidy.dedupe?.keep.join(",") ?? "highest-quality,first-added";
  const keepSelect = el<HTMLSelectElement>("managed-tidy-dedupe-keep");
  if (![...keepSelect.options].some((option) => option.value === keep)) {
    keepSelect.appendChild(new Option(`Keep: ${keep.replace(/,/g, ", then ")}`, keep));
  }
  keepSelect.value = keep;
  setValue("managed-tidy-dedupe-cadence", tidy.dedupe?.cadence ?? "every-pass");
  setValue("managed-tidy-dedupe-mode", tidy.dedupe?.mode ?? "apply");

  const schedule = job?.schedule ?? { every: "day", at: "06:00" };
  setValue("managed-every", schedule.every);
  setValue("managed-weekday", String(schedule.every === "week" ? schedule.weekday : 1));
  setValue("managed-at", schedule.every === "hour" ? "06:00" : schedule.at);
  showForm(job === undefined ? "Manage a playlist" : `Edit "${job.name}"`);
}

const KIND_HINTS: Record<Kind, string> = {
  none: "Nothing is added: the playlist is only tidied.",
  "new-releases": "What these artists release, newest on top. Artists with nothing new add nothing.",
  combined: "Kept in sync with the playlists you tick: tracks added there arrive here, tracks removed there leave.",
  follow: "A copy that follows another playlist, such as a Qobuz editorial one. Archiving keeps what it drops.",
  smart: "The tracks of the playlists you tick that meet every rule, re-checked each pass.",
  discovery: "Each rotation, artists similar to yours that you do not follow, and their best tracks.",
};

/** Show the parts that apply to the chosen target, source, window and schedule. */
function syncForm(): void {
  const target = (radio("managed-target") || "created") as TargetType;
  const kindSelect = el<HTMLSelectElement>("managed-kind");
  const noneOption = [...kindSelect.options].find((option) => option.value === "none");
  if (noneOption !== undefined) {
    noneOption.disabled = target === "created";
  }
  if (target === "created" && kindSelect.value === "none") {
    kindSelect.value = "new-releases";
  }
  if (target === "favourites") {
    kindSelect.value = "none";
  }
  const kind = kindSelect.value as Kind;

  el("managed-target-playlist-field").hidden = target !== "adopted";
  el("managed-name-field").hidden = target === "favourites";
  el<HTMLInputElement>("managed-name").placeholder =
    target === "adopted" ? "Same as the playlist" : "New from my artists";
  el("managed-public-field").hidden = target !== "created";
  el("managed-source-part").hidden = target === "favourites";
  el("managed-kind-hint").textContent = KIND_HINTS[kind];

  const show = (id: string, visible: boolean) => {
    el(id).hidden = !visible;
  };
  show("managed-artists-block", kind === "new-releases" || kind === "discovery");
  show("managed-releases-block", kind === "new-releases");
  show("managed-inputs-block", kind === "combined" || kind === "smart");
  show("managed-combined-block", kind === "combined");
  show("managed-follow-block", kind === "follow");
  show("managed-smart-block", kind === "smart");
  show("managed-discovery-block", kind === "discovery");
  show("managed-edits-field", kind !== "none");
  show("managed-limits", kind !== "none");
  show("managed-max-releases-field", kind === "new-releases");
  show("managed-exclude-grid", kind === "new-releases" || kind === "combined" || kind === "discovery");
  el("managed-similar-label").textContent =
    kind === "discovery" ? "Similar artists to pick from (per artist)" : "Also similar artists (per artist, 0 for none)";
  // Strict mirror only for a playlist qobuz-helper made: it removes anything else.
  show("managed-mirror-option", target === "created");
  if (target !== "created") {
    setRadio("managed-edits", "respect");
  }

  const source = el<HTMLSelectElement>("managed-source").value;
  show("managed-artists-field", source === "list");
  show("managed-playlist-field", source === "playlist");
  const window = el<HTMLSelectElement>("managed-window-type").value;
  show("managed-window-days-field", window === "last-days");
  show("managed-window-date-field", window === "since");
  show("managed-window-count-field", window === "latest-per-artist");
  const every = el<HTMLSelectElement>("managed-every").value;
  show("managed-weekday-field", every === "week");
  show("managed-at-field", every !== "hour");

  for (const tidy of ["repair", "upgrade", "dedupe"]) {
    const on = el<HTMLInputElement>(`managed-tidy-${tidy}`).checked;
    for (const control of document.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
      `.tidy-row[data-tidy="${tidy}"] select, .tidy-row[data-tidy="${tidy}"] input:not(#managed-tidy-${tidy})`,
    )) {
      control.disabled = !on;
    }
  }
  show(
    "managed-tidy-favourites-note",
    target === "favourites" &&
      (el<HTMLInputElement>("managed-tidy-upgrade").checked || el<HTMLInputElement>("managed-tidy-repair").checked),
  );
}

/** The checklist of inputs for a combined or smart source, numbered in ticking order. */
async function renderInputs(): Promise<void> {
  const container = el("managed-inputs");
  const options: { key: string; label: string }[] = [
    { key: "favourites", label: "Favourites" },
    ...playlists.map((playlist) => ({ key: `p${playlist.id}`, label: playlist.name })),
  ];
  for (const key of chosenInputs) {
    if (!options.some((option) => option.key === key)) {
      options.push({ key, label: `Playlist ${key.slice(1)}` });
    }
  }
  container.textContent = "";
  for (const option of options) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chosenInputs.includes(option.key);
    box.addEventListener("change", () => {
      chosenInputs = box.checked
        ? [...chosenInputs.filter((key) => key !== option.key), option.key]
        : chosenInputs.filter((key) => key !== option.key);
      void renderInputs();
    });
    label.appendChild(box);
    const position = chosenInputs.indexOf(option.key);
    label.appendChild(document.createTextNode(` ${position >= 0 ? `${position + 1}. ` : ""}${option.label}`));
    container.appendChild(label);
  }
}

function optionalNumber(id: string): number | undefined {
  const raw = el<HTMLInputElement>(id).value.trim();
  return raw === "" ? undefined : Number(raw);
}

function lengthOf(id: string, label: string): number | undefined {
  const raw = el<HTMLInputElement>(id).value.trim();
  if (raw === "") {
    return undefined;
  }
  const match = /^(\d+):([0-5]\d)$/.exec(raw);
  if (match === null) {
    throw new Error(`${label}: write a length as M:SS, e.g. 4:30.`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function commaList(id: string): string[] {
  return el<HTMLInputElement>(id)
    .value.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Look up typed artists, keeping those an edited job already has. */
async function lookUp(lines: readonly string[], known: ReadonlyMap<string, ArtistRef>): Promise<ArtistRef[]> {
  const queries = lines.filter((line) => !known.has(line));
  const looked =
    queries.length === 0
      ? { artists: [] as ArtistRef[], problems: [] as string[] }
      : await api<{ artists: ArtistRef[]; problems: string[] }>("POST", "/api/jobs/artists", { queries });
  if (looked.problems.length > 0) {
    throw new Error(`No Qobuz artist found for: ${looked.problems.join(", ")}`);
  }
  const found = [...looked.artists];
  const artists: ArtistRef[] = [];
  for (const line of lines) {
    const artist = known.get(line) ?? found.shift();
    if (artist !== undefined && !artists.some((a) => a.id === artist.id)) {
      artists.push(artist);
    }
  }
  return artists;
}

/** The artists typed in the form, looked up (reusing an edited job's when unchanged). */
async function listedArtists(): Promise<ArtistRef[]> {
  const typed = el<HTMLTextAreaElement>("managed-artists").value;
  if (editingArtists !== undefined && editingArtists.text === typed) {
    return editingArtists.artists;
  }
  const lines = readTerms("managed-artists");
  if (lines.length === 0) {
    throw new Error("List at least one artist.");
  }
  // Lines naming an artist the job already has keep that artist (it may have
  // been chosen by link); only new lines are looked up.
  const known = new Map((editingArtists?.artists ?? []).map((artist) => [artist.name, artist]));
  const artists = await lookUp(lines, known);
  editingArtists = { text: typed, artists };
  return artists;
}

async function readArtists(): Promise<unknown> {
  const source = el<HTMLSelectElement>("managed-source").value;
  if (source === "list") {
    return { type: "list", artists: await listedArtists() };
  }
  if (source === "playlist") {
    const id = el<HTMLSelectElement>("managed-playlist").value;
    if (id === "") {
      throw new Error("Choose the playlist whose artists to use.");
    }
    return { type: "playlist", playlistId: id as PlaylistId };
  }
  return { type: "favourites" };
}

function readExclude(): Record<string, string[]> {
  return {
    excludeArtists: readTerms("managed-exclude-artists"),
    excludeAlbums: readTerms("managed-exclude-albums"),
    excludeTracks: readTerms("managed-exclude-tracks"),
  };
}

async function readSource(kind: Kind): Promise<Record<string, unknown> | undefined> {
  switch (kind) {
    case "none":
      return undefined;
    case "new-releases": {
      const windowType = el<HTMLSelectElement>("managed-window-type").value;
      const window =
        windowType === "since"
          ? { type: "since", date: el<HTMLInputElement>("managed-window-date").value }
          : windowType === "latest-per-artist"
            ? { type: "latest-per-artist", count: Number(el<HTMLInputElement>("managed-window-count").value) }
            : { type: "last-days", days: Number(el<HTMLInputElement>("managed-window-days").value) };
      const similar = Number(el<HTMLInputElement>("managed-similar").value);
      const previous = editing?.source?.type === "new-releases" ? editing.source.similar : undefined;
      return {
        type: "new-releases",
        artists: await readArtists(),
        window,
        include: [...document.querySelectorAll<HTMLInputElement>('input[name="managed-include"]:checked')].map(
          (box) => box.value,
        ),
        hideFavourites: el<HTMLInputElement>("managed-hide-favourites").checked,
        ...(similar > 0 && { similar: { perArtist: similar, refreshDays: previous?.refreshDays ?? 30 } }),
        exclude: readExclude(),
      };
    }
    case "combined":
      if (chosenInputs.length < 2) {
        throw new Error("Tick at least two playlists to combine.");
      }
      return {
        type: "combined",
        inputs: chosenInputs.map(inputOfKey),
        mode: el<HTMLSelectElement>("managed-combine-mode").value,
        order: el<HTMLSelectElement>("managed-combine-order").value,
        keep: el<HTMLSelectElement>("managed-combine-keep").value,
        matchSongs: el<HTMLInputElement>("managed-combine-match").checked,
        exclude: readExclude(),
      };
    case "follow": {
      const raw = el<HTMLInputElement>("managed-follow").value.trim();
      const playlistId = parsePlaylistId(raw);
      if (playlistId === undefined) {
        throw new Error("Paste a Qobuz playlist link or id to follow.");
      }
      return { type: "follow", playlistId, keepRemoved: el<HTMLInputElement>("managed-follow-archive").checked };
    }
    case "smart": {
      if (chosenInputs.length === 0) {
        throw new Error("Tick the playlists (or the favourites) to choose from.");
      }
      const rules: Record<string, unknown>[] = [];
      const quality = el<HTMLSelectElement>("managed-smart-quality").value;
      if (quality !== "") {
        rules.push({ type: "quality", quality });
      }
      const days = optionalNumber("managed-smart-days");
      if (days !== undefined) {
        rules.push({ type: "favourited-within", days });
      }
      const decades = commaList("managed-smart-decades").map((decade) => (/^\d{2}s$/.test(decade) ? `19${decade}` : decade));
      if (decades.length > 0) {
        rules.push({ type: "decades", decades });
      }
      const genres = commaList("managed-smart-genres");
      if (genres.length > 0) {
        rules.push({ type: "genres", genres });
      }
      const min = lengthOf("managed-smart-min", "At least");
      const max = lengthOf("managed-smart-max", "At most");
      if (min !== undefined || max !== undefined) {
        rules.push({
          type: "duration",
          ...(min !== undefined && { minSeconds: min }),
          ...(max !== undefined && { maxSeconds: max }),
        });
      }
      const excluded = readTerms("managed-smart-exclude");
      if (excluded.length > 0) {
        const previous = editing?.source?.type === "smart" ? editing.source.rules : [];
        const known = new Map(
          previous.flatMap((rule) => (rule.type === "artists" ? (rule.exclude ?? []) : [])).map((artist) => [artist.name, artist]),
        );
        rules.push({ type: "artists", exclude: await lookUp(excluded, known) });
      }
      if (rules.length === 0) {
        throw new Error("Give the smart playlist at least one rule.");
      }
      return { type: "smart", from: chosenInputs.map(inputOfKey), rules, order: el<HTMLSelectElement>("managed-smart-order").value };
    }
    case "discovery": {
      const previous = editing?.source?.type === "discovery" ? editing.source.similar : undefined;
      return {
        type: "discovery",
        seeds: await readArtists(),
        similar: {
          perArtist: Math.max(1, Number(el<HTMLInputElement>("managed-similar").value)),
          refreshDays: previous?.refreshDays ?? 30,
        },
        artistsPerRotation: Number(el<HTMLInputElement>("managed-discovery-artists").value),
        tracksPerArtist: Number(el<HTMLInputElement>("managed-discovery-tracks").value),
        rotation: el<HTMLSelectElement>("managed-discovery-rotation").value,
        avoidRepeatsFor: Number(el<HTMLInputElement>("managed-discovery-avoid").value),
        skipFavouriteTracks: el<HTMLInputElement>("managed-discovery-skip-favourites").checked,
        exclude: readExclude(),
      };
    }
  }
}

function readTidy(): Record<string, unknown> {
  const tidy: Record<string, unknown> = {};
  const base = (kind: string) => ({
    cadence: el<HTMLSelectElement>(`managed-tidy-${kind}-cadence`).value,
    mode: el<HTMLSelectElement>(`managed-tidy-${kind}-mode`).value,
  });
  if (el<HTMLInputElement>("managed-tidy-repair").checked) {
    tidy["repair"] = { ...base("repair"), action: el<HTMLSelectElement>("managed-tidy-repair-action").value };
  }
  if (el<HTMLInputElement>("managed-tidy-upgrade").checked) {
    tidy["upgrade"] = {
      ...base("upgrade"),
      allowSignatureMatch: el<HTMLInputElement>("managed-tidy-upgrade-signature").checked,
      ...(editing?.tidy.upgrade !== undefined && { maxSearches: editing.tidy.upgrade.maxSearches }),
    };
  }
  if (el<HTMLInputElement>("managed-tidy-dedupe").checked) {
    tidy["dedupe"] = { ...base("dedupe"), keep: el<HTMLSelectElement>("managed-tidy-dedupe-keep").value.split(",") };
  }
  return tidy;
}

/** The job definition the form describes (looking up typed artists). */
async function readForm(): Promise<Record<string, unknown>> {
  const targetType = (radio("managed-target") || "created") as TargetType;
  let target: Record<string, unknown>;
  let name = el<HTMLInputElement>("managed-name").value.trim();
  if (targetType === "adopted") {
    const id = el<HTMLSelectElement>("managed-target-playlist").value;
    if (id === "") {
      throw new Error("Choose which of your playlists to manage.");
    }
    target = { type: "adopted", playlistId: id as PlaylistId };
    if (name === "") {
      name = names().get(id as PlaylistId) ?? `Playlist ${shortId(id as PlaylistId)}`;
    }
  } else if (targetType === "favourites") {
    target = { type: "favourites" };
    name = "Favourites";
  } else {
    target = { type: "created", isPublic: el<HTMLInputElement>("managed-public").checked };
    if (name === "") {
      throw new Error("Give the new playlist a name.");
    }
  }
  const kind = (el<HTMLSelectElement>("managed-kind").value || "none") as Kind;
  const source = await readSource(targetType === "favourites" ? "none" : kind);
  const tidy = readTidy();
  if (source === undefined && Object.keys(tidy).length === 0) {
    throw new Error("Choose a source, a tidy-up, or both.");
  }
  const every = el<HTMLSelectElement>("managed-every").value;
  const at = el<HTMLInputElement>("managed-at").value || "06:00";
  const schedule =
    every === "hour"
      ? { every }
      : every === "week"
        ? { every, weekday: Number(el<HTMLSelectElement>("managed-weekday").value), at }
        : { every, at };
  const shape = {
    ...(kind === "new-releases" && { maxReleases: optionalNumber("managed-max-releases") }),
    maxTracks: optionalNumber("managed-max-tracks"),
    maxMinutes: optionalNumber("managed-max-minutes"),
  };
  const shaped = Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined));
  return {
    name,
    kind: "playlist",
    enabled: editing?.enabled ?? true,
    target,
    edits: targetType === "created" ? radio("managed-edits") || "respect" : "respect",
    schedule,
    tidy,
    ...(source !== undefined && { source }),
    ...(source !== undefined && Object.keys(shaped).length > 0 && { shape: shaped }),
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
  if (saving) {
    return;
  }
  showError(errorNode, undefined);
  saving = true;
  const cancel = el<HTMLButtonElement>("managed-cancel");
  trigger.disabled = true;
  cancel.disabled = true;
  trigger.textContent = "Saving...";
  const target = editing;
  try {
    const definition = await readForm();
    const { job } = await (target === undefined
      ? api<{ job: Job }>("POST", "/api/jobs", { job: definition })
      : api<{ job: Job }>("PUT", `/api/jobs/${target.id}`, { job: definition }));
    // Saved: a retry after a failed run updates this job, not a new one.
    editing = job;
    trigger.textContent = "Running...";
    await api<{ summary: RunSummary }>("POST", `/api/jobs/${job.id}/run`, {});
    saving = false;
    closeForm();
    await load();
  } catch (error) {
    showError(errorNode, (error as Error).message);
    void load();
  } finally {
    saving = false;
    trigger.disabled = false;
    cancel.disabled = false;
    trigger.textContent = "Save and run now";
  }
}
