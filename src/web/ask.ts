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
import { VIEW_SHOWN } from "./route-state.js";
import { workingService } from "./service.js";

let shown: AskSuggestion[] = [];
let highlighted = 0;
let closing: ReturnType<typeof setTimeout> | undefined;
/** Where a picked suggestion went: the box empties once the page shows it (not if the user stays). */
let goingTo: string | undefined;

/** The suggestions that can be picked (a note cannot). */
function pickable(): number[] {
  return shown.flatMap((suggestion, index) => (suggestion.hash === undefined ? [] : [index]));
}

export function initAsk(): void {
  const box = el<HTMLTextAreaElement>("ask");
  box.addEventListener("input", () => {
    // Typing again: this is no longer the text a picked suggestion went off with.
    goingTo = undefined;
    grow(box);
    update(box.value);
  });
  box.addEventListener("focus", () => {
    clearTimeout(closing);
    grow(box);
    update(box.value);
  });
  box.addEventListener("blur", () => {
    // Late enough for a click on a suggestion to land first; one line again meanwhile.
    closing = setTimeout(() => {
      if (document.activeElement !== box) {
        close();
        shrink(box);
      }
    }, 150);
  });
  box.addEventListener("keydown", (event) => {
    // keyCode 229: Safari's Enter that confirms the composition comes after it ends.
    if (event.isComposing || event.keyCode === 229) {
      // Typing through an input method (Japanese, Chinese...): Enter confirms the text.
      return;
    }
    const choices = pickable();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const choice = shown[highlighted];
      if (choice?.hash !== undefined) {
        pick(choice);
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length > 0) {
        event.preventDefault();
        const at = choices.indexOf(highlighted);
        highlighted = choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]!;
        render();
      }
    } else if (event.key === "Escape") {
      close();
      box.blur();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey) {
      return;
    }
    // Another field than the box: Ctrl+K edits text there, and "/" is typed.
    const inField =
      event.target !== box &&
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, select, [contenteditable]") !== null;
    const shortcut = event.key === "k" && (event.ctrlKey || event.metaKey) && !event.shiftKey;
    const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && event.target !== box;
    if (!inField && (shortcut || slash)) {
      event.preventDefault();
      box.focus();
    }
  });
  // A picked suggestion's page is showing: the box is done with.
  window.addEventListener(VIEW_SHOWN, () => {
    if (goingTo !== undefined && location.hash === goingTo) {
      box.value = "";
      shrink(box);
    }
    goingTo = undefined;
  });
}

function shrink(box: HTMLTextAreaElement): void {
  box.style.height = "";
  box.style.overflowY = "hidden";
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
  highlighted = pickable()[0] ?? 0;
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
      item.setAttribute("aria-selected", String(index === highlighted && suggestion.hash !== undefined));
      item.textContent = suggestion.label;
      if (suggestion.hash === undefined) {
        item.setAttribute("aria-disabled", "true");
        item.classList.add("ask-note");
      }
      item.addEventListener("mousedown", (event) => {
        // Before the box's blur closes the menu.
        event.preventDefault();
        if (suggestion.hash !== undefined) {
          pick(suggestion);
        }
      });
      return item;
    }),
  );
  if (pickable().length > 0) {
    el("ask").setAttribute("aria-activedescendant", `ask-option-${highlighted}`);
  } else {
    el("ask").removeAttribute("aria-activedescendant");
  }
}

function close(): void {
  shown = [];
  render();
}

function pick(suggestion: AskSuggestion): void {
  const { hash } = suggestion;
  if (hash === undefined) {
    return;
  }
  const box = el<HTMLTextAreaElement>("ask");
  if (suggestion.fill !== undefined) {
    // For that address only: if the user stays (a draft, a preview), it is dropped.
    storePrefill({ ...suggestion.fill, hash });
  }
  close();
  box.blur();
  if (location.hash === hash) {
    // Already there: no hashchange, so fill it now.
    applyPrefill(viewOf(parseRoute(location.hash)));
    box.value = "";
    shrink(box);
  } else {
    // The text stays until that page shows: kept if the user stays where they are.
    goingTo = hash;
    location.hash = hash;
  }
}
