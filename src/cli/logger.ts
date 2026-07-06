/**
 * Levelled logging for the CLI.
 *
 * A tiny, dependency-free logger with the usual severity ladder. The active
 * level (chosen with `--loglevel`, default `info`) acts as a threshold: a
 * message is emitted only when its severity is at or above the active level.
 * Normal running detail (`info`, `debug`) is written to stdout; problems
 * (`warn`, `error`) to stderr, so diagnostics stay separable from output when
 * redirecting streams.
 *
 * The sinks are injectable so the logger can be unit-tested without capturing
 * the real process streams.
 */

/** Log levels, quietest first. The chosen level is the verbosity threshold. */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface Logger {
  /** The active threshold. */
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/** Where formatted log lines are written (defaults: the real stdout/stderr). */
export interface LoggerSinks {
  /** Normal running detail (info, debug). */
  out(line: string): void;
  /** Problems (warn, error). */
  err(line: string): void;
}

type MessageLevel = Exclude<LogLevel, "silent">;

/** Severity of each message level; higher is more verbose. */
const SEVERITY: Record<MessageLevel, number> = {
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Line prefix per level; info/error stay unprefixed to read as plain output. */
const PREFIX: Record<MessageLevel, string> = {
  error: "",
  warn: "warning: ",
  info: "",
  debug: "debug: ",
};

/**
 * Parse a `--loglevel` value into a {@link LogLevel}.
 *
 * @throws {Error} if the value is not one of {@link LOG_LEVELS}.
 */
export function parseLogLevel(value: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  throw new Error(
    `--loglevel must be one of: ${LOG_LEVELS.join(", ")} (got "${value}")`,
  );
}

const defaultSinks: LoggerSinks = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Create a logger emitting messages at or above `level` to the given sinks. */
export function createLogger(
  level: LogLevel,
  sinks: Partial<LoggerSinks> = {},
): Logger {
  const out = sinks.out ?? defaultSinks.out;
  const err = sinks.err ?? defaultSinks.err;
  const threshold = level === "silent" ? 0 : SEVERITY[level];

  const emit = (
    messageLevel: MessageLevel,
    stream: (line: string) => void,
    message: string,
  ): void => {
    if (threshold >= SEVERITY[messageLevel]) {
      stream(`${PREFIX[messageLevel]}${message}`);
    }
  };

  return {
    level,
    error: (message) => emit("error", err, message),
    warn: (message) => emit("warn", err, message),
    info: (message) => emit("info", out, message),
    debug: (message) => emit("debug", out, message),
  };
}
