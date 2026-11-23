/**
 * The playlist editor: one playlist's songs as an editable draft.
 *
 * Opening reads the playlist; every edit after that (removing, dragging,
 * sorting) happens to a draft in the page, with undo and redo, until Save sends
 * it in one request. Copying, favouriting and the playlist's own details are
 * written at once. This is DOM glue: the draft and everything that edits it
 * are in src/features/playlist-draft.ts, artist matching in artist-match.ts,
 * and saving in playlist-manager.ts on the server.
 */

import {
  serviceOf,
  type ArtistId,
  type EntryId,
  type PlaylistId,
  type TrackId,
} from "../../services/ids.js";
import {
  artistCounts,
  linkLines,
  matchArtists,
  matchedIndexes,
  parseArtistTerms,
} from "../../features/artist-match.js";
import { KEEP_STRATEGIES, type KeepStrategy } from "../../features/deduplicate.js";
import type { ConfirmedAdd } from "../../features/playlist-add.js";
import {
  addedIds,
  alreadyInIds,
  draftChanges,
  duplicateIds,
  EditStack,
  liveIds,
  moveBy,
  moveTo,
  notHiResIds,
  otherVersionIds,
  putBack,
  rangeBetween,
  rebase,
  reorder,
  retarget,
  searchIds,
  shuffleIds,
  sortIds,
  spreadArtists,
  startDraft,
  summarise,
  takeOut,
  unplayableIds,
  type Destination,
  type Draft,
  type DraftSummary,
  type Entry,
  type SortKey,
} from "../../features/playlist-draft.js";
import type { ManagerPlaylist, SaveOutcome } from "../../features/playlist-manager.js";
import { formatDuration } from "../../features/playlist-shape.js";
import { normaliseArtistName } from "../../features/track-filter.js";
import type { Pick, TransferDestination } from "../../features/transfer.js";
import { labelOf } from "../../services/errors.js";
import { SERVICE_LABELS, type ServiceName } from "../../services/names.js";
import { connectedServices } from "../service.js";
import { describeTransfer, reviewTransfer, sendPicks, serviceSelect } from "../transfer.js";
import { api, type Artist, type Track } from "../api.js";
import { coverSlot } from "../artwork.js";
import { dialogChoice, dialogField, openDialog, textInput } from "../dialog.js";
import { el, showError } from "../dom.js";
import { enableDrag } from "../drag-list.js";
import { storePrefill, type Prefill } from "../prefill.js";
import { clockTime, qualityPill, titleOf, trackText } from "../tracks.js";
import { confirmDelete, editDetails, managedNotice, playlistHash, playlistLink, songCount } from "./playlist-actions.js";
import { refreshLibrary } from "../library.js";
import { actionButton, openTool, renderPlaylistHeader } from "../playlist-page.js";
import { knownLinks, LINKS_CHANGED } from "./links.js";
import { linkMark } from "../../sync/wording.js";

interface Editor {
  playlist: ManagerPlaylist;
  entries: Map<EntryId, Entry>;
  edits: EditStack<Draft>;
  selected: Set<EntryId>;
  /** Where a shift-click range starts. */
  anchor?: EntryId;
  /** The row the keyboard is on. */
  focused?: EntryId;
  query: string;
  rows: Map<EntryId, HTMLElement>;
}

let editor: Editor | undefined;
/** Counts opens, so a slow one cannot replace a later one. */
let request = 0;
let busy = false;

// ---- Opening, and not losing a draft ----------------------------------------

/** Whether there are unsaved edits. */
function isDirty(): boolean {
  return editor !== undefined && summarise(editor.edits.now).changed;
}

function hashFor(id: PlaylistId): string {
  return playlistHash(id);
}

/**
 * Ask before leaving a playlist with unsaved edits: for another view, another
 * playlist, or by closing the page. Call before any view listens for the hash.
 */
export function guardUnsavedPlaylist(): void {
  window.addEventListener("beforeunload", (event) => {
    if (isDirty() || busy) {
      event.preventDefault();
    }
  });
  window.addEventListener("hashchange", (event) => {
    if (editor === undefined) {
      closeDialogs();
      return;
    }
    const here = hashFor(editor.playlist.id);
    const target = location.hash;
    if (target === here) {
      return;
    }
    if (!busy && !isDirty()) {
      // What a dialog was about is no longer on the page.
      closeDialogs();
      return;
    }
    // Back to this playlist before any view reacts, then ask.
    event.stopImmediatePropagation();
    history.pushState(null, "", here);
    if (busy) {
      announce("Please wait: still working on this playlist.");
      el("pl-editor-status").scrollIntoView({ block: "nearest" });
      return;
    }
    if (document.querySelector("dialog[open]") !== null) {
      return;
    }
    void confirmLeaving().then((leave) => {
      if (leave) {
        closeEditor();
        location.hash = target;
      }
    });
  });
}

function closeDialogs(): void {
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
}

function confirmLeaving(): Promise<boolean> {
  return openDialog({
    title: "Leave without saving?",
    body: [`Your changes to "${editor?.playlist.name ?? "this playlist"}" have not been saved: ${describeDraft(summariseNow())}.`],
    confirm: "Leave and lose them",
    cancel: "Stay here",
    danger: true,
  });
}

/** Forget the open playlist (and any draft). */
export function closeEditor(): void {
  editor = undefined;
  request += 1;
  el("pl-songs").textContent = "";
}

interface Opened {
  playlist: ManagerPlaylist;
  entries: Entry[];
}

/** Show a playlist, reading it unless it is open already. */
export async function openEditor(id: PlaylistId, known?: ManagerPlaylist): Promise<void> {
  if (editor?.playlist.id === id) {
    return;
  }
  closeEditor();
  const mine = request;
  el("pl-name").textContent = known?.name ?? "Playlist";
  el("pl-meta").textContent = "";
  el("pl-notice").hidden = true;
  el("pl-editor-body").hidden = true;
  renderPlaylistHeader({ id, name: known?.name ?? "Playlist" });
  el("pl-actions").hidden = true;
  el("pl-more").hidden = true;
  showError(el("pl-editor-error"), undefined);
  showError(el("pl-editor-result"), undefined);
  el("pl-editor-status").textContent =
    known?.trackCount === undefined ? "Reading its songs..." : `Reading ${songCount(known.trackCount)}...`;
  try {
    const opened = await api<Opened>("POST", "/api/manager/open", { playlistId: id }, serviceOf(id));
    if (mine === request) {
      show(opened);
    }
  } catch (error) {
    if (mine === request) {
      showError(el("pl-editor-error"), (error as Error).message);
    }
  } finally {
    if (mine === request) {
      el("pl-editor-status").textContent = "";
    }
  }
}

function show(opened: Opened, draft?: Draft): void {
  const ids = opened.entries.map((entry) => entry.playlistTrackId);
  editor = {
    playlist: opened.playlist,
    entries: new Map(opened.entries.map((entry) => [entry.playlistTrackId, entry])),
    edits: new EditStack(draft ?? startDraft(ids)),
    selected: new Set(),
    query: "",
    rows: new Map(),
  };
  el<HTMLInputElement>("pl-search").value = "";
  el("pl-editor-body").hidden = false;
  el("pl-actions").hidden = false;
  el("pl-more").hidden = false;
  el("pl-songs").textContent = "";
  renderHead();
  renderMenus();
  render();
}

// ---- The draft --------------------------------------------------------------

function current(): Editor {
  if (editor === undefined) {
    throw new Error("no playlist is open");
  }
  return editor;
}

function summariseNow(): DraftSummary {
  return summarise(current().edits.now);
}

/** Whether `mine` is still the playlist being edited (an action may outlast it). */
function isStill(mine: Editor): boolean {
  return editor === mine;
}

