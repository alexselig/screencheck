import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { handleApi, sendJson as json } from "./api";
import { assistEnabledFromEnv, createAssist } from "./assist";
import { appHome } from "./home";
import { acquireDataRootLock } from "./lock";
import { createProjectCatalog, defaultProjectsRoot } from "./projects";
import { assertLoopbackHost, LOOPBACK_HOST } from "./origin";
import {
  clearRuntimeInfo,
  shouldRecordRuntime,
  writeRuntimeInfo,
} from "./runtime";
import { PAGE_HEADERS } from "./send-file";
import { createStaticHandler } from "./static";
import { sharedFeedbackStorage } from "./storage";

export type ServerOptions = {
  host?: string;
  port?: number;
  dataRoot?: string;
  projectsRoot?: string;
  // A built client (dist/client). When set, the server serves it as static
  // files and never loads Vite; without it, Vite runs in middleware mode.
  clientRoot?: string;
  // AI assist through the reviewer's Copilot CLI (#14). Off unless true or
  // SCREENCHECK_ASSIST=1.
  assist?: boolean;
};

type Fallback = (
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
) => void | Promise<void>;

async function createFallback(
  clientRoot: string | undefined,
  httpServer: Server,
): Promise<{ handle: Fallback; close?: () => Promise<void> }> {
  if (clientRoot) {
    return { handle: await createStaticHandler(clientRoot) };
  }
  // Imported lazily so the published package never needs Vite at runtime.
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    // HMR shares this server's port. Vite's default fixed port (24678) is
    // taken by whichever dev server started first, so a second one (the
    // playground beside `npm run dev`) logged a failed websocket on every
    // page load.
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: "spa",
  });
  const handle: Fallback = (request, response) => {
    for (const [name, value] of Object.entries(PAGE_HEADERS)) {
      response.setHeader(name, value);
    }
    vite.middlewares(request, response, () => {
      json(response, 404, { error: "not found" });
    });
  };
  return { handle, close: () => vite.close() };
}

export function defaultDataRoot() {
  return (
    process.env.SCREENCHECK_DATA ??
    process.env.SCREEN_REVIEW_DATA ??
    join(appHome(), "feedback")
  );
}

export async function startServer({
  host = LOOPBACK_HOST,
  port = 4173,
  dataRoot = defaultDataRoot(),
  projectsRoot = defaultProjectsRoot(),
  clientRoot,
  assist: assistOption,
}: ServerOptions = {}) {
  assertLoopbackHost(host);
  const lock = await acquireDataRootLock(dataRoot);
  try {
    return await listen();
  } catch (error) {
    lock.release();
    throw error;
  }

  async function listen() {
    const storage = sharedFeedbackStorage(dataRoot);
    const catalog = createProjectCatalog({
      projectsRoot,
      hasFeedback: async (projectId) =>
        (await storage.listFeedback(projectId)).length > 0,
    });
    const assist =
      (assistOption ?? assistEnabledFromEnv()) ? createAssist() : undefined;
    let boundPort = port;
    // Assigned before listen(), so every request sees it.
    let fallback!: Awaited<ReturnType<typeof createFallback>>;
    const server = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        if (request.url === "/healthz") {
          json(response, 200, { ok: true });
          return;
        }
        if (
          await handleApi(request, response, {
            storage,
            port: boundPort,
            catalog,
            assist,
          })
        )
          return;
        await fallback.handle(request, response, boundPort);
      },
    );
    fallback = await createFallback(clientRoot, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
    } catch (error) {
      // Vite holds its own watchers; without this a failed listen leaves the
      // process running.
      await fallback.close?.().catch(() => undefined);
      throw error;
    }
    boundPort = (server.address() as AddressInfo).port;
    const origin = `http://${host}:${boundPort}`;
    lock.setOrigin(origin);
    return {
      origin,
      dataRoot,
      projectsRoot,
      mode: clientRoot ? ("static" as const) : ("dev" as const),
      assist: Boolean(assist),
      async close() {
        try {
          await fallback.close?.();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        } finally {
          lock.release();
        }
      },
    };
  }
}

// Starts the server for interactive use: logs where it lives and records it
// in ~/.screencheck/server.json so the CLI and MCP server can find it.
export async function serve(options: ServerOptions = {}) {
  const running = await startServer(options);
  console.log(`ScreenCheck: ${running.origin}`);
  console.log(`Feedback stored in: ${running.dataRoot}`);
  console.log(`Projects read from: ${running.projectsRoot}`);
  if (running.assist) {
    console.log("AI assist: on (uses your GitHub Copilot CLI, tool-less)");
  }
  if (shouldRecordRuntime()) {
    writeRuntimeInfo({
      origin: running.origin,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      dataRoot: running.dataRoot,
      projectsRoot: running.projectsRoot,
    });
    process.on("exit", () => clearRuntimeInfo());
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }
  return running;
}
