/**
 * Linked playlists, a panel of the Managed playlists view: each link with its
 * copies, its last sync and state; what its conflicts are and how to settle
 * them (every fix previewed first); the songs a sync asks about; and "Link
 * playlists..." to make one. Every load tells the page (LINKS_CHANGED), which
 * keeps the notices and the navigation count. DOM glue: the wording is in
 * src/sync/wording.ts, the syncing in src/sync/.
 */

import { describeSchedule } from "../../jobs/format.js";
import type { ManagerPlaylist } from "../../features/playlist-manager.js";
import { serviceOf, shortId, SERVICES, SERVICE_LABELS, type PlaylistId, type ServiceName, type TrackId } from "../../services/ids.js";
import type { Question } from "../../sync/model.js";
import type { CopyComparison, SyncOutcome } from "../../sync/run.js";
import type { InvalidLink, LinksSummary } from "../../sync/runner.js";
import type { LinkView } from "../../sync/service.js";
import {
  describeChange,
  describeConflict,
  describeLinkResult,
  describeLinksSummary,
  describeQuestion,
  describeSide,
  fixFor,
  songName,
} from "../../sync/wording.js";
import { api } from "../api.js";
import { dialogField, openDialog, textInput } from "../dialog.js";
import { el, showError } from "../dom.js";
import { connectedServices } from "../service.js";
import { playlistHash } from "./playlist-actions.js";

export interface LinksList {
  links: LinkView[];
  invalid: InvalidLink[];
}

/** Dispatched on window with the list as `detail` whenever it is loaded. */
export const LINKS_CHANGED = "crosstune:links";

const label = (service: ServiceName): string => SERVICE_LABELS[service];

/** The list as last loaded, for the marks on linked playlists. */
let known: LinksList | undefined;

export function knownLinks(): LinksList | undefined {
  return known;
}

/** The list, or undefined where this server has no linked playlists. */
export async function fetchLinks(): Promise<LinksList | undefined> {
  try {
    known = await api<LinksList>("GET", "/api/links", undefined, "all");
    return known;
  } catch (error) {
    if ((error as Error).message === "not found") {
      return undefined;
    }
    throw error;
  }
}

let playlists: ManagerPlaylist[] = [];
let playlistsLoad: Promise<void> | undefined;
let request = 0;
/** A line to show above the list after the next load (what an action did). */
let said: { text: string; error: boolean } | undefined;

/** Wire up the panel; it loads once the services are known (`servicesKnown`). */
export function initLinksView(): void {
  window.addEventListener("hashchange", () => {
    if (isShown()) {
      void load();
    }
  });
  el("links-new").addEventListener("click", () => void createLink());
}

/** The connected services are known: whether linking is offered depends on them. */
export function servicesKnown(): void {
  if (isShown()) {
    void load();
  }
}

function isShown(): boolean {
  return location.hash.replace(/^#\/?/, "") === "managed";
}

/** Every service's playlists, to name the copies and choose new ones. */
function loadPlaylists(): Promise<void> {
  playlistsLoad ??= (async () => {
    try {
      ({ playlists } = await api<{ playlists: ManagerPlaylist[] }>("GET", "/api/manager/playlists", undefined, "all"));
    } catch {
      playlistsLoad = undefined; // named by id meanwhile; try again next time
    }
  })();
  return playlistsLoad;
}

function playlistName(id: PlaylistId): string {
  return playlists.find((playlist) => playlist.id === id)?.name ?? `Playlist ${shortId(id)}`;
}

async function load(): Promise<void> {
  const mine = ++request;
  const panel = el("links-panel");
  let list: LinksList | undefined;
  try {
    [list] = await Promise.all([fetchLinks(), loadPlaylists()]);
  } catch (error) {
    if (mine === request) {
      panel.hidden = false;
      el("links-status").hidden = true;
      showError(el("links-error"), (error as Error).message);
    }
    return;
  }
  if (mine !== request) {
    return;
  }
  panel.hidden = list === undefined;
  if (list === undefined) {
    return;
  }
  window.dispatchEvent(new CustomEvent(LINKS_CHANGED, { detail: list }));
  const enough = connectedServices().length >= 2;
  el("links-new").hidden = !enough;
  el("links-need-two").hidden = enough;

  const result = el("links-result");
  result.hidden = said === undefined;
  result.className = said?.error === true ? "error" : "result";
  result.textContent = said?.text ?? "";
  said = undefined;
  showError(el("links-error"), undefined);

  const invalid = el("links-invalid");
  invalid.hidden = list.invalid.length === 0;
  invalid.textContent = list.invalid
    .map((bad) => `A link in links.json (${bad.id ?? `#${bad.index + 1}`}) is invalid and skipped: ${bad.error}`)
    .join(" ");

  const container = el("links-list");
  container.textContent = "";
  // The ones that need the user first.
  const order = (view: LinkView): number => (view.state.conflicts.length > 0 ? 0 : view.state.questions.length > 0 ? 1 : 2);
  for (const view of [...list.links].sort((a, b) => order(a) - order(b))) {
    container.appendChild(renderLink(view));
  }
  const status = el("links-status");
  status.hidden = list.links.length > 0;
  status.textContent = "No linked playlists yet.";
}

/** Show what an action did once the list is loaded again. */
async function reloadSaying(text: string, error = false): Promise<void> {
  said = { text, error };
  await load();
}

// --- small builders -------------------------------------------------------------

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function button(caption: string, onClick: (event: MouseEvent) => void, secondary = true): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = caption;
  if (secondary) {
    node.className = "secondary";
  }
  node.addEventListener("click", onClick);
  return node;
}

function fact(name: string, value: string | Node): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "managed-fact";
  wrap.appendChild(text("dt", "", name));
  const dd = document.createElement("dd");
  dd.append(value);
  wrap.appendChild(dd);
  return wrap;
}

