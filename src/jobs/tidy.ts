/**
 * Scheduled tidy-ups: dedupe, upgrade and repair on a playlist or the
 * favourites (ADR-0008).
 *
 * A tidy-up produces *findings* with stable keys ("repair:A", "upgrade:A>B",
 * "dedupe:<ids>"), which are either applied at once or kept as suggestions.
 * Applying one writes it with the existing tools' writers and records how the
 * playlist's source should see it: a substitution ("desired A is satisfied by
 * B"), so the next refresh neither undoes the change nor mistakes it for the
 * user's edit (see ./substitutions.ts).
 */

import type { Track } from "../services/model.js";
import {
  findDuplicateGroups,
  keptIndex,
  removedTracks,
  resolveDuplicateGroups,
  toDedupTrack,
} from "../features/deduplicate.js";
import {
  commitUpgrades,
  resolveUpgradesOf,
  type UpgradeChange,
  type UpgradeCommitClient,
  type UpgradeEntry,
  type UpgradeItem,
  type UpgradeResolverClient,
} from "../features/upgrade.js";
import {
  capList,
  CHECKED_CAP,
  DEFAULT_TIDY,
  STATE_LIST_CAP,
  TIDY_ORDER,
  type Cadence,
  type DedupeTidy,
  type Finding,
  type OwnedEntry,
  type Substitution,
  type TidyKind,
  type TidySet,
  type TidyState,
} from "./model.js";
import { addSubstitutions } from "./substitutions.js";

export type TidyTarget = { type: "favourites" } | { type: "playlist"; playlistId: number };

export type TidyClient = Pick<UpgradeResolverClient, "searchTracks"> & UpgradeCommitClient;

const DAY_MS = 86_400_000;
const CADENCE_DAYS: Record<Cadence, number> = { "every-pass": 0, weekly: 7, monthly: 30 };
/** A track whose upgrade search ran is not searched again for this long. */
export const RECHECK_DAYS = 90;

/** The tidy-ups due now, in the order they run. */
export function dueTidies(tidy: TidySet, state: TidyState, now: Date): TidyKind[] {
  return TIDY_ORDER.filter((kind) => {
    const def = tidy[kind];
    if (def === undefined) {
      return false;
    }
    const last = state[kind]?.lastRunAt;
    const days = CADENCE_DAYS[def.cadence];
    // A little slack, so a weekly tidy-up on a daily 06:00 schedule runs every 7th pass.
    return last === undefined || last === "" || now.getTime() - Date.parse(last) >= days * DAY_MS - 3_600_000;
  });
}

function label(track: Pick<Track, "title" | "artist">): string {
  return track.artist === undefined || track.artist === "" ? `"${track.title}"` : `"${track.title}" – ${track.artist}`;
}

function quality(track: Pick<Track, "bitDepth" | "samplingRate">): string {
  return track.bitDepth === undefined || track.samplingRate === undefined
    ? "unknown quality"
    : `${track.bitDepth}-bit/${track.samplingRate} kHz`;
}

export function dedupeKey(trackIds: readonly number[]): string {
  return `dedupe:${[...trackIds].sort((a, b) => a - b).join(",")}`;
}

/** The favourites in the order they were added, by their (carried-over) dates. */
function inAddedOrder(tracks: readonly Track[], favouriteDates: ReadonlyMap<number, string>): Track[] {
  const at = (track: Track) => favouriteDates.get(track.id) ?? track.favouritedAt;
  if (!tracks.some((track) => at(track) !== undefined)) {
    return [...tracks];
  }
  return tracks
    .map((track, index) => ({ track, index, at: at(track) }))
    .sort((a, b) =>
      a.at === b.at ? a.index - b.index : a.at === undefined ? 1 : b.at === undefined ? -1 : a.at < b.at ? -1 : 1,
    )
    .map(({ track }) => track);
}

function dedupeFindings(
  tracks: readonly Track[],
  def: DedupeTidy,
  target: TidyTarget,
  favouriteDates: ReadonlyMap<number, string>,
): Finding[] {
  const ordered = target.type === "favourites" ? inAddedOrder(tracks, favouriteDates) : tracks;
  const groups = resolveDuplicateGroups(findDuplicateGroups(ordered.map(toDedupTrack)), def.keep);
  return groups.flatMap((group): Finding[] => {
    const kept = group.tracks[keptIndex(group)];
    if (kept === undefined) {
      return [];
    }
    const removed = removedTracks(group);
    return [
      {
        key: dedupeKey(group.tracks.map((track) => track.id)),
        tidy: "dedupe",
        summary: `${group.tracks.length} copies of ${label(kept)}: keeping ${quality(kept)}${kept.album === undefined ? "" : ` from ${kept.album}`}`,
        change: {
          type: "dedupe",
          keepTrackId: kept.id,
          remove: removed.map((track) => ({
            trackId: track.id,
            ...(track.playlistTrackId !== undefined && { playlistTrackId: track.playlistTrackId }),
          })),
        },
      },
    ];
  });
}

