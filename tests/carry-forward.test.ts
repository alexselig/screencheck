// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";
import { createFeedbackStorage } from "../src/server/storage";
import { newestSameSize, planCarry } from "../src/shared/carry";
import { serializeMarkdown } from "../src/shared/export";
import type { FeedbackRecord } from "../src/shared/feedback";

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

const element = (
  name: string,
  box: { x: number; y: number; w: number; h: number },
) => ({ box, tag: "button", role: "button", name, selector: `#${name}` });

const MAP_B1 = {
  version: 1,
  capture: { width: 1440, height: 1000 },
  elements: [
    element("pay", { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
    element("help", { x: 0.5, y: 0.1, w: 0.2, h: 0.1 }),
    element("promo", { x: 0.1, y: 0.6, w: 0.2, h: 0.1 }),
  ],
};
// Next build: pay stays, help moved down, promo is gone.
const MAP_B2 = {
  version: 1,
  capture: { width: 1440, height: 1000 },
  elements: [
    element("pay", { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
    element("help", { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }),
  ],
};

const version = (id: string, revision: string, label: string) => ({
  id,
  revision,
  label,
  captureRoot: join(root, "captures", id),
});

async function register(versions: ReturnType<typeof version>[]) {
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions,
      screens: [
        {
          id: "home",
          ordinal: 1,
          title: "Home",
          capturePath: "home.png",
          viewport: { width: 1440, height: 1000 },
        },
      ],
    }),
  );
}

async function captureDir(id: string, map?: unknown) {
  const dir = join(root, "captures", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "home.png"), "png");
  if (map)
    await writeFile(join(dir, "home.elements.json"), JSON.stringify(map));
}

const B1 = () => [
  version("b1-1440", "b1", "1440"),
  version("b1-390", "b1", "390"),
];
const B2 = () => [
  version("b2-1440", "b2", "1440"),
  version("b2-390", "b2", "390"),
];

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-carry-"));
  await mkdir(join(root, "projects"));
  await captureDir("b1-1440", MAP_B1);
  await captureDir("b1-390");
  await captureDir("b2-1440", MAP_B2);
  await captureDir("b2-390");
  await register(B1());
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const base = () => `${server.origin}/api/projects/demo/feedback`;

