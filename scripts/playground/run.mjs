// A seeded ScreenCheck you can click around in, for trying every feature.
//
//   npm run playground            # start (or resume) on http://127.0.0.1:4299
//   npm run playground -- --reset # wipe the playground and seed it again
//
// It uses the made-up Tidewater ferry app from the project site, with two
// builds (build-41 and build-42, the latter at 390 / 768 / 1440), and keeps
// its own data in
// ~/.screencheck-playground. Your real ~/.screencheck is never touched.
// The walkthrough is docs/PLAYGROUND.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { captureFullPage } from "../../src/capture/full-page.ts";
import { captureThumbnails } from "../../src/capture/thumbnail.ts";
import {
  BUILDS,
  PROJECT,
  PROJECT_NAME,
  REGISTERED_SCREENS,
} from "./project.mjs";
import {
  APPROVED,
  EXTRA_SIZES,
  SEED,
  SIZE_APPROVED,
  SIZE_SEED,
  VERSIONS,
} from "./scenario.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PORT = Number(process.env.PLAYGROUND_PORT ?? 4299);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOME =
  process.env.PLAYGROUND_HOME ??
  path.join(homedir(), ".screencheck-playground");
const reset = process.argv.includes("--reset");
const noOpen = process.argv.includes("--no-open");

// The demo app is desktop-only; this lets its narrow captures reflow.
const NARROW_CSS = `
.top { padding: 0 16px; gap: 16px; } .top nav { display: none; }
main { padding: 24px 16px; }
.g2, .side { grid-template-columns: 1fr; }
.sail { grid-template-columns: 72px 1fr; }
.hero { height: auto; padding: 24px; } .hero h1 { font-size: 28px; }
.steps { flex-wrap: wrap; }`;

// Every capture to render: build-41 and build-42 at 1440, plus build-42's
// extra sizes as versions of the same revision.
function captureVersions() {
  const list = [];
  for (const [version, screens] of Object.entries(VERSIONS)) {
    for (const width of EXTRA_SIZES[version] ?? []) {
      list.push({
        id: `${version}-${width}`,
        revision: version,
        width,
        screens,
      });
    }
    list.push({ id: version, revision: version, width: 1440, screens });
  }
  return list;
}

// Screen index thumbnails in the server's cache layout (src/server/thumbnails
// writes the same files; plain node can't import it): thumbs/<project>/
// <version>/<screen>-<w>.<type> with a sidecar naming the capture it fits.
async function storeThumbnails(
  thumbsRoot,
  version,
  screenId,
  captureFile,
  images,
) {
  const info = await stat(captureFile);
  const source = `${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}`;
  const dir = path.join(thumbsRoot, PROJECT, version);
  await mkdir(dir, { recursive: true });
  for (const [width, bytes] of Object.entries(images)) {
    const riff = bytes[0] === 0x52 && bytes[8] === 0x57;
    const type = riff ? "webp" : "png";
    await writeFile(path.join(dir, `${screenId}-${width}.${type}`), bytes);
    await writeFile(
      path.join(dir, `${screenId}-${width}.json`),
      `${JSON.stringify({ source, type })}\n`,
    );
  }
}

async function renderCaptures(browser, captureRoot, thumbsRoot) {
  for (const { id, width, screens } of captureVersions()) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await mkdir(path.join(captureRoot, id), { recursive: true });
    for (const screen of screens) {
      await page.setContent(screen.html);
      if (width < 1024) await page.addStyleTag({ content: NARROW_CSS });
      const file = path.join(captureRoot, id, `${screen.id}.png`);
      await captureFullPage(page, { path: file, elements: true });
      const images = await captureThumbnails(page);
      if (images)
        await storeThumbnails(thumbsRoot, id, screen.id, file, images);
    }
    await page.close();
  }
}

async function writeRegistration(projectsRoot, captureRoot) {
  const registration = {
    id: PROJECT,
    name: PROJECT_NAME,
    // The 1440 version comes last in its revision, so it opens first.
    versions: captureVersions().map(({ id, revision, width }) => ({
      id,
      captureRoot: path.join(captureRoot, id),
      revision,
      label: String(width),
    })),
    screens: REGISTERED_SCREENS,
  };
  await writeFile(
    path.join(projectsRoot, `${PROJECT}.json`),
    JSON.stringify(registration, null, 2),
  );
}

