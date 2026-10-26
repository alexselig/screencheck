// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchesFilter } from "../src/agent-api/comments";
import { createFeedbackStorage } from "../src/server/storage";
import {
  cleanAuthorName,
  createFeedbackInputSchema,
  feedbackRecordSchema,
} from "../src/shared/feedback";
import {
  mentionsName,
  parseMentions,
  splitMentions,
} from "../src/shared/mentions";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-reviewer-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const createInput = {
  clientMutationId: "11111111-1111-4111-8111-111111111111",
  screenId: "landing",
  version: "live",
  x: 0.5,
  y: 0.5,
  note: "Footer floats.",
};

const stored = {
  id: "old",
  projectId: "demo",
  screenId: "landing",
  version: "live",
  x: 0.5,
  y: 0.5,
  note: "Saved before names existed.",
  tags: ["P1"],
  status: "OPEN",
  createdAt: "2026-10-05T19:00:00.000Z",
  updatedAt: "2026-10-05T19:00:00.000Z",
};

describe("author names", () => {
  it("strips control characters and bidi overrides, and collapses spaces", () => {
    expect(cleanAuthorName("  Ada\u0000 \n Lovelace\u202e ")).toBe(
      "Ada Lovelace",
    );
  });

  it("accepts a name up to 60 characters on a new comment", () => {
    const parsed = createFeedbackInputSchema.parse({
      ...createInput,
      author: " Ada\tLovelace ",
    });
    expect(parsed.author).toBe("Ada Lovelace");
    expect(
      createFeedbackInputSchema.safeParse({
        ...createInput,
        author: "x".repeat(61),
      }).success,
    ).toBe(false);
    expect(
      createFeedbackInputSchema.safeParse({ ...createInput, author: "\u0007" })
        .success,
    ).toBe(false);
  });

  it("reads comments without an author unchanged", () => {
    const record = feedbackRecordSchema.parse(stored);
    expect(record).not.toHaveProperty("author");
    expect(record.note).toBe("Saved before names existed.");
  });

  it("drops an unusable stored author instead of the comment", () => {
    const record = feedbackRecordSchema.parse({
      ...stored,
      author: "y".repeat(80),
    });
    expect(record).not.toHaveProperty("author");
    expect(record.id).toBe("old");
  });
});

describe("author stamping on the server", () => {
  it("persists the author on a new comment and on reviewer messages", async () => {
    const storage = createFeedbackStorage({ dataRoot: root });
    const created = await storage.createFeedback("demo", {
      ...createInput,
      author: "Ada",
    });
    expect(created.author).toBe("Ada");
    const updated = await storage.updateFeedback("demo", created.id, {
      expectedUpdatedAt: created.updatedAt,
      patch: {
        message: {
          note: "@agent see this",
          author: "Ada\u0000",
          role: "reviewer",
        },
      },
    });
    expect(updated.thread?.at(-1)).toMatchObject({
      author: "Ada",
      role: "reviewer",
    });
    const onDisk = JSON.parse(
      await readFile(join(root, "demo", "feedback.json"), "utf8"),
    );
    expect(onDisk.feedback[0].author).toBe("Ada");
  });

  it("still creates comments without an author", async () => {
    const storage = createFeedbackStorage({ dataRoot: root });
    const created = await storage.createFeedback("demo", createInput);
    expect(created).not.toHaveProperty("author");
    const updated = await storage.updateFeedback("demo", created.id, {
      expectedUpdatedAt: created.updatedAt,
      patch: { message: { note: "Follow-up", role: "reviewer" } },
    });
    expect(updated.thread?.at(-1)?.author).toBe("Reviewer");
  });

  it("loads an older feedback.json with no authors", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(
      join(root, "demo", "feedback.json"),
      JSON.stringify({ version: 1, feedback: [stored] }),
    );
    const storage = createFeedbackStorage({ dataRoot: root });
    const [record] = await storage.listFeedback("demo");
    expect(record).toMatchObject({ id: "old", thread: [] });
    expect(record).not.toHaveProperty("author");
  });
});

describe("mentions", () => {
  it("finds @agent and @names, not email addresses", () => {
    expect(
      parseMentions(
        "@Agent please check, cc @ada.l and @Bob-2. ada@example.com",
      ),
    ).toEqual(["agent", "ada.l", "bob-2"]);
    expect(parseMentions("no mentions here @")).toEqual([]);
  });

  it("splits text into plain runs and mention chips", () => {
    expect(splitMentions("Hi @agent, done?")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "mention", text: "@agent", name: "agent" },
      { kind: "text", text: ", done?" },
    ]);
  });

  it("matches a comment by its note or any thread message", () => {
    const record = {
      note: "Footer floats.",
      thread: [{ note: "Over to you @Agent" }],
    };
    expect(mentionsName(record, "agent")).toBe(true);
    expect(mentionsName(record, "@AGENT")).toBe(true);
    expect(mentionsName(record, "ada")).toBe(false);
    expect(mentionsName({ note: "@ada look" }, "Ada")).toBe(true);
  });

  it("filters comments by mention alongside the other filters", () => {
    const item = {
      ...stored,
      thread: [{ note: "@agent can you look?" }],
    };
    expect(matchesFilter(item, { mentions: "agent" })).toBe(true);
    expect(matchesFilter(item, { mentions: "ada" })).toBe(false);
    expect(matchesFilter(item, {})).toBe(true);
  });
});
