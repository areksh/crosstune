/**
 * The accounts that are connected: signing in and out of each service, one
 * account per service, and what the Accounts page shows.
 *
 * Each service has a {@link Connector} that knows its sign-in; this decides
 * what may be connected. The account's id is kept after signing out (until it
 * is forgotten), because jobs, links and history hold that account's ids: to
 * sign in as somebody else, the first account must be forgotten.
 */

import { labelOf, ServiceError } from "../services/errors.js";
import type { ServiceHub } from "../services/hub.js";
import type { ServiceName, UserId } from "../services/ids.js";
import type { MusicService } from "../services/service.js";
import { SignInError, SignIns } from "./sign-in.js";

export interface AccountRecord {
  id: UserId;
  displayName: string;
  /** When it was first connected (ms). */
  since: number;
}

export interface AccountStore {
  account(service: ServiceName): AccountRecord | undefined;
  saveAccount(service: ServiceName, record: AccountRecord): void;
  removeAccount(service: ServiceName): void;
  /** The id of the app the user registered with a service. */
  clientId(service: ServiceName): string | undefined;
  saveClientId(service: ServiceName, clientId: string): void;
}

/** One service's way of signing in. */
export interface Connector {
  readonly service: ServiceName;
  readonly needsClientId: boolean;
  /** The address to register with the service, where the user must. */
  readonly redirectUri?: string;
  /** The service's page to open. */
  startUrl(request: { state: string; challenge: string }): Promise<string>;
  /** Trade the code; the sign-in is kept only when `keep` is called. */
  finish(signIn: { code: string; verifier: string }): Promise<{ music: MusicService; keep(): void }>;
  /** The saved sign-in, or undefined when there is none. */
  resume(): Promise<MusicService | undefined>;
  /** Drop the saved sign-in. */
  signOut(): void;
  /** When the saved sign-in ends for good (ms), where that is known. */
  endsAt?(): number | undefined;
}

export type AccountStatus =
  | "connected"
  | "signed-out"
  | "needs-client-id"
  /** The service no longer accepts the sign-in. */
  | "expired"
  /** It could not be reached; the sign-in may be fine. */
  | "unreachable";

export interface AccountView {
  service: ServiceName;
  label: string;
  status: AccountStatus;
  displayName?: string;
  plan?: string;
  /** Who was signed in, when nobody is now. */
  knownAs?: string;
  problem?: string;
  /** The kind of error behind it. */
  problemKind?: string;
  needsClientId: boolean;
  clientId?: string;
  redirectUri?: string;
  endsAt?: number;
  endsSoon: boolean;
}

export interface AccountsOptions {
  hub: ServiceHub;
  store: AccountStore;
  connectors: readonly Connector[];
  /** Puts a service through the history recorder. */
  wrap(service: MusicService): MusicService;
  /** Called when what is connected changes. */
  onChange(service: ServiceName): void;
  now?: () => number;
}

