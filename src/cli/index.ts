import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { version } from "../../package.json";
import { serve } from "../server/index";
import { DataRootInUseError } from "../server/lock";
import { readRuntimeInfo, type RuntimeInfo } from "../server/runtime";
import { CAPTURE_USAGE, parseCaptureArgs, runCapture } from "./capture";
import { DOCTOR_USAGE, runDoctor } from "./doctor";
import { DEMO_USAGE, type DemoHandle, startDemo } from "./demo";
import { ADD_USAGE, INIT_USAGE, runAdd, runInit } from "./init";
import { ISSUES_USAGE, runIssues } from "./issues";
import { REPLY_USAGE, runReply } from "./reply";

export const VERSION = version;

export const HELP = `ScreenCheck ${version}: localhost design review with pin feedback.

Usage: screencheck <command> [options]

Commands:
  serve     Start the review server (default port 4173)
  demo      Try ScreenCheck on a seeded sample project
  init      Register a project from a folder of captures
  add       Add a folder of captures as a new version of a project
  status    Show whether a server is running and where
  reply     List open comments or reply to one
  issues    File comments as GitHub issues; sync closed ones to Fixed
  mcp       Run the MCP server on stdio for coding agents
  capture   Take a full-page screenshot without mid-page footers
  doctor    Check stored feedback and restore damaged files from backup

Run "screencheck <command> --help" for a command's options.
Data lives in ~/.screencheck. SCREENCHECK_HOME moves all of it (feedback,
projects and server.json); SCREENCHECK_DATA and SCREENCHECK_PROJECTS move
one folder each.`;

const SERVE_USAGE = `Usage:
  screencheck serve [--port 4173] [--open]

Starts ScreenCheck on http://127.0.0.1:<port> (default $PORT, else 4173) and
records it in ~/.screencheck/server.json so other commands find it. If
ScreenCheck is already running, prints where and exits 0.
  --port 0  Use any free port
  --open    Open the review page in your browser`;

const STATUS_USAGE = `Usage:
  screencheck status

Prints the origin of the running server, or "not running" (exit 1).`;

const MCP_USAGE = `Usage:
  screencheck mcp [--url <origin>] [--author <name>]

Runs the ScreenCheck MCP server over stdio. Without --url it talks to the
running server recorded in ~/.screencheck/server.json.`;

export type McpModule = {
  runMcpServer(options?: { origin?: string; author?: string }): Promise<void>;
};

export const loadMcpModule = (): Promise<McpModule> => import("../mcp/server");

