import { describe, expect, it } from "vitest";

import { createLogger, parseLogLevel, type LoggerSinks } from "./logger.js";

/** A logger writing into arrays, so emitted lines can be asserted on. */
function capturing(level: Parameters<typeof createLogger>[0]) {
  const out: string[] = [];
  const err: string[] = [];
  const sinks: LoggerSinks = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { logger: createLogger(level, sinks), out, err };
}

describe("parseLogLevel", () => {
  it("accepts each valid level name", () => {
    for (const level of ["silent", "error", "warn", "info", "debug"] as const) {
      expect(parseLogLevel(level)).toBe(level);
    }
  });

  it("throws on an unknown level", () => {
    expect(() => parseLogLevel("verbose")).toThrow(/loglevel/i);
  });
});

describe("createLogger", () => {
  it("exposes the active level", () => {
    expect(createLogger("warn").level).toBe("warn");
  });

  it("routes running detail to out and problems to err", () => {
    const { logger, out, err } = capturing("debug");
    logger.info("progress");
    logger.debug("gory detail");
    logger.warn("careful");
    logger.error("boom");
    expect(out).toEqual(["progress", "debug: gory detail"]);
    expect(err).toEqual(["warning: careful", "boom"]);
  });

  it("at info, shows info and above but hides debug", () => {
    const { logger, out, err } = capturing("info");
    logger.debug("hidden");
    logger.info("shown");
    logger.warn("shown too");
    expect(out).toEqual(["shown"]);
    expect(err).toEqual(["warning: shown too"]);
  });

  it("at warn, hides info and debug", () => {
    const { logger, out, err } = capturing("warn");
    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");
    expect(out).toEqual([]);
    expect(err).toEqual(["warning: yes", "yes"]);
  });

  it("at error, shows only errors", () => {
    const { logger, out, err } = capturing("error");
    logger.warn("no");
    logger.error("yes");
    expect(out).toEqual([]);
    expect(err).toEqual(["yes"]);
  });

  it("at silent, emits nothing at all", () => {
    const { logger, out, err } = capturing("silent");
    logger.error("boom");
    logger.warn("careful");
    logger.info("progress");
    logger.debug("detail");
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});
