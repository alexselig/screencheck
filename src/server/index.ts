import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { handleApi, sendJson as json } from "./api";
import { appHome } from "./home";
import { createProjectCatalog, defaultProjectsRoot } from "./projects";
import { assertLoopbackHost, LOOPBACK_HOST } from "./origin";
import {
  clearRuntimeInfo,
  shouldRecordRuntime,
  writeRuntimeInfo,
} from "./runtime";
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
  const handle: Fallback = (request, response) =>
    vite.middlewares(request, response, () => {
      json(response, 404, { error: "not found" });
    });
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
}: ServerOptions = {}) {
  assertLoopbackHost(host);
  const storage = sharedFeedbackStorage(dataRoot);
  const catalog = createProjectCatalog({
    projectsRoot,
    hasFeedback: async (projectId) =>
      (await storage.listFeedback(projectId)).length > 0,
  });
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
        })
      )
        return;
      await fallback.handle(request, response, boundPort);
    },
  );
  fallback = await createFallback(clientRoot, server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  boundPort = (server.address() as AddressInfo).port;
  return {
    origin: `http://${host}:${boundPort}`,
    dataRoot,
    projectsRoot,
    mode: clientRoot ? ("static" as const) : ("dev" as const),
    async close() {
      await fallback.close?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

// Starts the server for interactive use: logs where it lives and records it
// in ~/.screencheck/server.json so the CLI and MCP server can find it.
export async function serve(options: ServerOptions = {}) {
  const running = await startServer(options);
  console.log(`ScreenCheck: ${running.origin}`);
  console.log(`Feedback stored in: ${running.dataRoot}`);
  console.log(`Projects read from: ${running.projectsRoot}`);
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
