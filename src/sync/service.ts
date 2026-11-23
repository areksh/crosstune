/**
 * The linked playlists, as the web UI and the CLI manage them: create, run
 * now, settle a conflict, answer what a sync asked, pause, remove.
 */

import { randomBytes } from "node:crypto";

import type { MatchMemory } from "../features/match.js";
import { labelOf } from "../services/errors.js";
import { parseId, SERVICES, type ServiceName, type TrackId } from "../services/ids.js";
import type { RunRecord } from "../jobs/stores.js";
import { emptyLinkState, type LinkState } from "./model.js";
import { linkAsSame, resolveConflict, type SyncOutcome } from "./run.js";
import type { Choice } from "./plan.js";
import { pausedByUndo, runLinks, validateLink, type InvalidLink, type Link, type LinkConnect, type LinksSummary } from "./runner.js";

export interface LinksServiceDeps {
  links: { load(): { links: Link[]; invalid: InvalidLink[] }; save(links: Link[]): void };
  state: { load(id: string): LinkState; save(id: string, state: LinkState): void; remove(id: string): void };
  runs: { append(record: RunRecord, now?: Date): void; read(id?: string, limit?: number): RunRecord[] };
  matches: MatchMemory;
  connect: LinkConnect;
  journalRun<T>(label: string, fn: (entry: { id: string }) => Promise<T>): Promise<T>;
  /** Run `fn` holding the jobs lock (no managed playlist refresh meanwhile). */
  lock<T>(fn: () => Promise<T>): Promise<T>;
  newId?: () => string;
  now?: () => Date;
}

export interface LinkView {
  link: Link;
  state: LinkState;
  runs: RunRecord[];
}

export interface LinksService {
  list(): { links: LinkView[]; invalid: InvalidLink[] };
  create(input: unknown): Promise<{ link: Link; summary: LinksSummary }>;
  run(id: string): Promise<LinksSummary>;
  resolve(id: string, choice: Choice, dryRun: boolean): Promise<SyncOutcome>;
  /** Start a first link from what the copies have in common. */
  startFromCommon(id: string, from: ServiceName): Promise<LinksSummary>;
  answer(id: string, key: string, answer: "removed" | "withdrawn" | "keep"): Promise<LinksSummary>;
  chooseMatch(id: string, key: string, track: TrackId | null): Promise<LinksSummary>;
  setEnabled(id: string, enabled: boolean): Link;
  remove(id: string): void;
  /** A history entry was undone: pause the links it was a sync of. */
  undone(entryId: string): string[];
}

export function linksService(deps: LinksServiceDeps): LinksService {
  const now = deps.now ?? (() => new Date());
  const find = (id: string): Link => {
    const link = deps.links.load().links.find((one) => one.id === id);
    if (link === undefined) {
      throw new Error(`No link ${id}`);
    }
    return link;
  };
  const run = async (id: string): Promise<LinksSummary> => {
    find(id);
    return deps.lock(() => runLinks(deps, now(), { onlyLinkId: id }));
  };
  const clientsFor = async (link: Link) => {
    const connected = await deps.connect(SERVICES.filter((service) => link.copies[service] !== undefined));
    if (!connected.ok) {
      throw new Error(connected.message);
    }
    return connected.clients;
  };

  return {
    list: () => {
      const { links, invalid } = deps.links.load();
      return {
        links: links.map((link) => ({ link, state: deps.state.load(link.id), runs: deps.runs.read(link.id, 5) })),
        invalid,
      };
    },

    create: async (input) => {
      const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
      const link = validateLink({
        ...raw,
        id: (deps.newId ?? (() => randomBytes(4).toString("hex")))(),
        createdAt: now().toISOString(),
        schedule: raw["schedule"] ?? { every: "hour" },
      });
      const { links } = deps.links.load();
      for (const other of links) {
        for (const service of SERVICES) {
          if (link.copies[service] !== undefined && other.copies[service] === link.copies[service]) {
            throw new Error(`That ${labelOf(service)} playlist is already in the link "${other.name}".`);
          }
        }
      }
      deps.links.save([...links, link]);
      return { link, summary: await run(link.id) };
    },

    run,

    resolve: async (id, choice, dryRun) => {
      const link = find(id);
      const clients = await clientsFor(link);
      return deps.lock(() =>
        dryRun
          ? resolveConflict({ clients, copies: link.copies, state: deps.state.load(id), matches: deps.matches, now: now(), choice, dryRun, save: () => {} })
          : deps.journalRun(`Settled ${link.name}`, () =>
              resolveConflict({
                clients,
                copies: link.copies,
                state: deps.state.load(id),
                matches: deps.matches,
                now: now(),
                choice,
                save: (state) => deps.state.save(id, state),
              }),
            ),
      );
    },

    startFromCommon: async (id, from) => {
      const link = find(id);
      const clients = await clientsFor(link);
      const state = await linkAsSame({ clients, copies: link.copies, state: deps.state.load(id), matches: deps.matches, from, now: now() });
      deps.state.save(id, state);
      return run(id);
    },

    answer: async (id, key, answer) => {
      find(id);
      const state = deps.state.load(id);
      deps.state.save(id, { ...state, answers: { ...state.answers, [key]: answer } });
      return run(id);
    },

    chooseMatch: async (id, key, track) => {
      find(id);
      const question = deps.state.load(id).questions.find((one) => one.key === key);
      if (question?.kind !== "match") {
        throw new Error("That question is not waiting any more.");
      }
      if (track !== null && parseId(track)?.service !== question.on) {
        throw new Error(`Choose a song on ${labelOf(question.on)}.`);
      }
      deps.matches.remember(question.song.id, question.on, track);
      return run(id);
    },

    setEnabled: (id, enabled) => {
      const { links } = deps.links.load();
      const link = { ...find(id), enabled };
      deps.links.save(links.map((one) => (one.id === id ? link : one)));
      const state = deps.state.load(id);
      if (enabled && state.paused !== undefined) {
        // After an undo the copies may differ on purpose: look at them afresh.
        const { paused: _paused, base: _base, pending: _pending, ...rest } = state;
        deps.state.save(id, { ...emptyLinkState(), ...rest });
      }
      return link;
    },

    undone: (entryId) => pausedByUndo(deps, entryId, now()),

    remove: (id) => {
      find(id);
      deps.links.save(deps.links.load().links.filter((link) => link.id !== id));
      deps.state.remove(id);
    },
  };
}
