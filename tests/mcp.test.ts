// @vitest-environment node
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertLoopbackOrigin,
  NOT_RUNNING_MESSAGE,
} from "../src/agent-api/client";
import { createMcpServer, type McpServerOptions } from "../src/mcp/server";
import { statusLabel, toApiStatus } from "../src/agent-api/status";
import { runReply } from "../src/cli/reply";
import { startServer } from "../src/server/index";

type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
};

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;
let clients: Client[] = [];

const screen = {
  group: "Main",
  viewport: { width: 1440, height: 1000 },
};

function record(
  id: string,
  fields: Partial<{
    screenId: string;
    version: string;
    x: number;
    y: number;
    tags: string[];
    status: string;
    reply: unknown;
    createdAt: string;
  }>,
) {
  const createdAt = fields.createdAt ?? "2026-10-01T10:00:00.000Z";
  return {
    id,
    projectId: "demo",
    screenId: "home",
    version: "v1",
    x: 0.5,
    y: 0.5,
    note: `Note for ${id}`,
    tags: [],
    status: "OPEN",
    ...fields,
    createdAt,
    updatedAt: createdAt,
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${server.origin}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: server.origin,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

async function feedback() {
  return (await api("GET", "/api/projects/demo/feedback")).feedback as {
    id: string;
    status: string;
    note: string;
    updatedAt: string;
    reply?: { note: string; author: string };
  }[];
}

async function connect(options: McpServerOptions = {}) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createMcpServer({ origin: server.origin, ...options }).connect(
    serverTransport,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function text(result: ToolResult) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-mcp-"));
  await mkdir(join(root, "projects"));
  await mkdir(join(root, "captures", "v1"), { recursive: true });
  await mkdir(join(root, "captures", "v2"), { recursive: true });
  await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: "#f0f0f0",
    },
  })
    .png()
    .toFile(join(root, "captures", "v1", "home.png"));
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions: [
        { id: "v1", captureRoot: join(root, "captures", "v1") },
        { id: "v2", captureRoot: join(root, "captures", "v2") },
      ],
      screens: [
        {
          ...screen,
          id: "home",
          ordinal: 1,
          title: "Home",
          description: "Signed-in home page.",
          capturePath: "home.png",
        },
        {
          ...screen,
          id: "checkout",
          ordinal: 2,
          title: "Checkout",
          description: "Step 2 of 3.",
        },
      ],
    }),
  );
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
  });
  await api("POST", "/api/projects/demo/feedback/import", {
    records: [
      record("a1", {
        x: 0.75,
        y: 0.5,
        tags: ["P0"],
        createdAt: "2026-10-01T10:01:00.000Z",
      }),
      record("a2", {
        tags: ["P1", "copy"],
        status: "IN_PROGRESS",
        createdAt: "2026-10-01T10:02:00.000Z",
      }),
      record("a3", {
        tags: ["P2"],
        status: "RESOLVED",
        reply: {
          note: "Done.",
          author: "Agent",
          at: "2026-10-01T11:00:00.000Z",
        },
        createdAt: "2026-10-01T10:03:00.000Z",
      }),
      record("b1", {
        screenId: "checkout",
        tags: ["P0"],
        createdAt: "2026-10-01T10:00:00.000Z",
      }),
      record("c1", {
        version: "v2",
        tags: ["P1"],
        createdAt: "2026-10-01T10:04:00.000Z",
      }),
    ],
  });
  await api(
    "PUT",
    "/api/projects/demo/approvals",
    { version: "v1", screenId: "checkout", approved: true },
    { "x-screencheck-actor": "reviewer" },
  );
  await api("PUT", "/api/projects/demo/captions", {
    version: "v1",
    screenId: "home",
    text: "Home with three saved trips.",
  });
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients = [];
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("status names", () => {
  it("maps friendly names and passes unknown ones through", () => {
    expect(toApiStatus("fixed")).toBe("RESOLVED");
    expect(toApiStatus("wont-fix")).toBe("WONT_FIX");
    expect(toApiStatus("In progress")).toBe("IN_PROGRESS");
    expect(toApiStatus("backlog")).toBe("OPEN");
    expect(toApiStatus("verified")).toBe("VERIFIED");
    expect(toApiStatus("NEEDS_INFO")).toBe("NEEDS_INFO");
    expect(statusLabel("RESOLVED")).toBe("Fixed");
    expect(statusLabel("NEEDS_INFO")).toBe("Needs Info");
  });
});