function upgradeFinding(item: UpgradeItem): Finding | undefined {
  const pid = item.location.type === "playlist" ? { playlistTrackId: item.location.playlistTrackId } : {};
  const A = item.track.id;
  const best = item.candidates.find((candidate) => candidate.track.id === item.replacementId) ?? item.candidates[0];
  if (item.action === "replace" && best !== undefined) {
    if (item.kind === "upgrade") {
      return {
        key: `upgrade:${A}>${best.track.id}`,
        tidy: "upgrade",
        summary: `${label(item.track)}: ${quality(item.track)} -> ${quality(best.track)}${best.match === "signature" ? " (same song, maybe another recording)" : ""}`,
        change: { type: "replace", trackId: A, newTrackId: best.track.id, ...pid },
      };
    }
    return {
      key: `repair:${A}`,
      tidy: "repair",
      summary: `${label(item.track)} is no longer playable: replace it with another copy${best.track.album === undefined ? "" : ` (${best.track.album})`}`,
      change: { type: "replace", trackId: A, newTrackId: best.track.id, ...pid },
    };
  }
  if (item.kind === "unplayable" && item.action === "remove") {
    return {
      key: `repair:${A}`,
      tidy: "repair",
      summary: `${label(item.track)} is no longer playable and has no other copy: remove it`,
      change: { type: "remove", trackId: A, ...pid },
    };
  }
  return undefined;
}

export interface FindResult {
  findings: Finding[];
  /** The upgrade tidy-up's checked list after this run. */
  checked?: { trackId: number; at: string }[];
  /** Tracks whose upgrade or repair search ran this time. */
  searched: number[];
  notes: string[];
}

/** What the due tidy-ups find in the target's tracks (searches, but writes nothing). */
export async function findTidyFindings(
  client: Pick<UpgradeResolverClient, "searchTracks">,
  tidy: TidySet,
  kinds: readonly TidyKind[],
  target: TidyTarget,
  tracks: readonly Track[],
  ctx: { now: Date; state: TidyState; favouriteDates: ReadonlyMap<number, string> },
): Promise<FindResult> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  let checked: FindResult["checked"];
  let searched: number[] = [];
  const wantsUpgrade = kinds.includes("upgrade") && tidy.upgrade !== undefined;
  const wantsRepair = kinds.includes("repair") && tidy.repair !== undefined;
  if (wantsUpgrade || wantsRepair) {
    const entries: UpgradeEntry[] = tracks.flatMap((track): UpgradeEntry[] =>
      target.type === "favourites"
        ? [{ track, location: { type: "favourites" } }]
        : track.playlistTrackId === undefined
          ? []
          : [{ track, location: { type: "playlist", playlistId: target.playlistId, playlistTrackId: track.playlistTrackId } }],
    );
    const recent = new Set(
      (ctx.state.upgrade?.checked ?? [])
        .filter((entry) => ctx.now.getTime() - Date.parse(entry.at) < RECHECK_DAYS * DAY_MS)
        .map((entry) => entry.trackId),
    );
    const plan = await resolveUpgradesOf(client, entries, {
      kinds: [...(wantsRepair ? ["unplayable" as const] : []), ...(wantsUpgrade ? ["upgrade" as const] : [])],
      allowSignatureMatch: tidy.upgrade?.allowSignatureMatch ?? false,
      maxSearches: tidy.upgrade?.maxSearches ?? DEFAULT_TIDY.upgrade.maxSearches,
      removeUnplayable: tidy.repair?.action === "remove",
      skip: (track, kind) => kind === "upgrade" && recent.has(track.id),
    });
    findings.push(...plan.items.flatMap((item) => upgradeFinding(item) ?? []));
    searched = plan.checkedTrackIds;
    if (wantsUpgrade) {
      const at = ctx.now.toISOString();
      const fresh = new Set(plan.checkedTrackIds);
      const previous = (ctx.state.upgrade?.checked ?? []).filter((entry) => !fresh.has(entry.trackId));
      checked = capList([...previous, ...plan.checkedTrackIds.map((trackId) => ({ trackId, at }))], CHECKED_CAP);
    }
    if (plan.unchecked > 0) {
      notes.push(`${plan.unchecked} track(s) wait for the next tidy-up (search budget reached).`);
    }
    if (plan.failed > 0) {
      notes.push(`${plan.failed} search(es) failed; they are tried again next time.`);
    }
    const stranded = plan.items.filter((item) => item.kind === "unplayable" && item.action === "leave").length;
    if (stranded > 0) {
      notes.push(`${stranded} unplayable track(s) have no other copy; left in place.`);
    }
  }
  if (kinds.includes("dedupe") && tidy.dedupe !== undefined) {
    findings.push(...dedupeFindings(tracks, tidy.dedupe, target, ctx.favouriteDates));
  }
  // Repairs before upgrades before duplicates, as they ran.
  findings.sort((a, b) => TIDY_ORDER.indexOf(a.tidy) - TIDY_ORDER.indexOf(b.tidy));
  return { findings, ...(checked !== undefined && { checked }), searched, notes };
}

