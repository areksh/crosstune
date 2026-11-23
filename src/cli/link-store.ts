/** Linked playlists on disk: `links.json` and `links-state/<id>.json`, owner-only. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { emptyLinkState, type LinkState } from "../sync/model.js";
import { parseLinksFile, type Link } from "../sync/runner.js";
import { configDir } from "./config-dir.js";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function writeAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function fileLinkStore(dir: string = configDir()) {
  const path = join(dir, "links.json");
  const read = () => {
    const text = readText(path);
    if (text === undefined) {
      return { raw: [] as unknown[], parsed: { links: [] as Link[], invalid: [] } };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it`);
    }
    return { raw: (raw as { links?: unknown[] }).links ?? [], parsed: parseLinksFile(raw) };
  };
  return {
    load: () => read().parsed,
    save: (links: Link[]) => {
      // Never overwrite what cannot be read; keep invalid links for a hand fix.
      const { raw, parsed } = read();
      writeAtomically(path, { version: 1, links: [...links, ...parsed.invalid.map(({ index }) => raw[index])] });
    },
  };
}

export function fileLinkStateStore(dir: string = configDir()) {
  const pathOf = (id: string): string => {
    if (!/^[0-9a-f]{8}$/.test(id)) {
      throw new Error(`invalid link id ${id}`);
    }
    return join(dir, "links-state", `${id}.json`);
  };
  return {
    load: (id: string): LinkState => {
      const text = readText(pathOf(id));
      if (text === undefined) {
        return emptyLinkState();
      }
      // A state that cannot be read must not be taken as a first link: that
      // would compare the copies afresh and could undo the user's removals.
      const value = JSON.parse(text) as LinkState;
      if (typeof value !== "object" || value === null || !Array.isArray(value.conflicts)) {
        throw new Error(`${pathOf(id)} cannot be read; fix or remove it`);
      }
      return { ...emptyLinkState(), ...value };
    },
    save: (id: string, state: LinkState) => writeAtomically(pathOf(id), state),
    remove: (id: string) => rmSync(pathOf(id), { force: true }),
  };
}
