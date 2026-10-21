// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { version } from "../package.json";
import { parseCaptureArgs, loadPlaywright } from "../src/cli/capture";
import { HELP, loadMcpModule, main, openCommand } from "../src/cli/index";
import { parseReplyArgs, replyOrigin } from "../src/cli/reply";

function io(extra = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
      readRuntime: () => null,
      ...extra,
    },
  };
}

describe("screencheck CLI", () => {
  it("prints help and the package version", async () => {
    const help = io();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out.join("\n")).toBe(HELP);
    for (const command of ["serve", "status", "reply", "mcp", "capture"]) {
      expect(HELP).toContain(command);
    }

    const bare = io();
    expect(await main([], bare.io)).toBe(1);
    expect(bare.out.join("\n")).toBe(HELP);

    const shown = io();
    expect(await main(["--version"], shown.io)).toBe(0);
    expect(shown.out).toEqual([version]);
  });

  it("rejects an unknown command with help and exit 1", async () => {
    const run = io();
    expect(await main(["deploy"], run.io)).toBe(1);
    expect(run.err.join("\n")).toContain("Unknown command: deploy");
    expect(run.err.join("\n")).toContain("Usage: screencheck <command>");
  });

  it("shows per-command help", async () => {
    for (const [command, text] of [
      ["serve", "--open"],
      ["status", "not running"],
      ["reply", "--project <id> --list"],
      ["mcp", "--author <name>"],
      ["capture", "--wait-for <selector>"],
      ["init", "--captures <dir>"],
      ["add", "--version <id>"],
    ]) {
      const run = io();
      expect(await main([command!, "--help"], run.io)).toBe(0);
      expect(run.out.join("\n")).toContain(text);
    }
  });

  it("reports whether a server is running", async () => {
    const stopped = io();
    expect(await main(["status"], stopped.io)).toBe(1);
    expect(stopped.out).toEqual(["ScreenCheck is not running."]);

    const running = io({
      readRuntime: () => ({
        origin: "http://127.0.0.1:4999",
        pid: 1,
        startedAt: "2026-10-08T00:00:00.000Z",
        dataRoot: "/d",
        projectsRoot: "/p",
      }),
    });
    expect(await main(["status"], running.io)).toBe(0);
    expect(running.out[0]).toBe(
      "ScreenCheck is running at http://127.0.0.1:4999",
    );
  });

  it("loads the bundled MCP server and passes options to it", async () => {
    expect(typeof (await loadMcpModule()).runMcpServer).toBe("function");

    const failing = io({
      loadMcp: async () => {
        throw new Error("boom");
      },
    });
    expect(await main(["mcp"], failing.io)).toBe(1);
    expect(failing.err.join("\n")).toContain("boom");

    const runMcpServer = vi.fn(async () => {});
    const present = io({ loadMcp: async () => ({ runMcpServer }) });
    expect(
      await main(
        ["mcp", "--url", "http://127.0.0.1:5000", "--author", "Copilot"],
        present.io,
      ),
    ).toBe("running");
    expect(runMcpServer).toHaveBeenCalledWith({
      origin: "http://127.0.0.1:5000",
      author: "Copilot",
    });
  });

  it("rejects a bad serve port before starting anything", async () => {
    const run = io();
    expect(await main(["serve", "--port", "nope"], run.io)).toBe(1);
    expect(run.err.join("\n")).toContain("Invalid port");
  });

  it("explains a busy port instead of printing EADDRINUSE (be-17, pr-20)", async () => {
    const busy = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    const serve = vi.fn(async () => {
      throw busy;
    });
    const opened: string[] = [];
    const ours = io({
      serve,
      open: (url: string) => opened.push(url),
      readRuntime: () => ({
        origin: "http://127.0.0.1:4173",
        pid: 77,
        startedAt: "",
        dataRoot: "/d",
        projectsRoot: "/p",
      }),
    });
    expect(await main(["serve", "--open"], ours.io)).toBe(0);
    expect(ours.out).toEqual([
      "ScreenCheck is already running at http://127.0.0.1:4173 (pid 77).",
    ]);
    expect(opened).toEqual(["http://127.0.0.1:4173"]);

    const other = io({ serve });
    expect(await main(["serve", "--port", "4401"], other.io)).toBe(1);
    expect(other.err.join("\n")).toBe(
      "Port 4401 is in use by another program. Try --port 0 for any free port.",
    );
  });

  it("points at the server that already holds the data root (be-2)", async () => {
    const { DataRootInUseError } = await import("../src/server/lock");
    const run = io({
      serve: async () => {
        throw new DataRootInUseError("/d", {
          pid: 9,
          startedAt: "",
          origin: "http://127.0.0.1:4500",
        });
      },
    });
    expect(await main(["serve", "--port", "0"], run.io)).toBe(0);
    expect(run.out).toEqual([
      "ScreenCheck is already running at http://127.0.0.1:4500 (pid 9).",
    ]);
  });

  it("picks a browser opener per platform", () => {
    expect(openCommand("darwin").command).toBe("open");
    expect(openCommand("linux").command).toBe("xdg-open");
    expect(openCommand("win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", ""],
    });
  });
});

