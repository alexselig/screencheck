// Rebuilds the project site's screenshots from a made-up demo app.
//
//   node scripts/site/build-shots.mjs          # capture docs/assets/*.png
//   node scripts/site/build-shots.mjs --serve  # seed and leave the demo running
//
// Everything runs against a throwaway data folder and port, never your own
// projects or feedback.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { captureFullPage } from "../../src/capture/full-page.ts";
import { APPROVED, COMMENTS, SCREENS } from "./demo-app.mjs";
import { SHOTS } from "./shots.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 4196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROJECT = "tidewater";
const VERSION = "build-42";
const OUT = path.join(ROOT, "docs", "assets");
const serveOnly = process.argv.includes("--serve");

async function renderCaptures(browser, captureRoot) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  // ScreenCheck's own capture helper, so long pages end at their footer. It
  // also writes `<screen>.elements.json` beside each capture; the demo markup
  // carries `data-source` attributes, so comment cards name a source file.
  for (const screen of SCREENS) {
    await page.setContent(screen.html);
    await captureFullPage(page, {
      path: path.join(captureRoot, `${screen.id}.png`),
      elements: true,
    });
  }
  await page.close();
}

async function writeRegistration(projectsRoot, captureRoot) {
  const registration = {
    id: PROJECT,
    name: "Tidewater",
    versions: [{ id: VERSION, captureRoot }],
    screens: SCREENS.map((screen, index) => ({
      id: screen.id,
      ordinal: index + 1,
      title: screen.title,
      group: screen.group,
      description: screen.description,
      capturePath: path.join(captureRoot, `${screen.id}.png`),
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
  for (const comment of COMMENTS) {
    const created = await api("POST", "/feedback", {
      clientMutationId: randomUUID(),
      screenId: comment.screen,
      version: VERSION,
      x: comment.x,
      y: comment.y,
      note: comment.note,
      tags: comment.tags,
      status: comment.status,
    });
    let record = created.feedback;
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
          ? { message: { note: message.note, author: "Alex" } }
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
  for (const screenId of APPROVED) {
    await api(
      "PUT",
      "/approvals",
      { version: VERSION, screenId, approved: true },
      { "x-screencheck-actor": "reviewer" },
    );
  }
}

const work = await mkdtemp(path.join(tmpdir(), "srw-site-"));
const captureRoot = path.join(work, "captures");
const projectsRoot = path.join(work, "projects");
const dataRoot = path.join(work, "data");
await Promise.all(
  [captureRoot, projectsRoot, dataRoot].map((dir) =>
    mkdir(dir, { recursive: true }),
  ),
);

const browser = await chromium.launch();
let server;
try {
  await renderCaptures(browser, captureRoot);
  await writeRegistration(projectsRoot, captureRoot);
  server = await startServer(dataRoot, projectsRoot);
  await seed();
  if (serveOnly) {
    console.log(
      `Demo running at ${ORIGIN}/ (data in ${work}). Ctrl+C to stop.`,
    );
    await new Promise(() => {});
  }
  await mkdir(OUT, { recursive: true });
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/${shot.query ?? ""}`);
    await page.waitForSelector(".screen-rail li button");
    await page.waitForLoadState("networkidle");
    await shot.prepare?.(page);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(OUT, `${shot.name}.png`),
      clip: shot.clip,
    });
    console.log(`wrote docs/assets/${shot.name}.png`);
    await context.close();
  }
} finally {
  await browser.close();
  server?.kill();
  if (!serveOnly) await rm(work, { recursive: true, force: true });
}
