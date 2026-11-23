/**
 * Requests to the TIDAL API (JSON:API, https://openapi.tidal.com/v2): the
 * token, waiting when asked to, retrying what is safe to retry, and paging.
 *
 * It knows nothing of music; ./service.ts asks and ./models.ts reads the
 * answers. The HTTP boundary (`fetch`) and the waiting (`sleep`) are injectable
 * so tests touch neither the network nor the clock.
 */

import { randomUUID } from "node:crypto";

import { ServiceError } from "../errors.js";
import type { TokenSource } from "../tokens.js";

const BASE_URL = "https://openapi.tidal.com/v2";
const MEDIA_TYPE = "application/vnd.api+json";

/** A request TIDAL has not answered by then has failed. */
const TIMEOUT_MS = 60_000;

/** How often to ask again after a 429, and the longest wait that is worth it. */
const MAX_LIMITED = 4;
const MAX_WAIT_SECONDS = 60;

/** How often to ask again when TIDAL fails (5xx, or still working on it). */
const MAX_FAILED = 2;
const FAILED_BASE_MS = 500;

/** The debug logging the client needs (satisfied structurally by the CLI logger). */
export interface RequestLogger {
  debug(message: string): void;
}

export interface TidalClientOptions {
  tokens: TokenSource;
  /** HTTP implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Sleep for the given number of milliseconds; injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** One `debug` line per request: method, path and status, never a query or a token. */
  logger?: RequestLogger;
}

/** Query parameters; a list is sent comma-separated, an absent one left out. */
export type Query = Record<string, string | readonly string[] | undefined>;

/**
 * A path with every id in it encoded: route`/playlists/${id}`.
 *
 * @throws {ServiceError} kind `bad-id` for an id that cannot be part of a path.
 */
export function route(strings: TemplateStringsArray, ...ids: string[]): string {
  return strings.reduce((path, text, i) => path + (i === 0 ? "" : segment(ids[i - 1]!)) + text, "");
}

function segment(id: string): string {
  // "." and ".." would be resolved away, whether encoded or not.
  if (!/^\.{0,2}$/.test(id)) {
    try {
      return encodeURIComponent(id);
    } catch {
      // Half of a surrogate pair.
    }
  }
  throw new ServiceError("tidal", "bad-id", `not a TIDAL id: ${JSON.stringify(id)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class TidalClient {
  readonly #tokens: TokenSource;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: RequestLogger;
  /** Set while TIDAL has asked us to wait; every request waits for it. */
  #pause: Promise<unknown> | undefined;

  constructor(options: TidalClientOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#logger = options.logger ?? { debug: () => {} };
  }

  async get(path: string, query: Query = {}): Promise<unknown> {
    return this.#request("GET", path, query);
  }

  /** A write; its answer, or undefined when that is empty. */
  async send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    return this.#request(method, path, {}, body);
  }

  /**
   * A list's documents, page by page.
   *
   * The document says to follow `links.next` until it is absent; only its
   * cursor is used (it is also `links.meta.nextCursor`), on this same path and
   * query, so the token never goes to an address an answer names.
   *
   * @throws {ServiceError} if a page cannot be found: a part is never passed
   *   off as the whole.
   */
  async *pages(path: string, query: Query = {}, from?: string): AsyncGenerator<unknown> {
    const seen = new Set<string>();
    let cursor = from;
    do {
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new ServiceError("tidal", "api-response", "TIDAL gave the same page of a list twice");
        }
        seen.add(cursor);
      }
      const document = await this.get(path, { ...query, "page[cursor]": cursor });
      yield document;
      cursor = nextCursor(document);
    } while (cursor !== undefined);
  }

  async #request(method: string, path: string, query: Query, body?: unknown): Promise<unknown> {
    const url = new URL(BASE_URL + path);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, typeof value === "string" ? value : value.join(","));
      }
    }
    // The same key on every try, so that a write repeated is made once.
    const key = method === "GET" ? undefined : randomUUID();
    let token = await this.#tokens.accessToken();
    let renewed = false;
    let limited = 0;
    let failed = 0;
    for (;;) {
      while (this.#pause !== undefined) {
        await this.#pause;
      }
      const { response, text } = await this.#fetchOnce(method, path, url, {
        Authorization: `Bearer ${token}`,
        Accept: MEDIA_TYPE,
        ...(body !== undefined && { "Content-Type": MEDIA_TYPE }),
        ...(key !== undefined && { "Idempotency-Key": key }),
      }, body);
      const { status } = response;

      if (response.ok) {
        return read(text, method, path);
      }
      if (status === 401 && !renewed) {
        renewed = true;
        token = await this.#tokens.renewedToken(token);
        continue;
      }
      if (status === 429) {
        const asked = retryAfter(response);
        if (limited < MAX_LIMITED && (asked ?? 0) <= MAX_WAIT_SECONDS) {
          this.#wait((asked ?? 2 ** limited) * 1000);
          limited += 1;
          continue;
        }
        throw new ServiceError("tidal", "rate-limited", "TIDAL is getting too many requests; try again later", {
          ...(asked !== undefined && { retryAfterSeconds: asked }),
        });
      }
      const code = errorCode(text);
      if ((status >= 500 || code === "IDEMPOTENT_REQUEST_IN_PROGRESS") && failed < MAX_FAILED) {
        await this.#sleep(FAILED_BASE_MS * 2 ** failed);
        failed += 1;
        continue;
      }
      throw refusal(status, code, method, path);
    }
  }

  /** One try; TIDAL not answering, or breaking off, is a network error. */
  async #fetchOnce(
    method: string,
    path: string,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ response: Response; text: string }> {
    try {
      const response = await this.#fetch(url.toString(), {
        method,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      this.#logger.debug(`${method} ${path} -> ${response.status}`);
      return { response, text: await response.text() };
    } catch (cause) {
      throw new ServiceError("tidal", "network", "TIDAL could not be reached", { cause });
    }
  }

  /** Hold every request back for a while (and for any wait already going on). */
  #wait(ms: number): void {
    const pause: Promise<unknown> = Promise.all([this.#pause, this.#sleep(ms)]).finally(() => {
      if (this.#pause === pause) {
        this.#pause = undefined;
      }
    });
    this.#pause = pause;
  }
}

function read(text: string, method: string, path: string): unknown {
  if (text.length === 0 && method !== "GET") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (method !== "GET") {
      // Done all the same; whoever needs the answer will miss it.
      return undefined;
    }
    throw new ServiceError("tidal", "api-response", `TIDAL's answer could not be read (${method} ${path})`);
  }
}