function canEdit(): boolean {
  return editor !== undefined && editor.playlist.owned && !busy;
}

/** The kept entries, in the draft's order. */
function kept(): Entry[] {
  const { edits, entries } = current();
  return edits.now.order.map((id) => entries.get(id)!);
}

/** The ids shown: the kept ones, narrowed by the search. */
function shownIds(): readonly EntryId[] {
  const { edits, query } = current();
  return query.trim().length === 0 ? edits.now.order : searchIds(kept(), query);
}

function selectedInOrder(): EntryId[] {
  const { edits, selected } = current();
  return edits.now.order.filter((id) => selected.has(id));
}

/** Make an edit and show it. */
function edit(next: Draft, said?: string): void {
  const state = current();
  if (!canEdit() || next === state.edits.now) {
    return;
  }
  showError(el("pl-editor-result"), undefined);
  state.edits.push(next);
  render();
  if (said !== undefined) {
    announce(said);
  }
}

function announce(text: string): void {
  el("pl-live").textContent = text;
}

function say(text: string): void {
  const node = el("pl-editor-result");
  node.hidden = false;
  node.textContent = text;
}

function removeSelected(): void {
  const ids = selectedInOrder();
  if (ids.length > 0) {
    edit(takeOut(current().edits.now, ids), `Removed ${songCount(ids.length)} from the draft.`);
  }
}

function describeDraft(summary: DraftSummary): string {
  return draftParts(summary).join(", ");
}

function draftParts(summary: DraftSummary): string[] {
  const parts: string[] = [];
  if (summary.removed > 0) {
    parts.push(`remove ${songCount(summary.removed)}`);
  }
  for (const { destination, count } of summary.moved) {
    parts.push(`move ${songCount(count)} to ${destination.type === "new" ? "new playlist " : ""}${destination.name}`);
  }
  if (summary.reordered > 0) {
    parts.push(`reorder ${songCount(summary.reordered)}`);
  }
  return parts;
}

// ---- Rendering --------------------------------------------------------------

function renderHead(): void {
  const { playlist } = current();
  el("pl-name").textContent = playlist.name;
  const link = (knownLinks()?.links ?? []).find((view) => Object.values(view.link.copies).includes(playlist.id as never));
  const others =
    link === undefined
      ? undefined
      : (Object.keys(link.link.copies) as ServiceName[])
          .filter((service) => link.link.copies[service] !== playlist.id)
          .map((service) => SERVICE_LABELS[service])
          .join(", ");
  renderPlaylistHeader(playlist, others);
  const notice = managedNotice(playlist);
  const mark = linkMark(playlist.id, knownLinks()?.links ?? []);
  const node = el("pl-notice");
  node.hidden = notice === undefined && mark === undefined && playlist.owned;
  node.textContent = "";
  node.classList.toggle("urgent", mark?.conflict === true);
  if (mark !== undefined) {
    // A linked copy: its edits reach the other copies on the next sync.
    const link = document.createElement("a");
    link.href = "#/managed";
    link.textContent = mark.conflict ? "Choose in Managed playlists" : "Managed playlists";
    node.append(
      `${mark.text}.`,
      mark.conflict ? " Nothing is synced until you choose. " : " Changes saved here reach the other copies on the next sync. ",
      link,
    );
  } else if (!playlist.owned) {
    node.textContent = "This playlist belongs to someone else. You can copy songs from it, not change it.";
  } else if (notice !== undefined) {
    node.append(notice, " ");
    const link = document.createElement("a");
    link.href = "#/managed";
    link.textContent = "Managed playlists";
    node.append(link);
  }
}

function renderMeta(): void {
  const { playlist, edits } = current();
  const entries = kept();
  const seconds = entries.reduce((sum, entry) => sum + (entry.duration ?? 0), 0);
  const parts = [songCount(entries.length)];
  if (seconds > 0) {
    parts.push(formatDuration(seconds));
  }
  if (edits.now.base.length !== entries.length) {
    parts.push(`${songCount(edits.now.base.length)} as saved`);
  }
  if (playlist.isPublic !== undefined) {
    parts.push(playlist.isPublic ? "public" : "private");
  }
  if (playlist.isCollaborative === true) {
    parts.push("collaborative");
  }
  el("pl-meta").textContent = parts.join(" · ");
}

/** What marks a song out: a copy of another, unplayable... */
interface Badges {
  duplicates: Set<EntryId>;
  versions: Set<EntryId>;
}

function badgesNow(entries: readonly Entry[]): Badges {
  return {
    duplicates: new Set(duplicateIds(entries, "first-added")),
    versions: new Set(otherVersionIds(entries)),
  };
}

function render(): void {
  const state = current();
  const { edits, entries, selected } = state;
  for (const id of [...selected]) {
    if (edits.now.removed.has(id)) {
      selected.delete(id);
    }
  }
  if (state.focused !== undefined && edits.now.removed.has(state.focused)) {
    delete state.focused;
  }
  const shown = shownIds();
  const badges = badgesNow(kept());
  const place = new Map(edits.now.order.map((id, index) => [id, index + 1]));
  const list = el("pl-songs");
  const rows = shown.map((id) => {
    let row = state.rows.get(id);
    if (row === undefined) {
      row = createRow(entries.get(id)!);
      state.rows.set(id, row);
    }
    row.querySelector(".pl-number")!.textContent = String(place.get(id));
    row.querySelector<HTMLElement>(".pl-duplicate")!.hidden = !badges.duplicates.has(id);
    row.querySelector<HTMLElement>(".pl-version")!.hidden = !badges.versions.has(id);
    return row;
  });
  const same = list.children.length === rows.length && rows.every((row, i) => list.children[i] === row);
  if (!same) {
    const scroll = window.scrollY;
    list.replaceChildren(...rows);
    window.scrollTo(0, scroll);
  }
  const searching = state.query.trim().length > 0;
  list.classList.toggle("no-drag", searching || !state.playlist.owned);
  const count = el("pl-shown");
  count.hidden = !searching;
  count.textContent = searching
    ? `${shown.length} of ${songCount(edits.now.order.length)} match. Dragging is off while searching; Top, Bottom and Move to still work.`
    : "";
  renderMeta();
  renderSelection();
  renderRemoved();
  renderDraftBar();
  renderArtists();
  renderByArtist();
}

