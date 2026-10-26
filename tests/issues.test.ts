// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  groupByScreen,
  issueRef,
  parseIssueUrl,
  renderIssueBody,
  runIssues,
  type GhRunner,
} from "../src/cli/issues";
import { main } from "../src/cli/index";
import { handleApi } from "../src/server/api";
import { createFeedbackStorage } from "../src/server/storage";
import { feedbackRecordSchema } from "../src/shared/feedback";
import type { PublicProject } from "../src/shared/projects";

const PROJECT: PublicProject = {
  id: "demo",
  name: "Demo",
  versions: ["v1", "v2"],
  versionDetails: [{ id: "v1", label: "1440" }, { id: "v2" }],
  screens: [
    {
      id: "landing",
      ordinal: 1,
      title: "Landing",
      group: "Screens",
      viewport: { width: 1440, height: 900 },
      hasCapture: true,
    },
    {
      id: "checkout",
      ordinal: 2,
      title: "Checkout",
      group: "Screens",
      viewport: { width: 1440, height: 900 },
      hasCapture: true,
    },
  ],
};

let server: Server;
let root: string;
let origin: string;
let base: string;
let capture: Buffer;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  capture = await sharp({
    create: {
      width: 1200,
      height: 900,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  })
    .png()
    .toBuffer();
  const storage = createFeedbackStorage({ dataRoot: join(root, "feedback") });
  let port = 0;
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/projects") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects: [PROJECT], problems: [] }));
      return;
    }
    if (path.startsWith("/api/projects/demo/captures/")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(capture);
      return;
    }
    if (path.startsWith("/api/projects/demo/elements/")) {
      response.writeHead(404).end();
      return;
    }
    if (!(await handleApi(request, response, { storage, port }))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/projects/demo/feedback`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function send(method: string, url: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(
  note: string,
  {
    screenId = "landing",
    version = "v1",
    tags = [] as string[],
    status,
  }: {
    screenId?: string;
    version?: string;
    tags?: string[];
    status?: string;
  } = {},
) {
  const response = await send("POST", base, {
    clientMutationId: crypto.randomUUID(),
    screenId,
    version,
    x: 0.5,
    y: 0.25,
    note,
    tags,
    ...(status ? { status } : {}),
  });
  expect(response.status).toBe(201);
  return (await response.json()).feedback;
}

async function list() {
  return (await (await fetch(base)).json()).feedback as Array<
    Record<string, any>
  >;
}

type Call = { args: string[]; input?: string };

// Stands in for `gh`: records every call and answers create / view / label.
function fakeGh(states: Record<number, string> = {}) {
  const calls: Call[] = [];
  let next = 41;
  const run: GhRunner = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "label") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      next += 1;
      const repo = args[args.indexOf("--repo") + 1];
      return {
        code: 0,
        stdout: `https://github.com/${repo}/issues/${next}\n`,
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      return {
        code: 0,
        stdout: JSON.stringify({ state: states[number] ?? "OPEN" }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls };
}

async function cli(gh: GhRunner, ...args: string[]) {
  const lines: string[] = [];
  const code = await runIssues(
    ["--project", "demo", "--url", origin, ...args],
    {
      log: (line: string) => lines.push(line),
      gh,
      env: { SCREENCHECK_HOME: root },
    },
  );
  return { code, out: lines.join("\n") };
}

const creates = (calls: Call[]) =>
  calls.filter((call) => call.args[0] === "issue" && call.args[1] === "create");

describe("schema back-compat for linked issues", () => {
  it("loads records without an issue unchanged and keeps one when present", () => {
    const record = {
      id: "a",
      projectId: "demo",
      screenId: "landing",
      version: "v1",
      x: 0.1,
      y: 0.2,
      note: "Old record",
      tags: [],
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const old = feedbackRecordSchema.parse(record);
    expect(old).not.toHaveProperty("issue");
    const linked = feedbackRecordSchema.parse({
      ...record,
      issue: { repo: "o/r", number: 7, url: "https://github.com/o/r/issues/7" },
    });
    expect(linked.issue).toEqual({
      repo: "o/r",
      number: 7,
      url: "https://github.com/o/r/issues/7",
    });
  });

  it("stores an issue link through PATCH and unlinks it with null", async () => {
    const item = await create("Button is clipped");
    const linked = await send("PATCH", `${base}/${item.id}`, {
      expectedUpdatedAt: item.updatedAt,
      patch: {
        issue: {
          repo: "o/r",
          number: 3,
          url: "https://github.com/o/r/issues/3",
        },
      },
    });
    expect(linked.status).toBe(200);
    const saved = (await linked.json()).feedback;
    expect(saved.issue.number).toBe(3);
    expect(saved.status).toBe("OPEN");

    const bad = await send("PATCH", `${base}/${item.id}`, {
      expectedUpdatedAt: saved.updatedAt,
      patch: { issue: { repo: "nope", number: 0, url: "x" } },
    });
    expect(bad.status).toBe(400);

    const cleared = await send("PATCH", `${base}/${item.id}`, {
      expectedUpdatedAt: saved.updatedAt,
      patch: { issue: null },
    });
    expect((await cleared.json()).feedback).not.toHaveProperty("issue");
  });

  it("reads a feedback.json written before issues existed", async () => {
    const dir = join(root, "old", "demo");
    await rm(dir, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "feedback.json"),
      JSON.stringify({
        version: 1,
        schemaVersion: 2,
        feedback: [
          {
            id: "x",
            projectId: "demo",
            screenId: "landing",
            version: "v1",
            x: 0.5,
            y: 0.5,
            note: "From before",
            tags: ["P1"],
            status: "OPEN",
            thread: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const storage = createFeedbackStorage({ dataRoot: join(root, "old") });
    const [record] = await storage.listFeedback("demo");
    expect(record!.note).toBe("From before");
    expect(record).not.toHaveProperty("issue");
  });
});

describe("issue body rendering", () => {
  it("names the screen, size, priority, tags, note, thread, link and crop", () => {
    const body = renderIssueBody({
      origin: "http://127.0.0.1:4173",
      project: PROJECT,
      projectId: "demo",
      version: "v1",
      screenId: "landing",
      comments: [
        {
          pin: 2,
          record: {
            id: "c1",
            projectId: "demo",
            screenId: "landing",
            version: "v1",
            x: 0.5,
            y: 0.25,
            note: "Footer floats\nmid-page.",
            tags: ["P1", "layout"],
            status: "OPEN",
            thread: [
              {
                role: "reviewer",
                author: "Alex",
                note: "Still there on v1",
                at: "2026-01-02T00:00:00.000Z",
              },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          crop: "/home/me/.screencheck/issue-crops/demo/c1.png",
        },
      ],
    });
    expect(body).toContain("Landing");
    expect(body).toContain("v1");
    expect(body).toContain("1440×900");
    expect(body).toContain("P1");
    expect(body).toContain("`layout`");
    expect(body).toContain("Footer floats\nmid-page.");
    expect(body).toContain("Reviewer (Alex");
    expect(body).toContain("Still there on v1");
    expect(body).toContain(
      "http://127.0.0.1:4173/#project=demo&version=v1&screen=landing",
    );
    expect(body).toContain("/home/me/.screencheck/issue-crops/demo/c1.png");
    expect(body).toContain("Pin 2");
    expect(body).toContain("screencheck:c1");
  });

  it("parses the issue URL gh prints", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/12\n")).toEqual({
      number: 12,
      url: "https://github.com/o/r/issues/12",
    });
    expect(() => parseIssueUrl("oops")).toThrow();
    expect(issueRef({ repo: "o/r", number: 4, url: "" })).toBe("o/r#4");
  });
});

describe("per-screen grouping", () => {
  it("groups by version and screen in screen order", () => {
    const record = (id: string, screenId: string, version = "v1") =>
      ({ id, screenId, version }) as never;
    const groups = groupByScreen(
      [
        record("a", "checkout"),
        record("b", "landing"),
        record("c", "checkout"),
        record("d", "landing", "v2"),
      ],
      PROJECT,
    );
    expect(
      groups.map((group) => [
        group.version,
        group.screenId,
        group.items.map((item) => (item as { id: string }).id),
      ]),
    ).toEqual([
      ["v1", "landing", ["b"]],
      ["v1", "checkout", ["a", "c"]],
      ["v2", "landing", ["d"]],
    ]);
  });
});

describe("screencheck issues", () => {
  it("creates one issue per open comment, links it and writes the crop", async () => {
    const first = await create("Footer floats", { tags: ["P0"] });
    await create("Wrong total", { screenId: "checkout" });
    await create("Already done", { status: "RESOLVED" }).catch(() => null);
    const gh = fakeGh();

    const { code, out } = await cli(gh.run, "--repo", "o/r");
    expect(code).toBe(0);
    const made = creates(gh.calls);
    expect(made).toHaveLength(2);
    const firstCall = made.find((call) => call.input?.includes("Footer"))!;
    expect(firstCall.args).toEqual(
      expect.arrayContaining([
        "--repo",
        "o/r",
        "--body-file",
        "-",
        "--label",
        "screencheck",
      ]),
    );
    expect(firstCall.args[firstCall.args.indexOf("--title") + 1]).toMatch(
      /Landing.*Footer floats/,
    );
    expect(firstCall.input).toContain(
      `/#project=demo&version=v1&screen=landing`,
    );

    const crop = join(root, "issue-crops", "demo", `${first.id}.png`);
    expect((await stat(crop)).size).toBeGreaterThan(0);
    expect((await readFile(crop)).subarray(1, 4).toString()).toBe("PNG");
    expect(firstCall.input).toContain(crop);

    const saved = await list();
    const linked = saved.find((item) => item.id === first.id)!;
    expect(linked.issue).toMatchObject({ repo: "o/r" });
    expect(linked.issue.url).toMatch(
      /^https:\/\/github.com\/o\/r\/issues\/\d+$/,
    );
    expect(out).toMatch(/Created 2 issues/);
  });

  it("does not duplicate issues on a re-run", async () => {
    await create("Footer floats");
    const gh = fakeGh();
    await cli(gh.run, "--repo", "o/r");
    await create("New one");
    const again = await cli(gh.run, "--repo", "o/r");
    expect(again.code).toBe(0);
    expect(creates(gh.calls)).toHaveLength(2);
    expect(again.out).toMatch(/1 already linked/);
  });

  it("--dry-run prints the issues and changes nothing", async () => {
    await create("Footer floats");
    const gh = fakeGh();
    const { code, out } = await cli(gh.run, "--repo", "o/r", "--dry-run");
    expect(code).toBe(0);
    expect(gh.calls).toHaveLength(0);
    expect(out).toContain("Footer floats");
    expect(out).toMatch(/dry run/i);
    const [record] = await list();
    expect(record).not.toHaveProperty("issue");
    await expect(stat(join(root, "issue-crops"))).rejects.toThrow();
  });

  it("--per screen opens one issue per screen and links each comment", async () => {
    await create("One", { screenId: "landing" });
    await create("Two", { screenId: "landing" });
    await create("Three", { screenId: "checkout" });
    const gh = fakeGh();
    const { code } = await cli(gh.run, "--repo", "o/r", "--per", "screen");
    expect(code).toBe(0);
    const made = creates(gh.calls);
    expect(made).toHaveLength(2);
    const landing = made.find((call) => call.input?.includes("One"))!;
    expect(landing.input).toContain("Two");
    expect(landing.input).not.toContain("Three");
    const saved = await list();
    const byNote = Object.fromEntries(saved.map((item) => [item.note, item]));
    expect(byNote.One.issue.number).toBe(byNote.Two.issue.number);
    expect(byNote.Three.issue.number).not.toBe(byNote.One.issue.number);

    const again = await cli(gh.run, "--repo", "o/r", "--per", "screen");
    expect(again.code).toBe(0);
    expect(creates(gh.calls)).toHaveLength(2);
  });

  it("filters by --version, --status and skips the label with --label ''", async () => {
    await create("On v1", { version: "v1" });
    await create("On v2", { version: "v2" });
    const gh = fakeGh();
    await cli(gh.run, "--repo", "o/r", "--version", "v2", "--label", "");
    const made = creates(gh.calls);
    expect(made).toHaveLength(1);
    expect(made[0]!.input).toContain("On v2");
    expect(made[0]!.args).not.toContain("--label");
    expect(gh.calls.some((call) => call.args[0] === "label")).toBe(false);
  });

  it("reports gh failures without linking the comment", async () => {
    await create("Footer floats");
    const failing: GhRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 401: Bad credentials",
    });
    await expect(cli(failing, "--repo", "o/r")).rejects.toThrow(
      /Bad credentials/,
    );
    const [record] = await list();
    expect(record).not.toHaveProperty("issue");
  });

  it("requires --repo as owner/name", async () => {
    await expect(cli(fakeGh().run)).rejects.toThrow(/--repo/);
    await expect(cli(fakeGh().run, "--repo", "nope")).rejects.toThrow(
      /owner\/name/,
    );
  });
});

describe("screencheck issues sync", () => {
  async function linkAll(gh: ReturnType<typeof fakeGh>) {
    await cli(gh.run, "--repo", "o/r");
    return list();
  }

  it("moves comments whose issue closed to Fixed with a thread message", async () => {
    await create("Closed upstream");
    await create("Still open");
    const gh = fakeGh();
    const linked = await linkAll(gh);
    const closed = linked.find((item) => item.note === "Closed upstream")!;
    const open = linked.find((item) => item.note === "Still open")!;
    const states = { [closed.issue.number]: "CLOSED" };
    const syncGh = fakeGh(states);

    const { code, out } = await cli(syncGh.run, "sync");
    expect(code).toBe(0);
    const views = syncGh.calls.filter((call) => call.args[1] === "view");
    expect(views).toHaveLength(2);
    expect(views[0]!.args).toEqual(
      expect.arrayContaining(["--json", "state", "--repo", "o/r"]),
    );

    const after = await list();
    const fixed = after.find((item) => item.id === closed.id)!;
    expect(fixed.status).toBe("RESOLVED");
    const message = fixed.thread.at(-1);
    expect(message.note).toBe(`Closed in o/r#${closed.issue.number}`);
    expect(message.status).toBe("RESOLVED");
    expect(after.find((item) => item.id === open.id)!.status).toBe("OPEN");
    expect(out).toMatch(/1 comment moved to Fixed/);
  });

  it("never touches Verified, Won't fix or already Fixed comments", async () => {
    await create("Will be fixed by agent");
    const gh = fakeGh();
    const [item] = await linkAll(gh);
    const fixed = await send("PATCH", `${base}/${item!.id}`, {
      expectedUpdatedAt: item!.updatedAt,
      patch: { status: "RESOLVED", reply: { note: "Done" } },
    });
    expect(fixed.status).toBe(200);
    const syncGh = fakeGh({ [item!.issue.number]: "CLOSED" });
    const { code, out } = await cli(syncGh.run, "--sync");
    expect(code).toBe(0);
    const [after] = await list();
    expect(after!.status).toBe("RESOLVED");
    expect(after!.thread).toHaveLength(1);
    expect(out).toMatch(/0 comments moved/);
    expect(syncGh.calls).toHaveLength(0);
  });

  it("does nothing on --dry-run and reports what would change", async () => {
    await create("Closed upstream");
    const gh = fakeGh();
    const [item] = await linkAll(gh);
    const syncGh = fakeGh({ [item!.issue.number]: "CLOSED" });
    const { out } = await cli(syncGh.run, "sync", "--dry-run");
    expect(out).toMatch(/would move/i);
    const [after] = await list();
    expect(after!.status).toBe("OPEN");
  });

  it("asks gh once per issue in per-screen mode", async () => {
    await create("One");
    await create("Two");
    const gh = fakeGh();
    await cli(gh.run, "--repo", "o/r", "--per", "screen");
    const [first] = await list();
    const syncGh = fakeGh({ [first!.issue.number]: "CLOSED" });
    const { out } = await cli(syncGh.run, "sync");
    expect(syncGh.calls).toHaveLength(1);
    expect(out).toMatch(/2 comments moved to Fixed/);
    expect((await list()).every((item) => item.status === "RESOLVED")).toBe(
      true,
    );
  });
});

describe("CLI dispatcher", () => {
  it("lists issues in help and prints its usage", async () => {
    const lines: string[] = [];
    await main(["help"], { log: (line) => lines.push(line) });
    expect(lines.join("\n")).toMatch(/issues\s+/);
    const usage: string[] = [];
    expect(
      await main(["issues", "--help"], { log: (line) => usage.push(line) }),
    ).toBe(0);
    expect(usage.join("\n")).toMatch(/screencheck issues --project/);
  });
});
