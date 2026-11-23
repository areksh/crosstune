/**
 * Requests to Spotify's official Web API: tokens, pacing, retries and paging.
 *
 * A request is repeated only when that is safe: after a 401 or 429 it was not
 * carried out, and after a 5xx only a read or a `repeatable` write (one that
 * does the same twice as once) is sent again.
 */

import { ServiceError, type ServiceErrorKind } from "../errors.js";
import type { TokenSource } from "../tokens.js";
import { isRecord, number, text } from "./models.js";

export const SPOTIFY_API = "https://api.spotify.com/v1";

/** Requests open at once. Spotify counts calls per 30 seconds and publishes no number. */
export const MAX_AT_ONCE = 3;

/** The longest wait Spotify may ask for that is waited out (seconds). */
const LONGEST_WAIT_SECONDS = 10;
const MAX_WAITS = 3;
const MAX_SERVER_RETRIES = 2;
const SERVER_RETRY_MS = 500;
const MAX_PAGES = 2000;

export class SpotifyError extends ServiceError {
  /** The HTTP status, when Spotify answered. */
  readonly status?: number;

  constructor(
    kind: ServiceErrorKind | "forbidden" | "conflict" | "interrupted",
    message: string,
    options: { cause?: unknown; retryAfterSeconds?: number; status?: number } = {},
  ) {
    super("spotify", kind, message, options);
    this.name = "SpotifyError";
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** Whether a write that failed with `error` may have been carried out all the same. */
export function mayHaveHappened(error: unknown): boolean {
  return error instanceof SpotifyError && (error.kind === "network" || (error.status !== undefined && error.status >= 500));
}

/** Where debug lines go: method, path and status only, never a query, body or token. */
export interface RequestLogger {
  debug(message: string): void;
}

export interface SpotifyClientOptions {
  tokens: TokenSource;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: RequestLogger;
}

export type Query = Record<string, string | number | undefined>;

interface Send {
  query?: Query;
  body?: unknown;
  /** Sending it twice does the same as once. */
  repeatable?: boolean;
}

export interface Pages {
  /** Every item as it came, `null` included, so that positions hold. */
  items: unknown[];
  /** How many Spotify says there are. */
  total?: number;
  /** Whether a cap left some out. */
  more: boolean;
}

export class SpotifyClient {
  readonly #tokens: TokenSource;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: RequestLogger | undefined;
  #open = 0;
  readonly #queue: (() => void)[] = [];
  /** While Spotify has asked us to wait. */
  #pause: Promise<void> | undefined;

  constructor(options: SpotifyClientOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#logger = options.logger;
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.#paced("GET", path, { ...(query !== undefined && { query }), repeatable: true });
  }

  send(method: "POST" | "PUT" | "DELETE", path: string, request: Send = {}): Promise<unknown> {
    return this.#paced(method, path, request);
  }

  /** The items of a list paged by offset, up to `max`. `inside` names the field that holds the page. */
  async pages(
    path: string,
    query: Query,
    { size, max = Infinity, inside, from = 0 }: { size: number; max?: number; inside?: string; from?: number },
  ): Promise<Pages> {
    const items: unknown[] = [];
    let total: number | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = pageOf(await this.get(path, { ...query, limit: Math.min(size, max - items.length), offset: from + items.length }), inside);
      items.push(...answer.items);
      total = number(answer.page["total"]) ?? total;
      const last = text(answer.page["next"]) === undefined;
      if (last || items.length >= max) {
        return {
          items: items.slice(0, max),
          ...(total !== undefined && { total }),
          more: !last || items.length > max,
        };
      }
      if (answer.items.length === 0) {
        throw new SpotifyError("api-response", `Spotify's answer to ${path} was incomplete`);
      }
    }
    throw neverEnded(path);
  }

  /** The items of a list paged by cursor. */
  async cursorPages(path: string, query: Query, { size, inside }: { size: number; inside: string }): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    for (let after: string | undefined; ; ) {
      const answer = pageOf(await this.get(path, { ...query, limit: size, after }), inside);
      items.push(...answer.items);
      const cursors = answer.page["cursors"];
      after = isRecord(cursors) ? text(cursors["after"]) : undefined;
      if (after === undefined || text(answer.page["next"]) === undefined) {
        return items;
      }
      if (seen.has(after)) {
        throw neverEnded(path);
      }
      seen.add(after);
    }
  }

