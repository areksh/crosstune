/**
 * Running a sync: read every copy, ask the services what is needed, plan
 * (./plan.ts), and write -- the intended writes recorded first, so that a sync
 * cut off half-way is finished rather than mistaken for the user's changes.
 */

import { matchTracks, type MatchClient, type MatchMemory, type SongMatch } from "../features/match.js";
import { addInOrder } from "../features/playlist-add.js";
import { mergeOrder, planOrder } from "../features/playlist-order.js";
import { ServiceError, isNotFound } from "../services/errors.js";
import type { EntryId, PlaylistId, ServiceName, TrackId } from "../services/ids.js";
import { normaliseIsrc } from "../services/isrc.js";
import type { Playlist, Track } from "../services/model.js";
import { SERVICES } from "../services/names.js";
import type { Account, Capabilities } from "../services/service.js";
import { align } from "./align.js";
import {
  type Conflict,
  type Gap,
  type LinkCopies,
  type LinkState,
  type PendingSync,
  type Question,
  type SongRef,
  type SyncBase,
  type SyncSong,
} from "./model.js";
import { findChanges, planSync, refOf, type Choice, type Copy, type CopyPlan, type Facts, type Offered } from "./plan.js";

/** A service as a sync uses it; MusicService satisfies it. */
export interface SyncClient extends MatchClient {
  readonly capabilities?: Pick<Capabilities, "playability">;
  account?(): Account | undefined;
  getPlaylist(id: PlaylistId): Promise<Playlist>;
  getPlaylistTracks(id: PlaylistId): Promise<Track[]>;
  addTracksToPlaylist(id: PlaylistId, tracks: readonly TrackId[]): Promise<void>;
  removeTracksFromPlaylist(id: PlaylistId, entries: readonly EntryId[]): Promise<void>;
  movePlaylistTracks(id: PlaylistId, entries: readonly EntryId[], insertBefore: number): Promise<void>;
  updatePlaylist(id: PlaylistId, changes: { name?: string }): Promise<Playlist>;
  /** Songs that removing these entries would take out and add again. */
  removesByReAdding?(id: PlaylistId, entries: readonly EntryId[]): Promise<TrackId[]>;
}

export interface SyncInput {
  clients: ReadonlyMap<ServiceName, SyncClient>;
  copies: LinkCopies;
  state: LinkState;
  matches: MatchMemory;
  now: Date;
  /** Keep the state; called before the first write and after the last. */
  save(state: LinkState): void;
}

export interface CopyChange {
  service: ServiceName;
  added: number;
  removed: number;
  moved: boolean;
  renamed: boolean;
}

export interface SyncOutcome {
  status: "synced" | "unchanged" | "conflict" | "failed";
  state: LinkState;
  changes: CopyChange[];
  gaps: { service: ServiceName; gap: Gap; song: SongRef }[];
  /** Why it failed. */
  error?: string;
}

/** Songs a service did not have are looked for again after this. */
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

interface ReadCopy extends Copy {
  playlistId: PlaylistId;
  client: SyncClient;
}

/** Sync a link's copies. Reads that fail are thrown; nothing is written then. */
export async function syncLink(input: SyncInput): Promise<SyncOutcome> {
  let { state } = input;
  if (state.pending !== undefined) {
    const finished = await finishPending(input, state, state.pending);
    if (!("state" in finished)) {
      return finished.outcome;
    }
    state = finished.state;
  }
  const read = await readCopies(input);
  if ("conflicts" in read) {
    return conflicted(input, state, read.conflicts);
  }
  if (state.base === undefined) {
    const base = await commonBase(input, read.copies);
    const same = read.copies.every((copy) => songsOf(copy).length === base.songs.length) && sameOrder(base, read.copies);
    if (!same || new Set(read.copies.map((copy) => copy.name)).size > 1) {
      return conflicted(input, state, [{ kind: "first-link" }]);
    }
    const next = { ...settled(state, input.now), base, gapsCheckedAt: input.now.toISOString() };
    input.save(next);
    return { status: "synced", state: next, changes: [], gaps: [] };
  }
  return carryOut(input, { ...state, base: state.base }, read.copies);
}