function startServer(dataRoot, projectsRoot) {
  const child = spawn(
    path.join(ROOT, "node_modules/.bin/tsx"),
    ["src/server/main.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        SCREENCHECK_DATA: dataRoot,
        SCREENCHECK_PROJECTS: projectsRoot,
        SCREENCHECK_RECORD: "0",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ScreenCheck")) resolve(child);
    });
  });
}

async function api(method, route, body, headers = {}) {
  const response = await fetch(`${ORIGIN}/api/projects/${PROJECT}${route}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      `${method} ${route}: ${response.status} ${await response.text()}`,
    );
  return response.json();
}

async function seed() {
  for (const [version, comments] of Object.entries({
    ...SEED,
    ...SIZE_SEED,
  })) {
    for (const comment of comments) {
      let record = (
        await api("POST", "/feedback", {
          clientMutationId: randomUUID(),
          screenId: comment.screen,
          version,
          x: comment.x,
          y: comment.y,
          note: comment.note,
          tags: comment.tags,
          status: comment.status,
        })
      ).feedback;
      const patch = async (change, headers) => {
        record = (
          await api(
            "PATCH",
            `/feedback/${record.id}`,
            { expectedUpdatedAt: record.updatedAt, patch: change },
            headers,
          )
        ).feedback;
      };
      if (comment.reply) {
        await patch({ reply: { note: comment.reply, author: "Agent" } });
      }
      for (const message of comment.thread ?? []) {
        await patch(
          message.role === "reviewer"
            ? { message: { note: message.note, author: "You" } }
            : { reply: { note: message.note, author: "Agent" } },
        );
      }
      if (comment.verified) {
        await patch(
          { status: "VERIFIED" },
          { "x-screencheck-actor": "reviewer" },
        );
      }
    }
  }
  const approved = { ...SIZE_APPROVED };
  for (const [version, screens] of Object.entries(APPROVED)) {
    approved[version] = [...screens, ...(approved[version] ?? [])];
  }
  for (const [version, screens] of Object.entries(approved)) {
    for (const screenId of screens) {
      await api(
        "PUT",
        "/approvals",
        { version, screenId, approved: true },
        { "x-screencheck-actor": "reviewer" },
      );
    }
  }
}

if (reset) await rm(HOME, { recursive: true, force: true });
const captureRoot = path.join(HOME, "captures");
const projectsRoot = path.join(HOME, "projects");
const dataRoot = path.join(HOME, "data");
const fresh = !existsSync(dataRoot);
await Promise.all(
  [captureRoot, projectsRoot, dataRoot].map((dir) =>
    mkdir(dir, { recursive: true }),
  ),
);

const browser = await chromium.launch();
try {
  await renderCaptures(browser, captureRoot, path.join(HOME, "thumbs"));
} finally {
  await browser.close();
}
await writeRegistration(projectsRoot, captureRoot);
const server = await startServer(dataRoot, projectsRoot);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill();
    process.exit(0);
  });
}
if (fresh) {
  try {
    await seed();
  } catch (error) {
    server.kill();
    throw error;
  }
}

console.log(`
ScreenCheck playground: ${ORIGIN}/
  ${fresh ? "Seeded a fresh Tidewater project." : "Resumed where you left off (--reset to start over)."}
  Data:        ${HOME}
  Walkthrough: docs/PLAYGROUND.md
  Agent CLI:   npm run screencheck -- reply --url ${ORIGIN} --project ${PROJECT} --list
  MCP command: ${path.join(ROOT, "node_modules/.bin/tsx")} ${path.join(ROOT, "src/mcp/main.ts")} --url ${ORIGIN}
Ctrl+C to stop.`);
if (!noOpen && process.platform === "darwin") {
  spawn("open", [`${ORIGIN}/`], { stdio: "ignore" });
}
await new Promise(() => {});
