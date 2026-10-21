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
import {
  BUILDS,
  PROJECT,
  PROJECT_NAME,
  REGISTERED_SCREENS,
} from "./project.mjs";

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

// build-42 carries the fixes the agent claims to have made; build-41 is the
// build before them, so switching versions shows a real difference.
const FIXES = [
  [
    "route",
    '<span class="btn" role="button">Return</span>',
    '<span class="btn" role="button">Return <span class="pill" style="margin-left:6px">Save 10%</span></span>',
  ],
  [
    "sailing",
    "Prices are per vehicle with up to 2 adults.",
    "Prices are per vehicle with up to 2 adults. <b>Per vehicle, 2 adults</b>",
  ],
  ["review-pay", ">Pay £125<", ">Pay £125 for 2 sailings<"],
];

const [OLDER, NEWER] = BUILDS;
const VERSIONS = {
  [OLDER]: SCREENS,
  [NEWER]: SCREENS.map((screen) => {
    let html = screen.html;
    for (const [id, from, to] of FIXES) {
      if (id === screen.id) html = html.replace(from, to);
    }
    return { ...screen, html };
  }),
};

// Each scenario is staged for a step in docs/PLAYGROUND.md.
const SEED = {
  [OLDER]: [
    {
      screen: "route",
      x: 0.62,
      y: 0.53,
      note: "Return toggle is easy to miss; the 10% saving should sit next to it.",
      tags: ["P1", "Conversion"],
      status: "OPEN",
    },
    {
      screen: "sailing",
      x: 0.84,
      y: 0.27,
      note: "Price per what? Say per vehicle in the column header.",
      tags: ["P2", "Copy"],
      status: "OPEN",
    },
  ],
  [NEWER]: [
    // A fix with a thread, waiting for you to Verify.
    {
      screen: "route",
      x: 0.275,
      y: 0.517,
      note: "Return toggle is easy to miss; the 10% saving should sit next to it.",
      tags: ["P1", "Conversion"],
      status: "RESOLVED",
      reply:
        "Moved the saving into the Return button label and made Return the default.",
      thread: [
        {
          role: "reviewer",
          note: "Better. The saving still reads as body text; give it the teal accent.",
        },
        {
          role: "agent",
          note: "Saving is now a teal tag inside the Return button.",
        },
      ],
    },
    {
      screen: "route",
      x: 0.62,
      y: 0.125,
      note: "Step labels truncate at 1280px.",
      tags: ["P2", "Layout"],
      status: "OPEN",
    },
    // A fix you can Reopen.
    {
      screen: "review-pay",
      x: 0.8,
      y: 0.3,
      note: 'Pay button should say what you pay for: "Pay £125 for 2 sailings".',
      tags: ["P1", "Copy"],
      status: "RESOLVED",
      reply:
        "Label updated; the amount and sailing count both come from the basket.",
    },
    {
      screen: "review-pay",
      x: 0.78,
      y: 0.19,
      note: "Waitlist notice is the most important thing here; give it the top of the page.",
      tags: ["P0"],
      status: "OPEN",
    },
    // Already verified, for comparison.
    {
      screen: "sailing",
      x: 0.84,
      y: 0.27,
      note: "Price per what? Say per vehicle in the column header.",
      tags: ["P2", "Copy"],
      status: "RESOLVED",
      reply: 'Header now reads "Per vehicle, 2 adults".',
      verified: true,
    },
    {
      screen: "sailing",
      x: 0.42,
      y: 0.43,
      note: "Selected sailing needs more than a border. Add a check and repeat it in the footer button.",
      tags: ["P0", "Accessibility"],
      status: "OPEN",
    },
    {
      screen: "sailing",
      x: 0.78,
      y: 0.56,
      note: '"Few seats left" should be its own badge, not tucked in the boat name.',
      tags: ["P1"],
      status: "OPEN",
    },
    // Won't fix, with the agent's reason.
    {
      screen: "home",
      x: 0.78,
      y: 0.72,
      note: "Quick book duplicates the Book tab. Drop it or prefill from the last trip.",
      tags: ["P2"],
      status: "WONT_FIX",
      reply:
        "Keeping it: most repeat bookings start here. Prefilling from the last trip instead.",
    },
    {
      screen: "home",
      x: 0.56,
      y: 0.2,
      note: "Greeting is nice but the next trip is the real headline. Lead with the 08:40 sailing.",
      tags: ["P1", "Hierarchy"],
      status: "IN_PROGRESS",
    },
    {
      screen: "vehicle",
      x: 0.28,
      y: 0.4,
      note: "Manual path asks for length before we explain why. Lead with a car/van picker that fills it in.",
      tags: ["P0", "Flow"],
      status: "IN_PROGRESS",
    },
    // Open items for the agent CLI and MCP to answer.
    {
      screen: "trips",
      x: 0.75,
      y: 0.36,
      note: "Show ticket should be the primary button on the next trip.",
      tags: ["P1"],
      status: "OPEN",
    },
    {
      screen: "confirmation",
      x: 0.5,
      y: 0.3,
      note: "Add the check-in time here too.",
      tags: ["P2"],
      status: "OPEN",
    },
  ],
};

// Settings stays blank and unapproved so you can pin and approve it yourself.
const APPROVED = { [NEWER]: ["sign-in"] };

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
    name: PROJECT_NAME,
    versions: Object.keys(VERSIONS).map((id) => ({
      id,
      captureRoot: path.join(captureRoot, id),
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
      await api("PUT", "/approvals", { version, screenId, approved: true });
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
