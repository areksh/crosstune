/**
 * What becomes of a stored fill (src/web/prefill.ts) when the page shows a
 * view. A fill that names the address it was made for (a suggestion picked in
 * the ask box, a tool opened on a source) applies only there: if the user
 * stayed instead (a draft, an unsaved preview) and went elsewhere, it is
 * dropped rather than turning up on a later, unrelated visit.
 */
export function prefillFate(fill: { view: string; hash?: string }, view: string, hash: string): "apply" | "keep" | "drop" {
  if (fill.hash !== undefined && fill.hash !== hash) {
    return "drop";
  }
  return fill.view === view ? "apply" : "keep";
}
