// The real service adapters over the saved sign-ins, every request logged (never a token).
// For checking an adapter against the live API without the server or the UI:
//
//   import { open } from "./live.mts";
//   const { music, client } = await open("spotify");   // also "tidal"; open("qobuz") gives { music }
//   console.log(await music.searchTracks("Portishead Roads", 3));
//
// Run the script with `npx tsx <file>.mts` from the repo root. Requests are logged to
// $TMPDIR/qobuz-helper-live-<service>.jsonl (method, path, status, rate-limit headers, body start).
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = new URL("../../../src/", import.meta.url).pathname;
const from = (path: string) => import(join(SRC, path));

export function loggingFetch(service: string): typeof fetch {
  const log = join(tmpdir(), `qobuz-helper-live-${service}.jsonl`);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const response = await fetch(input, init);
    const text = await response.clone().text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (/retry-after|ratelimit/i.test(name)) headers[name] = value;
    });
    const secret = /token|authorize|login|oauth/i.test(url.pathname);
    appendFileSync(
      log,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: init?.method ?? "GET",
        path: secret ? url.pathname : url.pathname + url.search.replace(/([?&]request_(?:sig|ts)=)[^&]*/g, "$1-"),
        status: response.status,
        headers,
        sent: secret || typeof init?.body !== "string" ? undefined : init.body.slice(0, 2000),
        body: secret ? "(not logged)" : text.slice(0, 6000),
      })}\n`,
    );
    return response;
  };
}

export async function open(service: "tidal" | "spotify" | "qobuz") {
  if (service === "qobuz") {
    const { qobuzConnector } = await from("cli/qobuz-connector.ts");
    const { fileCredentialStore } = await from("cli/init.ts");
    const { fileTokenStore } = await from("cli/session.ts");
    const { QobuzClient } = await from("services/qobuz/index.ts");
    const music = await qobuzConnector({
      newClient: () => new QobuzClient({ fetchImpl: loggingFetch("qobuz") }),
      credentials: fileCredentialStore(),
      tokens: fileTokenStore(),
      port: 53683,
    }).resume();
    if (music === undefined) throw new Error("qobuz: not signed in (run: npm run dev -- login)");
    return { music, client: undefined };
  }
  const { oauthConnector } = await from("accounts/oauth-connector.ts");
  const { fileAccountStore, fileTokenVault, removeTokens } = await from("cli/account-store.ts");
  const config = await from(`services/${service}/oauth-config.ts`);
  const { [service === "tidal" ? "TidalClient" : "SpotifyClient"]: Client } = await from(`services/${service}/client.ts`);
  const { [service === "tidal" ? "TidalService" : "SpotifyService"]: Service } = await from(`services/${service}/service.ts`);
  const upper = service.toUpperCase();
  const store = fileAccountStore();
  const fetchImpl = loggingFetch(service);
  let client: any;
  const music = await oauthConnector({
    service,
    authorizeUrl: config[`${upper}_AUTHORIZE_URL`],
    tokenUrl: config[`${upper}_TOKEN_URL`],
    scopes: config[`${upper}_SCOPES`],
    redirectUri: `http://127.0.0.1:53683/callback/${service}`,
    clientId: () => store.clientId(service),
    vault: fileTokenVault(service),
    dropTokens: () => removeTokens(service),
    fetchImpl,
    load: async (tokens: unknown) => {
      client = new Client({ tokens, fetchImpl });
      const loaded = new Service(client);
      await loaded.load();
      return loaded;
    },
  }).resume();
  if (music === undefined) throw new Error(`${service}: not signed in (run: npm run dev -- login ${service})`);
  return { music, client };
}