function servicesOf(view: LinkView): ServiceName[] {
  return SERVICES.filter((service) => view.link.copies[service] !== undefined);
}

/** Run an action with the card's buttons off, then reload saying what it did. */
async function act(card: HTMLElement, action: () => Promise<string | undefined>): Promise<void> {
  setBusy(card, true);
  try {
    const outcome = await action();
    if (outcome === undefined) {
      await load(); // cancelled, or nothing to say
    } else {
      await reloadSaying(outcome);
    }
  } catch (error) {
    await reloadSaying((error as Error).message, true);
  }
}

// --- a link -------------------------------------------------------------------

function stateOf(view: LinkView): { badge: string; className: string } {
  const { link, state } = view;
  if (state.conflicts.length > 0) {
    return { badge: "needs you", className: "urgent" };
  }
  if (!link.enabled || state.paused !== undefined) {
    return { badge: "paused", className: "" };
  }
  if (state.questions.length > 0) {
    return { badge: "waiting for answers", className: "asking" };
  }
  return state.lastSyncAt === undefined ? { badge: "not synced yet", className: "" } : { badge: "in sync", className: "ok" };
}

function renderLink(view: LinkView): HTMLElement {
  const { link, state, runs } = view;
  const card = document.createElement("article");
  const paused = !link.enabled || state.paused !== undefined;
  card.className = `managed-job link-card${paused ? " disabled" : ""}`;
  card.setAttribute("aria-label", link.name);

  const head = document.createElement("div");
  head.className = "managed-job-head";
  head.appendChild(text("h3", "", link.name));
  const shown = stateOf(view);
  head.appendChild(text("span", `managed-badge link-state ${shown.className}`, shown.badge));
  card.appendChild(head);

  const copies = document.createElement("ul");
  copies.className = "link-copies";
  for (const service of servicesOf(view)) {
    const id = link.copies[service]!;
    const item = document.createElement("li");
    item.appendChild(text("span", "link-service", label(service)));
    const anchor = document.createElement("a");
    anchor.href = playlistHash(id);
    anchor.textContent = playlistName(id);
    item.appendChild(anchor);
    copies.appendChild(item);
  }

  const facts = document.createElement("dl");
  facts.className = "managed-facts";
  facts.appendChild(fact("Copies", copies));
  // A run is logged by syncs, not by settling a conflict: then the state is newer.
  const last = runs[0];
  const lastSync =
    state.lastSyncAt === undefined
      ? "never"
      : `${new Date(state.lastSyncAt).toLocaleString()}: ${
          last !== undefined && last.at >= state.lastSyncAt
            ? describeLinkResult(last.result)
            : state.conflicts.length > 0
              ? "stopped: the copies disagree"
              : "settled by you"
        }`;
  facts.appendChild(fact("Last sync", lastSync));
  facts.appendChild(
    fact(
      "Runs",
      paused
        ? state.paused?.reason === "undone"
          ? "Paused: one of its syncs was undone. Resuming compares the copies afresh."
          : "Paused."
        : `${describeSchedule(link.schedule)}${state.nextRunAt === undefined ? "" : `; next ${new Date(state.nextRunAt).toLocaleString()}`}`,
    ),
  );
  card.appendChild(facts);

  if (state.conflicts.length > 0) {
    card.appendChild(renderConflicts(view, card));
  }
  if (state.questions.length > 0) {
    card.appendChild(renderQuestions(view, card));
  }

  const actions = document.createElement("div");
  actions.className = "managed-actions";
  actions.appendChild(
    button(
      "Sync now",
      (event) => {
        (event.currentTarget as HTMLButtonElement).textContent = "Syncing...";
        void act(card, async () => describeLinksSummary(await api<LinksSummary>("POST", `/api/links/${link.id}/run`, {}, "all")));
      },
      state.conflicts.length > 0,
    ),
  );
  actions.appendChild(
    button(paused ? "Resume" : "Pause", () =>
      void act(card, async () => {
        await api("POST", `/api/links/${link.id}/${paused ? "resume" : "pause"}`, {}, "all");
        return paused ? `Resumed ${link.name}.` : `Paused ${link.name}.`;
      }),
    ),
  );
  actions.appendChild(button("Remove...", () => void removeLink(view, card)));
  card.appendChild(actions);
  return card;
}

