/**
 * Accounts view: connecting each music service, and what is connected.
 *
 * A sign-in opens the service's page in another tab; its redirect goes to this
 * computer's sign-in listener, and this view asks the server until the service
 * is connected. Where the redirect cannot come back (another machine, the port
 * taken), the address it ended on is pasted instead. No code or token reaches
 * this page except in an address the user pastes.
 */

import type { AccountView } from "../../accounts/accounts.js";
import type { ServiceName } from "../../services/names.js";
import { api } from "../api.js";
import { openDialog } from "../dialog.js";
import { el, showError } from "../dom.js";
import { chosenService, rememberService } from "../service.js";
import { SETUP } from "./account-setup.js";
import { parseRoute } from "../../ui/routes.js";

const POLL_MS = 1500;

let accounts: AccountView[] = [];
/** Services whose sign-in was started here and has not come back. */
const waiting = new Map<ServiceName, { listening: boolean; problem?: string; url: string }>();
let polling = false;

/** Wire up the accounts view. Call once on load. */
/** Whether the page shows Settings, where the accounts are. */
function onSettings(): boolean {
  return parseRoute(location.hash).kind === "settings";
}

export function initAccountsView(): void {
  window.addEventListener("hashchange", () => {
    if (onSettings()) {
      void load();
    }
  });
  if (onSettings()) {
    void load();
  }
}

async function load(): Promise<void> {
  try {
    ({ accounts } = await api<{ accounts: AccountView[] }>("GET", "/api/accounts"));
    showError(el("accounts-error"), undefined);
    render();
  } catch (error) {
    showError(el("accounts-error"), message(error));
  }
}

function render(): void {
  const list = el("accounts-list");
  // Keep what is being typed: only the cards that changed are drawn again.
  for (const account of accounts) {
    const id = `account-${account.service}`;
    const key = JSON.stringify([account, waiting.get(account.service)]);
    const old = document.getElementById(id);
    if (old?.dataset["key"] === key) {
      continue;
    }
    const card = cardOf(account);
    card.id = id;
    card.dataset["key"] = key;
    if (old === null) {
      list.appendChild(card);
    } else {
      old.replaceWith(card);
    }
  }
}

const STATUS: Record<AccountView["status"], string> = {
  connected: "Connected",
  "signed-out": "Not connected",
  "needs-client-id": "Not set up",
  expired: "Sign-in expired",
  unreachable: "Cannot be reached",
};

function cardOf(account: AccountView): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel account";
  const heading = document.createElement("h2");
  heading.id = `account-name-${account.service}`;
  heading.textContent = account.label;
  card.setAttribute("aria-labelledby", heading.id);
  const status = text("span", STATUS[account.status], `account-status is-${account.status}`);
  const head = document.createElement("div");
  head.className = "account-head";
  head.append(heading, status);
  card.appendChild(head);

  if (account.status === "connected") {
    card.append(...connectedPart(account));
  } else {
    card.append(...signInPart(account));
  }
  const error = text("p", "", "error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  card.appendChild(error);
  return card;
}

function connectedPart(account: AccountView): HTMLElement[] {
  const plan = account.plan === undefined ? "" : ` (${account.plan})`;
  const parts = [text("p", `Signed in as ${account.displayName ?? "you"}${plan}.`)];
  if (account.endsAt !== undefined) {
    const date = new Date(account.endsAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    parts.push(
      text("p", `${account.label} ends this sign-in on ${date}; sign in again ${account.endsSoon ? "now" : "by then"} to keep managed playlists running.`, account.endsSoon ? "account-soon" : "hint"),
    );
  }
  const buttons = [
    ...(account.endsSoon ? [button("Sign in again", () => start(account))] : []),
    button("Sign out", () => act(account, "sign-out"), "secondary"),
    button("Disconnect and forget...", () => forget(account), "secondary"),
  ];
  return [...parts, row(buttons)];
}

function signInPart(account: AccountView): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (account.problem !== undefined) {
    parts.push(text("p", account.problem, "account-problem"));
  }
  if (account.needsClientId) {
    parts.push(setupPart(account));
  }
  const started = waiting.get(account.service);
  if (started !== undefined) {
    parts.push(pastePart(account, started));
  }
  const buttons: HTMLElement[] = [];
  if (account.status === "unreachable") {
    buttons.push(button("Try again", () => act(account, "retry")));
  }
  if (account.status !== "needs-client-id") {
    const label = started !== undefined ? "Start again" : account.knownAs !== undefined ? `Sign in as ${account.knownAs}` : `Connect ${account.label}`;
    buttons.push(button(label, () => start(account), account.status === "unreachable" || started !== undefined ? "secondary" : ""));
  }
  if (account.knownAs !== undefined) {
    buttons.push(button("Disconnect and forget...", () => forget(account), "secondary"));
  }
  if (buttons.length > 0) {
    parts.push(row(buttons));
  }
  return parts;
}