/**
 * Start a link whose copies differ from what they have in common: the next sync
 * then puts on every copy what any of them has. `from`'s order is kept.
 */
export async function linkAsSame(input: Omit<SyncInput, "save"> & { from: ServiceName }): Promise<LinkState> {
  const read = await readCopies(input);
  if ("conflicts" in read) {
    return { ...input.state, conflicts: read.conflicts };
  }
  // Common songs in another copy's order: what differs is then `from`'s change.
  const others = read.copies.filter((copy) => copy.service !== input.from);
  const from = read.copies.filter((copy) => copy.service === input.from);
  const base = await commonBase(input, [...others, ...from]);
  return {
    ...settled(input.state, input.now),
    base: { ...base, name: others[0]?.name ?? base.name },
    gapsCheckedAt: input.now.toISOString(),
  };
}

/**
 * Settle a conflict: make every copy like one of them, or merge (every addition
 * kept, and only what no other copy touched removed; `merge` names whose order
 * and name are kept). With `dryRun` only what it would change.
 */
export async function resolveConflict(
  input: SyncInput & { choice: Choice; dryRun?: boolean },
): Promise<SyncOutcome> {
  const { pending: _interrupted, ...state } = input.state;
  const read = await readCopies(input);
  if ("conflicts" in read) {
    return conflicted(input, input.state, read.conflicts);
  }
  const leader = "use" in input.choice ? input.choice.use : input.choice.merge;
  const base =
    state.base ??
    (await commonBase(input, [...read.copies.filter((c) => c.service !== leader), ...read.copies.filter((c) => c.service === leader)]));
  return carryOut({ ...input, state }, { ...state, base }, read.copies, input.choice, input.dryRun === true);
}

/** One copy, as it differs: since the last sync, or from what all copies have. */
export interface CopySide {
  service: ServiceName;
  name: string;
  songs: number;
  renamed: boolean;
  reordered: boolean;
  added: SongRef[];
  removed: SongRef[];
}

export type CopyComparison = { since: "last-sync" | "in-common"; copies: CopySide[] } | { conflicts: Conflict[] };

/**
 * The copies side by side, to settle a conflict knowing what each changed: the
 * songs added to and removed from each since the last sync, and whether it was
 * reordered or renamed. A first link has no last sync: then each copy's
 * additions are the songs only it has, against what they all have in common.
 * Writes nothing.
 */
export async function compareCopies(input: Pick<SyncInput, "clients" | "copies" | "state" | "matches">): Promise<CopyComparison> {
  const read = await readCopies(input);
  if ("conflicts" in read) {
    return { conflicts: read.conflicts };
  }
  const { base: last } = input.state;
  const base = last ?? (await commonBase(input, read.copies));
  const byId = new Map(read.copies.flatMap((copy) => copy.entries.map((track) => [track.id, track] as const)));
  /** A song gone from `service`, named as a copy that still has it names it. */
  const named = (index: number, service: ServiceName): SongRef => {
    const { ids } = base.songs[index]!;
    const there = Object.values(ids).flatMap((id) => byId.get(id) ?? []);
    return there[0] === undefined ? { id: ids[service]!, title: "a song no copy has now" } : refOf(there[0]);
  };
  return {
    since: last === undefined ? "in-common" : "last-sync",
    copies: read.copies.map((copy) => {
      const changes = findChanges(base, copy);
      return {
        service: copy.service,
        name: copy.name,
        songs: songsOf(copy).length,
        renamed: last !== undefined && copy.name !== last.name,
        reordered: changes.moved.size > 0,
        added: changes.additions.map((place) => refOf(place.track)),
        removed: changes.removed.map((index) => named(index, copy.service)),
      };
    }),
  };
}