describe("loopback origins", () => {
  it("accepts loopback hosts and refuses everything else", () => {
    expect(assertLoopbackOrigin("http://127.0.0.1:4173/")).toBe(
      "http://127.0.0.1:4173",
    );
    expect(assertLoopbackOrigin("http://localhost:4173")).toBe(
      "http://localhost:4173",
    );
    expect(assertLoopbackOrigin("http://[::1]:4173")).toBe("http://[::1]:4173");
    for (const origin of [
      "http://example.com:4173",
      "http://127.0.0.1.nip.io:4173",
      "http://user:pw@127.0.0.1:4173",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => assertLoopbackOrigin(origin)).toThrow();
    }
  });
});

describe("MCP server", () => {
  it("lists tools, projects and open counts", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "approval_status",
      "get_comment",
      "list_feedback",
      "list_projects",
      "release_status",
      "reply",
      "set_status",
    ]);
    const result = await call(client, "list_projects");
    const [project] = result.structuredContent!.projects;
    expect(project.open).toBe(4);
    expect(project.versions).toEqual([
      { id: "v1", open: 3 },
      { id: "v2", open: 1 },
    ]);
    expect(
      project.screens.map((item: { id: string; open: number }) => [
        item.id,
        item.open,
      ]),
    ).toEqual([
      ["home", 3],
      ["checkout", 1],
    ]);
  });

  it("lists open feedback with on-screen pin numbers, sorted like the export", async () => {
    const client = await connect();
    const result = await call(client, "list_feedback");
    const items = result.structuredContent!.feedback;
    expect(
      items.map((item: { id: string; pin: number }) => [item.id, item.pin]),
    ).toEqual([
      ["a1", 1],
      ["a2", 2],
      ["b1", 1],
      ["c1", 1],
    ]);
    expect(items[0]).toMatchObject({
      version: "v1",
      screen: { id: "home", title: "Home", ordinal: 1 },
      status: "OPEN",
      statusLabel: "Backlog",
      tags: ["P0"],
      position: { x: 0.75, y: 0.5 },
    });
    expect(text(result)).toContain("Pin 1 on v1 / 01 Home · P0 · Backlog");
  });

  it("reports scope, size and carry-forward fields", async () => {
    await api("POST", "/api/projects/demo/feedback/import", {
      records: [
        {
          ...record("d1", {
            version: "v2",
            screenId: "checkout",
            createdAt: "2026-10-01T10:05:00.000Z",
          }),
          scope: "all",
          carriedFrom: ["v1"],
          checkPlacement: true,
        },
      ],
    });
    const client = await connect();
    const result = await call(client, "list_feedback", { version: "v2" });
    const items = result.structuredContent!.feedback;
    expect(
      items.find((item: { id: string }) => item.id === "c1"),
    ).toMatchObject({
      scope: "size",
      size: "v2",
      carriedFrom: [],
      checkPlacement: false,
    });
    expect(
      items.find((item: { id: string }) => item.id === "d1"),
    ).toMatchObject({
      scope: "all",
      size: "v2",
      carriedFrom: ["v1"],
      checkPlacement: true,
    });
    expect(text(result)).toContain(
      "all sizes (pinned at v2) · carried from v1 · check placement",
    );
    const comment = await call(client, "get_comment", { id: "d1" });
    expect(comment.structuredContent!.comment).toMatchObject({
      scope: "all",
      checkPlacement: true,
    });
    const lines: string[] = [];
    await runReply(
      [
        "--url",
        server.origin,
        "--project",
        "demo",
        "--list",
        "--version",
        "v2",
      ],
      { log: (line) => lines.push(line) },
    );
    expect(lines.join("\n")).toMatch(
      /^d1\tv2\/checkout pin \d+ \(all sizes, check placement\)\t/m,
    );
  });

  it("filters by status, tag, screen and version", async () => {
    const client = await connect();
    const ids = async (args: Record<string, unknown>) =>
      (
        await call(client, "list_feedback", args)
      ).structuredContent!.feedback.map((item: { id: string }) => item.id);
    expect(await ids({ includeClosed: true })).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "c1",
    ]);
    expect(await ids({ status: "fixed" })).toEqual(["a3"]);
    expect(await ids({ status: "backlog,in-progress", version: "v1" })).toEqual(
      ["a1", "a2", "b1"],
    );
    expect(await ids({ tag: "p0" })).toEqual(["a1", "b1"]);
    expect(await ids({ tag: "Copy" })).toEqual(["a2"]);
    expect(await ids({ screen: "2" })).toEqual(["b1"]);
    expect(await ids({ screen: "checkout" })).toEqual(["b1"]);
    expect(await ids({ version: "v2", project: "demo" })).toEqual(["c1"]);
    expect(await ids({ status: "VERIFIED" })).toEqual([]);
    const result = await call(client, "list_feedback", { version: "v9" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no version "v9"/);
  });

  it("returns the comment with a crop of the capture around the pin", async () => {
    const client = await connect();
    const result = await call(client, "get_comment", { id: "a1" });
    expect(result.isError).toBeFalsy();
    const image = result.content.find((item) => item.type === "image") as {
      data: string;
      mimeType: string;
    };
    expect(image.mimeType).toBe("image/png");
    const buffer = Buffer.from(image.data, "base64");
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([800, 600]);
    // Pin at (1200, 600) of 1600x1200: the crop clamps to the right edge.
    expect(result.structuredContent!.image).toMatchObject({
      region: { left: 800, top: 300, width: 800, height: 600 },
      capture: { width: 1600, height: 1200 },
      pin: { x: 400, y: 300 },
    });
    const { data, info } = await sharp(buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    // The pin dot is drawn in orange; far corners keep the capture colour.
    expect(pixel(400, 300)).toEqual([0xc2, 0x41, 0x0c]);
    expect(pixel(10, 10)).toEqual([0xf0, 0xf0, 0xf0]);

    expect(result.structuredContent!.comment).toMatchObject({
      id: "a1",
      pin: 1,
      note: "Note for a1",
      reply: null,
    });
    expect(result.structuredContent!.screen).toMatchObject({
      id: "home",
      caption: "Home with three saved trips.",
    });
    expect(result.structuredContent!.record.id).toBe("a1");
    expect(text(result)).toContain(
      "Screen shows: Home with three saved trips.",
    );
  });

  it("returns the whole capture downscaled on request", async () => {
    const client = await connect();
    const result = await call(client, "get_comment", {
      id: "a1",
      fullCapture: true,
    });
    const image = result.content.find((item) => item.type === "image") as {
      data: string;
      mimeType: string;
    };
    expect(image.mimeType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([800, 600]);
    expect(result.structuredContent!.image.pin).toEqual({ x: 600, y: 300 });
  });

  it("crops around a box pin and names the element best covering it", async () => {
    await writeFile(
      join(root, "captures", "v1", "home.elements.json"),
      JSON.stringify({
        version: 1,
        capture: { width: 1600, height: 1200 },
        elements: [
          { box: { x: 0, y: 0, w: 1, h: 1 }, tag: "main", selector: "main" },
          {
            box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
            role: "article",
            name: "Plan card",
            tag: "article",
            selector: "main > article",
          },
          {
            box: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 },
            role: "button",
            name: "Choose",
            tag: "button",
            selector: "main > article > button",
          },
        ],
      }),
    );
    await api("POST", "/api/projects/demo/feedback/import", {
      records: [
        {
          ...record("box1", { createdAt: "2026-10-01T10:05:00.000Z" }),
          box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        },
      ],
    });
    const client = await connect();
    const result = await call(client, "get_comment", { id: "box1" });
    expect(text(result)).toContain(
      'Element under the pin: article "Plan card"',
    );
    expect(text(result)).toContain(
      "· region 25%, 25%, 50% wide × 50% tall · id box1",
    );
    // An 800x600 box plus 48px padding each side, scaled to 800 wide.
    expect(result.structuredContent!.image).toMatchObject({
      region: { left: 352, top: 252, width: 896, height: 696 },
      box: { left: 43, top: 43, width: 714, height: 536 },
    });
    expect(text(result)).toContain(
      "the region is outlined at (43, 43), 714x536.",
    );
    expect(result.structuredContent!.comment.region).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.5,
    });
  });

  it("returns text only when the screen has no capture", async () => {
    const client = await connect();
    const result = await call(client, "get_comment", { id: "b1" });
    expect(result.isError).toBeFalsy();
    expect(result.content.every((item) => item.type === "text")).toBe(true);
    expect(result.structuredContent!.image).toBeNull();
    expect(result.structuredContent!.screen.caption).toBe("Step 2 of 3.");
    expect(text(result)).toMatch(/no capture for v1 \/ checkout/);
  });

  it("replies with a status and records the author", async () => {
    const client = await connect({ author: "Copilot" });
    const result = await call(client, "reply", {
      id: "a1",
      note: "Moved the button.",
      status: "fixed",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.comment).toMatchObject({
      id: "a1",
      status: "RESOLVED",
      statusLabel: "Fixed",
      pin: 1,
      latestReply: { note: "Moved the button.", author: "Copilot" },
    });
    const saved = (await feedback()).find((item) => item.id === "a1")!;
    expect(saved.status).toBe("RESOLVED");
    expect(saved.reply).toMatchObject({
      note: "Moved the button.",
      author: "Copilot",
    });

    await call(client, "reply", {
      id: "a2",
      note: "Looking at it.",
      author: "Claude",
    });
    const second = (await feedback()).find((item) => item.id === "a2")!;
    expect(second.status).toBe("IN_PROGRESS");
    expect(second.reply?.author).toBe("Claude");
  });

  it("sets a status without a note, but closing needs a reply", async () => {
    const client = await connect();
    const result = await call(client, "set_status", {
      id: "a1",
      status: "in-progress",
    });
    expect(result.structuredContent!.comment.status).toBe("IN_PROGRESS");
    expect((await feedback()).find((item) => item.id === "a1")!.status).toBe(
      "IN_PROGRESS",
    );
    const closing = await call(client, "set_status", {
      id: "a1",
      status: "fixed",
    });
    expect(closing.isError).toBe(true);
    expect(text(closing)).toMatch(/Use reply/);
  });

  it("refuses to verify: only a reviewer can", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["reply", { id: "a3", note: "Checked.", status: "verified" }],
      ["set_status", { id: "a3", status: "Verified" }],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Only a reviewer/);
    }
    expect((await feedback()).find((item) => item.id === "a3")!.status).toBe(
      "RESOLVED",
    );
  });

  it("re-reads and retries once when the comment changed meanwhile", async () => {
    let patches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === "PATCH" && patches++ === 0) {
        // The reviewer edits the note just before the agent's write lands.
        const current = (await feedback()).find((item) => item.id === "a1")!;
        await api("PATCH", "/api/projects/demo/feedback/a1", {
          expectedUpdatedAt: current.updatedAt,
          patch: { note: "Reviewer edit." },
        });
      }
      return fetch(input, init);
    };
    const client = await connect({ fetchImpl });
    const result = await call(client, "reply", {
      id: "a1",
      note: "Fixed it.",
      status: "fixed",
    });
    expect(result.isError).toBeFalsy();
    expect(patches).toBe(2);
    const saved = (await feedback()).find((item) => item.id === "a1")!;
    expect(saved).toMatchObject({
      note: "Reviewer edit.",
      status: "RESOLVED",
      reply: { note: "Fixed it." },
    });
  });

  it("keeps a reviewer's status change made while the agent was working", async () => {
    let patches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === "PATCH" && patches++ === 0) {
        // The reviewer verifies a3 just before the agent's write lands.
        const current = (await feedback()).find((item) => item.id === "a3")!;
        await api(
          "PATCH",
          "/api/projects/demo/feedback/a3",
          {
            expectedUpdatedAt: current.updatedAt,
            patch: { status: "VERIFIED" },
          },
          { "x-screencheck-actor": "reviewer" },
        );
      }
      return fetch(input, init);
    };
    const client = await connect({ fetchImpl });
    const result = await call(client, "reply", {
      id: "a3",
      note: "Also fixed the hover state.",
      status: "in-progress",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /changed comment a3 from Fixed to Verified .*Your note was added without a status change/,
    );
    const saved = (await feedback()).find((item) => item.id === "a3")!;
    expect(saved.status).toBe("VERIFIED");
    expect(JSON.stringify(saved)).toContain("Also fixed the hover state.");
  });

  it("labels who spoke last and flags comments awaiting the agent", async () => {
    const [a3] = (await feedback()).filter((item) => item.id === "a3");
    await api(
      "PATCH",
      "/api/projects/demo/feedback/a3",
      {
        expectedUpdatedAt: a3!.updatedAt,
        patch: {
          status: "OPEN",
          message: { note: "Still clipped on mobile.", author: "Alex" },
        },
      },
      { "x-screencheck-actor": "reviewer" },
    );
    const client = await connect();
    const result = await call(client, "list_feedback", {});
    expect(text(result)).toContain("Reviewer (Alex): Still clipped on mobile.");
    expect(text(result)).not.toContain("Reply (");
    const comments = result.structuredContent!.feedback as {
      id: string;
      awaitingAgent: boolean;
      latestReply: { role: string } | null;
    }[];
    const reopened = comments.find((item) => item.id === "a3")!;
    expect(reopened.awaitingAgent).toBe(true);
    expect(reopened.latestReply?.role).toBe("reviewer");
    expect(comments.find((item) => item.id === "a1")!.awaitingAgent).toBe(
      false,
    );
  });

  it("finds comments that mention the agent, and shows who left them", async () => {
    const created = await api(
      "POST",
      "/api/projects/demo/feedback",
      {
        clientMutationId: "22222222-2222-4222-8222-222222222222",
        screenId: "home",
        version: "v1",
        x: 0.2,
        y: 0.2,
        note: "Header wraps.",
        tags: ["P2"],
        author: "Ada\u0000 Lovelace",
      },
      { "x-screencheck-actor": "reviewer" },
    );
    expect(created.feedback.author).toBe("Ada Lovelace");
    await api(
      "PATCH",
      `/api/projects/demo/feedback/${created.feedback.id}`,
      {
        expectedUpdatedAt: created.feedback.updatedAt,
        patch: {
          message: { note: "@agent over to you", author: "Ada Lovelace" },
        },
      },
      { "x-screencheck-actor": "reviewer" },
    );
    const tooLong = await api("POST", "/api/projects/demo/feedback", {
      clientMutationId: "33333333-3333-4333-8333-333333333333",
      screenId: "home",
      version: "v1",
      x: 0.3,
      y: 0.3,
      note: "Too long a name.",
      author: "x".repeat(61),
    });
    expect(tooLong.error).toBeTruthy();

    const client = await connect();
    const result = await call(client, "list_feedback", { mentions: "@Agent" });
    const items = result.structuredContent!.feedback as {
      id: string;
      author: string | null;
    }[];
    expect(items.map((item) => item.id)).toEqual([created.feedback.id]);
    expect(items[0]!.author).toBe("Ada Lovelace");
    expect(text(result)).toContain("@agent");
    const nobody = await call(client, "list_feedback", { mentions: "bob" });
    expect(nobody.structuredContent!.feedback).toEqual([]);
    // Without the filter, everything open is listed as before; older
    // comments have no author.
    const all = (await call(client, "list_feedback", {})).structuredContent!
      .feedback as { id: string; author: string | null }[];
    expect(all.map((item) => item.id)).toContain("a1");
    expect(all.find((item) => item.id === "a1")!.author).toBeNull();
  });

  it("gives the reply CLI the same catalog: screen numbers, captions, unknown projects", async () => {
    const lines: string[] = [];
    const reply = (...args: string[]) =>
      runReply(["--url", server.origin, ...args], {
        log: (line) => lines.push(line),
      });
    expect(await reply("--project", "demo", "--list", "--screen", "2")).toBe(0);
    expect(lines.join("\n")).toMatch(/^b1\tv1\/checkout pin 1\t/);
    lines.length = 0;
    await reply("--project", "demo", "--show", "--id", "a1");
    expect(lines.join("\n")).toContain(
      "Screen shows: Home with three saved trips.",
    );
    await expect(
      reply("--project", "demo", "--list", "--version", "v9"),
    ).rejects.toThrow('Project demo has no version "v9"');
    await expect(reply("--project", "nope", "--list")).rejects.toThrow(
      'Unknown project "nope". Projects: demo.',
    );
  });

  it("names the element under the pin and shows the whole thread", async () => {
    await writeFile(
      join(root, "captures", "v1", "home.elements.json"),
      JSON.stringify({
        version: 1,
        capture: { width: 1600, height: 1200 },
        elements: [
          { box: { x: 0, y: 0, w: 1, h: 1 }, tag: "main", selector: "main" },
          {
            box: { x: 0.7, y: 0.45, w: 0.1, h: 0.1 },
            role: "button",
            name: "Continue",
            tag: "button",
            selector: "main > button",
            source: { file: "src/Footer.tsx", line: 42 },
          },
        ],
      }),
    );
    const [a3] = (await feedback()).filter((item) => item.id === "a3");
    await api("PATCH", "/api/projects/demo/feedback/a3", {
      expectedUpdatedAt: a3!.updatedAt,
      patch: { message: { note: "Still clipped on mobile.", author: "Alex" } },
    });
    const client = await connect();

    const a1 = await call(client, "get_comment", { id: "a1" });
    expect(text(a1)).toContain(
      'Element under the pin: button "Continue" (src/Footer.tsx:42)',
    );
    expect(a1.structuredContent!.comment.element).toMatchObject({
      tag: "button",
      source: { file: "src/Footer.tsx", line: 42 },
    });

    const withThread = await call(client, "get_comment", { id: "a3" });
    expect(text(withThread)).toMatch(
      /Thread:\n {2}Agent \(Agent, .*\): Done\./,
    );
    expect(text(withThread)).toMatch(
      /\n {2}Reviewer \(Alex, .*\): Still clipped on mobile\./,
    );
    expect(withThread.structuredContent!.comment.thread).toHaveLength(2);

    const read = await client.readResource({
      uri: "screencheck://project/demo/feedback.md",
    });
    expect((read.contents[0] as { text: string }).text).toContain(
      '  - Element: button "Continue" \\(src/Footer.tsx:42\\)',
    );
  });

  it("summarizes approvals and open comments by priority", async () => {
    const client = await connect();
    const v1 = await call(client, "approval_status", { version: "v1" });
    expect(v1.structuredContent!.summary).toBe(
      "1/2 approved, 3 open (2 P0, 1 P1), 1 fixed awaiting verification",
    );
    expect(v1.structuredContent!.unverified).toBe(1);
    expect(v1.structuredContent!.screens).toMatchObject([
      {
        id: "home",
        approved: false,
        open: { total: 2, P0: 1, P1: 1 },
        unverified: 1,
      },
      { id: "checkout", approved: true, open: { total: 1, P0: 1 } },
    ]);
    const latest = await call(client, "approval_status", {});
    expect(latest.structuredContent!.version).toBe("v2");
    expect(latest.structuredContent!.summary).toBe(
      "0/2 approved, 1 open (1 P1)",
    );
  });

  it("reports the release status and gate like the CLI", async () => {
    const client = await connect();
    const latest = await call(client, "release_status", {});
    expect(latest.isError).toBeFalsy();
    expect(latest.structuredContent).toMatchObject({
      schema: 1,
      project: "demo",
      revision: "v2",
      versions: ["v2"],
      previous: { revision: "v1", versions: ["v1"] },
      screens: { total: 2, approved: 0, unapproved: 2 },
      open: { total: 1, P0: 0, P1: 1, P2: 0, none: 0 },
      fixedNotVerified: 0,
      changes: {
        since: "v1",
        screensAdded: [],
        screensRemoved: [],
        commentsOpened: 1,
        commentsClosed: 1,
        commentsStillOpen: 3,
      },
      gate: {
        pass: false,
        reasons: ["2 screens not approved: 01 Home, 02 Checkout"],
      },
    });
    expect(text(latest)).toContain("demo · version v2");
    expect(text(latest)).toContain("Gate: FAIL");

    const v1 = await call(client, "release_status", {
      version: "v1",
      allowUnapproved: true,
      maxPriority: "P1",
    });
    expect(v1.structuredContent!.screens).toEqual({
      total: 2,
      approved: 1,
      unapproved: 1,
    });
    expect(v1.structuredContent!.gate.reasons).toEqual([
      "2 open P0 comments",
      "1 open P1 comment",
    ]);

    const both = await call(client, "release_status", {
      version: "v1",
      revision: "v1",
    });
    expect(both.isError).toBe(true);
    // approval_status is unchanged by the new tool.
    expect(
      (await call(client, "approval_status", { version: "v1" }))
        .structuredContent!.summary,
    ).toBe("1/2 approved, 3 open (2 P0, 1 P1), 1 fixed awaiting verification");
  });

  it("serves the Markdown export as a resource and offers a prompt", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((item) => item.uri)).toEqual([
      "screencheck://project/demo/feedback.md",
    ]);
    const read = await client.readResource({
      uri: "screencheck://project/demo/feedback.md",
    });
    const markdown = (read.contents[0] as { text: string }).text;
    expect(markdown).toContain("# demo Screen Review Feedback");
    expect(markdown).toContain("`id: a1`");
    const prompt = await client.getPrompt({
      name: "fix_open_feedback",
      arguments: { project: "demo", version: "v1" },
    });
    expect(JSON.stringify(prompt.messages)).toContain("demo/v1");
  });

  it("explains when ScreenCheck is not running", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const client = await connect({ origin: `http://127.0.0.1:${port}` });
    const result = await call(client, "list_feedback");
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(NOT_RUNNING_MESSAGE);
    expect((await client.listResources()).resources).toEqual([]);
  });

  it("refuses a non-loopback origin without sending a request", async () => {
    let requests = 0;
    const client = await connect({
      origin: "http://screencheck.example.com:4173",
      fetchImpl: async () => {
        requests += 1;
        return new Response("{}");
      },
    });
    const result = await call(client, "list_projects");
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/only runs on loopback/);
    expect(requests).toBe(0);
  });
});
