// Builds the publishable package: the client with Vite into dist/client, the
// Node entry points with esbuild into dist/, and types for screencheck/capture.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
// Run each tool's JS entry through node: node_modules/.bin holds .cmd shims on
// Windows, which execFileSync can't start without a shell.
const BINS = {
  vite: "node_modules/vite/bin/vite.js",
  tsc: "node_modules/typescript/bin/tsc",
};
const run = (tool, args) =>
  execFileSync(process.execPath, [path.join(ROOT, BINS[tool]), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });

rmSync(DIST, { recursive: true, force: true });

run("vite", ["build"]);

const entryPoints = {
  cli: "src/cli/bin.ts",
  capture: "src/capture/full-page.ts",
};
// The MCP server is optional on a branch; bundle it whenever it exists.
for (const name of ["server", "main"]) {
  const file = `src/mcp/${name}.ts`;
  if (existsSync(path.join(ROOT, file))) entryPoints[`mcp/${name}`] = file;
}

await build({
  absWorkingDir: ROOT,
  entryPoints,
  outdir: DIST,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Dependencies (zod, the MCP SDK, sharp, optional playwright, dev-only vite)
  // are resolved from node_modules at runtime, never inlined.
  packages: "external",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "info",
});
chmodSync(path.join(DIST, "cli.js"), 0o755);

run("tsc", [
  "src/capture/full-page.ts",
  "--declaration",
  "--emitDeclarationOnly",
  "--outDir",
  "dist/types",
  "--target",
  "ES2022",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  "--lib",
  "ES2022,DOM,DOM.Iterable",
  "--skipLibCheck",
]);

// Consumers on moduleResolution node16/nodenext need explicit extensions on
// relative imports inside the declarations (TS2834); the source omits them.
const TYPES = path.join(DIST, "types");
for (const entry of readdirSync(TYPES, { recursive: true })) {
  if (!entry.endsWith(".d.ts")) continue;
  const file = path.join(TYPES, entry);
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (match, open, specifier, close) =>
      /\.[cm]?js$/.test(specifier) ? match : `${open}${specifier}.js${close}`,
  );
  if (fixed !== source) writeFileSync(file, fixed);
}
