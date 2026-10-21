// `screencheck demo`: the seeded Tidewater playground without a clone. The
// captures and seed scenario ship pre-rendered in the package's demo/ folder
// (built by scripts/demo/build-assets.mjs), so this needs no Playwright.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { startServer } from "../server/index";

export const DEMO_USAGE = `Usage:
  screencheck demo [--port 0] [--reset] [--open]

Starts ScreenCheck on a seeded sample project (Tidewater, two builds, open
and fixed comments) so you can try review, replies and approvals before
capturing your own app. Its data lives in ~/.screencheck-demo (or
$SCREENCHECK_DEMO_HOME), apart from your real feedback, and it is not
recorded as your running server.
  --port <n>  Port to listen on (default: any free port)
  --reset     Discard earlier demo changes and seed again
  --open      Open the review page in your browser`;

export const WALKTHROUGH_URL =
  "https://github.com/alexselig/screencheck/blob/main/docs/PLAYGROUND.md";

const PROJECT = "tidewater";
// Written after seeding finishes, so an interrupted seed starts over.
const SEEDED_MARKER = ".seeded";

type SeedComment = {
  screen: string;
  x: number;
  y: number;
  note: string;
  tags?: string[];
  status?: string;
  reply?: string;
  thread?: { role: "reviewer" | "agent"; note: string }[];
  verified?: boolean;
};

type Scenario = {
  project: {
    id: string;
    name: string;
    versions: string[];
    screens: unknown[];
  };
  seed: Record<string, SeedComment[]>;
  approved: Record<string, string[]>;
};

export type DemoIo = {
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  clientRoot?: string;
  open?: (url: string) => void;
  // Where demo/scenario.json lives; found from this file when omitted.
  assetsRoot?: string;
};

export type DemoHandle = {
  origin: string;
  home: string;
  seeded: boolean;
  close(): Promise<void>;
};

// Walks up from this module to the package's demo/ folder: dist/cli.js (or
// a dist/chunks file) in the package, src/cli/demo.ts from source.
export function findDemoAssets(from = fileURLToPath(import.meta.url)) {
  let dir = path.dirname(from);
  for (;;) {
    const candidate = path.join(dir, "demo");
    if (existsSync(path.join(candidate, "scenario.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "The demo assets are missing from this install (demo/scenario.json).",
      );
    }
    dir = parent;
  }
}

export function demoHome(env: NodeJS.ProcessEnv) {
  return env.SCREENCHECK_DEMO_HOME || path.join(homedir(), ".screencheck-demo");
}

async function seed(origin: string, scenario: Scenario) {
  const api = async (
    method: string,
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${origin}/api/projects/${PROJECT}${route}`, {
      method,
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Seeding the demo failed: ${method} ${route} ${response.status} ${await response.text()}`,
      );
    }
    return response.json();
  };
  const reviewer = { "x-screencheck-actor": "reviewer" };

  for (const [version, comments] of Object.entries(scenario.seed)) {
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
      const patch = async (
        change: unknown,
        headers?: Record<string, string>,
      ) => {
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
      if (comment.verified) await patch({ status: "VERIFIED" }, reviewer);
    }
  }
  for (const [version, screens] of Object.entries(scenario.approved)) {
    for (const screenId of screens) {
      await api(
        "PUT",
        "/approvals",
        { version, screenId, approved: true },
        reviewer,
      );
    }
  }
}

export function parseDemoArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p" },
      reset: { type: "boolean" },
      open: { type: "boolean" },
    },
  });
  const port = Number(values.port ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}`);
  }
  return { port, reset: !!values.reset, open: !!values.open };
}

export async function startDemo(
  argv: string[],
  io: DemoIo,
): Promise<DemoHandle> {
  const options = parseDemoArgs(argv);
  const assets = io.assetsRoot ?? findDemoAssets();
  const scenario = JSON.parse(
    await readFile(path.join(assets, "scenario.json"), "utf8"),
  ) as Scenario;

  const home = demoHome(io.env);
  if (options.reset) await rm(home, { recursive: true, force: true });
  const projectsRoot = path.join(home, "projects");
  const dataRoot = path.join(home, "data");
  const marker = path.join(home, SEEDED_MARKER);
  const fresh = !existsSync(marker);
  if (fresh) await rm(dataRoot, { recursive: true, force: true });
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });

  // Rewritten every run: the captures stay in the installed package, which
  // moves when ScreenCheck is upgraded or run from another npx cache.
  const { versions, ...project } = scenario.project;
  await writeFile(
    path.join(projectsRoot, `${PROJECT}.json`),
    `${JSON.stringify(
      {
        ...project,
        versions: versions.map((id) => ({
          id,
          captureRoot: path.join(assets, "captures", id),
        })),
      },
      null,
      2,
    )}\n`,
  );

  // startServer, not serve: the demo never replaces server.json, so the CLI
  // and MCP keep pointing at your real ScreenCheck unless given --url.
  const running = await startServer({
    port: options.port,
    dataRoot,
    projectsRoot,
    ...(io.clientRoot ? { clientRoot: io.clientRoot } : {}),
  });
  if (fresh) {
    try {
      await seed(running.origin, scenario);
      await writeFile(marker, `${new Date().toISOString()}\n`);
    } catch (error) {
      await running.close();
      throw error;
    }
  }

  const { origin } = running;
  const mcp = {
    mcpServers: {
      screencheck: {
        command: "npx",
        args: ["-y", "screencheck", "mcp", "--url", origin],
      },
    },
  };
  io.log(`ScreenCheck demo: ${origin}/
  ${fresh ? "Seeded the Tidewater sample project." : "Resumed where you left off (--reset to start over)."}
  Data:        ${home}
  Walkthrough: ${WALKTHROUGH_URL}
  Agent CLI:   npx screencheck reply --url ${origin} --project ${PROJECT} --list
  MCP config:  ${JSON.stringify(mcp)}
Ctrl+C to stop.`);
  if (options.open) io.open?.(`${origin}/`);
  return { origin, home, seeded: fresh, close: () => running.close() };
}
