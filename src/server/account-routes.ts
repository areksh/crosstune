/**
 * The accounts' routes, under `/api/accounts`: what is connected, signing in
 * and out, and forgetting a service. An answer holds no code, state or token;
 * the one exception is the address a sign-in opens, which the browser needs.
 */

import type { Accounts } from "../accounts/accounts.js";
import { SignInError } from "../accounts/sign-in.js";
import type { ServiceHub } from "../services/hub.js";
import { isServiceName, type ServiceName } from "../services/names.js";
import type { ApiRequest, ApiResponse } from "./router.js";

export interface AccountDeps {
  accounts: Accounts;
  hub: ServiceHub;
  /** Wait for a sign-in's redirect; not possible when its port is taken. */
  listen(): Promise<{ ok: true } | { ok: false; problem: string }>;
  /** Remove everything kept about a service, once it is disconnected. */
  forget(service: ServiceName): void;
}

export const ACCOUNTS_PREFIX = "/api/accounts";

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (error: string): ApiResponse => ({ status: 400, body: { error } });

export async function accountRoutes(req: ApiRequest, deps: AccountDeps): Promise<ApiResponse> {
  const { accounts } = deps;
  const route = `${req.method} ${req.path.slice(ACCOUNTS_PREFIX.length)}`;
  const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  if (route === "GET ") {
    return ok({ accounts: accounts.view() });
  }
  try {
    if (route === "POST /paste") {
      const address = body["address"];
      return typeof address === "string" ? ok(await accounts.complete(address)) : bad("address must be text");
    }
    const service = body["service"];
    if (req.method === "POST" && !isServiceName(service)) {
      return bad("service must name a music service");
    }
    const name = service as ServiceName;
    switch (route) {
      case "POST /client-id": {
        const clientId = body["clientId"];
        if (typeof clientId !== "string") {
          return bad("clientId must be text");
        }
        accounts.setClientId(name, clientId);
        return ok({ accounts: accounts.view() });
      }
      case "POST /start": {
        const { url } = await accounts.start(name);
        const listening = await deps.listen();
        return ok({ url, listening: listening.ok, ...(!listening.ok && { problem: listening.problem }) });
      }
      case "POST /retry":
        await accounts.resumeOne(name);
        return ok({ accounts: accounts.view() });
      case "POST /sign-out":
        accounts.signOut(name);
        return ok({ accounts: accounts.view() });
      case "POST /forget":
        accounts.forget(name);
        deps.forget(name);
        return ok({ accounts: accounts.view() });
      default:
        return { status: 404, body: { error: "not found" } };
    }
  } catch (error) {
    if (error instanceof SignInError) {
      return bad(error.message);
    }
    throw error;
  }
}
