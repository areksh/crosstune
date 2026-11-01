/**
 * Opening a tool with its input filled in (the home paste box's buttons).
 *
 * The home view stores what to fill, then switches the hash; when the router
 * shows that tool it applies the fill once: text fields get their value,
 * radios are ticked, and each gets the `input`/`change` event a person's edit
 * would fire, so the view reacts as usual. A `<select>` whose options are
 * still loading (a playlist picker) is set once the option appears. The fill
 * is kept in memory, and in sessionStorage so a reload keeps it; storage
 * failures (private windows, blocked storage) are ignored.
 */

export interface Prefill {
  /** The view to fill, e.g. "playlist". */
  view: string;
  /** Element ids and their values (textarea, input or select). */
  fields?: Record<string, string>;
  /** Radio group names and the value to tick, applied before the fields. */
  radios?: Record<string, string>;
}

const STORAGE_KEY = "qobuz-helper:prefill";
/** How long to wait for a select's option to load before giving up. */
const OPTION_WAIT_MS = 15_000;

let pending: Prefill | undefined;

/** Remember a fill for the next time its view is shown. */
export function storePrefill(prefill: Prefill): void {
  pending = prefill;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
  } catch {
    // Kept in memory only; enough for an in-page switch.
  }
}

/** Apply (and forget) the stored fill if it is for this view. */
export function applyPrefill(view: string): void {
  const prefill = pending ?? readStored();
  if (prefill === undefined || prefill.view !== view) {
    return;
  }
  pending = undefined;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  for (const [name, value] of Object.entries(prefill.radios ?? {})) {
    const radio = document.querySelector<HTMLInputElement>(
      `input[type=radio][name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`,
    );
    if (radio !== null) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  for (const [id, value] of Object.entries(prefill.fields ?? {})) {
    const node = document.getElementById(id);
    if (node instanceof HTMLSelectElement) {
      selectWhenLoaded(node, value);
    } else if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

function readStored(): Prefill | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "view" in parsed
      ? (parsed as Prefill)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Choose `value` in a select now, or as soon as that option is added. */
function selectWhenLoaded(select: HTMLSelectElement, value: string): void {
  const choose = (): boolean => {
    if (![...select.options].some((option) => option.value === value)) {
      return false;
    }
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  if (choose()) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (choose()) {
      observer.disconnect();
    }
  });
  observer.observe(select, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), OPTION_WAIT_MS);
}
