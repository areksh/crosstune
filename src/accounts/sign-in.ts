/**
 * Sign-ins in progress: from opening a service's page until its redirect comes
 * back, to the listener or pasted by hand.
 *
 * A redirect is taken only if it carries the `state` of a sign-in started here,
 * for that service, not used before and not too old -- so a page that sends the
 * browser to the listener cannot connect an account of its own. Qobuz's flow
 * carries no state; its redirect is taken only while a Qobuz sign-in waits.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { labelOf } from "../services/errors.js";
import { isServiceName, type ServiceName } from "../services/names.js";
import { newPkce } from "../services/oauth.js";

/** How long a sign-in may take. */
export const SIGN_IN_MINUTES = 10;

/** A sign-in that did not work; the message is for the user. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

interface Waiting {
  state: string;
  verifier: string;
  startedAt: number;
}

export interface CompletedSignIn {
  service: ServiceName;
  code: string;
  verifier: string;
}

export class SignIns {
  readonly #waiting = new Map<ServiceName, Waiting>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Begin a sign-in; an earlier one to the same service no longer counts. */
  start(service: ServiceName): { state: string; challenge: string } {
    const { verifier, challenge } = newPkce();
    const state = randomBytes(32).toString("base64url");
    this.#waiting.set(service, { state, verifier, startedAt: this.#now() });
    return { state, challenge };
  }

  waiting(service: ServiceName): boolean {
    const waiting = this.#waiting.get(service);
    return waiting !== undefined && !this.#expired(waiting);
  }

  /**
   * End a sign-in with the address the service sent the browser to (a request
   * target, or a whole address pasted by the user).
   *
   * @throws {SignInError} if it belongs to no sign-in that is waiting.
   */
  complete(target: string): CompletedSignIn {
    const url = parse(target);
    const service = url === undefined ? undefined : serviceAt(url);
    if (url === undefined || !isServiceName(service)) {
      throw new SignInError("That is not the address a sign-in ends on.");
    }
    const params = url.searchParams;
    const waiting = this.#waiting.get(service);
    if (waiting === undefined || !this.#belongs(service, waiting, params)) {
      throw new SignInError(`This ${labelOf(service)} sign-in was not expected. Start it again.`);
    }
    if (this.#expired(waiting)) {
      this.#waiting.delete(service);
      throw new SignInError(`The ${labelOf(service)} sign-in took too long. Start it again.`);
    }
    this.#waiting.delete(service);
    const code = codeOf(service, params);
    if (code === undefined) {
      throw new SignInError(`${labelOf(service)} says the sign-in was declined.`);
    }
    return { service, code, verifier: waiting.verifier };
  }

  #belongs(service: ServiceName, waiting: Waiting, params: URLSearchParams): boolean {
    if (service === "qobuz") {
      return codeOf(service, params) !== undefined;
    }
    const given = Buffer.from(params.get("state") ?? "");
    const wanted = Buffer.from(waiting.state);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  #expired(waiting: Waiting): boolean {
    return this.#now() - waiting.startedAt > SIGN_IN_MINUTES * 60_000;
  }
}

/** The service an address is for. Qobuz is sent to the bare address. */
function serviceAt(url: URL): string | undefined {
  return url.pathname === "/" && url.searchParams.has("code_autorisation")
    ? "qobuz"
    : /^\/callback\/([a-z]+)$/.exec(url.pathname)?.[1];
}

function codeOf(service: ServiceName, params: URLSearchParams): string | undefined {
  const code = service === "qobuz" ? (params.get("code_autorisation") ?? params.get("code")) : params.get("code");
  return code === null || code === "" ? undefined : code;
}

function parse(target: string): URL | undefined {
  try {
    return new URL(target.trim(), "http://127.0.0.1");
  } catch {
    return undefined;
  }
}
