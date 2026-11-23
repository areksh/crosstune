import { describe, expect, it } from "vitest";
import { workingNotice } from "./working-service.js";

describe("workingNotice", () => {
  it("names the service a one-service tool works on, offering the others", () => {
    expect(workingNotice("qobuz", ["qobuz", "tidal", "spotify"], false)).toEqual({
      text: "This works on Qobuz.",
      switchTo: ["tidal", "spotify"],
    });
  });

  it("asks for one when the page is on all of them", () => {
    expect(workingNotice("all", ["qobuz", "tidal"], false)).toEqual({
      text: "This works on one music service at a time.",
      switchTo: ["qobuz", "tidal"],
    });
  });

  it("falls back to the first connected service when the remembered one is not connected", () => {
    expect(workingNotice("spotify", ["qobuz", "tidal"], false)).toEqual({ text: "This works on Qobuz.", switchTo: ["tidal"] });
    expect(workingNotice(undefined, ["tidal", "qobuz"], false)).toEqual({ text: "This works on TIDAL.", switchTo: ["qobuz"] });
  });

  it("says nothing on views that show every service, or with one service", () => {
    expect(workingNotice("qobuz", ["qobuz", "tidal"], true)).toBeUndefined();
    expect(workingNotice("qobuz", ["qobuz"], false)).toBeUndefined();
    expect(workingNotice(undefined, [], false)).toBeUndefined();
  });
});
