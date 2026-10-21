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

describe("one invalid record", () => {
  it("still lists the valid records and names the bad one", async () => {
    const root = await dataRoot();
    await seed(root, [record("a"), record("bad", { status: "SHIPPED" })]);
    const storage = createFeedbackStorage({ dataRoot: root });

    expect((await storage.listFeedback("demo")).map((item) => item.id)).toEqual(
      ["a"],
    );
    const { rejected } = await storage.inspectFeedback("demo");
    expect(rejected).toEqual([
      expect.objectContaining({ index: 1, id: "bad" }),
    ]);
    expect(rejected[0]!.problem).toMatch(/^status: /);
  });

  it("refuses writes until the bad record is quarantined, then keeps it aside", async () => {
    const root = await dataRoot();
    await seed(root, [record("a"), record("bad", { x: 7 })]);
    const storage = createFeedbackStorage({ dataRoot: root });

    await expect(
      storage.updateFeedback("demo", "a", {
        expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
        patch: { note: "Edited" },
      }),
    ).rejects.toMatchObject({
      name: "FeedbackQuarantineError",
      message: expect.stringMatching(
        /feedback\[1\] \(id bad\): x: .*--quarantine/,
      ),
    });
    expect(await onDisk(root)).toHaveLength(2);

    const moved = await storage.quarantineFeedback("demo");
    expect(moved.map((item) => item.id)).toEqual(["bad"]);
    expect((await onDisk(root)).map((item) => item.id)).toEqual(["a"]);
    const aside = JSON.parse(
      await readFile(join(root, "demo", "feedback.rejected.json"), "utf8"),
    );
    expect(aside.rejected).toEqual([
      expect.objectContaining({
        problem: expect.stringMatching(/^x: /),
        record: expect.objectContaining({ id: "bad", x: 7 }),
      }),
    ]);

    await storage.updateFeedback("demo", "a", {
      expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
      patch: { note: "Edited" },
    });
    expect((await onDisk(root))[0]!.note).toBe("Edited");
  });
});

describe("last-good backup", () => {
  const createInput = {
    clientMutationId: "11111111-1111-4111-8111-111111111111",
    screenId: "landing",
    version: "live",
    x: 0.25,
    y: 0.75,
    note: "Clarify the primary action.",
  };

  it("keeps the previous version, names it when the file is damaged, and restores it", async () => {
    const root = await dataRoot();
    const storage = createFeedbackStorage({ dataRoot: root });
    const first = await storage.createFeedback("demo", createInput);
    await storage.createFeedback("demo", {
      ...createInput,
      clientMutationId: "22222222-2222-4222-8222-222222222222",
      note: "Second",
    });
    const backup = JSON.parse(
      await readFile(join(root, "demo", "feedback.json.bak"), "utf8"),
    );
    expect(backup.feedback.map((item: { id: string }) => item.id)).toEqual([
      first.id,
    ]);

    await writeFile(join(root, "demo", "feedback.json"), "{oops");
    const failure = await storage.listFeedback("demo").catch((error) => error);
    expect(failure.message).toMatch(/feedback\.json\.bak/);
    expect(failure.message).toMatch(/screencheck doctor demo --restore/);
    expect(failure.message).not.toContain(root);

    expect(await storage.restoreBackup("demo", "feedback.json")).toBe(
      "restored",
    );
    expect((await storage.listFeedback("demo")).map((item) => item.id)).toEqual(
      [first.id],
    );
    expect(await storage.restoreBackup("demo", "feedback.json")).toBe(
      "healthy",
    );
  });

  it("backs up approvals and captions too", async () => {
    const root = await dataRoot();
    const storage = createFeedbackStorage({ dataRoot: root });
    await storage.setApproval("demo", {
      version: "v1",
      screenId: "home",
      approved: true,
    });
    await storage.setApproval("demo", {
      version: "v1",
      screenId: "cart",
      approved: true,
    });
    await writeFile(join(root, "demo", "approvals.json"), "[]");
    await expect(storage.listApprovals("demo")).rejects.toThrow(
      /approvals\.json\.bak/,
    );
    expect(await storage.restoreBackup("demo", "approvals.json")).toBe(
      "restored",
    );
    expect(await storage.listApprovals("demo")).toHaveLength(1);
  });
});

describe("atomic writes", () => {
  const createInput = {
    clientMutationId: "11111111-1111-4111-8111-111111111111",
    screenId: "landing",
    version: "live",
    x: 0.25,
    y: 0.75,
    note: "Clarify the primary action.",
  };

  it("uses a unique temp file per write", async () => {
    const root = await dataRoot();
    const temps: string[] = [];
    const { rename } = await import("node:fs/promises");
    const storage = createFeedbackStorage({
      dataRoot: root,
      fileSystem: {
        rename: async (from, to) => {
          temps.push(String(from));
          await rename(from, to);
        },
      },
    });
    await storage.createFeedback("demo", createInput);
    await storage.createFeedback("demo", {
      ...createInput,
      clientMutationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
    for (const temp of temps) {
      expect(temp).toMatch(
        new RegExp(`feedback\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.next$`),
      );
    }
  });

  it.each(["EISDIR", "EPERM", "EACCES"])(
    "tolerates %s when syncing the data directory",
    async (code) => {
      const root = await dataRoot();
      const { open } = await import("node:fs/promises");
      const storage = createFeedbackStorage({
        dataRoot: root,
        fileSystem: {
          open: (async (file: string, flags?: string, mode?: number) => {
            if (flags === "r") {
              throw Object.assign(new Error(code), { code });
            }
            return open(file, flags, mode);
          }) as typeof open,
        },
      });
      await storage.createFeedback("demo", createInput);
      expect(await storage.listFeedback("demo")).toHaveLength(1);
    },
  );

  it("skips the directory sync on Windows", async () => {
    const root = await dataRoot();
    const { open } = await import("node:fs/promises");
    const flags: (string | undefined)[] = [];
    const storage = createFeedbackStorage({
      dataRoot: root,
      platform: "win32",
      fileSystem: {
        open: (async (file: string, flag?: string, mode?: number) => {
          flags.push(flag);
          return open(file, flag, mode);
        }) as typeof open,
      },
    });
    await storage.createFeedback("demo", createInput);
    expect(flags).not.toContain("r");
  });
});