function refusal(status: number, code: string | undefined, method: string, path: string): ServiceError {
  const what = `${method} ${path}`;
  if (status === 401) {
    return new ServiceError("tidal", "authentication", "TIDAL did not accept the sign-in; connect TIDAL again");
  }
  if (status === 403) {
    return new ServiceError("tidal", "forbidden", `TIDAL did not allow this: your app lacks access to it (${what})`);
  }
  if (status === 404) {
    return new ServiceError("tidal", "not-found", `TIDAL has no such thing (${what})`);
  }
  if (code === "TOO_MANY_ITEMS_IN_PLAYLIST") {
    return new ServiceError("tidal", "playlist-full", "TIDAL says the playlist is full");
  }
  const detail = code === undefined ? "" : `, ${code}`;
  return new ServiceError("tidal", "api-response", `TIDAL answered HTTP ${status}${detail} (${what})`);
}

/** The code of an error document. Its text is not used: it may repeat a query. */
function errorCode(text: string): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const errors = isRecord(document) ? document["errors"] : undefined;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const code = isRecord(first) ? first["code"] : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,60}$/.test(code) ? code : undefined;
}

/** Seconds to wait, from a header that gives them or a date. */
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("Retry-After")?.trim();
  if (header === undefined || header.length === 0) {
    return undefined;
  }
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}

/**
 * The cursor of the page after this one; undefined on the last.
 *
 * @throws {ServiceError} if there is a next page but its cursor cannot be read.
 */
export function nextCursor(document: unknown): string | undefined {
  const links = isRecord(document) ? document["links"] : undefined;
  const next = isRecord(links) ? links["next"] : undefined;
  if (next === undefined || next === null || next === "") {
    return undefined;
  }
  const meta = isRecord(links) ? links["meta"] : undefined;
  const given = isRecord(meta) ? meta["nextCursor"] : undefined;
  const href = typeof next === "string" ? next : isRecord(next) ? next["href"] : undefined;
  const cursor =
    typeof given === "string" && given.length > 0
      ? given
      : typeof href === "string"
        ? new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("page[cursor]")
        : null;
  if (cursor === null || cursor.length === 0) {
    throw new ServiceError("tidal", "api-response", "TIDAL's list goes on, but not in a way that can be followed");
  }
  return cursor;
}
