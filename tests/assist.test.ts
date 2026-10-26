// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  assistEnabledFromEnv,
  buildCopilotArgs,
  createAssist,
  findDuplicates,
  parseSuggestion,
  type Spawner,
} from "../src/server/assist";
import type { FeedbackRecord } from "../src/shared/feedback";

function ok(stdout: string): Spawner {
  return vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" }));
}

function record(id: string, note: string, extra: Partial<FeedbackRecord> = {}) {
  return {
    id,
    projectId: "demo",
    version: "v1",
    screenId: "landing",
    x: 0.5,
    y: 0.5,
    note,
    tags: ["P1"],
    status: "OPEN",
    createdAt: `2026-10-0${id.length}T00:00:00.000Z`,
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...extra,
  } as FeedbackRecord;
}

describe("Copilot CLI arguments", () => {
  it("runs one non-interactive, tool-less prompt like CopilotBridge", () => {
    expect(buildCopilotArgs("hello")).toEqual([
      "-p",
      "hello",
      "--silent",
      "--no-color",
      "--log-level",
      "none",
      "--available-tools=",
    ]);
  });
});

describe("assist adapter", () => {
  it("is available when `copilot --version` succeeds", async () => {
    const spawn = ok("1.2.3\n");
    const assist = createAssist({ spawn });
    expect(await assist.available()).toEqual({
      available: true,
      version: "1.2.3",
    });
    expect(spawn).toHaveBeenCalledWith(
      "copilot",
      ["--version"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reports a missing CLI as unavailable instead of throwing", async () => {
    const spawn: Spawner = async () => {
      throw Object.assign(new Error("spawn copilot ENOENT"), {
        code: "ENOENT",
      });
    };
    const assist = createAssist({ spawn });
    const status = await assist.available();
    expect(status.available).toBe(false);
    expect(status.error).toMatch(/ENOENT|not found/i);
  });

  it("reports a failing probe (not logged in) as unavailable", async () => {
    const spawn: Spawner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Not logged in",
    });
    const status = await createAssist({ spawn }).available();
    expect(status).toEqual({ available: false, error: "Not logged in" });
  });

  it("times out a hung CLI and aborts the child", async () => {
    let signal: AbortSignal | undefined;
    const spawn: Spawner = (_bin, _args, options) => {
      signal = options.signal;
      return new Promise(() => {});
    };
    const assist = createAssist({ spawn, timeoutMs: 20 });
    await expect(assist.rewrite("make it pop")).rejects.toMatchObject({
      code: "ASSIST_TIMEOUT",
    });
    expect(signal?.aborted).toBe(true);
    const probe = createAssist({ spawn, probeTimeoutMs: 20 });
    expect((await probe.available()).available).toBe(false);
  });

  it("rewrites a note through a tool-less prompt", async () => {
    const spawn = ok("Increase the Continue button's contrast to 4.5:1.\n");
    const assist = createAssist({ spawn });
    expect(await assist.rewrite("button hard to see")).toBe(
      "Increase the Continue button's contrast to 4.5:1.",
    );
    const args = vi.mocked(spawn).mock.calls[0]![1];
    expect(args).toContain("--available-tools=");
    expect(args[1]).toContain("button hard to see");
  });

  it("surfaces a CLI failure as an AssistError", async () => {
    const spawn: Spawner = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "quota exceeded",
    });
    await expect(createAssist({ spawn }).rewrite("x")).rejects.toMatchObject({
      code: "ASSIST_FAILED",
      message: expect.stringMatching(/quota exceeded/),
    });
  });

  it("suggests tags and a priority from JSON, even fenced", async () => {
    const spawn = ok(
      '```json\n{"priority":"p0","tags":["Contrast","P2","a11y"]}\n```',
    );
    expect(await createAssist({ spawn }).suggest("unreadable")).toEqual({
      priority: "P0",
      tags: ["Contrast", "a11y"],
    });
  });

  it("summarises a round as markdown", async () => {
    const spawn = ok("## Round summary\n- 2 open\n");
    const assist = createAssist({ spawn });
    const text = await assist.summary({
      projectId: "demo",
      version: "v1",
      feedback: [record("a", "Logo blurry"), record("bb", "Typo in header")],
    });
    expect(text).toBe("## Round summary\n- 2 open");
    const prompt = vi.mocked(spawn).mock.calls[0]![1][1]!;
    expect(prompt).toContain("Logo blurry");
    expect(prompt).toContain("#1");
  });

  it("is enabled only by SCREENCHECK_ASSIST=1 or true", () => {
    expect(assistEnabledFromEnv({})).toBe(false);
    expect(assistEnabledFromEnv({ SCREENCHECK_ASSIST: "0" })).toBe(false);
    expect(assistEnabledFromEnv({ SCREENCHECK_ASSIST: "1" })).toBe(true);
    expect(assistEnabledFromEnv({ SCREENCHECK_ASSIST: "true" })).toBe(true);
  });
});

describe("parseSuggestion", () => {
  it("drops junk and keeps at most five short tags", () => {
    expect(parseSuggestion("nope")).toBeNull();
    expect(
      parseSuggestion(
        JSON.stringify({
          priority: "urgent",
          tags: ["a", "b", "c", "d", "e", "f", 3, "x".repeat(40)],
        }),
      ),
    ).toEqual({ priority: null, tags: ["a", "b", "c", "d", "e"] });
  });
});

describe("findDuplicates", () => {
  it("finds similar notes on the same screen, best first", () => {
    const feedback = [
      record("a", "The Continue button text has low contrast"),
      record("bb", "Logo is blurry on retina"),
      record("ccc", "Continue button contrast is too low"),
      record("dddd", "Continue button contrast is too low", {
        screenId: "other",
      }),
    ];
    const found = findDuplicates(feedback, {
      version: "v1",
      screenId: "landing",
      note: "contrast on the continue button is low",
    });
    expect(found.map((item) => item.id)).toEqual(["ccc", "a"]);
    expect(found[0]!.score).toBeGreaterThan(0.5);
  });

  it("skips the comment being edited and short notes", () => {
    const feedback = [record("a", "Continue button contrast too low")];
    expect(
      findDuplicates(feedback, {
        version: "v1",
        screenId: "landing",
        note: "Continue button contrast too low",
        excludeId: "a",
      }),
    ).toEqual([]);
    expect(
      findDuplicates(feedback, {
        version: "v1",
        screenId: "landing",
        note: "low",
      }),
    ).toEqual([]);
  });
});