  async #paced(method: string, path: string, request: Send): Promise<unknown> {
    if (this.#open >= MAX_AT_ONCE) {
      // The request that ends hands its place on, so the count stays.
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    } else {
      this.#open += 1;
    }
    try {
      return await this.#request(method, path, request);
    } finally {
      const next = this.#queue.shift();
      if (next === undefined) {
        this.#open -= 1;
      } else {
        next();
      }
    }
  }

  async #request(method: string, path: string, request: Send): Promise<unknown> {
    let token = await this.#tokens.accessToken();
    let renewed = false;
    let waits = 0;
    let retries = 0;
    for (;;) {
      while (this.#pause !== undefined) {
        await this.#pause;
      }
      const response = await this.#once(method, path, request, token);
      if (response.ok) {
        return method === "GET" ? bodyOf(response, path) : response.json === NOT_JSON ? undefined : response.json;
      }
      const { status } = response;
      if (status === 401 && !renewed) {
        renewed = true;
        token = await this.#tokens.renewedToken(token);
        continue;
      }
      const error = isRecord(response.json) ? response.json["error"] : undefined;
      if (status === 429) {
        const { retryAfterSeconds } = response;
        const waiting = { status, ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) };
        if (isRecord(error) && error["reason"] === "QUOTA_EXCEEDED") {
          throw new SpotifyError("quota", "the Spotify app's quota is used up; try again later", waiting);
        }
        waits += 1;
        if (waits > MAX_WAITS || (retryAfterSeconds ?? 0) > LONGEST_WAIT_SECONDS) {
          throw new SpotifyError("rate-limited", "Spotify asks to wait before any more requests", waiting);
        }
        await this.#wait((retryAfterSeconds ?? waits) * 1000);
        continue;
      }
      if (status >= 500 && request.repeatable === true && retries < MAX_SERVER_RETRIES) {
        retries += 1;
        await this.#sleep(SERVER_RETRY_MS * retries);
        continue;
      }
      throw failure(status, path, isRecord(error) ? text(error["message"]) : undefined);
    }
  }

  async #once(method: string, path: string, { query, body }: Send, token: string): Promise<Answer> {
    const url = new URL(SPOTIFY_API + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    try {
      const response = await this.#fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      this.#logger?.debug(`${method} ${path} -> ${response.status}`);
      const content = await response.text();
      const seconds = Number(response.headers.get("Retry-After") ?? "x");
      return {
        ok: response.ok,
        status: response.status,
        json: parsed(content),
        ...(Number.isFinite(seconds) && { retryAfterSeconds: seconds }),
      };
    } catch (cause) {
      throw new SpotifyError("network", "Spotify could not be reached", { cause });
    }
  }

  /** Hold every request back. */
  #wait(ms: number): Promise<void> {
    this.#pause ??= this.#sleep(ms).finally(() => {
      this.#pause = undefined;
    });
    return this.#pause;
  }
}

interface Answer {
  ok: boolean;
  status: number;
  /** The body; `undefined` when empty, {@link NOT_JSON} when it is something else. */
  json: unknown;
  retryAfterSeconds?: number;
}

const NOT_JSON = Symbol("not JSON");

function parsed(content: string): unknown {
  if (content.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch {
    return NOT_JSON;
  }
}

function bodyOf({ json, status }: Answer, path: string): unknown {
  if (json === NOT_JSON) {
    throw new SpotifyError("api-response", `Spotify's answer to ${path} was not understood`, { status });
  }
  return json;
}

function failure(status: number, path: string, message: string | undefined): SpotifyError {
  switch (status) {
    case 401:
      return new SpotifyError("authentication", "Spotify did not accept the sign-in; connect Spotify again", { status });
    case 403:
      return new SpotifyError(
        "forbidden",
        "Spotify refused this: the account may not be on the app's list of users, the Premium subscription of the app's owner may have ended, or this may not be yours to see or change",
        { status },
      );
    case 404:
      return new SpotifyError("not-found", `Spotify has nothing at ${path}`, { status });
    default:
      return new SpotifyError(
        "api-response",
        `Spotify answered HTTP ${status}${status === 400 && message !== undefined ? ` (${message.slice(0, 200)})` : ""}`,
        { status },
      );
  }
}

function pageOf(answer: unknown, inside: string | undefined): { page: Record<string, unknown>; items: unknown[] } {
  const page = inside === undefined ? answer : isRecord(answer) ? answer[inside] : undefined;
  if (!isRecord(page) || !Array.isArray(page["items"])) {
    throw new SpotifyError("api-response", "Spotify's answer held no list");
  }
  return { page, items: page["items"] };
}

function neverEnded(path: string): SpotifyError {
  return new SpotifyError("api-response", `Spotify's list at ${path} never ended`);
}