export function openCommand(platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32")
    return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

function openBrowser(url: string) {
  const { command, args } = openCommand();
  const child = spawn(command, [...args, url], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => console.error(`Could not open a browser: ${url}`));
  child.unref();
}

export type CliIo = {
  log?: (line: string) => void;
  error?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  // Built client to serve; when missing the server falls back to Vite dev.
  clientRoot?: string;
  loadMcp?: () => Promise<McpModule>;
  readRuntime?: () => RuntimeInfo | null;
  open?: (url: string) => void;
  serve?: typeof serve;
  // Receives the running demo so tests can stop it.
  onDemo?: (demo: DemoHandle) => void;
};

function portOf(origin: string) {
  try {
    return Number(new URL(origin).port);
  } catch {
    return NaN;
  }
}

function wantsHelp(argv: string[]) {
  return argv.includes("--help") || argv.includes("-h");
}

// Returns the exit code, or "running" when the command keeps the process
// alive (serve, mcp).
export async function main(
  argv: string[],
  io: CliIo = {},
): Promise<number | "running"> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const env = io.env ?? process.env;
  const readRuntime = io.readRuntime ?? (() => readRuntimeInfo());
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        log(HELP);
        return command === undefined ? 1 : 0;
      case "--version":
      case "-v":
      case "version":
        log(version);
        return 0;
      case "serve": {
        if (wantsHelp(rest)) return (log(SERVE_USAGE), 0);
        const { values } = parseArgs({
          args: rest,
          options: {
            port: { type: "string", short: "p" },
            open: { type: "boolean" },
          },
        });
        const port = Number(values.port ?? env.PORT ?? "4173");
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`Invalid port: ${values.port ?? env.PORT}`);
        }
        const open = (url: string) => (io.open ?? openBrowser)(url);
        try {
          const running = await (io.serve ?? serve)({
            port,
            ...(io.clientRoot ? { clientRoot: io.clientRoot } : {}),
          });
          if (values.open) open(running.origin);
          return "running";
        } catch (caught) {
          const inUse = (caught as NodeJS.ErrnoException).code === "EADDRINUSE";
          if (!inUse && !(caught instanceof DataRootInUseError)) throw caught;
          const info = readRuntime();
          const live =
            info && (!inUse || portOf(info.origin) === port)
              ? { origin: info.origin, pid: info.pid }
              : caught instanceof DataRootInUseError && caught.holder.origin
                ? { origin: caught.holder.origin, pid: caught.holder.pid }
                : null;
          if (live) {
            log(
              `ScreenCheck is already running at ${live.origin} (pid ${live.pid}).`,
            );
            if (values.open) open(live.origin);
            return 0;
          }
          if (inUse) {
            error(
              `Port ${port} is in use by another program. Try --port 0 for any free port.`,
            );
            return 1;
          }
          throw caught;
        }
      }
      case "demo": {
        if (wantsHelp(rest)) return (log(DEMO_USAGE), 0);
        const demo = await startDemo(rest, {
          log,
          env,
          open: (url) => (io.open ?? openBrowser)(url),
          ...(io.clientRoot ? { clientRoot: io.clientRoot } : {}),
        });
        io.onDemo?.(demo);
        if (!io.onDemo) {
          for (const signal of ["SIGINT", "SIGTERM"] as const) {
            process.once(signal, () => process.exit(0));
          }
        }
        return "running";
      }
      case "status": {
        if (wantsHelp(rest)) return (log(STATUS_USAGE), 0);
        const info = readRuntime();
        if (!info) {
          log("ScreenCheck is not running.");
          return 1;
        }
        log(`ScreenCheck is running at ${info.origin}`);
        log(`  pid ${info.pid}, started ${info.startedAt}`);
        log(`  feedback: ${info.dataRoot}`);
        log(`  projects: ${info.projectsRoot}`);
        return 0;
      }
      case "reply":
        if (wantsHelp(rest)) return (log(REPLY_USAGE), 0);
        return await runReply(rest, { log, env, readRuntime });
      case "issues":
        if (wantsHelp(rest)) return (log(ISSUES_USAGE), 0);
        return await runIssues(rest, { log, env, readRuntime });
      case "mcp": {
        if (wantsHelp(rest)) return (log(MCP_USAGE), 0);
        const { values } = parseArgs({
          args: rest,
          options: {
            url: { type: "string" },
            author: { type: "string" },
          },
        });
        const { runMcpServer } = await (io.loadMcp ?? loadMcpModule)();
        await runMcpServer({
          ...(values.url ? { origin: values.url } : {}),
          ...(values.author ? { author: values.author } : {}),
        });
        return "running";
      }
      case "capture": {
        const job = parseCaptureArgs(rest);
        if (job === "help") return (log(CAPTURE_USAGE), 0);
        await runCapture(job, { log });
        return 0;
      }
      case "init":
        if (wantsHelp(rest)) return (log(INIT_USAGE), 0);
        return await runInit(rest, { log, env });
      case "add":
        if (wantsHelp(rest)) return (log(ADD_USAGE), 0);
        return await runAdd(rest, { log, env });
      case "doctor":
        if (wantsHelp(rest)) return (log(DOCTOR_USAGE), 0);
        return await runDoctor(rest, { log });
      default:
        error(`Unknown command: ${command}\n`);
        error(HELP);
        return 1;
    }
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}
