/**
 * What a tool that works on one music service says about it. The service tabs
 * only filter the library, so a stand-alone tool (Playlist from artists,
 * Deduplicator...) names the service it reads and writes, and offers the
 * others; choosing one makes it the page's service.
 */

import { SERVICE_LABELS, type ServiceName } from "../services/names.js";

export interface WorkingNotice {
  text: string;
  /** The services the page can switch to. */
  switchTo: ServiceName[];
}

/**
 * @param chosen the remembered service (or "all"), as stored
 * @param worksOnAll whether the view shown can show every service at once
 */
export function workingNotice(
  chosen: string | undefined,
  connected: readonly ServiceName[],
  worksOnAll: boolean,
): WorkingNotice | undefined {
  if (worksOnAll || connected.length < 2) {
    return undefined;
  }
  if (chosen === "all") {
    return { text: "This works on one music service at a time.", switchTo: [...connected] };
  }
  const on = connected.find((service) => service === chosen) ?? connected[0]!;
  return { text: `This works on ${SERVICE_LABELS[on]}.`, switchTo: connected.filter((service) => service !== on) };
}
