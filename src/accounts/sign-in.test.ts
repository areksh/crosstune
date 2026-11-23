import { describe, expect, it } from "vitest";

import { SIGN_IN_MINUTES, SignIns } from "./sign-in.js";

function signIns() {
  let now = 0;
  const it = new SignIns({ now: () => now });
  return { signIns: it, later: (minutes: number) => (now += minutes * 60_000) };
}

const back = (service: string, query: string) => `/callback/${service}?${query}`;

describe("SignIns", () => {
  it("gives a state and challenge, and trades the redirect for the code and verifier", () => {
    const { signIns: s } = signIns();
    const { state, challenge } = s.start("spotify");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const done = s.complete(back("spotify", `code=abc&state=${state}`));
    expect(done).toMatchObject({ service: "spotify", code: "abc" });
    expect(done.verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(challenge).not.toBe(done.verifier);
  });

  it("works once", () => {
    const { signIns: s } = signIns();
    const { state } = s.start("tidal");
    s.complete(back("tidal", `code=a&state=${state}`));
    expect(() => s.complete(back("tidal", `code=a&state=${state}`))).toThrow(/not expected/);
  });

  it.each([
    ["a wrong state", (state: string) => `code=a&state=${state}x`],
    ["no state", () => "code=a"],
    ["an empty state", () => "code=a&state="],
  ])("refuses %s, and the right one still works after", (_what, query) => {
    const { signIns: s } = signIns();
    const { state } = s.start("tidal");
    expect(() => s.complete(back("tidal", query(state)))).toThrow(/not expected/);
    expect(s.complete(back("tidal", `code=b&state=${state}`)).code).toBe("b");
  });

  it("refuses one service's state at another's address", () => {
    const { signIns: s } = signIns();
    const { state } = s.start("tidal");
    s.start("spotify");
    expect(() => s.complete(back("spotify", `code=a&state=${state}`))).toThrow(/not expected/);
  });

  it("expires", () => {
    const { signIns: s, later } = signIns();
    const { state } = s.start("tidal");
    later(SIGN_IN_MINUTES + 1);
    expect(() => s.complete(back("tidal", `code=a&state=${state}`))).toThrow(/took too long/);
    expect(s.waiting("tidal")).toBe(false);
  });

  it("keeps only the newest sign-in to a service", () => {
    const { signIns: s } = signIns();
    const first = s.start("tidal");
    const second = s.start("tidal");
    expect(() => s.complete(back("tidal", `code=a&state=${first.state}`))).toThrow(/not expected/);
    expect(s.complete(back("tidal", `code=a&state=${second.state}`)).code).toBe("a");
  });

  it("says when the user declined, and ends the sign-in", () => {
    const { signIns: s } = signIns();
    const { state } = s.start("spotify");
    expect(() => s.complete(back("spotify", `error=access_denied&state=${state}`))).toThrow(/declined/);
    expect(s.waiting("spotify")).toBe(false);
  });

  it("does not end a sign-in on an error without its state", () => {
    const { signIns: s } = signIns();
    s.start("spotify");
    expect(() => s.complete(back("spotify", "error=access_denied"))).toThrow(/not expected/);
    expect(s.waiting("spotify")).toBe(true);
  });

  it("takes a pasted address, whatever host it names", () => {
    const { signIns: s } = signIns();
    const { state } = s.start("tidal");
    expect(s.complete(`http://127.0.0.1:53683/callback/tidal?code=abc&state=${state}`).code).toBe("abc");
  });

  it.each(["", "hello", "http://127.0.0.1:53683/", "/callback/nope?code=a", "/favicon.ico", "http://["])(
    "refuses %j",
    (target) => {
      const { signIns: s } = signIns();
      s.start("tidal");
      expect(() => s.complete(target)).toThrow();
      expect(s.waiting("tidal")).toBe(true);
    },
  );

  it("never repeats a code in its errors", () => {
    const { signIns: s } = signIns();
    s.start("tidal");
    expect(() => s.complete(back("tidal", "code=secretcode&state=bad"))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secretcode") }),
    );
  });

  describe("Qobuz, which carries no state", () => {
    it("takes the code its redirect calls code_autorisation", () => {
      const { signIns: s } = signIns();
      s.start("qobuz");
      expect(s.complete("/callback/qobuz?code_autorisation=q1")).toMatchObject({ service: "qobuz", code: "q1" });
    });

    it("is taken only while a Qobuz sign-in is waiting, and once", () => {
      const { signIns: s } = signIns();
      expect(() => s.complete("/callback/qobuz?code_autorisation=q1")).toThrow(/not expected/);
      s.start("qobuz");
      s.complete("/callback/qobuz?code_autorisation=q1");
      expect(() => s.complete("/callback/qobuz?code_autorisation=q1")).toThrow(/not expected/);
    });

    it("is never taken for another service", () => {
      const { signIns: s } = signIns();
      s.start("tidal");
      expect(() => s.complete("/callback/tidal?code_autorisation=q1")).toThrow(/not expected/);
    });
  });
});
