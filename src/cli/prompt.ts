/**
 * Terminal prompts.
 *
 * The visible prompt uses `node:readline`; the hidden (password) prompt reads
 * stdin in raw mode and echoes nothing, which is more robust than trying to
 * suppress readline's own echo. These are thin TTY wrappers and are not
 * unit-tested; the resolution logic that uses them is tested against injected
 * fakes (see credentials.test.ts).
 */

import * as readline from "node:readline";

import type { Prompters } from "./credentials.js";

// Control-character codes handled while reading a hidden line in raw mode.
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const DELETE = 127;

/** A set of prompt functions bound to the process TTY. */
export interface TerminalPrompter extends Prompters {
  close(): void;
}

/** Create a terminal prompter bound to stdin/stdout. */
export function createTerminalPrompter(): TerminalPrompter {
  return {
    promptLine(question: string): Promise<string> {
      return new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },

    promptHidden(question: string): Promise<string> {
      return readHidden(question);
    },

    close(): void {
      // Each prompt owns and releases its own resources; nothing to close.
    },
  };
}

/**
 * Read a line without echoing it. Uses raw mode on a TTY so no characters reach
 * the screen; on a non-TTY (piped) stdin, falls back to a plain line read since
 * there is nothing to mask.
 */
function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin });
      process.stdout.write(question);
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = (result: string): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        if (code === LINE_FEED || code === CARRIAGE_RETURN || code === CTRL_D) {
          finish(value);
          return;
        }
        if (code === CTRL_C) {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (code === BACKSPACE || code === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Keep printable input; ignore other control characters.
        if (code >= 32) {
          value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}