// ---- Reading ----------------------------------------------------------------

async function readCopies(
  input: Pick<SyncInput, "clients" | "copies">,
): Promise<{ copies: ReadCopy[] } | { conflicts: Conflict[] }> {
  const conflicts: Conflict[] = [];
  const services = SERVICES.filter((service) => input.copies[service] !== undefined);
  const copies = await Promise.all(
    services.map(async (service): Promise<ReadCopy | undefined> => {
      const client = input.clients.get(service);
      if (client === undefined) {
        throw new ServiceError(service, "not-connected", `${service} is not connected`);
      }
      const playlistId = input.copies[service]!;
      try {
        const playlist = await client.getPlaylist(playlistId);
        const entries = await client.getPlaylistTracks(playlistId);
        const mine = playlist.ownerId === undefined || playlist.ownerId === client.account?.()?.id;
        if (!mine && playlist.isCollaborative !== true) {
          conflicts.push({ kind: "not-editable", service });
        }
        return { service, client, playlistId, name: playlist.name, entries };
      } catch (error) {
        if (isNotFound(error)) {
          conflicts.push({ kind: "gone", service });
          return undefined;
        }
        throw error;
      }
    }),
  );
  return conflicts.length > 0 ? { conflicts } : { copies: copies.filter((copy) => copy !== undefined) };
}

function songsOf(copy: Copy): Track[] {
  return copy.entries.filter((track) => track.other === undefined);
}

/** The songs every copy has, in the first copy's order. */
async function commonBase(input: Pick<SyncInput, "clients" | "matches">, copies: readonly ReadCopy[]): Promise<SyncBase> {
  const [first, ...others] = copies;
  if (first === undefined) {
    return { name: "", songs: [] };
  }
  const songs = songsOf(first);
  const ids = new Map<ServiceName, (TrackId | undefined)[]>();
  for (const other of others) {
    const open = songsOf(other);
    const found: (TrackId | undefined)[] = songs.map((song) => {
      const at = open.findIndex((track) => sameIsrc(song, track));
      return at === -1 ? undefined : open.splice(at, 1)[0]!.id;
    });
    const left = songs.filter((_, index) => found[index] === undefined);
    const matches = await matchTracks(other.client, left, input.matches);
    songs.forEach((_, index) => {
      if (found[index] === undefined) {
        const match = matches.shift();
        const at = match?.grade === "exact" ? open.findIndex((track) => track.id === match.track?.id) : -1;
        found[index] = at === -1 ? undefined : open.splice(at, 1)[0]!.id;
      }
    });
    ids.set(other.service, found);
  }
  return {
    name: first.name,
    songs: songs.flatMap((song, index) => {
      const rest = others.map((other) => [other.service, ids.get(other.service)![index]] as const);
      return rest.some(([, id]) => id === undefined)
        ? []
        : [
            {
              ids: { [first.service]: song.id, ...Object.fromEntries(rest) },
              ...(song.isrc !== undefined && { isrc: normaliseIsrc(song.isrc) }),
            },
          ];
    }),
  };
}

function sameIsrc(a: Track, b: Track): boolean {
  return a.isrc !== undefined && b.isrc !== undefined && normaliseIsrc(a.isrc) === normaliseIsrc(b.isrc);
}

function sameOrder(base: SyncBase, copies: readonly ReadCopy[]): boolean {
  return copies.every((copy) =>
    songsOf(copy).every((track, index) => base.songs[index]?.ids[copy.service] === track.id),
  );
}

// ---- Asking -----------------------------------------------------------------

