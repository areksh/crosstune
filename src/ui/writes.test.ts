import { describe, expect, it } from "vitest";
import { WRITE_ROUTES } from "../server/router.js";
import { isWriteRequest } from "./writes.js";

describe("isWriteRequest", () => {
  it("knows every route the server records as a change", () => {
    for (const path of Object.keys(WRITE_ROUTES)) {
      expect(isWriteRequest("POST", path), path).toBe(true);
    }
  });

  it("counts undo, and changes to jobs and links", () => {
    expect(isWriteRequest("POST", "/api/history/undo")).toBe(true);
    expect(isWriteRequest("POST", "/api/jobs")).toBe(true);
    expect(isWriteRequest("DELETE", "/api/links/3")).toBe(true);
  });

  it("does not count reads, previews and plans", () => {
    expect(isWriteRequest("GET", "/api/manager/playlists")).toBe(false);
    expect(isWriteRequest("POST", "/api/upgrade/resolve")).toBe(false);
    expect(isWriteRequest("POST", "/api/deduplicate/scan")).toBe(false);
    expect(isWriteRequest("POST", "/api/manager/open")).toBe(false);
    expect(isWriteRequest("POST", "/api/history/plan")).toBe(false);
    expect(isWriteRequest("GET", "/api/jobs")).toBe(false);
  });
});
