// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { elementMapPath } from "../src/capture/full-page";
import { runCapture } from "../src/cli/capture";
import { elementMapPathFor } from "../src/shared/elements";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), "tests/.feedback-data-capture-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MAP = {
  version: 1,
  capture: { width: 800, height: 1200 },
  elements: [],
};

function fakePlaywright(image: string, seen: string[] = []) {
  const page = {
    goto: async () => undefined,
    waitForSelector: async () => undefined,
    screenshot: async (options: { type?: string }) => {
      seen.push(`screenshot:${options.type}`);
      return new TextEncoder().encode(image);
    },
    evaluate: async (fn: () => unknown) => {
      seen.push(`evaluate:${fn.name}`);
      if (fn.name === "pinBottomChromeInPage") return { pinned: [] };
      if (fn.name === "collectElementsInPage") return MAP;
      return undefined;
    },
  };
  return async () =>
    ({
      chromium: {
        launch: async () => ({
          newPage: async () => page,
          close: async () => undefined,
        }),
      },
    }) as never;
}

describe("screencheck capture (be-1, be-11)", () => {
  it("writes the element map beside the capture, where the server looks", async () => {
    const out = join(dir, "shots", "checkout.png");
    const seen: string[] = [];
    await runCapture(
      { url: "http://x.test", out, width: 800, height: 600 },
      { log: () => {}, playwright: fakePlaywright("PNGDATA", seen) },
    );
    expect(await readFile(out, "utf8")).toBe("PNGDATA");
    expect(
      JSON.parse(
        await readFile(join(dir, "shots", "checkout.elements.json"), "utf8"),
      ),
    ).toEqual(MAP);
    expect(seen).toContain("evaluate:collectElementsInPage");
  });

  it("replaces an existing capture whole and leaves no temp files", async () => {
    const out = join(dir, "home.png");
    await writeFile(out, "OLD");
    await runCapture(
      { url: "http://x.test", out, width: 800, height: 600 },
      { log: () => {}, playwright: fakePlaywright("NEW") },
    );
    expect(await readFile(out, "utf8")).toBe("NEW");
    expect((await readdir(dir)).sort()).toEqual([
      "home.elements.json",
      "home.png",
    ]);
  });

  it("keeps the public elementMapPath in step with the shared rule", () => {
    expect(elementMapPath("shots/a.b/checkout.png")).toBe(
      elementMapPathFor("shots/a.b/checkout.png"),
    );
    expect(elementMapPath("shots/checkout.png")).toBe(
      "shots/checkout.elements.json",
    );
  });
});