async function removeLink(view: LinkView, card: HTMLElement): Promise<void> {
  const copies = servicesOf(view).map((service) => `${playlistName(view.link.copies[service]!)} on ${label(service)}`);
  const confirmed = await openDialog({
    title: `Unlink ${view.link.name}?`,
    body: [
      "The playlists themselves are kept, as they are now; they are just not synced any more:",
      list(copies),
    ],
    confirm: "Unlink",
    danger: true,
  });
  if (confirmed) {
    await act(card, async () => {
      await api("POST", `/api/links/${view.link.id}/remove`, {}, "all");
      return `Unlinked ${view.link.name}; its playlists are kept.`;
    });
  }
}

function list(items: readonly string[]): HTMLUListElement {
  const node = document.createElement("ul");
  for (const item of items) {
    node.appendChild(text("li", "", item));
  }
  return node;
}

// --- conflicts ------------------------------------------------------------------

function renderConflicts(view: LinkView, card: HTMLElement): HTMLElement {
  const { state } = view;
  const box = document.createElement("div");
  box.className = "link-conflict";
  box.setAttribute("role", "alert");
  box.appendChild(text("p", "link-conflict-title", "The copies disagree. Nothing is synced until you choose."));
  box.appendChild(list(state.conflicts.map(describeConflict)));

  const fix = fixFor(state.conflicts);
  const row = (): HTMLElement => {
    const actions = document.createElement("div");
    actions.className = "managed-actions";
    box.appendChild(actions);
    return actions;
  };
  if (fix.kind === "unlink") {
    box.appendChild(
      text(
        "p",
        "link-conflict-hint",
        `To fix this, remove the link: every playlist is kept, they just stop being synced. Then link the others again with another ${fix.services.map(label).join(" or ")} playlist if you like.`,
      ),
    );
    row().appendChild(button("Remove the link...", () => void removeLink(view, card), false));
    return box;
  }
  box.appendChild(sideBySide(view));
  box.appendChild(text("p", "link-conflict-hint", "Each choice shows what it would write to every copy before writing anything."));
  const services = servicesOf(view);
  type Option = [string, (service: ServiceName) => void];
  const common: Option = ["Start from what they have in common, keeping %s's order", (service) => void fromCommon(view, card, service)];
  const choices: Option[] = [
    ["Use the %s copy", (service) => void settle(view, card, { use: service })],
    ["Merge, keeping %s's order", (service) => void settle(view, card, { merge: service })],
    ...(fix.fromCommon ? [common] : []),
  ];
  for (const [caption, choose] of choices) {
    const actions = row();
    for (const service of services) {
      actions.appendChild(button(caption.replace("%s", label(service)), () => choose(service)));
    }
  }
  return box;
}