/** What the services say about the songs a plan is about. */
async function gatherFacts(
  input: SyncInput,
  base: SyncBase,
  copies: readonly ReadCopy[],
  changes: readonly ReturnType<typeof findChanges>[],
  recheckGaps: boolean,
): Promise<Facts> {
  const wanted = new Map<ServiceName, Track[]>(copies.map((copy) => [copy.service, []]));
  for (const change of changes) {
    for (const { track } of change.additions) {
      copies.filter((copy) => copy.service !== change.service).forEach((copy) => wanted.get(copy.service)!.push(track));
    }
    if (recheckGaps) {
      for (const { track, base: index } of change.places) {
        for (const copy of copies) {
          if (index !== undefined && base.songs[index]?.gaps?.[copy.service] === "not-found") {
            wanted.get(copy.service)!.push(track);
          }
        }
      }
    }
  }
  const matches = new Map<string, SongMatch>();
  for (const copy of copies) {
    for (const match of await matchTracks(copy.client, wanted.get(copy.service)!, input.matches)) {
      matches.set(`${copy.service} ${match.source.id}`, match);
    }
  }
  const offered = new Map<TrackId, Offered>();
  for (const copy of copies) {
    const change = changes.find((one) => one.service === copy.service)!;
    for (const index of change.removed) {
      const id = base.songs[index]!.ids[copy.service]!;
      offered.set(id, await isOffered(copy.client, id));
    }
  }
  return {
    match: (track, on) =>
      matches.get(`${on} ${track.id}`) ?? { source: track, grade: "missing", options: [], failed: "not looked up" },
    offered: (id) => offered.get(id) ?? "unknown",
    answers: input.state.answers,
    recheckGaps,
  };
}

async function isOffered(client: SyncClient, id: TrackId): Promise<Offered> {
  try {
    const track = await client.getTrack(id);
    if (track.streamable === false) {
      return "no";
    }
    // Found, but does that mean offered? Only where the service says which are.
    return track.streamable === undefined && client.capabilities?.playability.ok === false ? "unknown" : "yes";
  } catch (error) {
    return isNotFound(error) ? "no" : "unknown";
  }
}

// ---- Carrying out -----------------------------------------------------------

