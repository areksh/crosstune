import { describe, expect, it } from "vitest";

import { scheduleSnippet } from "./schedule-print.js";

const paths = { node: "/usr/bin/node", script: "/opt/qh/dist/cli.js", logFile: "/home/me/.config/qobuz-helper/run-due.log" };

describe("scheduleSnippet", () => {
  it.each([
    ["cron", "*/15 * * * *"],
    ["systemd", "OnCalendar=*:0/15"],
    ["launchd", "<integer>900</integer>"],
    ["windows", "/MO 15"],
  ] as const)("calls run-due every 15 minutes for %s", (target, cadence) => {
    const text = scheduleSnippet(target, paths);
    expect(text).toContain(paths.node);
    expect(text).toContain(paths.script);
    expect(text).toContain("run-due");
    expect(text).toContain(cadence);
  });

  it("catches up after sleep on systemd", () => {
    expect(scheduleSnippet("systemd", paths)).toContain("Persistent=true");
  });
});
