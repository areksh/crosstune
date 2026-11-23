/** Notices above every view: what needs the user's attention until it is settled. */

import type { AccountView } from "../accounts/accounts.js";
import { attentionLines, type LinkAttention } from "../sync/wording.js";
import { el } from "./dom.js";

export interface Notice {
  text: string;
  link?: { href: string; text: string };
  /** Drawn as a problem rather than a reminder. */
  urgent?: boolean;
}

export function showNotices(notices: readonly Notice[]): void {
  const box = el("notices");
  box.textContent = "";
  for (const notice of notices) {
    const line = document.createElement("p");
    line.className = notice.urgent === true ? "notice urgent" : "notice";
    line.append(notice.text);
    if (notice.link !== undefined) {
      const link = document.createElement("a");
      link.href = notice.link.href;
      link.textContent = notice.link.text;
      line.append(" ", link);
    }
    box.appendChild(line);
  }
  box.hidden = notices.length === 0;
}

const ACCOUNTS = { href: "#/accounts", text: "Open Accounts" };

/** What the accounts need. */
export function accountNotices(accounts: readonly AccountView[]): Notice[] {
  if (!accounts.some((account) => account.status === "connected")) {
    const broken = accounts.find((account) => account.status === "expired" || account.status === "unreachable");
    if (broken === undefined) {
      return [{ text: "No music service is connected yet.", link: ACCOUNTS }];
    }
  }
  return accounts.flatMap((account): Notice[] => {
    switch (account.status) {
      case "expired":
        return [{ text: `${account.label} needs you to sign in again.`, link: ACCOUNTS, urgent: true }];
      case "unreachable":
        return [{ text: `${account.label} could not be reached.`, link: ACCOUNTS }];
      case "connected":
        return account.endsSoon ? [{ text: `Your ${account.label} sign-in ends soon.`, link: ACCOUNTS }] : [];
      default:
        return [];
    }
  });
}

const MANAGED = { href: "#/managed", text: "Open Managed playlists" };

/** What the linked playlists need: conflicts loudly, waiting questions less. */
export function linkNotices(attention: LinkAttention): Notice[] {
  return attentionLines(attention).map((line) => ({ text: line.text, link: MANAGED, urgent: line.urgent }));
}
