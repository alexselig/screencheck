// @vitest-environment node
import sharp from "sharp";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatComment, summarize } from "../src/agent-api/comments";
import { renderPinImage } from "../src/mcp/crop";
import { decodePng } from "../src/mcp/png";
import { createFeedbackStorage } from "../src/server/storage";
import { resolvePinElement, type MappedElement } from "../src/shared/elements";
import { serializeMarkdown } from "../src/shared/export";
import {
  createFeedbackInputSchema,
  feedbackRecordSchema,
  type FeedbackRecord,
} from "../src/shared/feedback";
import {
  PIN_DRAG_THRESHOLD,
  isPinDrag,
  normalizePinBox,
  pinAnchor,
  pinBoxOf,
  pinFromBox,
} from "../src/shared/pin-box";

const createdDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataRoot() {
  await mkdir(join(process.cwd(), "tests"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), "tests/.box-pins-"));
  createdDirectories.push(directory);
  return directory;
}

const RECORD = {
  id: "box-1",
  projectId: "demo",
  screenId: "landing",
  version: "live",
  x: 0.5,
  y: 0.5,
  note: "This whole card",
  tags: ["P1"],
  status: "OPEN" as const,
  createdAt: "2026-10-26T18:00:00.000Z",
  updatedAt: "2026-10-26T18:00:00.000Z",
};

