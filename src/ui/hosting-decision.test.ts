import { describe, expect, it } from "vitest";
import { hostingDecision } from "./hosting-decision.js";

const base = { connected: ["qobuz", "tidal"] as const, hash: "#/p/1/repeats" };

describe("hostingDecision", () => {
  it("shows a tool on the page's service, filling it the first time", () => {
    expect(hostingDecision({ ...base, target: "qobuz", remembered: "qobuz" })).toEqual({ kind: "show", fill: true });
  });

  it("does not fill again when coming back to the same address", () => {
    expect(hostingDecision({ ...base, target: "qobuz", remembered: "qobuz", lastHere: "#/p/1/repeats" })).toEqual({
      kind: "show",
      fill: false,
    });
  });

  it("switches to the tool's service when the page is on another, or on all", () => {
    expect(hostingDecision({ ...base, target: "tidal", remembered: "qobuz" })).toEqual({ kind: "switch", to: "tidal" });
    expect(hostingDecision({ ...base, target: "qobuz", remembered: "all" })).toEqual({ kind: "switch", to: "qobuz" });
  });

  it("takes an unremembered page to be on the first connected service", () => {
    expect(hostingDecision({ ...base, target: "qobuz" })).toEqual({ kind: "show", fill: true });
    expect(hostingDecision({ ...base, target: "tidal" })).toEqual({ kind: "switch", to: "tidal" });
  });

  it("never switches to a service that is not connected", () => {
    expect(hostingDecision({ ...base, target: "spotify", remembered: "qobuz" })).toEqual({
      kind: "not-connected",
      service: "spotify",
    });
    expect(hostingDecision({ connected: [], hash: "#/p/1/repeats", target: "qobuz" })).toEqual({
      kind: "not-connected",
      service: "qobuz",
    });
  });

  it("loads afresh for another source of the same tool", () => {
    expect(hostingDecision({ ...base, target: "qobuz", remembered: "qobuz", lastHere: "#/p/2/repeats" })).toEqual({
      kind: "fresh",
    });
  });

  it("leaves the page's service alone when the tool names none", () => {
    expect(hostingDecision({ ...base, remembered: "all" })).toEqual({ kind: "show", fill: true });
  });
});
