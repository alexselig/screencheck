// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFeedbackStorage } from "../src/server/storage";

const createdDirectories: string[] = [];

async function dataRoot() {
  const directory = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function record(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "demo",
    screenId: "landing",
    version: "live",
    x: 0.5,
    y: 0.5,
    note: `Note ${id}`,
    tags: [],
    status: "OPEN",
    thread: [],
    createdAt: "2026-10-05T20:00:00.000Z",
    updatedAt: "2026-10-05T20:00:00.000Z",
    ...extra,
  };
}

async function seed(root: string, feedback: unknown[]) {
  await mkdir(join(root, "demo"), { recursive: true });
  await writeFile(
    join(root, "demo", "feedback.json"),
    JSON.stringify({ version: 1, schemaVersion: 2, feedback }),
  );
}

async function onDisk(root: string) {
  return JSON.parse(await readFile(join(root, "demo", "feedback.json"), "utf8"))
    .feedback as Record<string, unknown>[];
}

describe("unknown fields on disk", () => {
  it("keeps fields this build doesn't know when another record is edited", async () => {
    const root = await dataRoot();
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    await seed(root, [
      record("a", {
        box,
        thread: [
          {
            id: "m1",
            role: "reviewer",
            author: "Alex",
            note: "Look here",
            at: "2026-10-05T20:00:00.000Z",
            mood: "curious",
          },
        ],
      }),
      record("b"),
    ]);
    const storage = createFeedbackStorage({ dataRoot: root });

    await storage.updateFeedback("demo", "b", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { note: "Edited" },
    });

    const [first] = await onDisk(root);
    expect(first!.box).toEqual(box);
    expect((first!.thread as Record<string, unknown>[])[0]!.mood).toBe(
      "curious",
    );
  });

  it("keeps unknown fields on the record being edited", async () => {
    const root = await dataRoot();
    await seed(root, [record("a", { anchor: { selector: "#buy" } })]);
    const storage = createFeedbackStorage({ dataRoot: root });

    await storage.updateFeedback("demo", "a", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { status: "IN_PROGRESS" },
    });

    expect((await onDisk(root))[0]!.anchor).toEqual({ selector: "#buy" });
  });
});
