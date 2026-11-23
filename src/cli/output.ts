/**
 * Machine-readable command output (the global `--json` option).
 *
 * In JSON mode a command does not print its report; it records the plan or
 * result it produced, field by field, into one document that is written to
 * stdout once the command has finished -- exactly one JSON document per run --
 * while every log line (progress included) goes to stderr. So
 * `qobuz-helper --json deduplicate --favourites > report.json` captures only
 * the JSON. In text mode recording is a no-op and the logger works as usual.
 *
 * The document always starts with `"command"`, then the fields in the order a
 * command first set them, so its keys are stable from run to run.
 */

import type { LoggerSinks } from "./logger.js";

export interface ExtractedJsonFlag {
  json: boolean;
  /** The arguments with every `--json` removed. */
  rest: string[];
}

/**
 * Pull the global `--json` flag out of an argument list. Like `--loglevel` it
 * may appear anywhere, before or after the command, so it is stripped before
 * per-command parsing.
 */
export function extractJsonFlag(argv: readonly string[]): ExtractedJsonFlag {
  const rest = argv.filter((arg) => arg !== "--json");
  return { json: rest.length !== argv.length, rest };
}

/** Serialise a value as one pretty-printed JSON document, ending in a newline. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, jsonReplacer, 2)}\n`;
}

/**
 * Maps become plain objects and Sets arrays (JSON.stringify would write `{}`),
 * and Qobuz's ids are written as Qobuz has them, as they were before ids
 * carried their service: {@link legacyId}.
 */
function jsonReplacer(key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [typeof k === "string" ? legacyId("", k) : k, v]));
  }
  if (value instanceof Set) {
    return [...value];
  }
  if (key === "albumIds" && Array.isArray(value)) {
    return value.map((id) => (typeof id === "string" ? String(legacyId("albumId", id)) : id));
  }
  return typeof value === "string" ? legacyId(key, value) : value;
}

const QOBUZ_ID = /^qobuz:([a-z0-9]+)$/i;

/**
 * A Qobuz id as scripts know it; any other text unchanged. Qobuz's ids are
 * numbers except an album's, which is text: alphanumeric, or a barcode of 12
 * digits or more -- longer than any of its numbers.
 */
function legacyId(key: string, text: string): string | number {
  const native = QOBUZ_ID.exec(text)?.[1];
  if (native === undefined) {
    return text;
  }
  return key !== "albumId" && /^[1-9]\d{0,10}$/.test(native) ? Number(native) : native;
}

/**
 * A deep copy of `value` without the named keys, at any depth (for leaving
 * bulky internals, such as track id lists, out of a document).
 */
export function omitKeys(value: unknown, keys: readonly string[]): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) =>
      keys.includes(key) ? undefined : jsonReplacer(key, inner),
    ),
  );
}

/** One command's machine-readable output. */
export interface CommandOutput {
  /** Whether `--json` is on. */
  readonly json: boolean;
  /** Record a field of the document (a later value replaces an earlier one). */
  set(key: string, value: unknown): void;
  /** Record every field of `fields`, as {@link set} would. */
  assign(fields: Record<string, unknown>): void;
  /** Write the document, once; later calls (and text mode) write nothing. */
  flush(): void;
}

/** Create the output for `command`, writing the document with `write`. */
export function createOutput(
  json: boolean,
  command: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): CommandOutput {
  const document = new Map<string, unknown>([["command", command]]);
  let flushed = false;
  const set = (key: string, value: unknown): void => {
    document.set(key, value);
  };
  return {
    json,
    set,
    assign: (fields) => {
      for (const [key, value] of Object.entries(fields)) {
        set(key, value);
      }
    },
    flush: () => {
      if (!json || flushed) {
        return;
      }
      flushed = true;
      write(toJson(Object.fromEntries(document)));
    },
  };
}

/**
 * The logger's sinks for a run: unchanged in text mode; in JSON mode normal
 * running detail is sent to stderr too, keeping stdout for the document.
 */
export function logSinksFor(json: boolean, streams: LoggerSinks): LoggerSinks {
  return json ? { out: streams.err, err: streams.err } : streams;
}
