import { describe, expect, it, vi } from "vitest";

import { resolveCredentials, type Prompters } from "./credentials.js";

function prompters(overrides: Partial<Prompters> = {}): Prompters {
  return {
    promptLine: vi.fn(async () => "typed-email@example.com"),
    promptHidden: vi.fn(async () => "typed-password"),
    ...overrides,
  };
}

describe("resolveCredentials", () => {
  it("uses environment variables when both are present", async () => {
    const p = prompters();
    const creds = await resolveCredentials(
      { QOBUZ_EMAIL: "env@example.com", QOBUZ_PASSWORD: "env-pw" },
      p,
    );
    expect(creds).toEqual({ email: "env@example.com", password: "env-pw" });
    expect(p.promptLine).not.toHaveBeenCalled();
    expect(p.promptHidden).not.toHaveBeenCalled();
  });

  it("prompts for whichever value the environment does not supply", async () => {
    const p = prompters();
    const creds = await resolveCredentials({ QOBUZ_EMAIL: "env@example.com" }, p);
    expect(creds.email).toBe("env@example.com");
    expect(creds.password).toBe("typed-password");
    expect(p.promptHidden).toHaveBeenCalledOnce();
    expect(p.promptLine).not.toHaveBeenCalled();
  });

  it("trims the email but preserves the password verbatim", async () => {
    const creds = await resolveCredentials(
      { QOBUZ_EMAIL: "  spaced@example.com  ", QOBUZ_PASSWORD: "  pw$ pace  " },
      prompters(),
    );
    expect(creds.email).toBe("spaced@example.com");
    expect(creds.password).toBe("  pw$ pace  ");
  });

  it("throws when a resolved value is empty", async () => {
    const p = prompters({ promptHidden: vi.fn(async () => "") });
    await expect(
      resolveCredentials({ QOBUZ_EMAIL: "env@example.com" }, p),
    ).rejects.toThrow(/password/i);
  });
});
