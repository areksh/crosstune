/**
 * The music service the page is on -- or all of them -- which every request
 * names, and the server works there. Remembered in this browser. Views load
 * their lists once, so choosing another loads the page afresh.
 */

import { isServiceName, type ServiceName } from "../services/names.js";

const STORAGE_KEY = "crosstune:service";

/** A service, or every connected one at once. */
export type Choice = ServiceName | "all";

export function chosenService(): Choice | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isServiceName(value) || value === "all" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the choice; undefined for the first that is connected. */
export function rememberService(choice: Choice | undefined): void {
  try {
    if (choice === undefined) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // Storage unavailable: the server's default is used.
  }
}

let connected: readonly ServiceName[] = [];

/** The services that are connected, once the page has asked. */
export function connectedServices(): readonly ServiceName[] {
  return connected;
}

export function setConnectedServices(services: readonly ServiceName[]): void {
  connected = services;
}