const WARN_MS = 14 * 24 * 60 * 60 * 1000;
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export class Accounts {
  readonly #options: AccountsOptions;
  readonly #connectors: Map<ServiceName, Connector>;
  readonly #signIns: SignIns;
  readonly #problems = new Map<ServiceName, { status: "expired" | "unreachable"; message: string; kind?: string }>();
  readonly #now: () => number;

  constructor(options: AccountsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#connectors = new Map(options.connectors.map((connector) => [connector.service, connector]));
    this.#signIns = new SignIns({ now: this.#now });
  }

  /** Connect what is saved. Each service on its own: one failing leaves the rest. */
  async resume(): Promise<void> {
    await Promise.all([...this.#connectors.keys()].map((service) => this.resumeOne(service)));
  }

  async resumeOne(service: ServiceName): Promise<void> {
    try {
      const music = await this.#connector(service).resume();
      if (music === undefined) {
        return;
      }
      this.#accept(music);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected = error instanceof ServiceError && error.kind === "authentication";
      this.#problems.set(service, {
        status: rejected ? "expired" : "unreachable",
        message,
        ...(error instanceof ServiceError && { kind: error.kind }),
      });
      this.#options.hub.disconnect(service);
    }
  }

  setClientId(service: ServiceName, clientId: string): void {
    const trimmed = clientId.trim();
    if (!CLIENT_ID.test(trimmed)) {
      throw new SignInError(`That does not look like a ${labelOf(service)} client id.`);
    }
    this.#options.store.saveClientId(service, trimmed);
  }

  /** Begin a sign-in; open the address in the browser. */
  async start(service: ServiceName): Promise<{ url: string }> {
    const connector = this.#connector(service);
    if (connector.needsClientId && this.#options.store.clientId(service) === undefined) {
      throw new SignInError(`Enter the client id of your ${labelOf(service)} app first.`);
    }
    return { url: await connector.startUrl(this.#signIns.start(service)) };
  }

  waiting(service: ServiceName): boolean {
    return this.#signIns.waiting(service);
  }

  /**
   * End a sign-in with the address the browser came back on.
   *
   * A refusal is a {@link SignInError}, not an authentication ServiceError:
   * those mean a connected account stopped working, and a sign-in that failed
   * says nothing about the account that may be connected.
   */
  async complete(target: string): Promise<{ service: ServiceName; displayName: string }> {
    const { service, code, verifier } = this.#signIns.complete(target);
    const label = labelOf(service);
    const { music, keep } = await this.#connector(service)
      .finish({ code, verifier })
      .catch((error: unknown) => {
        throw refused(error, `${label} did not accept that sign-in (a pasted address may be cut short). Start it again.`);
      });
    try {
      return { service, displayName: this.#accept(music, keep) };
    } catch (error) {
      throw refused(error, error instanceof Error ? error.message : String(error));
    }
  }

  /** Drop the sign-in; who it was is remembered. */
  signOut(service: ServiceName): void {
    this.#connector(service).signOut();
    this.#problems.delete(service);
    this.#options.hub.disconnect(service);
    this.#options.onChange(service);
  }

  /** Drop the sign-in and the account. Its other data is the caller's to remove. */
  forget(service: ServiceName): void {
    this.signOut(service);
    this.#options.store.removeAccount(service);
  }

  /** The service stopped accepting the sign-in while connected. */
  rejected(service: ServiceName, message: string): void {
    this.#problems.set(service, { status: "expired", message });
    this.#options.hub.disconnect(service);
    this.#options.onChange(service);
  }

  view(): AccountView[] {
    return [...this.#connectors.values()].map((connector) => this.#viewOf(connector));
  }

  #viewOf(connector: Connector): AccountView {
    const { service, needsClientId } = connector;
    const { hub, store } = this.#options;
    const clientId = store.clientId(service);
    const known = store.account(service);
    const problem = this.#problems.get(service);
    const account = hub.connected().includes(service) ? hub.service(service).account() : undefined;
    const endsAt = account === undefined ? undefined : connector.endsAt?.();
    const status: AccountStatus =
      account !== undefined
        ? "connected"
        : (problem?.status ?? (needsClientId && clientId === undefined ? "needs-client-id" : "signed-out"));
    return {
      service,
      label: labelOf(service),
      status,
      needsClientId,
      endsSoon: endsAt !== undefined && endsAt - this.#now() < WARN_MS,
      ...(account !== undefined && { displayName: account.displayName }),
      ...(account?.plan !== undefined && account.plan.length > 0 && { plan: account.plan }),
      ...(account === undefined && known !== undefined && { knownAs: known.displayName }),
      ...(account === undefined && problem !== undefined && { problem: problem.message }),
      ...(account === undefined && problem?.kind !== undefined && { problemKind: problem.kind }),
      ...(needsClientId && clientId !== undefined && { clientId }),
      ...(connector.redirectUri !== undefined && { redirectUri: connector.redirectUri }),
      ...(endsAt !== undefined && { endsAt }),
    };
  }

  /** Connect a signed-in service, if it is the account known here. */
  #accept(music: MusicService, keep: () => void = () => {}): string {
    const { hub, store, wrap, onChange } = this.#options;
    const service = music.name;
    const account = music.account();
    if (account === undefined) {
      throw new ServiceError(service, "authentication", `${labelOf(service)} did not say who signed in`);
    }
    const known = store.account(service);
    if (known !== undefined && known.id !== account.id) {
      throw new ServiceError(
        service,
        "authentication",
        `crosstune knows ${known.displayName} on ${labelOf(service)}, and this is ${account.displayName}. Forget the first account to use another.`,
      );
    }
    keep();
    store.saveAccount(service, {
      id: account.id,
      displayName: account.displayName,
      since: known?.since ?? this.#now(),
    });
    this.#problems.delete(service);
    hub.connect(wrap(music));
    onChange(service);
    return account.displayName;
  }

  #connector(service: ServiceName): Connector {
    const connector = this.#connectors.get(service);
    if (connector === undefined) {
      throw new SignInError(`${labelOf(service)} cannot be connected here.`);
    }
    return connector;
  }
}

/** An authentication failure during a sign-in, told as a sign-in error. */
function refused(error: unknown, message: string): unknown {
  return error instanceof ServiceError && error.kind === "authentication" ? new SignInError(message) : error;
}