function createRow(entry: Entry): HTMLElement {
  const row = document.createElement("li");
  row.className = "pl-row";
  row.id = `pl-row-${entry.playlistTrackId}`;
  row.dataset["id"] = String(entry.playlistTrackId);
  row.dataset["label"] = titleOf(entry);
  row.setAttribute("role", "option");

  const handle = span("pl-handle", "≡");
  handle.setAttribute("aria-hidden", "true");
  handle.title = "Drag to move";
  const box = span("pl-check", "");
  box.setAttribute("aria-hidden", "true");
  row.append(handle, box, span("pl-number", ""), coverSlot(entry.image, entry.album ?? entry.title));

  const artists = [entry.artist, ...(entry.jointArtists ?? [])].filter((name) => name !== undefined).join(", ");
  row.append(trackText(titleOf(entry), [artists, entry.album].filter((part) => part !== undefined && part !== "").join(" · ")));

  const badges = span("pl-badges", "");
  badges.append(
    badge("pl-duplicate", "duplicate", "Another copy of this song is higher up"),
    badge("pl-version", "other version", "Another version (live, acoustic, remix) of a song here"),
  );
  if (entry.streamable === false) {
    badges.append(badge("pl-unplayable", "unplayable", `${serviceName()} no longer plays this; once removed it cannot be put back`));
  }
  row.append(badges);

  const added = span("pl-added", entry.addedAt === undefined ? "" : shortDate(entry.addedAt));
  added.title = entry.addedAt === undefined ? "" : `Added ${shortDate(entry.addedAt)}`;
  row.append(added);
  row.append(qualityPill(entry) ?? span("quality-none", ""));
  row.append(span("length", entry.duration === undefined ? "" : clockTime(entry.duration)));
  return row;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function badge(className: string, text: string, title: string): HTMLSpanElement {
  const node = span(`pl-badge ${className}`, text);
  node.title = title;
  return node;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderSelection(): void {
  const state = current();
  for (const [id, row] of state.rows) {
    const on = state.selected.has(id);
    row.classList.toggle("selected", on);
    row.setAttribute("aria-selected", String(on));
    row.classList.toggle("focused", id === state.focused);
  }
  const list = el("pl-songs");
  if (state.focused === undefined) {
    list.removeAttribute("aria-activedescendant");
  } else {
    list.setAttribute("aria-activedescendant", `pl-row-${state.focused}`);
  }
  const count = state.selected.size;
  el("pl-selection").hidden = count === 0;
  if (count > 0) {
    const shown = new Set(shownIds());
    const hidden = [...state.selected].filter((id) => !shown.has(id)).length;
    const seconds = selectedInOrder().reduce((sum, id) => sum + (state.entries.get(id)?.duration ?? 0), 0);
    el("pl-selected").textContent =
      `${songCount(count)} selected` +
      (seconds > 0 ? `, ${formatDuration(seconds)}` : "") +
      (hidden > 0 ? ` (${hidden} hidden by the search)` : "");
  }
  renderBar();
}

function renderBar(): void {
  el("pl-edit-bar").hidden = el("pl-selection").hidden && el("pl-draft").hidden;
}

function renderDraftBar(): void {
  const { edits } = current();
  const summary = summarise(edits.now);
  el("pl-draft").hidden = !summary.changed && !edits.canUndo && !edits.canRedo;
  el("pl-draft-summary").textContent = summary.changed ? `Draft: ${describeDraft(summary)}` : "No changes to save";
  el<HTMLButtonElement>("pl-undo").disabled = !edits.canUndo;
  el<HTMLButtonElement>("pl-redo").disabled = !edits.canRedo;
  el<HTMLButtonElement>("pl-discard").disabled = !summary.changed;
  el<HTMLButtonElement>("pl-save").disabled = !summary.changed;
  renderBar();
}

function renderRemoved(): void {
  const { edits, entries } = current();
  const removed = edits.now.base.filter((id) => edits.now.removed.has(id));
  el("pl-removed").hidden = removed.length === 0;
  el("pl-removed-summary").textContent = `Taken out (${removed.length})`;
  el("pl-removed-list").replaceChildren(
    ...removed.map((id) => {
      const entry = entries.get(id)!;
      const destination = edits.now.removed.get(id);
      const item = document.createElement("li");
      const note = destination === undefined ? entry.artist : `${entry.artist ?? ""} → ${destination.name}`;
      item.append(trackText(titleOf(entry), note));
      const back = button("Put back", () => edit(putBack(current().edits.now, [id]), `Put ${titleOf(entry)} back.`));
      back.setAttribute("aria-label", `Put ${titleOf(entry)} back`);
      item.append(back);
      return item;
    }),
  );
}

function button(text: string, onClick: () => void, className = "secondary small"): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

// ---- Selecting --------------------------------------------------------------

function selectOnly(ids: Iterable<EntryId>): void {
  const state = current();
  state.selected = new Set(ids);
  renderSelection();
  renderArtists();
}

/** Select what a menu item picked, among the songs shown. */
function selectPicked(ids: readonly EntryId[], what: string): void {
  const shown = new Set(shownIds());
  const picked = ids.filter((id) => shown.has(id));
  selectOnly(picked);
  const text = picked.length === 0 ? `No ${what} here.` : `Selected ${songCount(picked.length)}: ${what}.`;
  say(text);
  const first = current().edits.now.order.find((id) => current().selected.has(id));
  if (first !== undefined) {
    current().rows.get(first)?.scrollIntoView({ block: "center" });
  }
}

function toggle(id: EntryId): void {
  const { selected } = current();
  if (!selected.delete(id)) {
    selected.add(id);
  }
}

function onRowClick(event: MouseEvent): void {
  const target = event.target as Element;
  const row = target.closest<HTMLElement>(".pl-row");
  if (row === null || editor === undefined || target.closest(".pl-handle") !== null) {
    return;
  }
  const id = (row.dataset["id"] as EntryId);
  const state = current();
  if (event.shiftKey && state.anchor !== undefined) {
    const range = rangeBetween(shownIds(), state.anchor, id);
    const on = state.selected.has(state.anchor);
    range.forEach((item) => (on ? state.selected.add(item) : state.selected.delete(item)));
    state.focused = id;
  } else {
    toggle(id);
    state.anchor = id;
    state.focused = id;
  }
  el("pl-songs").focus({ preventScroll: true });
  renderSelection();
  renderArtists();
}

/** Move the keyboard's row, extending the selection with shift. */
function focusRow(index: number, extend: boolean): void {
  const state = current();
  const shown = shownIds();
  const id = shown[Math.min(Math.max(index, 0), shown.length - 1)];
  if (id === undefined) {
    return;
  }
  if (extend) {
    state.anchor ??= state.focused ?? id;
    selectOnly(new Set([...state.selected, ...rangeBetween(shown, state.anchor, id)]));
  } else {
    state.anchor = id;
  }
  state.focused = id;
  renderSelection();
  state.rows.get(id)?.scrollIntoView({ block: "nearest" });
}

/** While rows are dragged, keys must not change the list under them. */
function isDragging(): boolean {
  return document.body.classList.contains("is-dragging");
}

function onListKey(event: KeyboardEvent): void {
  if (editor === undefined || isDragging()) {
    return;
  }
  const state = current();
  const shown = shownIds();
  const at = state.focused === undefined ? -1 : shown.indexOf(state.focused);
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (step !== 0 && event.altKey) {
    event.preventDefault();
    nudge(step as 1 | -1);
  } else if (step !== 0) {
    event.preventDefault();
    focusRow(at === -1 ? 0 : at + step, event.shiftKey);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusRow(event.key === "Home" ? 0 : shown.length - 1, event.shiftKey);
  } else if (event.key === "PageUp" || event.key === "PageDown") {
    event.preventDefault();
    focusRow(at + (event.key === "PageUp" ? -12 : 12), event.shiftKey);
  } else if (event.key === " ") {
    event.preventDefault();
    if (state.focused !== undefined) {
      toggle(state.focused);
      state.anchor = state.focused;
      renderSelection();
      renderArtists();
    }
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    const next = shown.slice(at + 1).find((id) => !state.selected.has(id));
    removeSelected();
    if (next !== undefined && editor.focused === undefined) {
      editor.focused = next;
      renderSelection();
    }
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectOnly(new Set([...state.selected, ...shown]));
  }
}

/** Keys that work anywhere on the page but in a field. */
function onPageKey(event: KeyboardEvent): void {
  const target = event.target as Element | null;
  if (
    editor === undefined ||
    isDragging() ||
    el("view-playlists").hidden ||
    document.querySelector("dialog[open]") !== null ||
    target?.closest("input, textarea, select") != null
  ) {
    return;
  }
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    step(event.shiftKey ? "redo" : "undo");
  } else if (event.ctrlKey && key === "y") {
    event.preventDefault();
    step("redo");
  } else if (event.key === "Escape" && editor.selected.size > 0) {
    selectOnly([]);
  }
}

function step(way: "undo" | "redo"): void {
  if (!canEdit()) {
    return;
  }
  const { edits } = current();
  if (way === "undo" ? edits.canUndo : edits.canRedo) {
    edits[way]();
    render();
    announce(way === "undo" ? "Undone." : "Redone.");
  }
}

function nudge(by: 1 | -1): void {
  const ids = current().selected.size > 0 ? selectedInOrder() : current().focused === undefined ? [] : [current().focused!];
  if (ids.length === 0 || current().query.trim().length > 0) {
    return;
  }
  edit(moveBy(current().edits.now, ids, by), `Moved ${songCount(ids.length)} ${by === -1 ? "up" : "down"}.`);
  const focused = current().focused;
  if (focused !== undefined) {
    current().rows.get(focused)?.scrollIntoView({ block: "nearest" });
  }
}

// ---- Actions on the selection -------------------------------------------------

function renderMenus(): void {
  const { playlist } = current();
  const actions: HTMLElement[] = [];
  if (playlist.owned) {
    actions.push(
      button("Remove", removeSelected, "danger small"),
      button("Move to...", () => void sendSelected("move")),
    );
  }
  actions.push(
    button("Copy to...", () => void sendSelected("copy")),
    button("New playlist...", () => void splitSelected()),
    button("Favourite", () => void favouriteSelected()),
  );
  if (playlist.owned) {
    actions.push(
      button("Top", () => moveSelected(0, "the top")),
      button("Bottom", () => moveSelected(current().edits.now.order.length, "the end")),
      button("Move to place...", () => void moveToPlace()),
    );
  }
  actions.push(button("Clear", () => selectOnly([])));
  el("pl-selection-actions").replaceChildren(...actions);

  renderSelectMenu();
  renderSortMenu();
  el("pl-sort-menu").hidden = !playlist.owned;
  renderActions();
  renderMore();
}

function moveSelected(index: number, where: string): void {
  const ids = selectedInOrder();
  edit(moveTo(current().edits.now, ids, index), `Moved ${songCount(ids.length)} to ${where}.`);
}

async function moveToPlace(): Promise<void> {
  const mine = current();
  const ids = selectedInOrder();
  const total = current().edits.now.order.length;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = String(total);
  input.value = "1";
  const valid = (): boolean => Number.isInteger(input.valueAsNumber) && input.valueAsNumber >= 1 && input.valueAsNumber <= total;
  const ok = await openDialog({
    title: "Move to a place",
    body: [dialogField(`Where ${ids.length === 1 ? "the song" : `the first of the ${ids.length} songs`} goes (1 to ${total})`, input)],
    confirm: "Move",
    validate: () => (valid() ? undefined : `Enter a whole number from 1 to ${total}.`),
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  // The place counts the list as it ends up: that many songs stay ahead of them.
  const { now } = current().edits;
  const moving = new Set(ids);
  const others = now.order.filter((id) => !moving.has(id));
  const before = others[input.valueAsNumber - 1];
  edit(
    moveTo(now, ids, before === undefined ? now.order.length : now.order.indexOf(before)),
    `Moved ${songCount(ids.length)} to place ${input.valueAsNumber}.`,
  );
}

/** The name of the service this playlist is on. */
function serviceName(): string {
  return labelOf(serviceOf(current().playlist.id));
}

/** Ask for one of the user's playlists songs can be put in. */
async function pickPlaylist(title: string, confirm: string, forSongs: boolean): Promise<ManagerPlaylist | undefined> {
  const mine = current();
  const here = mine.playlist.id;
  let playlists: ManagerPlaylist[];
  try {
    // Songs can go to a playlist on any connected service.
    const on = forSongs && connectedServices().length > 1 ? "all" : serviceOf(here);
    ({ playlists } = await api<{ playlists: ManagerPlaylist[] }>("GET", "/api/manager/playlists", undefined, on));
  } catch (error) {
    if (isStill(mine)) {
      showError(el("pl-editor-error"), (error as Error).message);
    }
    return undefined;
  }
  if (!isStill(mine)) {
    return undefined;
  }
  const others = playlists
    .filter((p) => p.id !== here && (!forSongs || p.owned))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (others.length === 0) {
    await openDialog({ title, body: ["You have no other playlists."], confirm: "Close", cancel: null });
    return undefined;
  }
  const select = document.createElement("select");
  for (const playlist of others) {
    const there = serviceOf(playlist.id);
    const option = new Option(there === serviceOf(here) ? playlist.name : `${playlist.name} (${labelOf(there)})`, playlist.id);
    if (forSongs && playlist.managed?.mode === "mirror") {
      option.disabled = true;
      option.textContent = `${playlist.name} (managed: kept exactly as its source)`;
    }
    select.append(option);
  }
  const ok = await openDialog({
    title,
    body: [dialogField("Playlist", select)],
    confirm,
    validate: () => (select.value === "" || select.selectedOptions[0]?.disabled === true ? "Choose a playlist." : undefined),
  });
  return ok && isStill(mine) ? others.find((p) => String(p.id) === select.value) : undefined;
}

async function sendSelected(how: "copy" | "move"): Promise<void> {
  const ids = selectedInOrder();
  const playlist = await pickPlaylist(
    `${how === "copy" ? "Copy" : "Move"} ${songCount(ids.length)} to`,
    how === "copy" ? "Copy" : "Move on save",
    true,
  );
  if (playlist === undefined) {
    return;
  }
  const destination: Destination = { type: "existing", playlistId: playlist.id, name: playlist.name };
  const to = serviceOf(playlist.id);
  if (to !== serviceOf(current().playlist.id)) {
    await sendAcross(ids, to, { type: "existing", playlistId: playlist.id }, playlist.name, how === "move");
    return;
  }
  if (how === "copy") {
    await copyNow(ids, destination);
  } else {
    edit(takeOut(current().edits.now, ids, destination), `${songCount(ids.length)} will move to ${playlist.name} when you save.`);
  }
}

async function splitSelected(): Promise<void> {
  const mine = current();
  const ids = selectedInOrder();
  const { owned, name: from } = current().playlist;
  const name = textInput(`${from} (part)`);
  const isPublic = dialogChoice("checkbox", "Public");
  const keep = dialogChoice("radio", "Keep the songs here too (made at once)", { name: "split", checked: true });
  const take = dialogChoice("radio", "Take them out of this playlist (when you save)", { name: "split" });
  const here = serviceOf(current().playlist.id);
  const on = serviceSelect(here);
  const ok = await openDialog({
    title: `New playlist of ${songCount(ids.length)}`,
    body: [
      dialogField("Name", name),
      ...(on === undefined ? [] : [dialogField("On", on)]),
      isPublic.field,
      ...(owned ? [keep.field, take.field] : []),
    ],
    confirm: "Create",
    validate: () => (name.value.trim() === "" ? "Give it a name." : undefined),
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  const destination: Destination = { type: "new", name: name.value.trim(), isPublic: isPublic.input.checked };
  const to = (on?.value ?? here) as ServiceName;
  if (to !== here) {
    await sendAcross(ids, to, destination, destination.name, take.input.checked);
    return;
  }
  if (take.input.checked) {
    edit(takeOut(current().edits.now, ids, destination), `${songCount(ids.length)} will move to ${destination.name} when you save.`);
  } else {
    await copyNow(ids, destination);
  }
}

/**
 * Put songs on another service, once reviewed. With `take`, those that arrived
 * are then taken out of the draft; the others stay.
 */
async function sendAcross(
  ids: readonly EntryId[],
  to: ServiceName,
  destination: TransferDestination,
  name: string,
  take: boolean,
): Promise<void> {
  const mine = current();
  const songs = ids.map((id) => mine.entries.get(id)!);
  let picks: Pick[] | undefined;
  await working(`Looking on ${labelOf(to)}...`, async () => {
    picks = await reviewTransfer({ tracks: songs }, to);
  });
  if (picks === undefined || !isStill(mine)) {
    return;
  }
  const chosen = picks;
  await working(`Copying to ${labelOf(to)}...`, async () => {
    const result = await sendPicks(to, destination, chosen);
    const missing = new Set(result.missing);
    const arrived = ids.filter((_, index) => {
      const { track } = chosen[index]!;
      return track !== null && !missing.has(track);
    });
    const text = describeTransfer(to, name, result);
    if (take && arrived.length > 0) {
      edit(takeOut(current().edits.now, arrived), `${text} They leave this playlist when you save.`);
    } else {
      say(text);
    }
  });
}

/** Copy this whole playlist, as saved, to a new one on another service. */
async function copyToService(): Promise<void> {
  const mine = current();
  const { playlist } = mine;
  const here = serviceOf(playlist.id);
  const others = connectedServices().filter((service) => service !== here);
  if (others.length === 0) {
    await openDialog({
      title: "Copy to another service",
      body: ["Connect another music service in Accounts first."],
      confirm: "Close",
      cancel: null,
    });
    return;
  }
  const on = document.createElement("select");
  others.forEach((service) => on.append(new Option(labelOf(service), service)));
  const name = textInput(playlist.name);
  const ok = await openDialog({
    title: "Copy to another service",
    body: [dialogField("To", on), dialogField("Name", name)],
    confirm: "Find the songs",
    validate: () => (name.value.trim() === "" ? "Give it a name." : undefined),
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  const to = on.value as ServiceName;
  await sendAcross(
    mine.edits.now.order,
    to,
    { type: "new", name: name.value.trim(), isPublic: false },
    name.value.trim(),
    false,
  );
}

async function copyNow(ids: readonly EntryId[], destination: Destination): Promise<void> {
  await working("Copying...", async () => {
    const result = await api<ConfirmedAdd>("POST", "/api/manager/copy", { trackIds: trackIdsOf(ids), destination }, serviceOf(current().playlist.id));
    say(describeAdd(result, "Copied"));
  });
}

/** "Copied 5 songs to Mix; 2 were there already; ..." */
function describeAdd(result: ConfirmedAdd, verb: string): string {
  const parts = [
    result.added.length === 0 && result.already.length > 0
      ? `Nothing to add to ${result.name}`
      : `${verb} ${songCount(result.added.length)} to ${result.name}`,
  ];
  if (result.already.length > 0) {
    parts.push(`${result.already.length} ${result.already.length === 1 ? "was" : "were"} there already`);
  }
  if (result.missing.length > 0) {
    parts.push(`${serviceName()} no longer offers ${result.missing.length}`);
  }
  return `${parts.join("; ")}.`;
}

function trackIdsOf(ids: readonly EntryId[]): TrackId[] {
  const { entries } = current();
  return ids.map((id) => entries.get(id)!.id);
}

async function favouriteSelected(): Promise<void> {
  const ids = trackIdsOf(selectedInOrder());
  await working("Adding to Favourites...", async () => {
    const { added, already } = await api<{ added: number; already: number }>("POST", "/api/manager/favourite", {
      trackIds: ids,
    }, serviceOf(current().playlist.id));
    const there = already === 0 ? "" : ` ${already} ${already === 1 ? "was" : "were"} there already.`;
    say(`Added ${songCount(added)} to your Favourites.${there}`);
  });
}

/** Run something that writes, with the editor out of use meanwhile. */
async function working(text: string, task: () => Promise<void>): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  const body = el("pl-editor-body");
  // The header's links and menus too: nothing may start meanwhile.
  const parts = [body, ...document.querySelectorAll<HTMLElement>(".pl-editor-head")];
  parts.forEach((part) => (part.inert = true));
  body.setAttribute("aria-busy", "true");
  el("pl-editor-status").textContent = text;
  showError(el("pl-editor-error"), undefined);
  showError(el("pl-editor-result"), undefined);
  try {
    await task();
  } catch (error) {
    showError(el("pl-editor-error"), (error as Error).message);
    el("pl-editor-error").scrollIntoView({ block: "nearest" });
  } finally {
    busy = false;
    parts.forEach((part) => (part.inert = false));
    body.removeAttribute("aria-busy");
    el("pl-editor-status").textContent = "";
  }
}

// ---- Select and sort menus ----------------------------------------------------

/** A menu item that closes its menu and acts. */
function menuItem(text: string, act: () => void): HTMLButtonElement {
  const item = button(text, () => {
    item.closest("details")?.removeAttribute("open");
    act();
  }, "menu-item");
  return item;
}

function renderSelectMenu(): void {
  const pick = (text: string, what: string, ids: () => readonly EntryId[]): HTMLElement =>
    menuItem(text, () => selectPicked(ids(), what));

  const keep = document.createElement("select");
  keep.setAttribute("aria-label", "Copy to keep");
  for (const strategy of KEEP_STRATEGIES) {
    keep.append(new Option(KEEP_LABELS[strategy], strategy));
  }
  const versions = dialogChoice("checkbox", "also other versions (live, acoustic, remix)");
  const duplicates = document.createElement("div");
  duplicates.className = "menu-group";
  duplicates.append(
    menuItem("Duplicates", () =>
      selectPicked(
        duplicateIds(kept(), keep.value as KeepStrategy, { includeVersions: versions.input.checked }),
        "duplicates",
      ),
    ),
    keep,
    versions.field,
  );

  const date = document.createElement("input");
  date.type = "date";
  date.setAttribute("aria-label", "Date added");
  const dated = document.createElement("div");
  dated.className = "menu-group";
  const addedItem = (text: string, when: "before" | "since"): HTMLElement =>
    menuItem(text, () => {
      if (date.value !== "") {
        selectPicked(addedIds(kept(), when, date.value), `added ${when === "before" ? "before" : "on or after"} ${shortDate(`${date.value}T12:00:00`)}`);
      }
    });
  dated.append(date, addedItem("Added before this date", "before"), addedItem("Added since this date", "since"));

  el("pl-select-items").replaceChildren(
    menuItem("All shown", () => selectOnly(shownIds())),
    menuItem("None", () => selectOnly([])),
    menuItem("Invert", () => {
      const { selected } = current();
      selectOnly(shownIds().filter((id) => !selected.has(id)));
    }),
    duplicates,
    pick("Other versions (live, acoustic, remix)", "other versions of songs here", () => otherVersionIds(kept())),
    pick("Live recordings", "live recordings", () => liveIds(kept())),
    pick("Unplayable", "unplayable songs", () => unplayableIds(kept())),
    pick("Not hi-res", "songs not in hi-res", () => notHiResIds(kept())),
    menuItem("Already in Favourites", () => void selectAlreadyIn("favourites")),
    menuItem("Already in another playlist...", () => void selectAlreadyIn("playlist")),
    dated,
  );
}

/** Which copy of a duplicate stays; "first" and "last" go by the list as it stands. */
const KEEP_LABELS: Record<KeepStrategy, string> = {
  "first-added": "keep the first in the list",
  "last-added": "keep the last in the list",
  "highest-quality": "keep the highest quality",
  oldest: "keep the oldest release",
  newest: "keep the newest release",
};

async function selectAlreadyIn(where: "favourites" | "playlist"): Promise<void> {
  const mine = current();
  let body: unknown = { favourites: true };
  let name = "your Favourites";
  if (where === "playlist") {
    const playlist = await pickPlaylist("Select songs already in", "Select", false);
    if (playlist === undefined) {
      return;
    }
    body = { playlistId: playlist.id };
    name = playlist.name;
  }
  let found: readonly Track[] | undefined;
  await working(`Reading ${name}...`, async () => {
    ({ tracks: found } = await api<{ tracks: Track[] }>("POST", "/api/manager/compare", body, serviceOf(current().playlist.id)));
  });
  if (found !== undefined && isStill(mine)) {
    selectPicked(alreadyInIds(kept(), found), `songs already in ${name}`);
  }
}

const SORTS: ReadonlyArray<{ key: SortKey; up: string; down: string }> = [
  { key: "title", up: "Title, A to Z", down: "Title, Z to A" },
  { key: "artist", up: "Artist, A to Z", down: "Artist, Z to A" },
  { key: "album", up: "Album, in track order", down: "Album, Z to A" },
  { key: "added", up: "Added, oldest first", down: "Added, newest first" },
  { key: "released", up: "Released, oldest first", down: "Released, newest first" },
  { key: "length", up: "Shortest first", down: "Longest first" },
  { key: "quality", up: "Lowest quality first", down: "Highest quality first" },
];

function renderSortMenu(): void {
  const only = dialogChoice("checkbox", "Just the selected songs");
  const menu = el<HTMLDetailsElement>("pl-sort-menu");
  menu.ontoggle = () => {
    // With fewer than two there is nothing to arrange among them.
    const enough = editor !== undefined && editor.selected.size > 1;
    only.input.disabled = !enough;
    only.input.checked = only.input.checked && enough;
  };
  /** The songs to arrange: the selected ones, if asked and there are several. */
  const scope = (): Entry[] => {
    const { selected } = current();
    return only.input.checked && selected.size > 1 ? kept().filter((e) => selected.has(e.playlistTrackId)) : kept();
  };
  const arrange = (text: string, ids: (entries: Entry[]) => EntryId[]): HTMLElement =>
    menuItem(text, () => edit(reorder(current().edits.now, ids(scope())), `Sorted: ${text}.`));
  el("pl-sort-items").replaceChildren(
    only.field,
    ...SORTS.flatMap(({ key, up, down }) => [
      arrange(up, (entries) => sortIds(entries, key)),
      arrange(down, (entries) => sortIds(entries, key, true)),
    ]),
    arrange("Reverse", (entries) => entries.map((e) => e.playlistTrackId).reverse()),
    arrange("Shuffle", (entries) => shuffleIds(entries)),
    arrange("Spread out artists", (entries) => spreadArtists(entries)),
  );
}

// ---- Artists ------------------------------------------------------------------

function entriesOfArtist(artist: { id?: ArtistId; name: string }): EntryId[] {
  const name = normaliseArtistName(artist.name);
  return kept()
    .filter((entry) =>
      artist.id === undefined
        ? entry.artistId === undefined && entry.artist !== undefined && normaliseArtistName(entry.artist) === name
        : entry.artistId === artist.id,
    )
    .map((entry) => entry.playlistTrackId);
}

function renderArtists(): void {
  if (el("pl-artist-panel").hidden) {
    return;
  }
  const { selected } = current();
  const filter = normaliseArtistName(el<HTMLInputElement>("pl-artist-filter").value);
  const items = artistCounts(kept())
    .filter((artist) => normaliseArtistName(artist.name).includes(filter))
    .map((artist) => {
      const ids = entriesOfArtist(artist);
      const on = ids.filter((id) => selected.has(id)).length;
      const item = document.createElement("li");
      const choice = dialogChoice("checkbox", "", { checked: on > 0 && on === ids.length });
      choice.input.indeterminate = on > 0 && on < ids.length;
      choice.input.dataset["artist"] = artist.name;
      choice.input.addEventListener("change", () => {
        ids.forEach((id) => (choice.input.checked ? selected.add(id) : selected.delete(id)));
        renderSelection();
      });
      choice.field.append(span("pl-artist-name", artist.name), span("count", String(artist.count)));
      item.append(choice.field);
      return item;
    });
  const list = el("pl-artist-list");
  const scroll = list.scrollTop;
  list.replaceChildren(...items);
  list.scrollTop = scroll;
}

/** Artist links already looked up. */
const links = new Map<string, Artist | { problem: string }>();
let lookupTimer = 0;

function byLines(): string[] {
  return el<HTMLTextAreaElement>("pl-by-lines").value.split("\n");
}

function onByInput(): void {
  renderByArtist();
  clearTimeout(lookupTimer);
  const unknown = linkLines(byLines()).filter((line) => !links.has(line));
  if (unknown.length > 0) {
    lookupTimer = window.setTimeout(() => void lookUpLinks(unknown), 500);
  }
}

async function lookUpLinks(lines: readonly string[]): Promise<void> {
  try {
    const found = await api<{ links: Array<{ line: string; artist?: Artist; problem?: string }> }>(
      "POST",
      "/api/manager/artist-links",
      { lines },
      editor === undefined ? undefined : serviceOf(editor.playlist.id),
    );
    for (const { line, artist, problem } of found.links) {
      links.set(line, artist ?? { problem: problem ?? "not found" });
    }
  } catch (error) {
    showError(el("pl-editor-error"), (error as Error).message);
  }
  if (editor !== undefined) {
    renderByArtist();
  }
}

/** The songs the typed artists pick: theirs, or (to keep only them) all others. */
function byPicked(): { ids: EntryId[]; keepOnly: boolean } {
  const entries = kept();
  const { terms } = parseArtistTerms(byLines(), links);
  const guests = el<HTMLInputElement>("pl-by-guests").checked;
  const matched = new Set(matchedIndexes(matchArtists(entries, terms), guests));
  const keepOnly = document.querySelector<HTMLInputElement>('input[name="pl-by-mode"]:checked')?.value === "keep";
  const ids = entries.flatMap((entry, i) => (matched.has(i) !== keepOnly ? [entry.playlistTrackId] : []));
  // Keeping only artists that match nothing would empty the playlist.
  return { ids: keepOnly && matched.size === 0 ? [] : ids, keepOnly };
}

function renderByArtist(): void {
  if (el("pl-by-panel").hidden) {
    return;
  }
  const entries = kept();
  const { terms, problems } = parseArtistTerms(byLines(), links);
  const results = matchArtists(entries, terms);
  const found = el("pl-by-found");
  found.replaceChildren(
    ...results.map((result) => {
      const line = document.createElement("p");
      line.append(span("pl-artist-name", result.name));
      if (result.main.length + result.guest.length > 0) {
        const guest = result.guest.length === 0 ? "" : `${result.main.length > 0 ? ", and " : ""}${result.guest.length} as a guest`;
        line.append(span("count", `${result.main.length > 0 ? songCount(result.main.length) : ""}${guest}`));
      } else {
        line.append(span("pl-missing", "not in this playlist"));
        const { suggestion } = result;
        if (suggestion !== undefined) {
          line.append(
            button(`Did you mean ${suggestion.name} (${suggestion.count})?`, () => {
              const box = el<HTMLTextAreaElement>("pl-by-lines");
              box.value = byLines().map((text) => (text.trim() === result.line ? suggestion.name : text)).join("\n");
              onByInput();
            }),
          );
        }
      }
      return line;
    }),
    ...problems.map(({ line, reason }) => {
      const node = document.createElement("p");
      const waiting = linkLines([line]).length > 0 && !links.has(line);
      node.append(span("pl-artist-name", line), span("pl-missing", waiting ? "looking it up..." : reason));
      return node;
    }),
  );
  const guests = matchedIndexes(results, true).length - matchedIndexes(results, false).length;
  el("pl-by-guests-label").textContent =
    `Include songs where they are only a guest${guests > 0 ? ` (${guests})` : ""}`;
  const { ids, keepOnly } = byPicked();
  const apply = el<HTMLButtonElement>("pl-by-apply");
  apply.hidden = !current().playlist.owned;
  // Keeping only the listed artists needs every line understood.
  const unclear = keepOnly && problems.length > 0;
  apply.disabled = ids.length === 0 || unclear;
  apply.textContent = unclear
    ? "Fix the lines above first"
    : ids.length === 0
      ? "Nothing to remove"
      : `Remove ${songCount(ids.length)}`;
  el<HTMLButtonElement>("pl-by-select").disabled = ids.length === 0 || unclear;
}

function togglePanel(buttonId: string, panelId: string): void {
  const panel = el(panelId);
  panel.hidden = !panel.hidden;
  el(buttonId).setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden && editor !== undefined) {
    renderArtists();
    renderByArtist();
    panel.querySelector<HTMLElement>("input, textarea")?.focus();
  }
}

// ---- Other tools, and the playlist itself --------------------------------------

/** Leave for a tool filled in for this playlist, asking first about a draft. */
function leaveFor(prefill: Prefill): void {
  void (async () => {
    const mine = current();
    if ((isDirty() && !(await confirmLeaving())) || !isStill(mine)) {
      return;
    }
    closeEditor();
    openTool(prefill, serviceOf(mine.playlist.id));
  })();
}

/** The prefills of the tools this playlist opens in. */
function toolsFor(id: PlaylistId): Record<"repeats" | "upgrade" | "stats" | "export" | "similar" | "combine", Prefill> {
  const text = String(id);
  return {
    repeats: { view: "deduplicate", radios: { "dedup-source": "playlist" }, fields: { "dedup-playlist-select": text } },
    upgrade: { view: "upgrade", fields: { "upgrade-source": `playlist:${text}` } },
    stats: { view: "stats", fields: { "stats-source": text } },
    export: { view: "import-export", radios: { "ie-source": "playlist" }, fields: { "ie-export-playlist-select": text } },
    similar: { view: "similar", radios: { "similar-source": "playlist" }, fields: { "similar-source-link": playlistLink(id) } },
    combine: { view: "combine", fields: { "combine-source-first": text } },
  };
}

/** The action row: the tools for this playlist (the songs below are edited in place). */
function renderActions(): void {
  const tools = toolsFor(current().playlist.id);
  el("pl-actions").replaceChildren(
    actionButton("Find repeats", () => leaveFor(tools.repeats)),
    actionButton("Upgrade", () => leaveFor(tools.upgrade)),
    actionButton("Copy to...", () => void copyToService()),
    actionButton("Link", () => {
      location.hash = "#/managed";
    }),
    actionButton("Stats", () => leaveFor(tools.stats)),
    actionButton("Export", () => leaveFor(tools.export)),
  );
}

function renderMore(): void {
  const mine = current();
  const { playlist } = mine;
  const update = (changes: Record<string, unknown>, text: string): void =>
    void working("Saving...", async () => {
      const result = await api<{ playlist: ManagerPlaylist }>("POST", "/api/manager/update", {
        playlistId: playlist.id,
        ...changes,
      }, serviceOf(playlist.id));
      if (!isStill(mine)) {
        return;
      }
      mine.playlist = result.playlist;
      renderHead();
      renderMeta();
      renderMore();
      say(text);
      void refreshLibrary();
    });
  const tools = toolsFor(playlist.id);
  const items: HTMLElement[] = [
    menuItem("Similar artists", () => leaveFor(tools.similar)),
    menuItem("Combine with other playlists", () => leaveFor(tools.combine)),
  ];
  if (playlist.owned) {
    items.push(
      menuItem("Rename and describe...", () => {
        void editDetails(playlist).then((changes) => {
          if (changes !== undefined && isStill(mine)) {
            update(changes, "Saved its details.");
          }
        });
      }),
      // Both where the service does not say which it is (Spotify).
      ...[true, false]
        .filter((to) => playlist.isPublic === undefined || playlist.isPublic !== to)
        .map((to) => menuItem(to ? "Make public" : "Make private", () => update({ isPublic: to }, to ? "It is now public." : "It is now private."))),
    );
  }
  items.push(menuItem("Duplicate...", () => void duplicateHere()));
  if (playlist.owned) {
    items.push(menuItem("Delete...", () => void deleteHere()));
  }
  items.push(
    menuItem(`Reload from ${labelOf(serviceOf(current().playlist.id))}`, () => {
      void (async () => {
        const mine = current();
        if ((isDirty() && !(await confirmLeaving())) || !isStill(mine)) {
          return;
        }
        const { id } = mine.playlist;
        closeEditor();
        await openEditor(id);
      })();
    }),
  );
  el("pl-more-items").replaceChildren(...items);
}

async function duplicateHere(): Promise<void> {
  const mine = current();
  const { playlist } = mine;
  const name = textInput(`${playlist.name} (copy)`);
  const ok = await openDialog({
    title: "Duplicate this playlist",
    body: [
      ...(isDirty() ? ["The copy is of the playlist as saved, without your unsaved changes."] : []),
      dialogField("Name of the copy", name),
    ],
    confirm: "Duplicate",
    validate: () => (name.value.trim() === "" ? "Give it a name." : undefined),
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  await working("Copying...", async () => {
    const result = await api<{ playlist: { name: string }; added: number; missing: number }>(
      "POST",
      "/api/manager/duplicate",
      { playlistId: playlist.id, name: name.value.trim() },
      serviceOf(playlist.id),
    );
    say(
      `Made ${result.playlist.name} with ${songCount(result.added)}` +
        (result.missing > 0 ? `; ${serviceName()} no longer offers ${result.missing}.` : "."),
    );
    void refreshLibrary();
  });
}

async function deleteHere(): Promise<void> {
  const mine = current();
  const { playlist } = mine;
  if (!(await confirmDelete({ ...playlist, trackCount: mine.edits.now.base.length })) || !isStill(mine)) {
    return;
  }
  let deleted = false;
  await working("Deleting...", async () => {
    await api("POST", "/api/manager/delete", { playlistId: playlist.id }, serviceOf(playlist.id));
    deleted = true;
  });
  if (deleted) {
    closeEditor();
    sessionDeleted(playlist.name);
    void refreshLibrary();
    location.hash = "#/";
  }
}

/** Set by the list view: says that a playlist was deleted from the editor. */
let sessionDeleted: (name: string) => void = () => {};
export function onDeleted(listener: (name: string) => void): void {
  sessionDeleted = listener;
}

// ---- Saving -------------------------------------------------------------------

async function save(): Promise<void> {
  if (!canEdit() || !isDirty()) {
    return;
  }
  const mine = current();
  const { playlist, edits, entries } = mine;
  const draft = edits.now;
  const summary = summarise(draft);
  const gone = [...draft.removed].map(([id, destination]) => ({ entry: entries.get(id), destination }));
  const body: Array<string | Node> = [];
  const list = document.createElement("ul");
  for (const part of draftParts(summary)) {
    const item = document.createElement("li");
    item.textContent = part.charAt(0).toUpperCase() + part.slice(1);
    list.append(item);
  }
  body.push(list);
  const warnings: string[] = [];
  if (draft.order.length === 0) {
    warnings.push("This empties the playlist.");
  } else if (draft.removed.size * 2 > draft.base.length) {
    warnings.push(`This takes out more than half of it: ${draft.removed.size} of ${draft.base.length} songs.`);
  }
  const unplayable = gone.filter(({ entry }) => entry?.streamable === false);
  const lost = unplayable.filter(({ destination }) => destination === undefined).length;
  if (lost > 0) {
    warnings.push(
      `${songCount(lost)} you are removing can no longer be played on ${serviceName()}, so undo cannot put ${lost === 1 ? "it" : "them"} back.`,
    );
  }
  if (unplayable.length > lost) {
    warnings.push(`${songCount(unplayable.length - lost)} cannot be moved, as ${serviceName()} no longer offers them; they will stay here.`);
  }
  const notice = managedNotice(playlist);
  if (notice !== undefined) {
    warnings.push(notice);
  }
  for (const warning of warnings) {
    const node = document.createElement("p");
    node.className = "warning";
    node.textContent = warning;
    body.push(node);
  }
  const ok = await openDialog({
    title: `Save changes to ${playlist.name}?`,
    body,
    confirm: "Save changes",
    danger: draft.order.length === 0,
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  let drift: Extract<SaveOutcome, { status: "changed" }> | undefined;
  await working(`Saving: ${describeDraft(summary)}...`, async () => {
    const outcome = await api<SaveOutcome>("POST", "/api/manager/save", {
      playlistId: playlist.id,
      ...draftChanges(draft),
    }, serviceOf(playlist.id));
    if (outcome.status === "changed") {
      drift = outcome;
      return;
    }
    const report = describeSaved(outcome);
    let opened: Opened;
    try {
      opened = await api<Opened>("POST", "/api/manager/open", { playlistId: playlist.id }, serviceOf(playlist.id));
    } catch (error) {
      // The draft no longer matches the playlist: do not leave it up as unsaved.
      closeEditor();
      el("pl-editor-body").hidden = true;
      say(report);
      throw new Error(`The playlist could not be read again (${(error as Error).message}). Open it again from the library.`);
    }
    const scroll = window.scrollY;
    if (outcome.failed === undefined) {
      show(opened);
    } else {
      // What was not done stays as the draft; a playlist already made is used, not made again.
      let rest = rebase(draft, opened.entries.map((entry) => entry.playlistTrackId));
      for (const { destination, playlistId } of outcome.created) {
        rest = retarget(rest, destination, { type: "existing", playlistId, name: destination.name });
      }
      show(opened, rest);
    }
    window.scrollTo(0, scroll);
    say(report);
    void refreshLibrary();
    if (outcome.failed !== undefined) {
      showError(
        el("pl-editor-error"),
        `"${outcome.failed.step}" failed: ${outcome.failed.reason}. What was not done is still in your draft.`,
      );
    }
  });
  if (drift !== undefined && isStill(mine)) {
    await offerRebase(drift, draft);
  }
}

function describeSaved(outcome: Extract<SaveOutcome, { status: "saved" }>): string {
  const parts: string[] = [];
  for (const move of outcome.moved) {
    // Those that did not arrive are told of below, as songs that stayed.
    if (move.added.length + move.already.length > 0) {
      parts.push(describeAdd({ ...move, missing: [] }, "Added").replace(/\.$/, ""));
    }
  }
  if (outcome.removed > 0) {
    parts.push(`Took ${songCount(outcome.removed)} out`);
  }
  if (outcome.reordered) {
    parts.push("Reordered it");
  }
  if (outcome.kept.length > 0) {
    parts.push(`${songCount(outcome.kept.length)} stayed here, as ${serviceName()} no longer offers ${outcome.kept.length === 1 ? "it" : "them"}`);
  }
  if (outcome.unverified === true) {
    parts.push("How much of the rest went through could not be checked");
  }
  if (outcome.failed !== undefined) {
    return parts.length === 0
      ? "Nothing was taken out of this playlist or reordered."
      : `Saved in part. ${parts.join(". ")}. You can undo this in History.`;
  }
  return parts.length === 0 ? "Nothing was changed." : `Saved. ${parts.join(". ")}. You can undo this in History.`;
}

async function offerRebase(outcome: Extract<SaveOutcome, { status: "changed" }>, draft: Draft): Promise<void> {
  const mine = current();
  const { added, gone, reordered } = outcome.drift;
  const what = [
    added > 0 ? `${added} added` : undefined,
    gone > 0 ? `${gone} removed` : undefined,
    reordered ? "songs reordered" : undefined,
  ].filter((part) => part !== undefined);
  const ok = await openDialog({
    title: `This playlist has changed on ${labelOf(serviceOf(current().playlist.id))}`,
    body: [
      `Since you opened it: ${what.join(", ")}. Nothing has been saved.`,
      "Bring those changes into your draft, check it, then save again?",
    ],
    confirm: "Bring in the changes",
    cancel: "Not now",
  });
  if (!ok || !isStill(mine)) {
    return;
  }
  await working("Reading it again...", async () => {
    const opened = await api<Opened>("POST", "/api/manager/open", { playlistId: mine.playlist.id }, serviceOf(mine.playlist.id));
    show(opened, rebase(draft, opened.entries.map((entry) => entry.playlistTrackId)));
    say("Brought in the changes made elsewhere. Check the list, then save.");
  });
}

// ---- Wiring -------------------------------------------------------------------

/** Wire up the editor. Call once on load. */
export function initPlaylistEditor(): void {
  window.addEventListener(LINKS_CHANGED, () => {
    if (editor !== undefined) {
      renderHead();
    }
  });
  const list = el("pl-songs");
  list.addEventListener("click", onRowClick);
  list.addEventListener("keydown", onListKey);
  // Shift-click selects rows, not text.
  list.addEventListener("mousedown", (event) => {
    if (event.shiftKey) {
      event.preventDefault();
    }
  });
  document.addEventListener("keydown", onPageKey);
  enableDrag({
    list,
    row: ".pl-row",
    handle: ".pl-handle",
    enabled: () => canEdit() && current().query.trim().length === 0,
    rowsToDrag: (row) => {
      const id = (row.dataset["id"] as EntryId);
      const { selected, rows } = current();
      return selected.has(id) ? selectedInOrder().map((item) => rows.get(item)!) : [row];
    },
    onDrop: (rows, index) => {
      if (editor !== undefined) {
        const ids = rows.map((row) => (row.dataset["id"] as EntryId));
        edit(moveTo(current().edits.now, ids, index), `Moved ${songCount(ids.length)}.`);
      }
    },
  });

  const search = el<HTMLInputElement>("pl-search");
  search.addEventListener("input", () => {
    if (editor !== undefined) {
      editor.query = search.value;
      render();
    }
  });
  el("pl-artists-toggle").addEventListener("click", () => togglePanel("pl-artists-toggle", "pl-artist-panel"));
  el("pl-by-toggle").addEventListener("click", () => togglePanel("pl-by-toggle", "pl-by-panel"));
  el("pl-artist-filter").addEventListener("input", () => editor !== undefined && renderArtists());
  el("pl-by-lines").addEventListener("input", () => editor !== undefined && onByInput());
  el("pl-by-guests").addEventListener("change", () => editor !== undefined && renderByArtist());
  for (const radio of document.querySelectorAll('input[name="pl-by-mode"]')) {
    radio.addEventListener("change", () => editor !== undefined && renderByArtist());
  }
  el("pl-by-select").addEventListener("click", () => {
    selectOnly(byPicked().ids);
    say(`Selected ${songCount(current().selected.size)}.`);
  });
  el("pl-by-apply").addEventListener("click", () => {
    const { ids } = byPicked();
    edit(takeOut(current().edits.now, ids), `Removed ${songCount(ids.length)} from the draft.`);
  });
  el("pl-put-all-back").addEventListener("click", () =>
    edit(putBack(current().edits.now, current().edits.now.removed.keys()), "Put them all back."),
  );
  el("pl-undo").addEventListener("click", () => step("undo"));
  el("pl-redo").addEventListener("click", () => step("redo"));
  el("pl-discard").addEventListener("click", () => edit(startDraft(current().edits.now.base), "Discarded the draft's changes."));
  el("pl-save").addEventListener("click", () => void save());

  // Menus close on a click elsewhere, or Escape.
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
      if (!menu.contains(event.target as Node)) {
        menu.open = false;
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
        menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
        event.stopImmediatePropagation();
      }
    }
  }, true);
}
