// A seeded ScreenCheck you can click around in, for trying every feature.
//
//   npm run playground            # start (or resume) on http://127.0.0.1:4299
//   npm run playground -- --reset # wipe the playground and seed it again
//
// It uses the made-up Tidewater ferry app from the project site, with two
// builds (build-41 and build-42), and keeps its own data in
// ~/.screencheck-playground. Your real ~/.screencheck is never touched.
// The walkthrough is docs/PLAYGROUND.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { captureFullPage } from "../../src/capture/full-page.ts";
import { SCREENS } from "../site/demo-app.mjs";
import { APPROVED, SEED, VERSIONS } from "./scenario.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PORT = Number(process.env.PLAYGROUND_PORT ?? 4299);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROJECT = "tidewater";
const HOME =
  process.env.PLAYGROUND_HOME ??
  path.join(homedir(), ".screencheck-playground");
const reset = process.argv.includes("--reset");
const noOpen = process.argv.includes("--no-open");

async function renderCaptures(browser, captureRoot) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  for (const [version, screens] of Object.entries(VERSIONS)) {
    await mkdir(path.join(captureRoot, version), { recursive: true });
    for (const screen of screens) {
      await page.setContent(screen.html);
      await captureFullPage(page, {
        path: path.join(captureRoot, version, `${screen.id}.png`),
        elements: true,
      });
    }
  }
  await page.close();
}

async function writeRegistration(projectsRoot, captureRoot) {
  const registration = {
    id: PROJECT,
    name: "Tidewater",
    versions: Object.keys(VERSIONS).map((id) => ({
      id,
      captureRoot: path.join(captureRoot, id),
    })),
    screens: SCREENS.map((screen, index) => ({
      id: screen.id,
      ordinal: index + 1,
      title: screen.title,
      group: screen.group,
      description: screen.description,
      capturePath: `${screen.id}.png`,
      viewport: { width: 1440, height: 1000 },
    })),
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
  for (const [version, comments] of Object.entries(SEED)) {
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
  for (const [version, screens] of Object.entries(APPROVED)) {
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
  await renderCaptures(browser, captureRoot);
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
