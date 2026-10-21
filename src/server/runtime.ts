import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { appHome } from "./home";

// A running server records where it listens so the CLI and the MCP server can
// find it without anyone passing a port number.
export type RuntimeInfo = {
  origin: string;
  pid: number;
  startedAt: string;
  dataRoot: string;
  projectsRoot: string;
};

export function runtimeFile(home = appHome()) {
  return join(home, "server.json");
}

export function writeRuntimeInfo(info: RuntimeInfo, file = runtimeFile()) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRuntimeInfo(
  file = runtimeFile(),
  alive: (pid: number) => boolean = processAlive,
): RuntimeInfo | null {
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo;
    if (typeof info.origin !== "string" || typeof info.pid !== "number") {
      return null;
    }
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

// Removes the file only if it still describes this process, so a second
// server that started later keeps its record.
export function clearRuntimeInfo(pid = process.pid, file = runtimeFile()) {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo;
    if (info.pid === pid) rmSync(file, { force: true });
  } catch {
    // Nothing to clear.
  }
}

// Where to reach the server: an explicit origin wins, then the environment,
// then the runtime file, then the default port.
export function resolveOrigin(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  read: () => RuntimeInfo | null = () => readRuntimeInfo(),
) {
  if (explicit) return explicit.replace(/\/$/, "");
  const fromEnv = env.SCREENCHECK_URL ?? env.SCREEN_REVIEW_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const running = read();
  if (running) return running.origin;
  return `http://127.0.0.1:${env.PORT ?? "4173"}`;
}

// Throwaway servers (demo shots, smoke tests) set SCREENCHECK_RECORD=0 so they
// never repoint agents away from the reviewer's real server.
export function shouldRecordRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.SCREENCHECK_RECORD !== "0";
}