/**
 * Drop findings already dealt with: ignored ones, and ones applied before --
 * finding an applied change again means the user put it back, so it is
 * ignored from now on.
 */
export function screenFindings(
  findings: readonly Finding[],
  book: Pick<TidyBook, "applied" | "ignored">,
): { fresh: Finding[]; newlyIgnored: string[] } {
  const ignored = new Set(book.ignored);
  const applied = new Set(book.applied);
  const fresh: Finding[] = [];
  const newlyIgnored: string[] = [];
  for (const finding of findings) {
    if (ignored.has(finding.key)) {
      continue;
    }
    if (applied.has(finding.key)) {
      newlyIgnored.push(finding.key);
      ignored.add(finding.key);
      continue;
    }
    fresh.push(finding);
  }
  return { fresh, newlyIgnored };
}

/** The parts of a job's state that applying findings changes. */
export interface TidyBook {
  owned: OwnedEntry[];
  substitutions: Substitution[];
  applied: string[];
  ignored: string[];
  favouriteDates: Map<number, string>;
}

export interface ApplyResult {
  book: TidyBook;
  appliedKeys: string[];
  replaced: number;
  removed: number;
  notes: string[];
  /** The playlist's tracks after the writes (playlists only). */
  after?: Track[];
}

export type TidyWriteClient = UpgradeCommitClient & {
  getPlaylistTracks(playlistId: number): Promise<Track[]>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write findings and do their book-keeping. Failures are reported in the
 * notes, never thrown (each tidy-up looks again next time), except what the
 * writers themselves rethrow -- an expired session must stop the run.
 */
export async function applyFindings(
  client: TidyWriteClient,
  target: TidyTarget,
  findings: readonly Finding[],
  before: readonly Track[],
  book: TidyBook,
): Promise<ApplyResult> {
  const notes: string[] = [];
  const succeeded: Finding[] = [];
  const location = (playlistTrackId: number | undefined): UpgradeChange["location"] | undefined =>
    target.type === "favourites"
      ? { type: "favourites" }
      : playlistTrackId === undefined
        ? undefined
        : { type: "playlist", playlistId: target.playlistId, playlistTrackId };

  // Replacements and repairs, through the upgrade tool's writer.
  const byChange = new Map<UpgradeChange, Finding>();
  for (const finding of findings) {
    const { change } = finding;
    if (change.type === "dedupe") {
      continue;
    }
    const where = location(change.playlistTrackId);
    if (where === undefined) {
      continue;
    }
    byChange.set(
      change.type === "replace"
        ? { action: "replace", location: where, trackId: change.trackId, newTrackId: change.newTrackId }
        : { action: "remove", location: where, trackId: change.trackId },
      finding,
    );
  }
  let replaced = 0;
  let removed = 0;
  if (byChange.size > 0) {
    const result = await commitUpgrades(client, [...byChange.keys()]);
    const failed = new Set(result.failed.map((entry) => entry.change));
    for (const [change, finding] of byChange) {
      if (!failed.has(change)) {
        succeeded.push(finding);
      }
    }
    replaced += result.replaced;
    removed += result.removed;
    if (result.failed.length > 0) {
      notes.push(`${result.failed.length} change(s) could not be written: ${result.failed[0]?.reason ?? ""}`);
    }
  }

  // Duplicates: remove the extra copies.
  const dedupes = findings.filter((finding) => finding.change.type === "dedupe");
  if (dedupes.length > 0) {
    const copies = dedupes.flatMap((finding) => (finding.change.type === "dedupe" ? finding.change.remove : []));
    try {
      if (target.type === "favourites") {
        await client.removeFavoriteTracks([...new Set(copies.map((copy) => copy.trackId))]);
      } else {
        const ids = copies.flatMap((copy) => (copy.playlistTrackId === undefined ? [] : [copy.playlistTrackId]));
        if (ids.length > 0) {
          await client.removeTracksFromPlaylist(target.playlistId, ids);
        }
      }
      succeeded.push(...dedupes);
      removed += copies.length;
    } catch (error) {
      if (isAuthentication(error)) {
        throw error;
      }
      notes.push(`Duplicates could not be removed: ${messageOf(error)}`);
    }
  }

  const next: TidyBook = {
    owned: book.owned,
    substitutions: book.substitutions,
    applied: book.applied,
    ignored: book.ignored,
    favouriteDates: new Map(book.favouriteDates),
  };
  const newSubs: Substitution[] = [];
  const appliedKeys: string[] = [];
  for (const finding of succeeded) {
    const { change } = finding;
    if (target.type === "favourites") {
      appliedKeys.push(finding.key);
      if (change.type === "replace") {
        const old = before.find((track) => track.id === change.trackId);
        const at = next.favouriteDates.get(change.trackId) ?? old?.favouritedAt;
        next.favouriteDates.delete(change.trackId);
        if (at !== undefined) {
          next.favouriteDates.set(change.newTrackId, at);
        }
      }
      continue;
    }
    if (change.type === "replace") {
      newSubs.push({ from: change.trackId, to: change.newTrackId, key: finding.key });
    } else if (change.type === "remove") {
      newSubs.push({ from: change.trackId, key: finding.key });
    } else {
      const others = change.remove.filter((copy) => copy.trackId !== change.keepTrackId);
      others.forEach((copy) => newSubs.push({ from: copy.trackId, to: change.keepTrackId, key: finding.key }));
      if (others.length < change.remove.length) {
        appliedKeys.push(finding.key); // an exact copy has no substitution to watch
      }
    }
  }
  next.substitutions = addSubstitutions(next.substitutions, newSubs);
  next.applied = capList([...next.applied, ...appliedKeys], STATE_LIST_CAP);

  let after: Track[] | undefined;
  if (target.type === "playlist" && succeeded.length > 0) {
    after = await client.getPlaylistTracks(target.playlistId);
    next.owned = carryOwnership(book.owned, before, after, succeeded);
  }
  return {
    book: next,
    appliedKeys: succeeded.map((finding) => finding.key),
    replaced,
    removed,
    notes,
    ...(after !== undefined && { after }),
  };
}

/**
 * Owned entries after tidy writes: those still present stay owned; an owned
 * entry that was replaced passes its ownership to its replacement's new entry.
 * Ownership never moves onto an entry the user added.
 */
export function carryOwnership(
  owned: readonly OwnedEntry[],
  before: readonly Track[],
  after: readonly Track[],
  applied: readonly Finding[],
): OwnedEntry[] {
  const present = new Set(after.flatMap((track) => (track.playlistTrackId === undefined ? [] : [track.playlistTrackId])));
  const wasThere = new Set(before.flatMap((track) => (track.playlistTrackId === undefined ? [] : [track.playlistTrackId])));
  const ownedIds = new Set(owned.map((entry) => entry.playlistTrackId));
  const kept = owned.filter((entry) => present.has(entry.playlistTrackId));
  const claimed = new Set(kept.map((entry) => entry.playlistTrackId));
  for (const finding of applied) {
    const { change } = finding;
    if (change.type !== "replace" || change.playlistTrackId === undefined || !ownedIds.has(change.playlistTrackId)) {
      continue;
    }
    const entry = after.find(
      (track) =>
        track.id === change.newTrackId &&
        track.playlistTrackId !== undefined &&
        !wasThere.has(track.playlistTrackId) &&
        !claimed.has(track.playlistTrackId),
    );
    if (entry?.playlistTrackId !== undefined) {
      claimed.add(entry.playlistTrackId);
      kept.push({ playlistTrackId: entry.playlistTrackId, trackId: entry.id });
    }
  }
  return kept;
}

/** Is a finding's change still possible on these tracks (for accepting a suggestion later)? */
export function stillApplies(finding: Finding, target: TidyTarget, tracks: readonly Track[]): boolean {
  const has = (trackId: number, playlistTrackId: number | undefined) =>
    tracks.some(
      (track) =>
        track.id === trackId && (target.type === "favourites" || track.playlistTrackId === playlistTrackId),
    );
  const { change } = finding;
  if (change.type === "dedupe") {
    return change.remove.every((copy) => has(copy.trackId, copy.playlistTrackId)) && tracks.some((t) => t.id === change.keepTrackId);
  }
  return has(change.trackId, change.playlistTrackId);
}

function isAuthentication(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "authentication";
}
