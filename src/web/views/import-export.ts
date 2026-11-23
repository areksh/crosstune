/**
 * Import & export view.
 *
 * Two independent panels. Export reads a source (favourites, a playlist, or the
 * whole account) and downloads it in the chosen format. Import parses pasted or
 * uploaded content, resolves each entry to a Qobuz item (a reviewable plan),
 * then writes the matched items to favourites or a playlist; a whole-account
 * backup is restored in one step. This is DOM glue; the serialising, parsing,
 * matching and writing all live in the tested server modules.
 */

import type { AnyId, PlaylistId } from "../../services/ids.js";
import { api, apiDownload, type Playlist } from "../api.js";
import { el, setStep, showError } from "../dom.js";

interface ExportResponse {
  filename: string;
  content: string;
}

interface ImportPlan {
  kind: "tracks" | "albums" | "artists";
  matched: Array<{ label: string; id: AnyId; via?: "id" | "isrc" | "search" }>;
  unmatched: string[];
  /** The format the server read (a CSV may turn out to be a Spotify export). */
  format?: string;
}

type ImportTarget =
  | { type: "favourites" }
  | { type: "playlist-new"; name: string; isPublic?: boolean }
  | { type: "playlist-existing"; playlistId: PlaylistId };

let exportPlaylistsLoaded = false;
let importPlaylistsLoaded = false;
let currentPlan: ImportPlan | undefined;

/** Wire up the import/export view. Call once on load. */
export function initImportExportView(): void {
  for (const radio of document.querySelectorAll('input[name="ie-source"]')) {
    radio.addEventListener("change", onExportSourceChange);
  }
  for (const radio of document.querySelectorAll('input[name="ie-target"]')) {
    radio.addEventListener("change", onImportTargetChange);
  }
  el("ie-export").addEventListener("click", () => void onExport());
  el("ie-resolve").addEventListener("click", () => void onResolve());
  el("ie-commit").addEventListener("click", () => void onCommit());
  el<HTMLInputElement>("ie-import-file").addEventListener("change", () => void onFileChosen());
}

// --- Export ----------------------------------------------------------------

function exportSource(): string {
  return (
    document.querySelector<HTMLInputElement>('input[name="ie-source"]:checked')
      ?.value ?? "favourite-tracks"
  );
}

function onExportSourceChange(): void {
  const source = exportSource();
  el("ie-export-playlist-fields").hidden = source !== "playlist";
  // A backup is always JSON, so lock the format for the account source.
  const format = el<HTMLSelectElement>("ie-export-format");
  if (source === "account") {
    format.value = "json";
    format.disabled = true;
  } else {
    format.disabled = false;
  }
  if (source === "playlist") {
    void loadPlaylists("ie-export-playlist-select", () => {
      exportPlaylistsLoaded = true;
    }, exportPlaylistsLoaded);
  }
}

