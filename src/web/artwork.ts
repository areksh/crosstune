/**
 * Optional album artwork (see docs/adr/0004-optional-artwork.md).
 *
 * Covers are the one thing the page loads from a music service itself (the
 * image servers of Qobuz, TIDAL and Spotify), so they are off by default. While off, a cover is an `<img>` that
 * keeps its URL in `data-src` and has no `src`, so no request is made; turning
 * the setting on copies `data-src` into `src`. The choice is remembered in
 * this browser only.
 */

import { coverBackground, coverFromColour, generatedCover, glowBackground } from "../ui/cover-art.js";
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
 * A cover slot: a placeholder square holding the cover image, which only loads
 * while artwork is on. Given a seed (the album's name, or the song's), the
 * placeholder is a cover drawn from it; with no URL, just the placeholder.
 */
export function coverSlot(url: string | undefined, seed?: string): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "cover";
  slot.setAttribute("aria-hidden", "true");
  if (seed !== undefined) {
    slot.classList.add("gen-cover");
    slot.style.background = coverBackground(generatedCover(seed));
  }
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

/**
 * Put a cover into an existing slot (the sidebar's, a page header's): the same
 * lazy, no-referrer image as `coverSlot`, loaded only while artwork is on,
 * over whatever the slot shows meanwhile (a cover drawn from the name).
 */
export function artworkInto(slot: HTMLElement, url: string | undefined): void {
  slot.querySelector("img")?.remove();
  slot.classList.add("cover-host");
  if (url === undefined || !url.startsWith("https://")) {
    return;
  }
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

/** Whether album covers are shown (and so may be requested). */
export function artworkOn(): boolean {
  return enabled;
}

/**
 * A cover's average colour, read in the page (ADR-0015): the image servers
 * answer CORS, so a CORS-mode image can be drawn to a canvas and read. Only
 * while artwork is on; undefined on any failure (the caller keeps its tint).
 */
export function readCoverColour(url: string): Promise<{ r: number; g: number; b: number } | undefined> {
  if (!enabled || !url.startsWith("https://")) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.addEventListener("error", () => resolve(undefined));
    img.addEventListener("load", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext("2d");
        if (context === null) {
          resolve(undefined);
          return;
        }
        context.drawImage(img, 0, 0, 8, 8);
        const { data } = context.getImageData(0, 0, 8, 8);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
        }
        const n = data.length / 4;
        resolve({ r: r / n, g: g / n, b: b / n });
      } catch {
        // A canvas that cannot be read (no CORS after all).
        resolve(undefined);
      }
    });
    img.src = url;
  });
}

/**
 * Tint `target` from the real cover at `url` once its colour is read, if it
 * still shows that cover then (the page may have moved on).
 */
export function tintFromCover(target: HTMLElement, url: string | undefined): void {
  target.dataset["tintFor"] = url ?? "";
  if (url === undefined) {
    return;
  }
  void readCoverColour(url).then((rgb) => {
    if (rgb !== undefined && target.dataset["tintFor"] === url) {
      target.style.background = glowBackground(coverFromColour(rgb));
    }
  });
}

/** Point an existing cover slot at another cover (e.g. a different version). */
export function setCover(slot: HTMLElement, url: string | undefined, seed?: string): void {
  slot.replaceWith(coverSlot(url, seed));
}

function apply(): void {
  document.body.classList.toggle("artwork-on", enabled);
  if (enabled) {
    document.querySelectorAll<HTMLImageElement>(".cover img[data-src], .cover-host img[data-src]").forEach(load);
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
