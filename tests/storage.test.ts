import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FeedbackConflictError,
  createFeedbackStorage,
} from "../src/server/storage";
import { normalizePinCoordinates } from "../src/shared/feedback";

const createdDirectories: string[] = [];

async function dataRoot() {
  await mkdir(join(process.cwd(), "tests"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  createdDirectories.push(directory);
  return directory;
}

const createInput = {
  clientMutationId: "11111111-1111-4111-8111-111111111111",
  screenId: "landing",
  version: "live",
  x: 0.25,
  y: 0.75,
  note: "Clarify the primary action.",
  tags: ["P1"],
};

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("feedback storage", () => {
  it("normalizes pin coordinates and rejects positions outside the frame", () => {
    expect(
      normalizePinCoordinates(520, 350, {
        left: 20,
        top: 100,
        width: 1000,
        height: 500,
      }),
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(() =>
      normalizePinCoordinates(0, 0, {
        left: 20,
        top: 100,
        width: 1000,
        height: 500,
      }),
    ).toThrow(/inside/i);
  });

  it("uses the client mutation ID as a stable id across create retries", async () => {
    const storage = createFeedbackStorage({
      dataRoot: await dataRoot(),
      now: () => new Date("2026-10-05T20:00:00.000Z"),
    });

    const first = await storage.createFeedback("demo", createInput);
    const retry = await storage.createFeedback("demo", createInput);

    expect(first.id).toBe(createInput.clientMutationId);
    expect(retry).toEqual(first);
    expect(await storage.listFeedback("demo")).toEqual([first]);
  });

  it("writes and syncs a temp file before atomically renaming it", async () => {
    const root = await dataRoot();
    let inspectedNextFile = false;
    let temp = "";
    const storage = createFeedbackStorage({
      dataRoot: root,
      fileSystem: {
        rename: async (from, to) => {
          temp = String(from);
          expect(from).toMatch(/feedback\.json\.\d+\.[0-9a-f-]+\.next$/);
          expect(String(from).startsWith(join(root, "demo"))).toBe(true);
          expect(to).toBe(join(root, "demo", "feedback.json"));
          expect(
            JSON.parse(await readFile(from, "utf8")).feedback,
          ).toHaveLength(1);
          inspectedNextFile = true;
          await rename(from, to);
        },
      },
    });

    await storage.createFeedback("demo", createInput);

    expect(inspectedNextFile).toBe(true);
    await expect(readFile(temp, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects stale updates and returns the current record", async () => {
    const storage = createFeedbackStorage({
      dataRoot: await dataRoot(),
      now: (() => {
        const values = [
          new Date("2026-10-05T20:00:00.000Z"),
          new Date("2026-10-05T20:00:01.000Z"),
        ];
        return () => values.shift() ?? new Date("2026-10-05T20:00:02.000Z");
      })(),
    });
    const created = await storage.createFeedback("demo", createInput);
    const updated = await storage.updateFeedback("demo", created.id, {
      expectedUpdatedAt: created.updatedAt,
      patch: { note: "Use a more direct primary action." },
    });

    await expect(
      storage.updateFeedback("demo", created.id, {
        expectedUpdatedAt: created.updatedAt,
        patch: {
          status: "RESOLVED",
          reply: { note: "Updated the primary action.", author: "Agent" },
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FeedbackConflictError>>({
        name: "FeedbackConflictError",
        current: updated,
      }),
    );
  });

  it("refuses invalid persisted JSON instead of overwriting it", async () => {
    const root = await dataRoot();
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "feedback.json"), "{broken", "utf8");
    const storage = createFeedbackStorage({ dataRoot: root });

    await expect(storage.listFeedback("demo")).rejects.toThrow(
      /feedback\.json.*invalid json/i,
    );
    await expect(storage.createFeedback("demo", createInput)).rejects.toThrow(
      /feedback\.json.*invalid json/i,
    );
    expect(await readFile(join(root, "demo", "feedback.json"), "utf8")).toBe(
      "{broken",
    );
  });

  it("recovers persisted feedback after a storage instance restart", async () => {
    const root = await dataRoot();
    const firstStorage = createFeedbackStorage({ dataRoot: root });
    const created = await firstStorage.createFeedback("demo", createInput);

    const restartedStorage = createFeedbackStorage({ dataRoot: root });

    expect(await restartedStorage.listFeedback("demo")).toEqual([created]);
  });

  it("serializes concurrent mutations so neither atomic write is lost", async () => {
    const storage = createFeedbackStorage({ dataRoot: await dataRoot() });

    await Promise.all([
      storage.createFeedback("demo", createInput),
      storage.createFeedback("demo", {
        ...createInput,
        clientMutationId: "22222222-2222-4222-8222-222222222222",
        note: "Second concurrent note.",
      }),
    ]);

    expect(await storage.listFeedback("demo")).toHaveLength(2);
  });

  it("deletes only the expected persisted revision", async () => {
    const storage = createFeedbackStorage({ dataRoot: await dataRoot() });
    const created = await storage.createFeedback("demo", createInput);

    await storage.deleteFeedback("demo", created.id, created.updatedAt);

    expect(await storage.listFeedback("demo")).toEqual([]);
  });
});