/** The copies in columns, each with what it changed: filled once they are read. */
function sideBySide(view: LinkView): HTMLElement {
  const box = document.createElement("div");
  box.className = "link-sides";
  box.setAttribute("aria-live", "polite");
  box.appendChild(text("p", "link-conflict-hint", "Reading the copies..."));
  void api<CopyComparison>("POST", `/api/links/${view.link.id}/compare`, {}, "all").then(
    (compared) => {
      box.textContent = "";
      if ("conflicts" in compared) {
        box.appendChild(text("p", "link-conflict-hint", compared.conflicts.map(describeConflict).join(" ")));
        return;
      }
      box.appendChild(
        text(
          "p",
          "link-sides-title",
          compared.since === "last-sync"
            ? "What each copy changed since the last sync:"
            : compared.copies.length > 2
              ? "What each copy has that not every copy has:"
              : "What only each copy has:",
        ),
      );
      const columns = document.createElement("div");
      columns.className = "link-sides-columns";
      for (const side of compared.copies) {
        const { title, lines } = describeSide(side, compared.since, compared.copies.length);
        const column = document.createElement("section");
        column.className = "link-side";
        column.append(text("h4", "link-side-title", title), list(lines));
        columns.appendChild(column);
      }
      box.appendChild(columns);
    },
    (error: unknown) => {
      box.textContent = "";
      box.appendChild(text("p", "link-conflict-hint", `The copies could not be read: ${(error as Error).message}`));
    },
  );
  return box;
}

function setBusy(card: HTMLElement, busy: boolean): void {
  for (const node of card.querySelectorAll("button, select")) {
    (node as HTMLButtonElement).disabled = busy;
  }
}

type Choice = { use: ServiceName } | { merge: ServiceName };

async function settle(view: LinkView, card: HTMLElement, choice: Choice): Promise<void> {
  const { link } = view;
  const path = `/api/links/${link.id}/resolve`;
  let preview: SyncOutcome;
  setBusy(card, true);
  try {
    preview = await api<SyncOutcome>("POST", path, { ...choice, dryRun: true }, "all");
  } catch (error) {
    await reloadSaying((error as Error).message, true);
    return;
  }
  if (preview.status === "conflict" || preview.status === "failed") {
    await reloadSaying(
      preview.status === "failed"
        ? `It cannot be settled that way: ${preview.error ?? "the sync stopped"}.`
        : `It cannot be settled that way: ${preview.state.conflicts.map(describeConflict).join(" ")}`,
      true,
    );
    return;
  }
  const changes = servicesOf(view).map((service) =>
    describeChange(preview.changes.find((change) => change.service === service), service),
  );
  const title = "use" in choice ? `Use the ${label(choice.use)} copy?` : `Merge, keeping ${label(choice.merge)}'s order?`;
  const explain =
    "use" in choice
      ? `Every copy is made like the ${label(choice.use)} one. This is what would be written:`
      : `Every song added to any copy is kept, and a song removed from one goes unless another copy changed it. The order and the name are ${label(choice.merge)}'s. This is what would be written:`;
  setBusy(card, false);
  const confirmed = await openDialog({ title, body: [explain, list(changes), "Undo it from History if it is not what you wanted."], confirm: "Write it" });
  if (!confirmed) {
    return;
  }
  await act(card, async () => {
    const outcome = await api<SyncOutcome>("POST", path, { ...choice, dryRun: false }, "all");
    if (outcome.status === "failed" || outcome.status === "conflict") {
      throw new Error(
        outcome.status === "failed"
          ? `Not settled: ${outcome.error ?? "the sync stopped"}.`
          : `Not settled: ${outcome.state.conflicts.map(describeConflict).join(" ")}`,
      );
    }
    return `Settled ${link.name}: ${outcome.changes.length === 0 ? "nothing needed writing" : outcome.changes.map((change) => describeChange(change, change.service)).join("; ")}.`;
  });
}

async function fromCommon(view: LinkView, card: HTMLElement, from: ServiceName): Promise<void> {
  const confirmed = await openDialog({
    title: `Start from what they have in common?`,
    body: [
      `The songs every copy has are taken as where the link starts, in ${label(from)}'s order. A song only some copies have counts as newly added, so it is added to the others; ${label(from)}'s order is then given to every copy.`,
      "This cannot be previewed; undo it from History if it is not what you wanted.",
    ],
    confirm: "Start",
  });
  if (confirmed) {
    await act(card, async () =>
      describeLinksSummary(await api<LinksSummary>("POST", `/api/links/${view.link.id}/start-from-common`, { from }, "all")),
    );
  }
}

// --- questions ------------------------------------------------------------------

function renderQuestions(view: LinkView, card: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "link-questions";
  const count = view.state.questions.length;
  box.appendChild(
    text("p", "link-questions-title", `${count} song${count === 1 ? " waits" : "s wait"} for your answer; the rest is synced.`),
  );
  const items = document.createElement("ul");
  for (const question of view.state.questions) {
    items.appendChild(renderQuestion(view, card, question));
  }
  box.appendChild(items);
  return box;
}

