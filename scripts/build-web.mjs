/**
 * Build the web UI frontend into `dist/web`.
 *
 * esbuild bundles the TypeScript entry point into a single ES module with no
 * runtime dependencies; the static HTML and CSS, and the self-hosted fonts with
 * their licence, are copied alongside it. This runs as part of `npm run build`,
 * after `tsc` compiles the server and CLI.
 */

import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";

const outDir = "dist/web";

await build({
  entryPoints: ["src/web/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  outfile: `${outDir}/main.js`,
});

mkdirSync(outDir, { recursive: true });
copyFileSync("src/web/index.html", `${outDir}/index.html`);
copyFileSync("src/web/styles.css", `${outDir}/styles.css`);
cpSync("src/web/fonts", `${outDir}/fonts`, { recursive: true });

console.log(`Built web UI into ${outDir}`);
