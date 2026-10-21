// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli/index";
import { createFeedbackStorage } from "../src/server/storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function dataRoot() {
  const root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  roots.push(root);
  return root;
}

function run(argv: string[]) {
  const out: string[] = [];
  return main(argv, {
    log: (line) => out.push(line),
    error: (line) => out.push(line),
    readRuntime: () => null,
  }).then((code) => ({ code, out: out.join("\n") }));
}

const createInput = {
  clientMutationId: "11111111-1111-4111-8111-111111111111",
  screenId: "landing",
  version: "live",
  x: 0.25,
  y: 0.75,
  note: "Clarify the primary action.",
};

describe("screencheck doctor", () => {
  it("reports a damaged file, restores it from backup, and reports healthy", async () => {
    const root = await dataRoot();
    const storage = createFeedbackStorage({ dataRoot: root });
    const first = await storage.createFeedback("demo", createInput);
    await storage.createFeedback("demo", {
      ...createInput,
      clientMutationId: "22222222-2222-4222-8222-222222222222",
    });
    await writeFile(join(root, "demo", "feedback.json"), "{broken");

    const checked = await run(["doctor", "--data", root]);
    expect(checked.code).toBe(1);
    expect(checked.out).toMatch(/demo\/feedback\.json: .*invalid JSON/);
    expect(checked.out).toMatch(/--restore/);

    const restored = await run(["doctor", "demo", "--restore", "--data", root]);
    expect(restored.code).toBe(0);
    expect(restored.out).toMatch(/restored from feedback\.json\.bak/);
    expect(restored.out).toMatch(/demo\/feedback\.json: ok \(1\)/);
    expect((await storage.listFeedback("demo")).map((item) => item.id)).toEqual(
      [first.id],
    );
    const damaged = (await import("node:fs/promises")).readdir(
      join(root, "demo"),
    );
    expect((await damaged).some((name) => name.includes(".damaged-"))).toBe(
      true,
    );
  });

  it("quarantines invalid records", async () => {
    const root = await dataRoot();
    const storage = createFeedbackStorage({ dataRoot: root });
    const created = await storage.createFeedback("demo", createInput);
    const file = join(root, "demo", "feedback.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.feedback.push({ ...created, id: "bad", y: -1 });
    await writeFile(file, JSON.stringify(envelope));

    expect((await run(["doctor", "demo", "--data", root])).code).toBe(1);
    const fixed = await run(["doctor", "demo", "--quarantine", "--data", root]);
    expect(fixed.code).toBe(0);
    expect(fixed.out).toMatch(/moved 1 invalid record/);
    expect(await storage.listFeedback("demo")).toHaveLength(1);
  });
});
