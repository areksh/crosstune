/**
 * What to do on opening a tool hosted on a source (src/web/hosting.ts): show
 * it, load the page afresh on the tool's service, load it afresh for a new
 * source, or refuse a service that is not connected (switching to one could
 * never stick, and would reload for ever).
 */

import type { ServiceName } from "../services/names.js";

export type HostingDecision =
  /** `fill`: put the route's source in the tool (not again on coming back to it). */
  | { kind: "show"; fill: boolean }
  | { kind: "switch"; to: ServiceName }
  | { kind: "fresh" }
  | { kind: "not-connected"; service: ServiceName };

export function hostingDecision(input: {
  /** The service the tool must work on; undefined when the page's own stands. */
  target?: ServiceName;
  /** The page's remembered service (or "all"), as stored. */
  remembered?: string;
  connected: readonly ServiceName[];
  /** Where this tool was last hosted on this page load. */
  lastHere?: string;
  hash: string;
}): HostingDecision {
  const { target, remembered, connected, lastHere, hash } = input;
  if (target !== undefined) {
    if (!connected.includes(target)) {
      return { kind: "not-connected", service: target };
    }
    if (target !== (remembered ?? connected[0])) {
      return { kind: "switch", to: target };
    }
  }
  if (lastHere !== undefined && lastHere !== hash) {
    return { kind: "fresh" };
  }
  return { kind: "show", fill: lastHere === undefined };
}