async function onExport(): Promise<void> {
  const button = el<HTMLButtonElement>("ie-export");
  const errorNode = el("ie-export-error");
  const resultNode = el("ie-export-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const source = exportSourceBody();
  if (source === undefined) {
    showError(errorNode, "Choose a playlist to export.");
    return;
  }
  const format = el<HTMLSelectElement>("ie-export-format").value;

  button.disabled = true;
  button.textContent = "Exporting...";
  try {
    const body: Record<string, unknown> = { source };
    if (source.type !== "account") {
      body["format"] = format;
    }
    let filename: string;
    if (source.type === "all-playlists") {
      // The server zips one file per playlist; save the archive as it comes.
      const result = await apiDownload("POST", "/api/export", body, "qobuz-playlists.zip");
      filename = result.filename;
      download(filename, result.blob);
    } else {
      const result = await api<ExportResponse>("POST", "/api/export", body);
      filename = result.filename;
      download(filename, result.content);
    }
    resultNode.hidden = false;
    resultNode.textContent = `Downloaded ${filename}.`;
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Export & download";
  }
}

function exportSourceBody():
  | {
      type:
        | "favourite-tracks"
        | "favourite-albums"
        | "favourite-artists"
        | "account"
        | "all-playlists";
    }
  | { type: "playlist"; playlistId: PlaylistId }
  | undefined {
  const source = exportSource();
  if (source === "playlist") {
    const value = el<HTMLSelectElement>("ie-export-playlist-select").value;
    if (value === "") {
      return undefined;
    }
    return { type: "playlist", playlistId: value as PlaylistId };
  }
  return { type: source as "favourite-tracks" };
}

/** Trigger a browser download of text content or a received file. */
function download(filename: string, content: string | Blob): void {
  const blob =
    typeof content === "string"
      ? new Blob([content], { type: "application/octet-stream" })
      : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// --- Import ----------------------------------------------------------------

function importTarget(): string {
  return (
    document.querySelector<HTMLInputElement>('input[name="ie-target"]:checked')
      ?.value ?? "favourites"
  );
}

function onImportTargetChange(): void {
  const target = importTarget();
  el("ie-import-new-fields").hidden = target !== "playlist-new";
  el("ie-import-existing-fields").hidden = target !== "playlist-existing";
  if (target === "playlist-existing") {
    void loadPlaylists("ie-import-playlist-select", () => {
      importPlaylistsLoaded = true;
    }, importPlaylistsLoaded);
  }
  // Reset any preview: the plan no longer matches the new target's kind.
  currentPlan = undefined;
  el("ie-import-preview").hidden = true;
  setStep("import-steps", 0);
}

async function onFileChosen(): Promise<void> {
  const input = el<HTMLInputElement>("ie-import-file");
  const file = input.files?.[0];
  if (file === undefined) {
    return;
  }
  el<HTMLTextAreaElement>("ie-import-content").value = await file.text();
  // Auto-select the format from the file's extension when left on "detect".
  const format = el<HTMLSelectElement>("ie-import-format");
  if (format.value === "auto") {
    const inferred = formatFromName(file.name);
    if (inferred !== undefined) {
      format.value = inferred;
    }
  }
}

async function onResolve(): Promise<void> {
  const button = el<HTMLButtonElement>("ie-resolve");
  const errorNode = el("ie-import-error");
  showError(errorNode, undefined);
  showError(el("ie-commit-result"), undefined);
  currentPlan = undefined;

  const content = el<HTMLTextAreaElement>("ie-import-content").value.trim();
  if (content.length === 0) {
    showError(errorNode, "Paste some content or choose a file first.");
    return;
  }
  const target = importTarget();

  // Restoring a backup skips the resolve/plan flow: its ids are already known.
  if (target === "account") {
    renderRestorePreview(content, errorNode);
    return;
  }

  const format = resolveFormat();
  if (format === undefined) {
    showError(errorNode, "Choose a format, or a file with a known extension.");
    return;
  }

  button.disabled = true;
  button.textContent = "Resolving...";
  try {
    const plan = await api<ImportPlan>("POST", "/api/import/resolve", {
      format,
      content,
      kind: kindForTarget(target),
    });
    currentPlan = { kind: plan.kind, matched: plan.matched, unmatched: plan.unmatched };
    renderPlan(plan);
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Preview import";
  }
}

/** Show a plan: how many matched, and which entries did not. */
function renderPlan(plan: ImportPlan): void {
  el("ie-import-preview").hidden = false;
  setStep("import-steps", 1);
  const total = plan.matched.length + plan.unmatched.length;
  // How the matches were found: an id or ISRC is exact; a search can misfire.
  const byMethod = { id: 0, isrc: 0, search: 0 };
  for (const item of plan.matched) {
    byMethod[item.via ?? "search"] += 1;
  }
  const how = [
    byMethod.id > 0 ? `${byMethod.id} by Qobuz id` : undefined,
    byMethod.isrc > 0 ? `${byMethod.isrc} by ISRC` : undefined,
    byMethod.search > 0 ? `${byMethod.search} by artist and title` : undefined,
  ].filter((part) => part !== undefined);
  const source = plan.format === "spotify" ? "Read as a Spotify (Exportify) export. " : "";
  el("ie-import-summary").textContent =
    `${source}Matched ${plan.matched.length} of ${total} ${plan.kind}` +
    (how.length > 0 ? ` (${how.join(", ")}).` : ".");

  const unmatched = el("ie-import-unmatched");
  if (plan.unmatched.length === 0) {
    unmatched.hidden = true;
    unmatched.textContent = "";
  } else {
    unmatched.hidden = false;
    unmatched.textContent = `Not found: ${plan.unmatched.join(", ")}`;
  }

  const commit = el<HTMLButtonElement>("ie-commit");
  commit.disabled = plan.matched.length === 0;
  commit.textContent =
    plan.matched.length === 0
      ? "Nothing to import"
      : `Import ${plan.matched.length} matched ${plan.kind}`;
}

/** Preview a backup restore by reading its counts from the JSON client-side. */
function renderRestorePreview(content: string, errorNode: HTMLElement): void {
  let counts: string;
  try {
    const data = JSON.parse(content) as {
      favourites?: { tracks?: unknown[]; albums?: unknown[]; artists?: unknown[] };
      playlists?: unknown[];
    };
    if (data.favourites === undefined) {
      throw new Error("not a backup");
    }
    counts =
      `${data.favourites.tracks?.length ?? 0} favourite tracks, ` +
      `${data.favourites.albums?.length ?? 0} albums, ` +
      `${data.favourites.artists?.length ?? 0} artists, ` +
      `${data.playlists?.length ?? 0} playlists`;
  } catch {
    showError(errorNode, "This does not look like a qobuz-helper backup.");
    return;
  }
  currentPlan = undefined;
  el("ie-import-preview").hidden = false;
  setStep("import-steps", 1);
  el("ie-import-summary").textContent = `Backup contains ${counts}.`;
  const unmatched = el("ie-import-unmatched");
  unmatched.hidden = true;
  unmatched.textContent = "";
  const commit = el<HTMLButtonElement>("ie-commit");
  commit.disabled = false;
  commit.textContent = "Restore backup";
}

async function onCommit(): Promise<void> {
  const button = el<HTMLButtonElement>("ie-commit");
  const errorNode = el("ie-commit-error");
  const resultNode = el("ie-commit-result");
  showError(errorNode, undefined);
  showError(resultNode, undefined);

  const target = importTarget();
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Working...";
  try {
    if (target === "account") {
      const content = el<HTMLTextAreaElement>("ie-import-content").value.trim();
      const result = await api<{
        favouriteTracks: number;
        favouriteAlbums: number;
        favouriteArtists: number;
        playlists: unknown[];
      }>("POST", "/api/restore", { content });
      resultNode.hidden = false;
      resultNode.textContent =
        `Restored ${result.favouriteTracks} favourite tracks, ` +
        `${result.favouriteAlbums} albums, ${result.favouriteArtists} artists, ` +
        `and ${result.playlists.length} playlists.`;
    } else {
      if (currentPlan === undefined) {
        return;
      }
      const commitTarget = commitTargetBody(target);
      if (commitTarget === undefined) {
        showError(errorNode, "Choose a destination playlist.");
        return;
      }
      const result = await api<{ written: number; playlist?: { name: string } }>(
        "POST",
        "/api/import/commit",
        { plan: currentPlan, target: commitTarget },
      );
      resultNode.hidden = false;
      resultNode.textContent =
        result.playlist !== undefined
          ? `Created "${result.playlist.name}" with ${result.written} tracks.`
          : `Imported ${result.written} items.`;
    }
    el("ie-import-preview").hidden = true;
    setStep("import-steps", 3);
    currentPlan = undefined;
  } catch (error) {
    showError(errorNode, (error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function commitTargetBody(target: string): ImportTarget | undefined {
  if (target === "playlist-new") {
    const name = el<HTMLInputElement>("ie-import-playlist-name").value.trim();
    const isPublic = el<HTMLInputElement>("ie-import-playlist-public").checked;
    return { type: "playlist-new", name: name.length > 0 ? name : "Imported", isPublic };
  }
  if (target === "playlist-existing") {
    const value = el<HTMLSelectElement>("ie-import-playlist-select").value;
    if (value === "") {
      return undefined;
    }
    return { type: "playlist-existing", playlistId: value as PlaylistId };
  }
  // favourites, favourite-albums and favourite-artists all route by plan kind.
  return { type: "favourites" };
}

function kindForTarget(target: string): "tracks" | "albums" | "artists" {
  if (target === "favourite-albums") return "albums";
  if (target === "favourite-artists") return "artists";
  return "tracks";
}

/** The chosen import format, or the file-inferred one when set to "detect". */
function resolveFormat(): string | undefined {
  const value = el<HTMLSelectElement>("ie-import-format").value;
  if (value !== "auto") {
    return value;
  }
  const file = el<HTMLInputElement>("ie-import-file").files?.[0];
  return file === undefined ? undefined : formatFromName(file.name);
}

function formatFromName(name: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  switch (ext) {
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "txt":
    case "text":
      return "text";
    case "m3u":
    case "m3u8":
      return "m3u";
    default:
      return undefined;
  }
}

// --- Shared ----------------------------------------------------------------

/** Populate a playlist <select> once, mirroring the other views. */
async function loadPlaylists(
  selectId: string,
  markLoaded: () => void,
  alreadyLoaded: boolean,
): Promise<void> {
  if (alreadyLoaded) {
    return;
  }
  const select = el<HTMLSelectElement>(selectId);
  try {
    const { playlists } = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
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
    markLoaded();
  } catch {
    select.textContent = "";
    select.appendChild(new Option("Could not load playlists", ""));
  }
}
