/**
 * Optional album artwork (see docs/adr/0004-optional-artwork.md).
 *
 * Covers are the one thing the page loads from a music service itself (the
 * image servers of Qobuz, TIDAL and Spotify), so they are off by default. While off, a cover is an `<img>` that
 * keeps its URL in `data-src` and has no `src`, so no request is made; turning
 * the setting on copies `data-src` into `src`. The choice is remembered in
 * this browser only.
 */

import { el } from "./dom.js";

const STORAGE_KEY = "crosstune:show-artwork";

let enabled = readSetting();

function readSetting(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function saveSetting(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable (private window, blocked): the choice lasts this page.
  }
}

/** Give an image its URL, if artwork is on and it has none yet. */
function load(img: HTMLImageElement): void {
  const url = img.dataset["src"];
  if (enabled && url !== undefined && img.getAttribute("src") === null) {
    img.src = url;
  }
}

/**
 * A cover slot: a neutral placeholder square holding the cover image, which
 * only loads while artwork is on. With no URL, just the placeholder.
 */
export function coverSlot(url: string | undefined): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "cover";
  slot.setAttribute("aria-hidden", "true");
  if (url !== undefined && url.startsWith("https://")) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.dataset["src"] = url;
    img.addEventListener("error", () => img.remove());
    load(img);
    slot.appendChild(img);
  }
  return slot;
}

/** Point an existing cover slot at another cover (e.g. a different version). */
export function setCover(slot: HTMLElement, url: string | undefined): void {
  slot.replaceWith(coverSlot(url));
}

function apply(): void {
  document.body.classList.toggle("artwork-on", enabled);
  if (enabled) {
    document.querySelectorAll<HTMLImageElement>(".cover img[data-src]").forEach(load);
  }
}

/** Wire up the "Show artwork" checkbox. Call once on load. */
export function initArtworkToggle(): void {
  const checkbox = el<HTMLInputElement>("show-artwork");
  checkbox.checked = enabled;
  checkbox.addEventListener("change", () => {
    enabled = checkbox.checked;
    saveSetting(enabled);
    apply();
  });
  apply();
}