describe("drag vs click", () => {
  it("treats movement up to the threshold as a click", () => {
    expect(PIN_DRAG_THRESHOLD).toBe(6);
    expect(isPinDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(isPinDrag({ x: 10, y: 10 }, { x: 14, y: 14 })).toBe(false);
    expect(isPinDrag({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(false);
    expect(isPinDrag({ x: 10, y: 10 }, { x: 17, y: 10 })).toBe(true);
    expect(isPinDrag({ x: 10, y: 10 }, { x: 10, y: 3 })).toBe(true);
  });
});

describe("box percent math", () => {
  it("stores the same box at any frame size", () => {
    const small = { left: 0, top: 0, width: 400, height: 300 };
    const large = { left: 100, top: 50, width: 1600, height: 1200 };
    expect(
      normalizePinBox({ x: 40, y: 30 }, { x: 200, y: 120 }, small),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    expect(
      normalizePinBox({ x: 260, y: 170 }, { x: 900, y: 530 }, large),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
  });

  it("accepts a drag in any direction and clamps to the frame", () => {
    const frame = { left: 100, top: 100, width: 1000, height: 500 };
    expect(
      normalizePinBox({ x: 600, y: 350 }, { x: 350, y: 225 }, frame),
    ).toEqual({ x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    expect(
      normalizePinBox({ x: 900, y: 500 }, { x: 2000, y: 0 }, frame),
    ).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.8 });
  });

  it("keeps x/y at the box centre and draws the badge at its top-left", () => {
    const box = { x: 0.1, y: 0.2, w: 0.4, h: 0.3 };
    expect(pinFromBox(box)).toEqual({ x: 0.3, y: 0.35, box });
    expect(pinAnchor({ x: 0.3, y: 0.35, box })).toEqual({ x: 0.1, y: 0.2 });
    expect(pinAnchor({ x: 0.3, y: 0.35 })).toEqual({ x: 0.3, y: 0.35 });
  });
});

describe("box schema", () => {
  it("round-trips a box on records and create input", () => {
    const box = { x: 0.1, y: 0.2, w: 0.4, h: 0.3 };
    expect(feedbackRecordSchema.parse({ ...RECORD, box }).box).toEqual(box);
    expect(
      createFeedbackInputSchema.parse({
        clientMutationId: "11111111-1111-4111-8111-111111111111",
        screenId: "landing",
        version: "live",
        x: 0.3,
        y: 0.35,
        box,
        note: "Card",
      }).box,
    ).toEqual(box);
  });

  it("treats a box in another shape as a point pin, and keeps it", () => {
    const foreign = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const parsed = feedbackRecordSchema.parse({ ...RECORD, box: foreign });
    expect(parsed.box).toEqual(foreign);
    expect(pinBoxOf(parsed)).toBeUndefined();
    expect(pinAnchor(parsed)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("loads old point records unchanged", () => {
    const parsed = feedbackRecordSchema.parse(RECORD);
    expect(parsed).not.toHaveProperty("box");
    expect(parsed).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("rejects a box outside the capture or with no size", () => {
    const base = {
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      screenId: "landing",
      version: "live",
      x: 0.5,
      y: 0.5,
      note: "Card",
    };
    for (const box of [
      { x: 0.8, y: 0.1, w: 0.4, h: 0.1 },
      { x: 0.1, y: 0.1, w: 0, h: 0.1 },
      { x: -0.1, y: 0.1, w: 0.2, h: 0.1 },
    ]) {
      expect(
        createFeedbackInputSchema.safeParse({ ...base, box }).success,
      ).toBe(false);
    }
  });
});

describe("box persistence", () => {
  it("saves the box to feedback.json and reads it back", async () => {
    const root = await dataRoot();
    const storage = createFeedbackStorage({
      dataRoot: root,
      now: () => new Date("2026-10-26T18:00:00.000Z"),
    });
    const input = {
      clientMutationId: "22222222-2222-4222-8222-222222222222",
      screenId: "landing",
      version: "live",
      x: 0.3,
      y: 0.35,
      box: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
      note: "This whole card",
    };
    const created = await storage.createFeedback("demo", input);
    expect(created.box).toEqual(input.box);
    // A retry with the same box is the same create; a different box is not.
    expect(await storage.createFeedback("demo", input)).toEqual(created);
    await expect(
      storage.createFeedback("demo", {
        ...input,
        box: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      }),
    ).rejects.toThrow(/already used/);
    const onDisk = JSON.parse(
      await readFile(join(root, "demo", "feedback.json"), "utf8"),
    );
    expect(onDisk.feedback[0].box).toEqual(input.box);
    expect(await storage.listFeedback("demo")).toEqual([created]);
  });
});

function element(
  box: MappedElement["box"],
  rest: Partial<MappedElement> = {},
): MappedElement {
  return { box, tag: "div", selector: "div", ...rest };
}

describe("element resolution with a box", () => {
  const main = element({ x: 0, y: 0, w: 1, h: 1 }, { tag: "main" });
  const card = element(
    { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
    { tag: "article", name: "Plan card" },
  );
  const button = element(
    { x: 0.25, y: 0.2, w: 0.1, h: 0.1 },
    { tag: "button", name: "Choose" },
  );
  const map = { elements: [main, card, button] };

  it("resolves to the element best covering the box, not the one under its centre", () => {
    const box = { x: 0.09, y: 0.09, w: 0.42, h: 0.32 };
    expect(resolvePinElement(map, { x: 0.3, y: 0.25 })).toBe(button);
    expect(resolvePinElement(map, { x: 0.3, y: 0.25, box })).toBe(card);
    // A box drawn inside the card, around the button, picks the button.
    expect(
      resolvePinElement(map, {
        x: 0.3,
        y: 0.25,
        box: { x: 0.24, y: 0.19, w: 0.12, h: 0.12 },
      }),
    ).toBe(button);
  });

  it("names nothing when no element overlaps the box", () => {
    const only = { elements: [card] };
    expect(
      resolvePinElement(only, {
        x: 0.2,
        y: 0.2,
        box: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 },
      }),
    ).toBeNull();
  });
});

describe("box exports", () => {
  it("mentions the region in Markdown and agent summaries", () => {
    const record = {
      ...RECORD,
      x: 0.3,
      y: 0.35,
      box: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
    } as FeedbackRecord;
    const markdown = serializeMarkdown({
      projectId: "demo",
      screens: [],
      feedback: [record],
    });
    expect(markdown).toContain(
      "(region 10%, 20%, 40% wide × 30% tall): This whole card",
    );
    const comment = summarize(record, null, new Map([["box-1", 1]]));
    expect(comment.region).toEqual(record.box);
    expect(formatComment(comment)).toContain(
      "region 10%, 20%, 40% wide × 30% tall",
    );
    const point = serializeMarkdown({
      projectId: "demo",
      screens: [],
      feedback: [RECORD as FeedbackRecord],
    });
    expect(point).toContain("(50%, 50%): This whole card");
  });
});

async function flat(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#808080" },
  })
    .png()
    .toBuffer();
}

describe("MCP crop with a box", () => {
  it("crops around the box with padding and outlines it", async () => {
    const capture = await flat(2000, 3000);
    // 1000 x 900 px box: bigger than the default 800 x 600 crop.
    const pin = pinFromBox({ x: 0.25, y: 0.3, w: 0.5, h: 0.3 });
    const [withSharp, fallback] = await Promise.all([
      renderPinImage(capture, pin, { sharp }),
      renderPinImage(capture, pin, { sharp: null }),
    ]);
    expect(withSharp.region).toEqual({
      left: 452,
      top: 852,
      width: 1096,
      height: 996,
    });
    expect(withSharp.box).toEqual({
      left: Math.round(48 * (800 / 1096)),
      top: Math.round(48 * (800 / 1096)),
      width: Math.round(1000 * (800 / 1096)),
      height: Math.round(900 * (800 / 1096)),
    });
    expect(fallback).toMatchObject({
      region: withSharp.region,
      width: withSharp.width,
      height: withSharp.height,
      box: withSharp.box,
    });
    const decoded = decodePng(fallback.data)!;
    const at = (x: number, y: number) => {
      const index = (y * decoded.width + x) * 3;
      return [...decoded.data.subarray(index, index + 3)];
    };
    const { left, top } = fallback.box!;
    expect(at(left + 20, top)).toEqual([0xc2, 0x41, 0x0c]);
    expect(at(left + 40, top + 40)).toEqual([0x80, 0x80, 0x80]);
  });

  it("keeps the default crop for a small box, centred on it", async () => {
    const capture = await flat(1600, 1200);
    const pin = pinFromBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
    const image = await renderPinImage(capture, pin, { sharp });
    expect(image.region).toEqual({
      left: 480,
      top: 360,
      width: 800,
      height: 600,
    });
    expect(image.box).toEqual({ left: 320, top: 240, width: 160, height: 120 });
  });

  it("leaves point pins as they were", async () => {
    const capture = await flat(1600, 1200);
    const image = await renderPinImage(capture, { x: 0.5, y: 0.5 }, { sharp });
    expect(image.box).toBeUndefined();
    expect(image.region).toEqual({
      left: 400,
      top: 300,
      width: 800,
      height: 600,
    });
  });
});