/** Registering an app with the service, and its client id. */
function setupPart(account: AccountView): HTMLElement {
  const setup = SETUP[account.service];
  const details = document.createElement("details");
  details.className = "account-setup";
  details.open = account.clientId === undefined;
  details.appendChild(text("summary", account.clientId === undefined ? `Set up ${account.label}` : `${account.label} app`));
  if (setup !== undefined) {
    details.appendChild(text("p", setup.why, "hint"));
    const steps = document.createElement("ol");
    for (const step of setup.steps) {
      const item = document.createElement("li");
      for (const part of step) {
        if (typeof part === "string") {
          item.append(part);
        } else if ("href" in part) {
          const link = document.createElement("a");
          link.href = part.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = part.text;
          item.appendChild(link);
        } else {
          item.appendChild(text("code", part.code === "REDIRECT" ? (account.redirectUri ?? "") : part.code));
        }
      }
      steps.appendChild(item);
    }
    details.appendChild(steps);
  }
  const field = document.createElement("label");
  field.className = "field";
  const input = document.createElement("input");
  input.type = "text";
  input.value = account.clientId ?? "";
  input.autocomplete = "off";
  input.spellcheck = false;
  field.append(text("span", "Client ID"), input);
  const save = button("Save client ID", () => act(account, "client-id", { clientId: input.value }), account.clientId === undefined ? "" : "secondary");
  details.append(field, row([save]));
  return details;
}

function pastePart(account: AccountView, started: { listening: boolean; problem?: string; url: string }): HTMLElement {
  const box = document.createElement("div");
  box.className = "account-waiting";
  const line = text("p", started.listening ? `Finish signing in to ${account.label} in the other tab. This page follows by itself.` : (started.problem ?? ""));
  line.setAttribute("role", "status");
  const again = document.createElement("a");
  again.href = started.url;
  again.target = "_blank";
  again.rel = "noopener noreferrer";
  again.textContent = "Open the sign-in page";
  const field = document.createElement("label");
  field.className = "field";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  field.append(text("span", "If the tab ends on a page that does not load, paste its address"), input);
  const go = button("Use this address", async () => {
    await api("POST", "/api/accounts/paste", { address: input.value });
    await connected(account.service);
  }, "secondary");
  box.append(line, again, field, row([go]));
  return box;
}

async function start(account: AccountView): Promise<void> {
  // Opened before asking, or the browser blocks it as a pop-up.
  const tab = window.open("about:blank", "_blank");
  try {
    const answer = await api<{ url: string; listening: boolean; problem?: string }>("POST", "/api/accounts/start", {
      service: account.service,
    });
    waiting.set(account.service, answer);
    if (tab !== null) {
      tab.opener = null;
      tab.location.href = answer.url;
    }
    render();
    void poll();
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Ask until every sign-in started here has come back. */
async function poll(): Promise<void> {
  if (polling) {
    return;
  }
  polling = true;
  try {
    while (waiting.size > 0 && onSettings()) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      await load();
      for (const account of accounts) {
        if (waiting.has(account.service) && account.status === "connected" && !account.endsSoon) {
          await connected(account.service);
          return;
        }
      }
    }
  } finally {
    polling = false;
  }
}

/** A service was connected: the rest of the page is loaded for it afresh. */
async function connected(service: ServiceName): Promise<void> {
  waiting.delete(service);
  if (chosenService() === undefined) {
    rememberService(service);
  }
  location.reload();
}

async function act(account: AccountView, action: "sign-out" | "retry" | "client-id" | "forget", extra: object = {}): Promise<void> {
  await api("POST", `/api/accounts/${action}`, { service: account.service, ...extra });
  if (action === "client-id") {
    await load();
    return;
  }
  if (action !== "retry" && chosenService() === account.service) {
    rememberService(undefined);
  }
  location.reload();
}

async function forget(account: AccountView): Promise<void> {
  const sure = await openDialog({
    title: `Disconnect and forget ${account.label}?`,
    body: [
      `This signs out and deletes what crosstune keeps about ${account.label} on this computer: its matches, the managed and linked playlists that use it, and its entries in History, which can then no longer be undone.`,
      `Your music and playlists on ${account.label} are not touched.`,
    ],
    confirm: "Disconnect and forget",
    danger: true,
  });
  if (sure) {
    await act(account, "forget");
  }
}

// ---- Small parts ------------------------------------------------------------

function text(tag: string, content: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className !== "") {
    node.className = className;
  }
  return node;
}

function row(children: HTMLElement[]): HTMLElement {
  const node = document.createElement("div");
  node.className = "account-actions";
  node.append(...children);
  return node;
}

/** A button whose failure is shown in its card. */
function button(label: string, onClick: () => Promise<void>, className = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", () => {
    const error = node.closest(".account")?.querySelector<HTMLElement>(":scope > .error");
    node.disabled = true;
    onClick()
      .then(() => undefined, message)
      .then((problem) => {
        node.disabled = false;
        if (error !== null && error !== undefined) {
          showError(error, problem);
        }
      });
  });
  return node;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
