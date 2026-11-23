/**
 * The music service the page is on: every request names it, and the server
 * carries the request out there. Remembered in this browser. Views load their
 * lists once, so choosing another service loads the page afresh.
 */

import { isServiceName, type ServiceName } from "../services/names.js";

const STORAGE_KEY = "qobuz-helper:service";

export function chosenService(): ServiceName | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isServiceName(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the choice; undefined for the first that is connected. */
export function rememberService(service: ServiceName | undefined): void {
  try {
    if (service === undefined) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, service);
    }
  } catch {
    // Storage unavailable: the server's default is used.
  }
}
