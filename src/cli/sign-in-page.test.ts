import { describe, expect, it } from "vitest";

import { signInPage } from "./sign-in-page.js";

describe("signInPage", () => {
  it("says it worked, or why not", () => {
    expect(signInPage({ ok: true, message: "TIDAL is connected as Arek." })).toContain("TIDAL is connected as Arek.");
    expect(signInPage({ ok: false, message: "It was declined." })).toContain("It was declined.");
  });

  it("escapes what it shows", () => {
    const page = signInPage({ ok: false, message: `<script>alert("x")</script> & 'y'` });
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;");
  });

  it("loads and runs nothing", () => {
    const page = signInPage({ ok: true, message: "x" });
    expect(page).not.toMatch(/<script|src=|href=|@import|url\(/);
  });
});