function renderQuestion(view: LinkView, card: HTMLElement, question: Question): HTMLElement {
  const item = document.createElement("li");
  const words = describeQuestion(question);
  const textBox = document.createElement("div");
  textBox.appendChild(text("p", "link-question", words.text));
  if (words.detail !== undefined) {
    textBox.appendChild(text("p", "link-question-detail", words.detail));
  }
  item.appendChild(textBox);
  const actions = document.createElement("div");
  actions.className = "managed-suggestion-actions";
  const answer = (caption: string, value: "removed" | "withdrawn" | "keep", primary = false) =>
    button(
      caption,
      () =>
        void act(card, async () =>
          describeLinksSummary(
            await api<LinksSummary>("POST", `/api/links/${view.link.id}/answer`, { key: question.key, answer: value }, "all"),
          ),
        ),
      !primary,
    );
  switch (question.kind) {
    case "removed-or-withdrawn":
      actions.append(answer("Removed by me", "removed", true), answer("Withdrawn by the service", "withdrawn"));
      break;
    case "which-was-removed":
      actions.append(answer("Removed", "removed", true), answer("Keep them", "keep"));
      break;
    case "repeated":
      actions.append(answer("Remove it", "removed", true), answer("Keep", "keep"));
      break;
    case "match": {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `The ${label(question.on)} song for ${songName(question.song)}`);
      for (const option of question.options) {
        select.appendChild(new Option(songName(option), String(option.id)));
      }
      const choose = (track: TrackId | null) =>
        void act(card, async () =>
          describeLinksSummary(
            await api<LinksSummary>("POST", `/api/links/${view.link.id}/match`, { key: question.key, track }, "all"),
          ),
        );
      if (question.options.length > 0) {
        actions.append(select, button("Use this", () => choose(select.value as TrackId), false));
      }
      actions.append(button("Leave it out", () => choose(null)));
      break;
    }
  }
  item.appendChild(actions);
  return item;
}

// --- linking --------------------------------------------------------------------

async function createLink(): Promise<void> {
  const services = connectedServices();
  if (services.length < 2) {
    return;
  }
  playlistsLoad = undefined; // afresh: playlists made since are offered too
  await loadPlaylists();
  const linked = new Set<string>();
  try {
    const current = await fetchLinks();
    for (const view of current?.links ?? []) {
      for (const id of Object.values(view.link.copies)) {
        linked.add(String(id));
      }
    }
  } catch {
    // The server says so on saving.
  }
  const name = textInput();
  name.placeholder = "Late night";
  const selects = new Map<ServiceName, HTMLSelectElement>();
  const fields: HTMLElement[] = [];
  for (const service of services) {
    const select = document.createElement("select");
    select.appendChild(new Option("None", ""));
    const own = playlists.filter((playlist) => playlist.owned && serviceOf(playlist.id) === service);
    for (const playlist of own) {
      const option = new Option(
        `${playlist.name}${playlist.trackCount === undefined ? "" : ` (${playlist.trackCount})`}${linked.has(String(playlist.id)) ? " -- already linked" : ""}`,
        String(playlist.id),
      );
      option.disabled = linked.has(String(playlist.id));
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      if (name.value.trim() === "" && select.value !== "") {
        name.value = playlistName(select.value as PlaylistId);
      }
    });
    selects.set(service, select);
    fields.push(dialogField(`${label(service)} playlist`, select));
  }
  const chosen = (): Partial<Record<ServiceName, string>> =>
    Object.fromEntries([...selects].filter(([, select]) => select.value !== "").map(([service, select]) => [service, select.value]));
  const confirmed = await openDialog({
    title: "Link playlists",
    body: [
      "Linked playlists are kept the same both ways, every hour: a song added to or removed from one is added to or removed from the others. Choose one of your playlists on two or more services.",
      dialogField("Name", name),
      ...fields,
      "If the copies differ now, nothing is written: you choose how to start.",
    ],
    confirm: "Link them",
    validate: () =>
      name.value.trim() === ""
        ? "Give the link a name."
        : Object.keys(chosen()).length < 2
          ? "Choose playlists on at least two services."
          : undefined,
  });
  if (!confirmed) {
    return;
  }
  const button = el<HTMLButtonElement>("links-new");
  button.disabled = true;
  try {
    const created = await api<{ link: { name: string }; summary: LinksSummary }>(
      "POST",
      "/api/links",
      { name: name.value.trim(), copies: chosen(), schedule: { every: "hour" } },
      "all",
    );
    await reloadSaying(`Linked ${created.link.name}. ${describeLinksSummary(created.summary)}`);
  } catch (error) {
    await reloadSaying((error as Error).message, true);
  } finally {
    button.disabled = false;
  }
}
