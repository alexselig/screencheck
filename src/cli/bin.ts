#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main } from "./index";

// In the package this file is dist/cli.js and the built client sits beside it
// in dist/client. From source there is none, so serve falls back to Vite.
const clientRoot = fileURLToPath(new URL("./client/", import.meta.url));

// The offline viewer for `bundle`: dist/viewer, or the repo's build when
// running from source.
const viewerRoot = [
  new URL("./viewer/", import.meta.url),
  new URL("../../dist/viewer/", import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((dir) => existsSync(`${dir}viewer.js`));

const code = await main(process.argv.slice(2), {
  ...(existsSync(`${clientRoot}index.html`) ? { clientRoot } : {}),
  ...(viewerRoot ? { viewerRoot } : {}),
});
if (code !== "running") process.exitCode = code;
