// Smoke-tests the packed tarball the way a user gets it: `npm pack`, unpack it
// into a scratch app, then check the CLI runs, `serve` answers /healthz and the
// documented `import ... from "screencheck/capture"` type-checks.
// Run after `npm run build`. Dependencies resolve from this repo's node_modules.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(ROOT, ".smoke");
const APP = path.join(SCRATCH, "app");
const PKG_DIR = path.join(APP, "node_modules", "screencheck");
const HOME = path.join(SCRATCH, "home");
const { version } = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const windows = process.platform === "win32";

function step(label) {
  console.log(`smoke: ${label}`);
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
mkdirSync(HOME, { recursive: true });

step("npm pack");
const packed = JSON.parse(
  execFileSync(
    windows ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", SCRATCH],
    { cwd: ROOT, encoding: "utf8", shell: windows },
  ),
);
const tarball = path.join(SCRATCH, packed[0].filename);
execFileSync("tar", ["-xzf", tarball, "-C", PKG_DIR, "--strip-components=1"], {
  cwd: SCRATCH,
});

const cli = path.join(PKG_DIR, "dist", "cli.js");
const env = { ...process.env, HOME, USERPROFILE: HOME };

step("screencheck --version");
const printed = execFileSync(process.execPath, [cli, "--version"], {
  env,
  encoding: "utf8",
}).trim();
if (!printed.includes(version)) {
  throw new Error(`--version printed "${printed}", expected ${version}`);
}

step("screencheck serve answers /healthz");
const port = 4400 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [cli, "serve", "--port", String(port)], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  let healthy = false;
  for (let attempt = 0; attempt < 50 && !healthy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      healthy = response.ok && (await response.json()).ok === true;
    } catch {
      // Not listening yet.
    }
  }
  if (!healthy) throw new Error(`/healthz never answered on port ${port}`);
} finally {
  server.kill();
}

step('tsc on import { captureFullPage } from "screencheck/capture"');
writeFileSync(
  path.join(APP, "package.json"),
  JSON.stringify({ name: "smoke-app", private: true, type: "module" }),
);
writeFileSync(
  path.join(APP, "index.ts"),
  'import { captureFullPage } from "screencheck/capture";\n' +
    "export const capture: typeof captureFullPage = captureFullPage;\n",
);
writeFileSync(
  path.join(APP, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "ES2022",
      strict: true,
      noEmit: true,
      types: [],
    },
    files: ["index.ts"],
  }),
);
execFileSync(
  process.execPath,
  [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", APP],
  { stdio: "inherit" },
);

rmSync(SCRATCH, { recursive: true, force: true });
step("ok");
