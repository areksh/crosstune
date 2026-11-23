/**
 * The ask box in the top bar: type or paste anything, and pick what to do
 * (suggestions from src/ui/ask.ts). A textarea, so pasted lists keep their
 * lines: Enter picks the highlighted suggestion, Shift+Enter adds a line,
 * the arrows move, Escape closes. Ctrl+K (or "/" outside a field) focuses it.
 * Picking navigates by hash, so the playlist editor's draft guard still asks.
 */

import { askSuggestions, type AskSuggestion } from "../ui/ask.js";
import { parseRoute, viewOf } from "../ui/routes.js";
import { el } from "./dom.js";
import { libraryPlaylists } from "./library.js";
import { applyPrefill, storePrefill } from "./prefill.js";
import { workingService } from "./service.js";

let shown: AskSuggestion[] = [];
let highlighted = 0;

export function initAsk(): void {
  const box = el<HTMLTextAreaElement>("ask");
  box.addEventListener("input", () => {
    grow(box);
    update(box.value);
  });
  box.addEventListener("focus", () => {
    grow(box);
    update(box.value);
  });
  box.addEventListener("blur", () => {
    // Late enough for a click on a suggestion to land first.
    setTimeout(close, 150);
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const choice = shown[highlighted];
      if (choice !== undefined) {
        pick(choice);
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (shown.length > 0) {
        event.preventDefault();
        highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
        render();
      }
    } else if (event.key === "Escape") {
      close();
      box.blur();
    }
  });
  document.addEventListener("keydown", (event) => {
    const inField = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]") !== null;
    if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !inField)) {
      event.preventDefault();
      box.focus();
    }
  });
}

function grow(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  box.style.overflowY = box.scrollHeight > 120 ? "auto" : "hidden";
}

function update(text: string): void {
  const where = parseRoute(location.hash);
  const service = workingService();
  shown = askSuggestions(text, {
    playlists: libraryPlaylists(),
    ...(where.kind === "playlist" && { open: where.id }),
    ...(service !== undefined && { service }),
  });
  highlighted = 0;
  render();
}

function render(): void {
  const menu = el("ask-menu");
  menu.hidden = shown.length === 0;
  el("ask").setAttribute("aria-expanded", String(shown.length > 0));
  menu.replaceChildren(
    ...shown.map((suggestion, index) => {
      const item = document.createElement("li");
      item.id = `ask-option-${index}`;
      item.setAttribute("role", "option");
      item.className = "ask-option";
      item.setAttribute("aria-selected", String(index === highlighted));
      item.textContent = suggestion.label;
      item.addEventListener("mousedown", (event) => {
        // Before the box's blur closes the menu.
        event.preventDefault();
        pick(suggestion);
      });
      return item;
    }),
  );
  el("ask").setAttribute("aria-activedescendant", shown.length > 0 ? `ask-option-${highlighted}` : "");
}

function close(): void {
  shown = [];
  render();
}

function pick(suggestion: AskSuggestion): void {
  const box = el<HTMLTextAreaElement>("ask");
  if (suggestion.fill !== undefined) {
    storePrefill(suggestion.fill);
  }
  box.value = "";
  grow(box);
  close();
  box.blur();
  if (location.hash === suggestion.hash) {
    // Already there: no hashchange, so fill it now.
    applyPrefill(viewOf(parseRoute(location.hash)));
  } else {
    location.hash = suggestion.hash;
  }
}
