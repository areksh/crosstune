/**
 * The top bar: the service tabs (a filter on the sidebar's playlists, so
 * switching does not reload the page), and "+ New". DOM glue over
 * src/ui/library.ts.
 */

import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import { tabsFor, validTab, type Tab } from "../ui/library.js";
import { el } from "./dom.js";
import { chosenTab, rememberTab } from "./service.js";

/** Fired on `window` with the new tab as its detail. */
export const TAB_CHANGED = "crosstune:tab-changed";

let current: Tab = "all";

/** The tab the sidebar shows now. */
export function currentTab(): Tab {
  return current;
}

/** Draw the tabs for the connected services. Call once they are known. */
export function initShell(connected: readonly ServiceName[]): void {
  current = validTab(chosenTab(), connected);
  const box = el("tabs");
  const tabs = tabsFor(connected);
  // One service connected: its tab alone, so the page still names it.
  box.hidden = tabs.length === 0;
  box.replaceChildren(
    ...tabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      button.dataset["tab"] = tab;
      if (tab !== "all") {
        const dot = document.createElement("span");
        dot.className = "svc-dot";
        dot.dataset["service"] = tab;
        button.append(dot);
      }
      button.append(tab === "all" ? "All" : SERVICE_LABELS[tab]);
      button.addEventListener("click", () => choose(tab));
      return button;
    }),
  );
  mark();
  // "+ New" closes once one of its tools is chosen (also the one already open).
  const menu = el<HTMLDetailsElement>("new-menu");
  window.addEventListener("hashchange", () => {
    menu.open = false;
  });
  menu.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a") !== null) {
      menu.open = false;
    }
  });
}

/** Show this tab, as a click on it would. */
export function chooseTab(tab: Tab): void {
  choose(tab);
}

function choose(tab: Tab): void {
  if (tab === current) {
    return;
  }
  current = tab;
  rememberTab(tab);
  mark();
  window.dispatchEvent(new CustomEvent<Tab>(TAB_CHANGED, { detail: tab }));
}

function mark(): void {
  for (const button of el("tabs").querySelectorAll<HTMLButtonElement>(".tab")) {
    button.setAttribute("aria-pressed", String(button.dataset["tab"] === current));
  }
}