describe("screencheck reply", () => {
  it("parses the same flags as scripts/reply.mjs", () => {
    expect(
      parseReplyArgs([
        "--project",
        "shop",
        "--id",
        "a1",
        "--status",
        "fixed",
        "--note",
        "Done.",
        "--author",
        "Copilot",
        "--list",
        "--all",
        "--clear",
      ]),
    ).toEqual({
      project: "shop",
      id: "a1",
      status: "fixed",
      note: "Done.",
      author: "Copilot",
      list: true,
      all: true,
      clear: true,
    });
    expect(() => parseReplyArgs(["shop"])).toThrow("Unexpected argument");
    expect(() => parseReplyArgs(["--note"])).toThrow("--note needs a value");
  });

  it("finds the server from --url, --port, the environment or server.json", () => {
    const running = () => ({
      origin: "http://127.0.0.1:4555",
      pid: 1,
      startedAt: "",
      dataRoot: "",
      projectsRoot: "",
    });
    expect(replyOrigin({ url: "http://127.0.0.1:1/" }, {}, running)).toBe(
      "http://127.0.0.1:1",
    );
    expect(replyOrigin({ port: "4200" }, {}, running)).toBe(
      "http://127.0.0.1:4200",
    );
    expect(
      replyOrigin({}, { SCREENCHECK_URL: "http://127.0.0.1:7" }, running),
    ).toBe("http://127.0.0.1:7");
    expect(replyOrigin({}, {}, running)).toBe("http://127.0.0.1:4555");
    expect(replyOrigin({}, {}, () => null)).toBe("http://127.0.0.1:4173");
  });

  it("still runs through the scripts/reply.mjs shim", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "scripts/reply.mjs",
      "--help",
    ]);
    expect(stdout).toContain("screencheck reply --project <id> --list");
  });
});

describe("screencheck capture", () => {
  it("parses a capture job with defaults", () => {
    expect(parseCaptureArgs(["http://x.test", "--out", "a.png"])).toEqual({
      url: "http://x.test",
      out: "a.png",
      width: 1440,
      height: 1000,
    });
    expect(
      parseCaptureArgs([
        "http://x.test",
        "-o",
        "a.webp",
        "--width",
        "390",
        "--height",
        "844",
        "--wait-for",
        "main",
      ]),
    ).toEqual({
      url: "http://x.test",
      out: "a.webp",
      width: 390,
      height: 844,
      waitFor: "main",
    });
    expect(parseCaptureArgs(["--help"])).toBe("help");
    expect(() => parseCaptureArgs(["http://x.test"])).toThrow("--out");
    expect(() =>
      parseCaptureArgs(["http://x.test", "--out", "a.png", "--width", "0"]),
    ).toThrow("--width");
  });

  it("explains how to install Playwright when it is missing", async () => {
    const missing = Object.assign(new Error("Cannot find package"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(loadPlaywright(() => Promise.reject(missing))).rejects.toThrow(
      "npm i -D playwright && npx playwright install chromium",
    );
  });
});