async function post(body: Record<string, unknown>) {
  const response = await fetch(base(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.origin,
      "x-screencheck-actor": "reviewer",
    },
    body: JSON.stringify({
      clientMutationId: crypto.randomUUID(),
      screenId: "home",
      tags: [],
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).feedback as FeedbackRecord;
}

async function list() {
  const response = await fetch(base());
  expect(response.status).toBe(200);
  return (await response.json()).feedback as FeedbackRecord[];
}

describe("carry forward", () => {
  it("records the element under a new pin", async () => {
    const created = await post({
      version: "b1-1440",
      x: 0.15,
      y: 0.12,
      note: "Pay button",
    });
    expect(created.element).toMatchObject({
      selector: "#pay",
      capture: { width: 1440, height: 1000 },
    });
    // No map, no element; the comment is still saved.
    const bare = await post({ version: "b1-390", x: 0.5, y: 0.5, note: "x" });
    expect(bare.element).toBeUndefined();
  });

  it("moves open comments to the newest build, re-anchored and flagged", async () => {
    const pay = await post({
      version: "b1-1440",
      x: 0.15,
      y: 0.12,
      note: "Pay",
    });
    const help = await post({
      version: "b1-1440",
      x: 0.55,
      y: 0.15,
      note: "Help",
    });
    const promo = await post({
      version: "b1-1440",
      x: 0.2,
      y: 0.65,
      note: "Promo",
    });
    const phone = await post({
      version: "b1-390",
      x: 0.3,
      y: 0.3,
      note: "Phone",
      scope: "all",
    });
    const fixed = await post({
      version: "b1-1440",
      x: 0.9,
      y: 0.9,
      note: "Done",
      status: "VERIFIED",
    });
    expect((await list()).every((item) => item.version.startsWith("b1"))).toBe(
      true,
    );

    await register([...B1(), ...B2()]);
    const carried = new Map((await list()).map((item) => [item.id, item]));
    expect(carried.size).toBe(5);

    expect(carried.get(pay.id)).toMatchObject({
      version: "b2-1440",
      x: 0.15,
      y: 0.12,
      carriedFrom: ["b1-1440"],
    });
    expect(carried.get(pay.id)!.checkPlacement).toBeUndefined();

    const moved = carried.get(help.id)!;
    expect(moved).toMatchObject({ version: "b2-1440", checkPlacement: true });
    expect(moved.x).toBeCloseTo(0.55);
    expect(moved.y).toBeCloseTo(0.55);

    expect(carried.get(promo.id)).toMatchObject({
      version: "b2-1440",
      x: 0.2,
      y: 0.65,
      checkPlacement: true,
    });
    // No maps at 390: the % position, flagged.
    expect(carried.get(phone.id)).toMatchObject({
      version: "b2-390",
      scope: "all",
      checkPlacement: true,
      carriedFrom: ["b1-390"],
    });
    // Closed comments stay with the build they were made on.
    expect(carried.get(fixed.id)!.version).toBe("b1-1440");

    // Reading again moves nothing.
    const again = await list();
    expect(again.find((item) => item.id === pay.id)!.updatedAt).toBe(
      carried.get(pay.id)!.updatedAt,
    );

    // Placement OK clears the flag.
    const response = await fetch(`${base()}/${help.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({
        expectedUpdatedAt: moved.updatedAt,
        patch: { checkPlacement: false },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).feedback.checkPlacement).toBeUndefined();
  });

  it("keeps carrying across several builds", async () => {
    const pay = await post({
      version: "b1-1440",
      x: 0.15,
      y: 0.12,
      note: "Pay",
    });
    await register([...B1(), ...B2()]);
    await list();
    await captureDir("b3-1440", MAP_B2);
    await register([...B1(), ...B2(), version("b3-1440", "b3", "1440")]);
    const record = (await list()).find((item) => item.id === pay.id)!;
    expect(record).toMatchObject({
      version: "b3-1440",
      carriedFrom: ["b1-1440", "b2-1440"],
    });
  });
});

describe("planning", () => {
  const versions = [
    { id: "a", revision: "r1", label: "1440" },
    { id: "b", revision: "r1", label: "390" },
    { id: "c", revision: "r2", label: "1440" },
  ];
  it("finds the same size in the newest build", () => {
    expect(newestSameSize(versions, "a")).toBe("c");
    // The newest build has no 390, so it stays.
    expect(newestSameSize(versions, "b")).toBeUndefined();
    expect(newestSameSize(versions, "c")).toBeUndefined();
    expect(newestSameSize(versions, "zz")).toBeUndefined();
    // Builds without sizes match one another.
    expect(newestSameSize([{ id: "v1" }, { id: "v2" }], "v1")).toBe("v2");
  });

  it("plans only open comments", () => {
    const record = (status: string) =>
      ({ id: status, version: "a", status }) as FeedbackRecord;
    expect(
      planCarry(
        ["OPEN", "IN_PROGRESS", "RESOLVED", "VERIFIED", "WONT_FIX"].map(record),
        versions,
      ).map((plan) => plan.record.id),
    ).toEqual(["OPEN", "IN_PROGRESS"]);
  });
});

describe("scope", () => {
  it("persists all-sizes comments and loads old records unchanged", async () => {
    const dataRoot = join(root, "store");
    await mkdir(join(dataRoot, "demo"), { recursive: true });
    const old = {
      id: "old",
      projectId: "demo",
      screenId: "home",
      version: "b1-1440",
      x: 0.5,
      y: 0.5,
      note: "Before scopes",
      tags: [],
      status: "OPEN",
      thread: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const foreign = { ...old, id: "foreign", scope: "page" };
    await writeFile(
      join(dataRoot, "demo", "feedback.json"),
      JSON.stringify({
        version: 1,
        schemaVersion: 2,
        feedback: [old, foreign],
      }),
    );
    const storage = createFeedbackStorage({ dataRoot });
    const [loaded, unknown] = await storage.listFeedback("demo");
    expect(loaded).toEqual(old);
    expect(unknown!.scope).toBeUndefined();

    const all = await storage.createFeedback("demo", {
      clientMutationId: crypto.randomUUID(),
      screenId: "home",
      version: "b1-1440",
      x: 0.2,
      y: 0.2,
      note: "Header wraps",
      scope: "all",
    });
    expect(all.scope).toBe("all");
    const raw = JSON.parse(
      await readFile(join(dataRoot, "demo", "feedback.json"), "utf8"),
    );
    expect(raw.feedback.at(-1).scope).toBe("all");
    const narrowed = await storage.updateFeedback("demo", all.id, {
      expectedUpdatedAt: all.updatedAt,
      patch: { scope: "size" },
    });
    expect(narrowed.scope).toBeUndefined();
  });
});

describe("Markdown export with sizes", () => {
  it("groups a screen's comments as All sizes, then by size", () => {
    const at = (minute: number) => `2026-10-01T10:0${minute}:00.000Z`;
    const base = {
      projectId: "demo",
      screenId: "home",
      x: 0.5,
      y: 0.5,
      tags: [],
      status: "OPEN" as const,
    };
    const markdown = serializeMarkdown({
      projectId: "demo",
      screens: [
        { id: "home", ordinal: 1, title: "Home", group: "Main" } as never,
      ],
      versions: [
        { id: "r1-1440", label: "1440" },
        { id: "r1-390", label: "390" },
      ],
      feedback: [
        {
          ...base,
          id: "s390",
          version: "r1-390",
          note: "Small only",
          createdAt: at(1),
          updatedAt: at(1),
        },
        {
          ...base,
          id: "s1440",
          version: "r1-1440",
          note: "Wide only",
          createdAt: at(2),
          updatedAt: at(2),
        },
        {
          ...base,
          id: "all",
          version: "r1-1440",
          note: "Everywhere",
          scope: "all",
          createdAt: at(3),
          updatedAt: at(3),
        },
      ] as FeedbackRecord[],
    });
    const order = [
      "## 01 · Home",
      "### All sizes",
      "Everywhere",
      "Pinned at 1440",
      "### 1440",
      "Wide only",
      "### 390",
      "Small only",
    ].map((text) => markdown.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
