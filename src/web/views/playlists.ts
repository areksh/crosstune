/**
 * Playlists: the list of your playlists, and removing artists from several of
 * them. Opening one hands over to the editor (./playlist-editor.ts).
 *
 * DOM glue: matching and removing are in src/features/playlist-manager.ts, on
 * the server.
 */

import { serviceOf, shortId, type EntryId, type PlaylistId } from "../../services/ids.js";
import type { ArtistHit, ManagerPlaylist, RemovalReport, RemoveArtistsPlan } from "../../features/playlist-manager.js";
import { formatDuration } from "../../features/playlist-shape.js";
import { labelOf } from "../../services/errors.js";
import { connectedServices } from "../service.js";
import { api } from "../api.js";
import { dialogField, openDialog, textInput } from "../dialog.js";
import { el, showError } from "../dom.js";
import { groupHead, titleOf, trackText } from "../tracks.js";
import { confirmDelete, editDetails, managedNotice, playlistHash, songCount } from "./playlist-actions.js";
import { closeEditor, initPlaylistEditor, onDeleted, openEditor } from "./playlist-editor.js";
import { knownLinks, LINKS_CHANGED } from "./links.js";
import { linkMark } from "../../sync/wording.js";
import type { ServiceName } from "../../services/names.js";
import { parseRoute } from "../../ui/routes.js";
import { knownPlaylist, refreshLibrary } from "../library.js";
import { showAllActions } from "../playlist-page.js";
import { wireRangeTick } from "../range-tick.js";

let playlists: ManagerPlaylist[] = [];
const ticked = new Set<PlaylistId>();
let request = 0;
let plan: RemoveArtistsPlan | undefined;
/** The service whose playlists the list shows. */
let listService: ServiceName | undefined;

/** Wire up the playlists view. Call once on load. */
export function initPlaylistsView(): void {
  initPlaylistEditor();
  onDeleted((name) => say(`Deleted ${name}. You can undo this in History.`));
  window.addEventListener("hashchange", route);
  el("pl-filter").addEventListener("input", renderList);
  el("pl-sort").addEventListener("change", renderList);
  el("pl-tick-all").addEventListener("change", () => {
    const on = el<HTMLInputElement>("pl-tick-all").checked;
    shown().filter((p) => p.owned).forEach((p) => (on ? ticked.add(p.id) : ticked.delete(p.id)));
    renderList();
  });
  el("pl-remove-artists").addEventListener("click", openArtists);
  el("pl-artists-close").addEventListener("click", closeArtists);
  el("pl-artists-find").addEventListener("click", () => void findArtists());
  el("pl-artists-remove").addEventListener("click", () => void removeArtists());
  // The marks on linked playlists follow the links as they load.
  window.addEventListener(LINKS_CHANGED, () => {
    if (playlists.length > 0) {
      renderList();
    }
  });
  route();
}

/** Show a playlist ("#/p/<id>") or a service's list ("#/all/<service>"), by the hash. */
function route(): void {
  const where = parseRoute(location.hash);
  if (handedArtists !== undefined && handedArtists.at !== location.hash) {
    handedArtists = undefined;
  }
  if ((where.kind !== "playlist" && where.kind !== "all") || where.tool !== undefined) {
    // Read it afresh next time: it may change meanwhile (an undo, another tool).
    // Unsaved edits have been asked about (guardUnsavedPlaylist).
    closeEditor();
    return;
  }
  el("pl-list-page").hidden = where.kind === "playlist";
  el("pl-editor").hidden = where.kind !== "playlist";
  if (where.kind === "playlist") {
    void openEditor(where.id, playlists.find((p) => p.id === where.id) ?? knownPlaylist(where.id));
    window.scrollTo(0, 0);
  } else {
    closeEditor();
    if (listService !== where.service) {
      listService = where.service;
      playlists = [];
      ticked.clear();
    }
    showAllActions(where.service);
    void load();
  }
}