async function carryOut(
  input: SyncInput,
  state: LinkState & { base: SyncBase },
  copies: readonly ReadCopy[],
  choice?: Choice,
  dryRun = false,
): Promise<SyncOutcome> {
  const changes = copies.map((copy) => findChanges(state.base, copy));
  const since = state.gapsCheckedAt === undefined ? 0 : Date.parse(state.gapsCheckedAt);
  const recheckGaps =
    input.now.getTime() - since > RECHECK_MS &&
    state.base.songs.some((song) => Object.values(song.gaps ?? {}).includes("not-found"));
  const facts = await gatherFacts(input, state.base, copies, changes, recheckGaps);
  const planned = planSync(state.base, changes, facts, choice);
  if ("conflicts" in planned) {
    return dryRun
      ? { status: "conflict", state: { ...state, conflicts: planned.conflicts }, changes: [], gaps: [] }
      : conflicted(input, state, planned.conflicts);
  }
  const { plan } = planned;
  const report = plan.copies.map(({ service, added, removed, moved, rename }) => ({
    service,
    added,
    removed,
    moved,
    renamed: rename !== undefined,
  }));
  if (dryRun) {
    return { status: "synced", state, changes: report, gaps: [] };
  }
  const next: LinkState = {
    ...settled(state, input.now),
    questions: plan.questions,
    answers: stillAsked(state.answers, plan.questions),
    ...(recheckGaps && { gapsCheckedAt: input.now.toISOString() }),
  };
  const gaps = () => gapsOf(next.base ?? plan.base, changes);
  if (plan.copies.length === 0) {
    const done = { ...next, base: plan.base };
    const quiet = JSON.stringify(done.base) === JSON.stringify(state.base) && JSON.stringify(done.questions) === JSON.stringify(state.questions);
    input.save(done);
    return { status: quiet && report.length === 0 ? "unchanged" : "synced", state: done, changes: [], gaps: gapsOf(plan.base, changes) };
  }
  // Another read just before writing: a copy changed meanwhile is left alone.
  for (const copy of copies) {
    const again = await copy.client.getPlaylistTracks(copy.playlistId);
    if (again.length !== copy.entries.length || again.some((track, index) => track.id !== copy.entries[index]!.id)) {
      return { status: "failed", state, changes: [], gaps: [], error: "A copy was changed while it was being synced." };
    }
  }
  const pending: PendingSync = {
    base: plan.base,
    copies: Object.fromEntries(plan.copies.map((copy) => [copy.service, { before: copy.before, after: copy.after }])),
  };
  const writing: LinkState = { ...next, base: state.base, pending };
  input.save(writing);
  // What is on disk: on a failure the caller keeps this, not an older state.
  let latest = writing;
  try {
    const written = await write(copies, plan.copies, plan.base, state.answers, (base, left) => {
      latest = { ...writing, pending: { base, copies: left } };
      input.save(latest);
    });
    const { pending: _done, ...rest } = writing;
    const done: LinkState = { ...rest, base: written.base, questions: [...plan.questions, ...written.questions] };
    next.base = written.base;
    input.save(done);
    // A repeat kept (and asked about) was not removed.
    const changes = report
      .map((change) => ({ ...change, removed: change.removed - (written.kept.get(change.service) ?? 0) }))
      .filter((change) => change.added > 0 || change.removed > 0 || change.moved || change.renamed);
    return { status: "synced", state: done, changes, gaps: gaps() };
  } catch (error) {
    return {
      status: "failed",
      state: latest,
      changes: report,
      gaps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Write each copy; songs a service took but dropped become gaps. After each
 * copy, `progress` gets the base as learnt so far and the copies still to
 * write: an interruption then finishes only those (a finished copy's later
 * edits are the user's, and must not be undone).
 */
async function write(
  copies: readonly ReadCopy[],
  plans: readonly (Pick<CopyPlan, "service" | "before" | "after"> & { rename?: string })[],
  base: SyncBase,
  answers: LinkState["answers"],
  progress?: (base: SyncBase, left: PendingSync["copies"]) => void,
): Promise<{ base: SyncBase; questions: Question[]; kept: Map<ServiceName, number> }> {
  const songs = base.songs.map((song) => ({ ...song, ids: { ...song.ids } }));
  const questions: Question[] = [];
  const kept = new Map<ServiceName, number>();
  const services = copies.map((copy) => copy.service);
  const left = new Map(plans.map((plan) => [plan.service, plan]));
  const now = (): SyncBase => ({ ...base, songs: songs.filter((song) => Object.keys(song.ids).length > 0) });
  for (const plan of plans) {
    const copy = copies.find((one) => one.service === plan.service)!;
    if (plan.rename !== undefined) {
      await copy.client.updatePlaylist(copy.playlistId, { name: plan.rename });
    }
    const result = await writeCopy(copy, plan.before, plan.after, answers);
    questions.push(...result.questions);
    for (const id of result.dropped) {
      const song = songs.find((one) => one.ids[plan.service] === id);
      if (song !== undefined) {
        delete song.ids[plan.service];
        song.gaps = { ...song.gaps, [plan.service]: "not-found" };
      }
    }
    // A repeat it could not take out stays, there only, until the user says.
    kept.set(plan.service, result.kept.length);
    for (const { track, at } of result.kept) {
      let seen = 0;
      const place = songs.findIndex((song) => song.ids[plan.service] !== undefined && seen++ === at);
      const gaps = Object.fromEntries(services.filter((one) => one !== plan.service).map((one) => [one, "left-out" as const]));
      const song: SyncSong = { ids: { [plan.service]: track.id }, gaps, ...(track.isrc !== undefined && { isrc: normaliseIsrc(track.isrc) }) };
      songs.splice(place === -1 ? songs.length : place, 0, song);
    }
    left.delete(plan.service);
    if (left.size > 0) {
      progress?.(
        now(),
        Object.fromEntries([...left.values()].map(({ service, before, after }) => [service, { before, after }])),
      );
    }
  }
  return { base: now(), questions, kept };
}

function count(ids: readonly TrackId[]): Map<TrackId, number> {
  const counts = new Map<TrackId, number>();
  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  return counts;
}

/**
 * Bring a copy from `before` to `after`: add, then move, then remove, each
 * worked out from what is there at the time -- so it also finishes a copy left
 * part-way. Only what the change itself adds is added, and only as many are
 * removed as it removes: an edit made meanwhile is not undone.
 */
async function writeCopy(
  copy: ReadCopy,
  before: readonly TrackId[],
  after: readonly TrackId[],
  answers: LinkState["answers"],
): Promise<{ dropped: TrackId[]; questions: Question[]; kept: { track: Track; at: number }[] }> {
  const { client, playlistId } = copy;
  const [had, wants] = [count(before), count(after)];
  const read = async (): Promise<Track[]> => client.getPlaylistTracks(playlistId);

  let entries = await read();
  const here = count(entries.map((track) => track.id));
  const room = new Map<TrackId, number>();
  for (const [id, many] of wants) {
    const mayAdd = many - (had.get(id) ?? 0);
    room.set(id, Math.min(mayAdd, many - (here.get(id) ?? 0)));
  }
  // The last of a repeated song's places are the new ones.
  const adds = [...after]
    .reverse()
    .filter((id) => {
      const left = room.get(id) ?? 0;
      room.set(id, left - 1);
      return left > 0;
    })
    .reverse();
  if (adds.length > 0) {
    await addInOrder(client, playlistId, adds);
    entries = await read();
  }
  const arrived = count(entries.map((track) => track.id));
  const dropped = [...count(adds).keys()].filter((id) => (arrived.get(id) ?? 0) < (wants.get(id) ?? 0));

  // Moves, checked against what is there: where entries are places, one at a time.
  for (let round = 0; round < 1000; round += 1) {
    const moves = movesFor(entries, after);
    if (moves.length === 0) {
      break;
    }
    const lasting = entries.every((track) => !track.playlistTrackId!.includes("#"));
    for (const move of lasting ? moves : moves.slice(0, 1)) {
      await client.movePlaylistTracks(playlistId, move.playlistTrackIds, move.insertBefore);
    }
    entries = await read();
  }

  // Removals: never more of a song than the change takes out.
  const pairs = align(after, entries.map((track) => track.id));
  const kept = new Set(pairs);
  const going = new Map<TrackId, number>();
  for (const [id, many] of had) {
    going.set(id, many - (wants.get(id) ?? 0));
  }
  const surplus = entries.filter((track, index) => {
    const left = going.get(track.id) ?? 0;
    if (kept.has(index) || left <= 0) {
      return false;
    }
    going.set(track.id, left - 1);
    return true;
  });
  const questions: Question[] = [];
  const repeats: { track: Track; at: number }[] = [];
  if (surplus.length > 0) {
    // Taking out one of a repeated song re-adds the others: only when asked to.
    const reAdded = new Set(
      ((await client.removesByReAdding?.(playlistId, surplus.map((track) => track.playlistTrackId!))) ?? []).filter(
        (id) => answers[`repeated ${id}`] !== "removed",
      ),
    );
    const plain = surplus.filter((track) => !reAdded.has(track.id));
    const staying = entries.filter((track) => !plain.includes(track));
    for (const track of surplus.filter((one) => reAdded.has(one.id))) {
      questions.push({ kind: "repeated", key: `repeated ${track.id}`, song: refOf(track), service: copy.service });
      repeats.push({ track, at: staying.indexOf(track) });
    }
    if (plain.length > 0) {
      await client.removeTracksFromPlaylist(playlistId, plain.map((track) => track.playlistTrackId!));
    }
  }
  return { dropped, questions, kept: repeats };
}

function movesFor(entries: readonly Track[], after: readonly TrackId[]) {
  const ids = entries.map((track) => track.playlistTrackId!);
  const wanted = align(after, entries.map((track) => track.id)).flatMap((at) => (at === -1 ? [] : [ids[at]!]));
  return planOrder(ids, mergeOrder(ids, wanted));
}

// ---- An interrupted sync ----------------------------------------------------

/** Finish what an interrupted sync had begun, or say that it cannot be told apart. */
async function finishPending(
  input: SyncInput,
  state: LinkState,
  pending: PendingSync,
): Promise<{ state: LinkState } | { outcome: SyncOutcome }> {
  const read = await readCopies(input);
  if ("conflicts" in read) {
    return { outcome: conflicted(input, state, read.conflicts) };
  }
  const strange = read.copies.filter((copy) => {
    const intended = pending.copies[copy.service];
    return intended !== undefined && !isBetween(copy.entries.map((track) => track.id), intended.before, intended.after);
  });
  if (strange.length > 0) {
    return { outcome: conflicted(input, state, strange.map(({ service }) => ({ kind: "interrupted", service }))) };
  }
  let latest = state;
  try {
    const plans = SERVICES.flatMap((service) => {
      const intended = pending.copies[service];
      return intended === undefined ? [] : [{ service, ...intended }];
    });
    const { base, questions } = await write(read.copies, plans, pending.base, state.answers, (base, left) => {
      latest = { ...state, pending: { base, copies: left } };
      input.save(latest);
    });
    const { pending: _done, ...rest } = state;
    const next: LinkState = {
      ...rest,
      // A rename may not have been written: told apart again from the old name.
      base: { ...base, name: state.base?.name ?? base.name },
      questions: [...state.questions, ...questions],
    };
    input.save(next);
    return { state: next };
  } catch (error) {
    return {
      outcome: {
        status: "failed",
        state: latest,
        changes: [],
        gaps: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Whether a list is `before`, `after`, or on the way from one to the other. */
function isBetween(now: readonly TrackId[], before: readonly TrackId[], after: readonly TrackId[]): boolean {
  const [have, b, a] = [count(now), count(before), count(after)];
  return [...new Set([...have.keys(), ...b.keys(), ...a.keys()])].every((id) => {
    const [n, x, y] = [have.get(id) ?? 0, b.get(id) ?? 0, a.get(id) ?? 0];
    return n >= Math.min(x, y) && n <= Math.max(x, y);
  });
}

// ---- State ------------------------------------------------------------------

function settled(state: LinkState, now: Date): LinkState {
  return { ...state, conflicts: [], questions: [], lastSyncAt: now.toISOString() };
}

function conflicted(input: Pick<SyncInput, "now"> & { save?: SyncInput["save"] }, state: LinkState, conflicts: Conflict[]): SyncOutcome {
  const next: LinkState = { ...state, conflicts, lastSyncAt: input.now.toISOString() };
  input.save?.(next);
  return { status: "conflict", state: next, changes: [], gaps: [] };
}

function stillAsked(answers: LinkState["answers"], questions: readonly Question[]): LinkState["answers"] {
  const keys = new Set(questions.map((question) => question.key));
  return Object.fromEntries(Object.entries(answers).filter(([key]) => keys.has(key)));
}

function gapsOf(base: SyncBase, changes: readonly ReturnType<typeof findChanges>[]): SyncOutcome["gaps"] {
  const tracks = new Map(changes.flatMap((change) => change.entries.map((track) => [track.id, track] as const)));
  return base.songs.flatMap((song) =>
    Object.entries(song.gaps ?? {}).map(([service, gap]) => {
      const id = Object.values(song.ids)[0]!;
      return { service: service as ServiceName, gap, song: refOf(tracks.get(id) ?? { id, title: id }) };
    }),
  );
}
