// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigCaptureJob } from "../src/cli/capture";
import { findCaptureConfig } from "../src/cli/recapture";
import { runReply } from "../src/cli/reply";
import { createMcpServer } from "../src/mcp/server";
import { startServer } from "../src/server/index";

let root: string;
let app: string;
let server: Awaited<ReturnType<typeof startServer>>;
let id: string;

const CONFIG = (project = "shop", version = "build-43") =>
  `export default ${JSON.stringify({
    project: { id: project },
    version,
    baseUrl: "http://127.0.0.1:5173",
    screens: [
      { id: "home", title: "Home", url: "/" },
      { id: "cart", title: "Cart", url: "/cart" },
    ],
  })};\n`;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-recap-"));
  app = join(root, "app");
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "captures"), { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(
    join(root, "projects", "shop.json"),
    JSON.stringify({
      id: "shop",
      name: "Shop",
      versions: [
        { id: "build-41", captureRoot: join(root, "captures") },
        { id: "build-42", captureRoot: join(root, "captures") },
      ],
      screens: [
        {
          id: "home",
          ordinal: 1,
          title: "Home",
          group: "Main",
          viewport: { width: 1440, height: 1000 },
        },
      ],
    }),
  );
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
  });
  id = crypto.randomUUID();
  await fetch(`${server.origin}/api/projects/shop/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({
      clientMutationId: id,
      screenId: "home",
      version: "build-42",
      x: 0.5,
      y: 0.5,
      note: "Button is clipped",
    }),
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function status() {
  const body = await (
    await fetch(`${server.origin}/api/projects/shop/feedback`)
  ).json();
  return body.feedback[0].status as string;
}

const noCapture = () =>
  vi.fn(async (_job: ConfigCaptureJob, _io: unknown) => {});

async function reply(args: string[], capture = noCapture()) {
  const lines: string[] = [];
  const code = await runReply(
    ["--project", "shop", "--url", server.origin, "--id", id, ...args],
    { log: (line) => lines.push(line), cwd: app, recapture: capture },
  );
  return { code, out: lines.join("\n"), capture };
}

describe("reply --recapture", () => {
  it("finds the project's capture config", async () => {
    expect(await findCaptureConfig(app)).toBeNull();
    await writeFile(join(app, "screencheck.config.json"), "{}");
    expect(await findCaptureConfig(app)).toBe(
      join(app, "screencheck.config.json"),
    );
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    expect(await findCaptureConfig(app)).toBe(
      join(app, "screencheck.config.mjs"),
    );
  });

  it("leaves the default reply alone", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    const { code, capture } = await reply([
      "--status",
      "fixed",
      "--note",
      "Unclipped it.",
    ]);
    expect(code).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    expect(await status()).toBe("RESOLVED");
  });

  it("captures just that screen with the project's config", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    const capture = vi.fn(
      async (job: ConfigCaptureJob, io: { log?: (line: string) => void }) => {
        io.log?.(`Captured ${job.screen} at 1440px`);
      },
    );
    const { code, out } = await reply(
      ["--status", "fixed", "--note", "Unclipped it.", "--recapture"],
      capture,
    );
    expect(code).toBe(0);
    expect(await status()).toBe("RESOLVED");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toEqual({
      config: join(app, "screencheck.config.mjs"),
      screen: "home",
    });
    expect(out).toContain("Replied to");
    expect(out).toContain("Captured home at 1440px");
    expect(out).toContain("Recaptured home into build-43");
  });

  it("passes --revision through as the capture version", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    const { capture } = await reply([
      "--status",
      "fixed",
      "--note",
      "Done.",
      "--recapture",
      "--revision",
      "build-44",
    ]);
    expect(capture.mock.calls[0]![0]).toMatchObject({
      screen: "home",
      version: "build-44",
    });
  });

  it("explains and skips when there is no capture config", async () => {
    const { code, out, capture } = await reply([
      "--status",
      "fixed",
      "--note",
      "Done.",
      "--recapture",
    ]);
    expect(code).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    expect(await status()).toBe("RESOLVED");
    expect(out).toMatch(/No capture config .*skipped the recapture/);
  });

  it("skips a config for another project", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG("other"));
    const { out, capture } = await reply([
      "--status",
      "fixed",
      "--note",
      "Done.",
      "--recapture",
    ]);
    expect(capture).not.toHaveBeenCalled();
    expect(out).toContain('is for project "other", not "shop"');
  });

  it("warns when the recapture overwrites the build the comment is on", async () => {
    await writeFile(
      join(app, "screencheck.config.mjs"),
      CONFIG("shop", "build-42"),
    );
    const { out } = await reply([
      "--status",
      "fixed",
      "--note",
      "Done.",
      "--recapture",
    ]);
    expect(out).toContain("replaced the capture the comment was made on");
  });

  it("reports a failed capture without undoing the reply", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    const { code, out } = await reply(
      ["--status", "fixed", "--note", "Done.", "--recapture"],
      vi.fn(async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }),
    );
    expect(code).toBe(1);
    expect(await status()).toBe("RESOLVED");
    expect(out).toContain("Recapture failed: net::ERR_CONNECTION_REFUSED");
  });

  it("is refused outside a reply", async () => {
    await expect(reply(["--show", "--recapture"])).rejects.toThrow(
      "--recapture goes with a reply",
    );
  });
});

describe("MCP reply recapture", () => {
  it("recaptures the screen when asked", async () => {
    await writeFile(join(app, "screencheck.config.mjs"), CONFIG());
    const capture = noCapture();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createMcpServer({
      origin: server.origin,
      cwd: app,
      recapture: capture,
    }).connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const plain = (await client.callTool({
        name: "reply",
        arguments: { id, note: "Working on it.", status: "in-progress" },
      })) as { content: { text: string }[] };
      expect(capture).not.toHaveBeenCalled();
      expect(plain.content[0]!.text).not.toContain("Recapture");

      const result = (await client.callTool({
        name: "reply",
        arguments: { id, note: "Fixed.", status: "fixed", recapture: true },
      })) as {
        content: { text: string }[];
        structuredContent: Record<string, any>;
      };
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]![0]).toEqual({
        config: join(app, "screencheck.config.mjs"),
        screen: "home",
      });
      expect(result.content[0]!.text).toContain(
        "Recaptured home into build-43",
      );
      expect(result.structuredContent.recapture).toMatchObject({
        ok: true,
        revision: "build-43",
      });
    } finally {
      await client.close();
    }
  });
});
