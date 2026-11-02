/**
 * History view, and the "Last change" strip on the home view.
 *
 * Lists every change qobuz-helper recorded, grouped by day, newest first,
 * with what each added (+) and removed (-). Undo asks the server what undoing
 * would reverse (it reads the account, changing nothing), shows that with any
 * notes and warnings, and only on confirmation undoes it. Undone entries are
 * dimmed. This is DOM glue; the history and undo logic live in
 * src/features/history.ts, journal.ts and undo.ts.
 */

import { clockTime, dayLabel, timeAgo, type HistorySummary } from "../../features/history.js";
import { api } from "../api.js";
import { el, showError } from "../dom.js";

interface UndoPlanResponse {
  entry: HistorySummary;
  steps: string[];
  notes: string[];
  warnings: string[];
  blocked?: string;
}

interface UndoResponse {
  entryId: string;
  undone: boolean;
  done: string[];
  failed: Array<{ step: string; reason: string }>;
  notes: string[];
}

/** An entry the home strip asked to undo, opened once the list is shown. */
let pendingUndo: string | undefined;
let request = 0;

/** Wire up the history view. Call once on load. */
export function initHistoryView(): void {
  window.addEventListener("hashchange", () => {
    if (isShown("history")) {
      void load();
    }
  });
  if (isShown("history")) {
    void load();
  }
}

/** Wire up the home view's "Last change" strip. Call once on load. */
export function initLastChange(): void {
  el("home-last-undo").addEventListener("click", (event) => {
    const id = el("home-last-change").dataset["entry"];
    if (id !== undefined) {
      event.preventDefault();
      pendingUndo = id;
      location.hash = "#/history";
    }
  });
  window.addEventListener("hashchange", () => {
    if (isShown("home")) {
      void loadLastChange();
    }
  });
  void loadLastChange();
}

