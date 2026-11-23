/**
 * Remembered matches on disk: `matches.json` in the config directory,
 * owner-only, ids only. Read at each use, as the web server, a scheduled run
 * and a command may each remember some.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MatchMemory } from "../features/match.js";
import { parseId, type TrackId } from "../services/ids.js";
import { isServiceName, type ServiceName } from "../services/names.js";
import { configDir } from "./config-dir.js";

type Matches = Partial<Record<ServiceName, Record<string, TrackId | null>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fileMatches(dir: string = configDir()): MatchMemory {
  const path = join(dir, "matches.json");

  /** The file as last read: asked about each song of a long list. */
  let cached: { stamp: string; matches: Matches } | undefined;

  const load = (): Matches => {
    let raw: unknown;
    let stamp: string;
    try {
      const { mtimeMs, size, ino } = statSync(path);
      stamp = `${mtimeMs} ${size} ${ino}`;
      if (cached?.stamp === stamp) {
        return cached.matches;
      }
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new Error(`${path} cannot be read; fix or remove it`, { cause: error });
    }
    const out: Matches = {};
    for (const [to, list] of Object.entries(isRecord(raw) && isRecord(raw["matches"]) ? raw["matches"] : {})) {
      if (!isServiceName(to) || !isRecord(list)) {
        continue;
      }
      const kept: Record<string, TrackId | null> = {};
      for (const [source, match] of Object.entries(list)) {
        const fits = match === null || (typeof match === "string" && parseId(match)?.service === to);
        if (parseId(source) !== undefined && fits) {
          kept[source] = match as TrackId | null;
        }
      }
      out[to] = kept;
    }
    cached = { stamp, matches: out };
    return out;
  };

  const update = (change: (matches: Matches) => void): void => {
    const matches = structuredClone(load());
    change(matches);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, matches }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  };

  return {
    recall: (source, to) => {
      try {
        return load()[to]?.[source];
      } catch {
        return undefined; // unreadable: asked again, and never overwritten
      }
    },
    remember: (source, to, match) =>
      update((matches) => {
        matches[to] = { ...matches[to], [source]: match };
      }),
    forget: (source, to) =>
      update((matches) => {
        delete matches[to]?.[source];
      }),
    forgetService: (service) =>
      update((matches) => {
        delete matches[service];
        for (const list of Object.values(matches)) {
          for (const source of Object.keys(list)) {
            if (parseId(source)?.service === service) {
              delete list[source];
            }
          }
        }
      }),
  };
}