function say(text: string): void {
  const node = el("pl-result");
  node.hidden = false;
  node.textContent = text;
}

async function load(): Promise<void> {
  const mine = ++request;
  showError(el("pl-error"), undefined);
  if (playlists.length === 0) {
    el("pl-status").hidden = false;
    el("pl-status").textContent = "Loading...";
  }
  try {
    const result = await api<{ playlists: ManagerPlaylist[] }>("GET", "/api/manager/playlists", undefined, listService);
    if (mine === request) {
      playlists = result.playlists;
      const ids = new Set(playlists.map((p) => p.id));
      [...ticked].filter((id) => !ids.has(id)).forEach((id) => ticked.delete(id));
      if (handedArtists !== undefined && handedArtists.at === location.hash) {
        ticked.clear();
        handedArtists.ids.filter((id) => ids.has(id)).forEach((id) => ticked.add(id));
        handedArtists = undefined;
        renderList();
        openArtists();
      } else {
        renderList();
      }
    }
  } catch (error) {
    if (mine === request) {
      el("pl-status").hidden = true;
      showError(el("pl-error"), (error as Error).message);
    }
  }
}

function shown(): ManagerPlaylist[] {
  const filter = el<HTMLInputElement>("pl-filter").value.trim().toLowerCase();
  const sort = el<HTMLSelectElement>("pl-sort").value;
  const compare: Record<string, (a: ManagerPlaylist, b: ManagerPlaylist) => number> = {
    changed: (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    songs: (a, b) => (b.trackCount ?? 0) - (a.trackCount ?? 0),
  };
  return playlists.filter((p) => p.name.toLowerCase().includes(filter)).sort(compare[sort] ?? compare["changed"]);
}

function renderList(): void {
  const rows = shown();
  const status = el("pl-status");
  status.hidden = rows.length > 0;
  status.textContent = playlists.length === 0 ? "You have no playlists yet." : "No playlist matches.";
  el("pl-list").replaceChildren(...rows.map(renderRow));
  const own = rows.filter((p) => p.owned);
  const all = el<HTMLInputElement>("pl-tick-all");
  const on = own.filter((p) => ticked.has(p.id)).length;
  all.checked = own.length > 0 && on === own.length;
  all.indeterminate = on > 0 && on < own.length;
  renderBar();
}

function renderBar(): void {
  el("pl-bar").hidden = ticked.size === 0 || !el("pl-artists").hidden;
  el("pl-bar-count").textContent = `${ticked.size} playlist${ticked.size === 1 ? "" : "s"} ticked`;
}

function renderRow(playlist: ManagerPlaylist): HTMLElement {
  const row = document.createElement("li");
  row.className = "pl-item";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = ticked.has(playlist.id);
  box.disabled = !playlist.owned;
  box.setAttribute("aria-label", `Tick ${playlist.name}`);
  wireRangeTick(
    box,
    playlist.id,
    () => document.getElementById("pl-list"),
    (key, on) => (on ? ticked.add(key as PlaylistId) : ticked.delete(key as PlaylistId)),
    renderList,
  );

  const link = document.createElement("a");
  link.className = "pl-item-name";
  link.href = playlistHash(playlist.id);
  link.textContent = playlist.name;

  const facts = document.createElement("span");
  facts.className = "pl-item-facts";
  facts.textContent = [
    playlist.trackCount === undefined ? undefined : songCount(playlist.trackCount),
    playlist.duration === undefined || playlist.duration === 0 ? undefined : formatDuration(playlist.duration),
    playlist.updatedAt === undefined ? undefined : `changed ${new Date(playlist.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

  const badges = document.createElement("span");
  badges.className = "pl-badges";
  const add = (text: string, title = "", className = "pl-badge"): void => {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    node.title = title;
    badges.append(node);
  };
  if (connectedServices().length > 1) {
    add(labelOf(serviceOf(playlist.id)));
  }
  if (!playlist.owned) {
    add("not yours");
  }
  if (playlist.isPublic === true) {
    add("public");
  }
  if (playlist.isCollaborative === true) {
    add("collaborative");
  }
  if (playlist.managed !== undefined) {
    add("managed", managedNotice(playlist));
  }
  const mark = linkMark(playlist.id, knownLinks()?.links ?? []);
  if (mark !== undefined) {
    add(mark.conflict ? "linked: copies disagree" : "linked", mark.text, mark.conflict ? "pl-badge pl-conflict" : "pl-badge");
  }

  const menu = document.createElement("details");
  menu.className = "menu";
  const summary = document.createElement("summary");
  summary.textContent = "More";
  summary.setAttribute("aria-label", `More for ${playlist.name}`);
  const items = document.createElement("div");
  items.className = "menu-items";
  const item = (text: string, act: () => Promise<void>): void => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "menu-item";
    node.textContent = text;
    node.addEventListener("click", () => {
      menu.open = false;
      void act().catch((error: unknown) => showError(el("pl-error"), (error as Error).message));
    });
    items.append(node);
  };
  if (playlist.owned) {
    item("Rename and describe...", () => rename(playlist));
  }
  item("Duplicate...", () => duplicate(playlist));
  if (playlist.owned) {
    item("Delete...", () => remove(playlist));
  }
  menu.append(summary, items);

  const text = document.createElement("div");
  text.className = "pl-item-text";
  text.append(link, facts);
  row.append(box, text, badges, menu);
  return row;
}

/** Make a change, with the list out of use meanwhile, then read it again. */
async function change(text: string, act: () => Promise<string>): Promise<void> {
  showError(el("pl-error"), undefined);
  showError(el("pl-result"), undefined);
  const list = el("pl-list");
  list.inert = true;
  el("pl-status").hidden = false;
  el("pl-status").textContent = text;
  try {
    const done = await act();
    await load();
    say(done);
    void refreshLibrary();
  } finally {
    list.inert = false;
    el("pl-status").hidden = playlists.length > 0;
  }
}

async function rename(playlist: ManagerPlaylist): Promise<void> {
  const changes = await editDetails(playlist);
  if (changes !== undefined) {
    await change("Saving...", async () => {
      await api("POST", "/api/manager/update", { playlistId: playlist.id, ...changes }, serviceOf(playlist.id));
      return "Saved its details.";
    });
  }
}

async function duplicate(playlist: ManagerPlaylist): Promise<void> {
  const name = textInput(`${playlist.name} (copy)`);
  const ok = await openDialog({
    title: "Duplicate this playlist",
    body: [dialogField("Name of the copy", name)],
    confirm: "Duplicate",
    validate: () => (name.value.trim() === "" ? "Give it a name." : undefined),
  });
  if (ok) {
    await change("Copying...", async () => {
      const result = await api<{ playlist: { name: string }; added: number; missing: number }>(
        "POST",
        "/api/manager/duplicate",
        { playlistId: playlist.id, name: name.value.trim() },
        serviceOf(playlist.id),
      );
      const lost = result.missing > 0 ? `; the service no longer offers ${result.missing}` : "";
      return `Made ${result.playlist.name} with ${songCount(result.added)}${lost}.`;
    });
  }
}

async function remove(playlist: ManagerPlaylist): Promise<void> {
  if (await confirmDelete(playlist)) {
    await change("Deleting...", async () => {
      await api("POST", "/api/manager/delete", { playlistId: playlist.id }, serviceOf(playlist.id));
      ticked.delete(playlist.id);
      return `Deleted ${playlist.name}. You can undo this in History.`;
    });
  }
}

// ---- Removing artists from several playlists ----------------------------------

function tickedPlaylists(): ManagerPlaylist[] {
  return playlists.filter((p) => ticked.has(p.id));
}

/** Playlists to remove artists from, ticked in the library, for the list at `at`. */
let handedArtists: { ids: PlaylistId[]; at: string } | undefined;

/**
 * Open "Remove artists" on these playlists of one service, on the list at
 * `at` ("#/all/<service>"): at once if the page is there already, else once
 * it gets there (a hand-over not taken up there is dropped).
 */
export function startRemoveArtists(ids: readonly PlaylistId[], at: string): void {
  handedArtists = { ids: [...ids], at };
  if (location.hash === at) {
    void load();
  }
}

function openArtists(): void {
  clearPlan();
  el("pl-artists").hidden = false;
  const chosen = tickedPlaylists();
  el("pl-artists-where").textContent = `From ${chosen.map((p) => p.name).join(", ")}.`;
  renderBar();
  el("pl-artists").scrollIntoView({ block: "start" });
  el("pl-artists-lines").focus();
}

function closeArtists(): void {
  el("pl-artists").hidden = true;
  clearPlan();
  renderBar();
}

function clearPlan(): void {
  plan = undefined;
  el("pl-artists-found").textContent = "";
  el("pl-artists-hits").textContent = "";
  el("pl-artists-bar").hidden = true;
  showError(el("pl-artists-error"), undefined);
}

async function findArtists(): Promise<void> {
  clearPlan();
  const lines = el<HTMLTextAreaElement>("pl-artists-lines")
    .value.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || ticked.size === 0) {
    showError(el("pl-artists-error"), lines.length === 0 ? "Type at least one artist." : "Tick at least one playlist.");
    return;
  }
  const find = el<HTMLButtonElement>("pl-artists-find");
  find.disabled = true;
  find.textContent = "Reading the playlists...";
  el("pl-artists-where").textContent = `From ${tickedPlaylists().map((p) => p.name).join(", ")}.`;
  try {
    plan = await api<RemoveArtistsPlan>("POST", "/api/manager/remove-artists/resolve", {
      playlistIds: [...ticked],
      lines,
    }, listService);
    renderPlan(plan);
  } catch (error) {
    showError(el("pl-artists-error"), (error as Error).message);
  } finally {
    find.disabled = false;
    find.textContent = "Find their songs";
  }
}

function renderPlan(found: RemoveArtistsPlan): void {
  const line = (name: string, text: string): HTMLElement => {
    const node = document.createElement("p");
    const label = document.createElement("span");
    label.className = "pl-artist-name";
    label.textContent = name;
    const note = document.createElement("span");
    note.className = "count";
    note.textContent = text;
    node.append(label, note);
    return node;
  };
  el("pl-artists-found").replaceChildren(
    ...found.artists.map(({ name, main, guest, suggestion }) =>
      line(
        name,
        main + guest === 0
          ? `not in these playlists${suggestion === undefined ? "" : `. Did you mean ${suggestion.name}?`}`
          : [main > 0 ? songCount(main) : "", guest > 0 ? `${guest} as a guest` : ""].filter((part) => part !== "").join(", and "),
      ),
    ),
    ...found.problems.map(({ line: text, reason }) => line(text, reason)),
  );
  el("pl-artists-hits").replaceChildren(
    ...found.playlists
      .filter(({ hits, error }) => hits.length > 0 || error !== undefined)
      .map(({ playlist, hits, trackCount, error }) => {
        const section = document.createElement("section");
        section.className = "dedup-section";
        section.append(
          groupHead("h3", playlist.name, {
            note: error === undefined ? managedNotice(playlists.find((p) => p.id === playlist.id) ?? { ...playlist, owned: true, readBy: [] }) ?? "" : `Could not be read: ${error}`,
            count: error === undefined ? `${hits.length} of ${trackCount}` : "",
          }),
        );
        hits.forEach((hit) => section.append(renderHit(hit, playlist.id)));
        return section;
      }),
  );
  updateRemoveButton();
}

function renderHit({ entry, as, names }: ArtistHit, playlistId: PlaylistId): HTMLElement {
  const row = document.createElement("label");
  row.className = "track no-cover";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "pl-hit";
  box.checked = as === "main";
  box.dataset["playlist"] = String(playlistId);
  box.dataset["entry"] = String(entry.playlistTrackId);
  wireRangeTick(box, String(entry.playlistTrackId), () => row.parentElement, () => {}, updateRemoveButton);
  row.append(box,trackText(titleOf(entry), [entry.artist, entry.album].filter(Boolean).join(" · ")));
  if (as === "guest") {
    const note = document.createElement("span");
    note.className = "reason";
    note.textContent = `${names.join(", ")} only as a guest`;
    row.append(note);
  }
  return row;
}

function tickedHits(): Map<PlaylistId, EntryId[]> {
  const removals = new Map<PlaylistId, EntryId[]>();
  for (const box of document.querySelectorAll<HTMLInputElement>("#pl-artists-hits .pl-hit:checked")) {
    const id = box.dataset["playlist"] as PlaylistId;
    removals.set(id, [...(removals.get(id) ?? []), box.dataset["entry"] as EntryId]);
  }
  return removals;
}

function updateRemoveButton(): void {
  const count = [...tickedHits().values()].reduce((n, entries) => n + entries.length, 0);
  el("pl-artists-bar").hidden = plan === undefined || plan.playlists.every(({ hits }) => hits.length === 0);
  const button = el<HTMLButtonElement>("pl-artists-remove");
  button.disabled = count === 0;
  button.textContent = count === 0 ? "Nothing to remove" : `Remove ${songCount(count)}`;
}

async function removeArtists(): Promise<void> {
  const removals = [...tickedHits()].map(([playlistId, entries]) => ({ playlistId, entries }));
  const total = removals.reduce((n, { entries }) => n + entries.length, 0);
  if (total === 0 || plan === undefined) {
    return;
  }
  const unplayable = plan.playlists
    .flatMap(({ playlist, hits }) => hits.filter((hit) => removals.some((r) => r.playlistId === playlist.id && r.entries.includes(hit.entry.playlistTrackId))))
    .filter((hit) => hit.entry.streamable === false).length;
  const ok = await openDialog({
    title: `Remove ${songCount(total)}?`,
    body: [
      `From ${removals.length} playlist${removals.length === 1 ? "" : "s"}. You can undo this in History.`,
      ...(unplayable > 0
        ? [`${songCount(unplayable)} can no longer be played, so undo cannot put ${unplayable === 1 ? "it" : "them"} back.`]
        : []),
    ],
    confirm: "Remove",
    danger: true,
  });
  if (!ok) {
    return;
  }
  const panel = el("pl-artists");
  panel.inert = true;
  const button = el<HTMLButtonElement>("pl-artists-remove");
  button.disabled = true;
  button.textContent = `Removing ${songCount(total)}...`;
  try {
    const { reports } = await api<{ reports: RemovalReport[] }>("POST", "/api/manager/remove-artists/commit", { removals }, listService);
    const removed = reports.reduce((n, report) => n + report.removed, 0);
    const failed = reports.filter((report) => report.error !== undefined);
    closeArtists();
    ticked.clear();
    await load();
    void refreshLibrary();
    say(removed === 0 ? "Nothing was removed." : `Removed ${songCount(removed)}. You can undo this in History.`);
    if (failed.length > 0) {
      const nameOf = (id: PlaylistId): string => playlists.find((p) => p.id === id)?.name ?? `playlist ${shortId(id)}`;
      showError(el("pl-error"), failed.map((f) => `${nameOf(f.playlistId)}: ${f.error}`).join(" "));
    }
    el("pl-result").scrollIntoView({ block: "center" });
  } catch (error) {
    showError(el("pl-artists-error"), (error as Error).message);
  } finally {
    panel.inert = false;
    updateRemoveButton();
  }
}
