/**
 * Substitutions: how a playlist's source and its tidy-ups agree (ADR-0008).
 *
 * When a tidy-up replaces track A by B (an upgrade, a repair) or keeps B over
 * its duplicate A, it records "desired A is satisfied by B"; a repair that
 * removes A records "A is left out". The source's desired list is mapped
 * through them before reconciling, so the next refresh neither re-adds A nor
 * removes B -- in respect and in mirror mode alike.
 *
 * While a substitution stands the source never adds A, so A turning up in the
 * playlist again means the user (or an undo) put it back: the substitution is
 * dropped and its finding ignored from then on.
 */

import type { TrackId } from "../services/ids.js";
import { STATE_LIST_CAP, type Substitution } from "./model.js";
import type { DesiredTrack } from "./reconcile.js";

/** Follow a track's substitutions; undefined when it is left out. */
function resolve(trackId: TrackId, byFrom: ReadonlyMap<number, Substitution>): number | undefined {
  let current = trackId;
  const visited = new Set<number>();
  for (;;) {
    const next = byFrom.get(current);
    if (next === undefined || visited.has(current)) {
      return current;
    }
    visited.add(current);
    if (next.to === undefined) {
      return undefined;
    }
    current = next.to;
  }
}

/** The desired list with substitutions applied; each track once, at its first place. */
export function mapDesired(
  desired: readonly DesiredTrack[],
  substitutions: readonly Substitution[],
): DesiredTrack[] {
  if (substitutions.length === 0) {
    return [...desired];
  }
  const byFrom = new Map(substitutions.map((sub) => [sub.from, sub]));
  const seen = new Set<number>();
  const out: DesiredTrack[] = [];
  for (const track of desired) {
    const trackId = resolve(track.trackId, byFrom);
    if (trackId === undefined || seen.has(trackId)) {
      continue;
    }
    seen.add(trackId);
    out.push(trackId === track.trackId ? track : { ...track, trackId });
  }
  return out;
}

/** Split off the substitutions whose original track is in the playlist again. */
export function findReverts(
  substitutions: readonly Substitution[],
  presentTrackIds: ReadonlySet<number>,
): { kept: Substitution[]; revertedKeys: string[] } {
  const kept: Substitution[] = [];
  const revertedKeys: string[] = [];
  for (const sub of substitutions) {
    if (presentTrackIds.has(sub.from)) {
      revertedKeys.push(sub.key);
    } else {
      kept.push(sub);
    }
  }
  return { kept, revertedKeys };
}

/** Add substitutions (a newer one for the same track wins), keeping the newest `cap`. */
export function addSubstitutions(
  existing: readonly Substitution[],
  added: readonly Substitution[],
  cap: number = STATE_LIST_CAP,
): Substitution[] {
  const replaced = new Set(added.map((sub) => sub.from));
  const merged = [...existing.filter((sub) => !replaced.has(sub.from)), ...added];
  return merged.length <= cap ? merged : merged.slice(merged.length - cap);
}
