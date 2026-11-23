/**
 * The app was called qobuz-helper (ADR-0014): this browser's settings for it
 * (the chosen service, artwork, a tool's prefilled input) carry over once.
 * Imported first by main.ts, as the other modules read their settings on load.
 */

const KEYS = ["service", "show-artwork", "prefill"];

try {
  for (const key of KEYS) {
    const old = localStorage.getItem(`qobuz-helper:${key}`);
    if (old !== null && localStorage.getItem(`crosstune:${key}`) === null) {
      localStorage.setItem(`crosstune:${key}`, old);
    }
    localStorage.removeItem(`qobuz-helper:${key}`);
  }
} catch {
  // Storage unavailable (private window, blocked): there is nothing to carry over.
}

export {};
