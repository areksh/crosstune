#!/usr/bin/env node
// Drive the qobuz-helper web UI in headless Chromium over the DevTools protocol.
// No dependencies: Node 22's fetch and WebSocket, and the system's chromium-browser.
//
//   node .claude/skills/run-qobuz-helper/driver.mjs [--url http://127.0.0.1:4567] < steps.json
//
// steps.json is an array of steps, run in order:
//   {"service": "all"|"qobuz"|"tidal"|"spotify"}  choose the music service (as the sidebar does)
//   {"nav": "#/playlists"}       go to a view (a hash, or a whole URL)
//   {"waitFor": "<js expr>"}     poll until it is true (500 ms apart; "tries", default 120)
//   {"click": "Button text"}     click the first visible button or link with exactly this text
//   {"dialog": "Write it"}       click a button in the open <dialog>
//   {"eval": "<js expr>"}        print its value (awaited, as JSON)
//   {"shot": "name"}             screenshot to $TMPDIR/qobuz-helper-shots/name.png (never in the repo:
//                                a signed-in page shows account names and emails)
//   {"sleep": 1000}
// Page exceptions and console errors are printed at the end; the exit code is 1 if a
// waitFor timed out or the page threw.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Outside the repo: a signed-in page shows account names and emails.
const SHOTS = process.env.QOBUZ_HELPER_SHOTS ?? join(tmpdir(), "qobuz-helper-shots");
const urlAt = process.argv.indexOf("--url");
const BASE = urlAt === -1 ? "http://127.0.0.1:4567" : process.argv[urlAt + 1];
const PORT = 9333 + Math.floor(Math.random() * 500);
const steps = JSON.parse(readFileSync(0, "utf8"));

mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "qobuz-helper-chromium-"));
const browser = spawn(
  "chromium-browser",
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1400,1000",
    "--no-first-run", "--no-default-browser-check", "about:blank"],
  // Its own process group: Chromium's helper processes outlive the main one.
  { stdio: "ignore", detached: true },
);
let failed = false;
// Chromium keeps writing its profile for a moment after the signal: stop the
// whole group and wait for it, or the profile cannot be removed.
const finish = async () => {
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  try {
    process.kill(-browser.pid, "SIGTERM");
  } catch {
    browser.kill();
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover profile in the temp dir is harmless.
  }
};

try {
  let page;
  for (let i = 0; i < 100 && page === undefined; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
    } catch {}
    if (page === undefined) await new Promise((r) => setTimeout(r, 200));
  }
  if (page === undefined) throw new Error("chromium-browser did not start (is it installed?)");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? `EXCEPTION ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
  };
  const go = async (where) => {
    await send("Page.navigate", { url: where.startsWith("http") ? where : `${BASE}/${where}` });
    await new Promise((r) => setTimeout(r, 1500));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await go("");

  for (const step of steps) {
    if (step.service !== undefined) {
      await evaluate(`localStorage.setItem("qobuz-helper:service", ${JSON.stringify(step.service)})`);
      await go("");
      console.log(`service: ${step.service}`);
    }
    if (step.nav !== undefined) {
      await go(step.nav);
      console.log(`nav: ${step.nav}`);
    }
    if (step.waitFor !== undefined) {
      let ok = false;
      for (let i = 0; i < (step.tries ?? 120) && !ok; i++) {
        ok = (await evaluate(step.waitFor)) === true;
        if (!ok) await new Promise((r) => setTimeout(r, 500));
      }
      console.log(`waitFor ${ok ? "ok" : "TIMED OUT"}: ${step.waitFor}`);
      failed ||= !ok;
    }
    if (step.click !== undefined || step.dialog !== undefined) {
      const scope = step.dialog !== undefined ? "dialog[open]" : "body";
      const text = step.dialog ?? step.click;
      const done = await evaluate(`(() => {
        const node = [...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} a`)})]
          .find((b) => b.innerText.trim() === ${JSON.stringify(text)} && b.offsetParent !== null);
        if (node === undefined) return false;
        node.click();
        return true;
      })()`);
      console.log(`${step.dialog !== undefined ? "dialog" : "click"} ${done ? "ok" : "NOT FOUND"}: ${text}`);
      failed ||= !done;
    }
    if (step.eval !== undefined) {
      console.log(`eval: ${JSON.stringify(await evaluate(step.eval))?.slice(0, 2000)}`);
    }
    if (step.sleep !== undefined) {
      await new Promise((r) => setTimeout(r, step.sleep));
    }
    if (step.shot !== undefined) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const file = join(SHOTS, `${step.shot}.png`);
      writeFileSync(file, Buffer.from(r.result.data, "base64"));
      console.log(`shot: ${file}`);
    }
  }
  console.log(`page errors: ${JSON.stringify(errors)}`);
  failed ||= errors.length > 0;
  ws.close();
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await finish();
}
process.exit(failed ? 1 : 0);
