/**
 * Build the web UI frontend into `dist/web`.
 *
 * esbuild bundles the TypeScript entry point into a single ES module with no
 * runtime dependencies; the static HTML and CSS are copied alongside it. This
 * runs as part of `npm run build`, after `tsc` compiles the server and CLI.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

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

console.log(`Built web UI into ${outDir}`);