function isShown(view: string): boolean {
  const name = location.hash.replace(/^#\/?/, "");
  return name === view || (view === "home" && name === "");
}

async function loadLastChange(): Promise<void> {
  const strip = el("home-last-change");
  let entries: HistorySummary[];
  try {
    ({ entries } = await api<{ entries: HistorySummary[] }>("GET", "/api/history"));
  } catch {
    strip.hidden = true;
    return;
  }
  const last = entries[0];
  if (last === undefined) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.dataset["entry"] = last.id;
  const undone = last.undoneAt === undefined ? "" : " (undone)";
  el("home-last-text").textContent = `${last.label}, ${timeAgo(new Date(last.at), new Date())}${undone}`;
  el("home-last-undo").hidden = last.undoneAt !== undefined;
}

async function load(): Promise<void> {
  const mine = ++request;
  const status = el("history-status");
  const days = el("history-days");
  showError(el("history-error"), undefined);
  status.hidden = false;
  status.textContent = "Loading...";
  let entries: HistorySummary[];
  try {
    ({ entries } = await api<{ entries: HistorySummary[] }>("GET", "/api/history"));
  } catch (error) {
    if (mine === request) {
      status.hidden = true;
      showError(el("history-error"), (error as Error).message);
    }
    return;
  }
  if (mine !== request) {
    return;
  }
  render(days, entries);
  status.hidden = entries.length > 0;
  status.textContent = "No changes recorded yet. Whatever a tool saves to your account will be listed here.";

  const pending = pendingUndo;
  pendingUndo = undefined;
  const row = pending === undefined ? null : days.querySelector<HTMLElement>(`[data-entry="${pending}"]`);
  const entry = entries.find((e) => e.id === pending);
  if (row !== null && entry !== undefined && entry.undoneAt === undefined) {
    row.scrollIntoView({ block: "center" });
    void confirmUndo(row, entry);
  }
}

/** The entries, grouped by day (in local time), newest first. */
function render(container: HTMLElement, entries: readonly HistorySummary[]): void {
  container.textContent = "";
  const now = new Date();
  let day: HTMLElement | undefined;
  let dayName = "";
  for (const entry of entries) {
    const at = new Date(entry.at);
    const name = dayLabel(at, now);
    if (day === undefined || name !== dayName) {
      dayName = name;
      day = document.createElement("section");
      day.className = "history-day";
      const heading = document.createElement("h2");
      heading.textContent = name;
      day.appendChild(heading);
      container.appendChild(day);
    }
    day.appendChild(renderRow(entry, at));
  }
}

function renderRow(entry: HistorySummary, at: Date): HTMLElement {
  const row = document.createElement("div");
  row.className = "history-row";
  row.dataset["entry"] = entry.id;
  row.classList.toggle("undone", entry.undoneAt !== undefined);

  const counts = document.createElement("span");
  counts.className = "history-counts";
  counts.append(
    span("added", entry.added > 0 ? `+${entry.added}` : ""),
    span("removed", entry.removed > 0 ? `−${entry.removed}` : ""),
  );

  const text = document.createElement("span");
  text.className = "history-text";
  const meta = [entry.toolName, clockTime(at)];
  if (entry.source === "cli") {
    meta.push("command line");
  }
  if (entry.error !== undefined) {
    meta.push("stopped part-way");
  }
  text.append(span("history-label", entry.label), span("history-meta", meta.join(", ")));
  text.title = `Entry ${entry.id}`;

  row.append(counts, text);
  if (entry.undoneAt !== undefined) {
    row.appendChild(span("history-state", "Undone"));
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary history-undo";
    button.textContent = "Undo";
    button.setAttribute("aria-label", `Undo: ${entry.label}`);
    button.addEventListener("click", () => void confirmUndo(row, entry));
    row.appendChild(button);
  }
  return row;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

/** Open the confirm step under a row: what undoing would reverse, then do it. */
async function confirmUndo(row: HTMLElement, entry: HistorySummary): Promise<void> {
  document.querySelectorAll(".history-confirm").forEach((node) => node.remove());
  el("history-result").hidden = true;
  const panel = document.createElement("div");
  panel.className = "history-confirm";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", `Undo ${entry.label}`);
  const status = span("hint", "Checking what undoing it would change...");
  panel.appendChild(status);
  row.after(panel);

  let plan: UndoPlanResponse;
  try {
    plan = await api<UndoPlanResponse>("POST", "/api/history/plan", { id: entry.id });
  } catch (error) {
    status.className = "error";
    status.textContent = (error as Error).message;
    return;
  }
  panel.textContent = "";
  if (plan.blocked !== undefined) {
    panel.appendChild(span("error", plan.blocked));
    return;
  }

  const heading = document.createElement("p");
  heading.className = "history-confirm-title";
  heading.textContent = plan.steps.length > 0 ? "Undoing this will:" : "There is nothing left to change.";
  panel.appendChild(heading);
  if (plan.steps.length > 0) {
    const list = document.createElement("ul");
    for (const step of plan.steps) {
      const item = document.createElement("li");
      item.textContent = step;
      list.appendChild(item);
    }
    panel.appendChild(list);
  }
  for (const note of plan.notes) {
    panel.appendChild(notice("info", note));
  }
  for (const warning of plan.warnings) {
    panel.appendChild(notice("warning", warning));
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = plan.steps.length > 0 ? "Undo these changes" : "Mark as undone";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => panel.remove());
  actions.append(go, cancel);
  panel.appendChild(actions);
  const error = span("error", "");
  error.hidden = true;
  panel.appendChild(error);

  go.addEventListener("click", () => {
    void (async () => {
      go.disabled = true;
      cancel.disabled = true;
      go.textContent = "Undoing...";
      try {
        const result = await api<UndoResponse>("POST", "/api/history/undo", { id: entry.id });
        showResult(entry, result);
        await load();
      } catch (failure) {
        showError(error, (failure as Error).message);
        go.disabled = false;
        cancel.disabled = false;
        go.textContent = "Try again";
      }
    })();
  });
  go.focus();
}

function notice(className: string, text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

/** Say what the undo did, above the list. */
function showResult(entry: HistorySummary, result: UndoResponse): void {
  const lines = [
    result.undone ? `Undid "${entry.label}".` : `Could not undo "${entry.label}"; nothing was changed.`,
    ...result.failed.map((f) => `Failed: ${f.step} (${f.reason}).`),
    ...result.notes,
  ];
  const node = el("history-result");
  node.hidden = false;
  node.className = result.failed.length === 0 ? "result" : "warning";
  node.textContent = lines.join(" ");
}
