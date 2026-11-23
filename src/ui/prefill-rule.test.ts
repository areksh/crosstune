import { describe, expect, it } from "vitest";
import { prefillFate } from "./prefill-rule.js";

describe("prefillFate", () => {
  it("applies a fill made for this address when its view shows", () => {
    expect(prefillFate({ view: "playlist", hash: "#/new/artists" }, "playlist", "#/new/artists")).toBe("apply");
  });

  it("drops a fill made for another address (the user stayed, then went elsewhere)", () => {
    expect(prefillFate({ view: "playlist", hash: "#/new/artists" }, "home", "#/")).toBe("drop");
    expect(prefillFate({ view: "playlist", hash: "#/new/artists" }, "playlist", "#/p/1")).toBe("drop");
  });

  it("keeps a fill with no address for its view, as before", () => {
    expect(prefillFate({ view: "managed" }, "home", "#/")).toBe("keep");
    expect(prefillFate({ view: "managed" }, "managed", "#/jobs")).toBe("apply");
  });
});
