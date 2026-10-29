// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AXE_MISSING_NOTICE,
  a11yReportPath,
  captureFractionBox,
  captureFullPage,
  loadAxeSource,
  toA11yReport,
} from "../src/capture/full-page";
import {
  a11yReportPathFor,
  a11yReportSchema,
  suggestionsFromReport,
} from "../src/shared/a11y";

let browser: Browser;
let root: string;

beforeAll(async () => {
  browser = await chromium.launch();
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-a11y-"));
});

afterAll(async () => {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
});

const FIXTURE = `<!doctype html><html lang="en"><head><title>Sailings</title><style>
  html, body { margin: 0; font: 14px sans-serif; background: #fff; }
  main { height: 1600px; padding: 20px; box-sizing: border-box; }
  .faint { color: #ccc; margin-top: 900px; }
</style></head><body>
  <main>
    <h1>Pick a sailing</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">
    <p class="faint" id="faint">Arrives 09:35</p>
  </main>
</body></html>`;

describe("a11y report mapping", () => {
  it("maps document-pixel rects to clamped, rounded capture fractions", () => {
    const capture = { width: 400, height: 1000 };
    expect(
      captureFractionBox(
        { left: 40, top: 100, right: 140, bottom: 150 },
        capture,
      ),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.25, h: 0.05 });
    // Clamped to the capture.
    expect(
      captureFractionBox(
        { left: -10, top: 950, right: 500, bottom: 1200 },
        capture,
      ),
    ).toEqual({ x: 0, y: 0.95, w: 1, h: 0.05 });
    expect(
      captureFractionBox(
        { left: 500, top: 0, right: 600, bottom: 10 },
        capture,
      ),
    ).toBeUndefined();
  });

  it("turns an axe result into a valid report, keeping rule, impact, help and link", () => {
    const report = toA11yReport({
      capture: { width: 200, height: 400 },
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          help: "Elements must meet minimum color contrast ratio thresholds",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
          nodes: [
            {
              target: "#faint",
              rect: { left: 20, top: 200, right: 120, bottom: 220 },
              summary:
                "Fix any of the following:\n  Element has insufficient color contrast",
            },
            { target: "#offscreen", rect: null },
          ],
        },
        { id: "made-up", impact: "weird", help: "Odd", nodes: [] },
      ],
    });
    expect(a11yReportSchema.parse(report)).toEqual(report);
    expect(report.violations[0]!.nodes[0]).toEqual({
      target: "#faint",
      box: { x: 0.1, y: 0.5, w: 0.5, h: 0.05 },
      summary:
        "Fix any of the following: Element has insufficient color contrast",
    });
    expect(report.violations[0]!.nodes[1]).toEqual({ target: "#offscreen" });
    expect(report.violations[1]!.impact).toBeNull();
    expect(suggestionsFromReport(report)).toHaveLength(1);
  });

  it("names the report like the element map", () => {
    expect(a11yReportPath("shots/checkout.png")).toBe(
      "shots/checkout.a11y.json",
    );
    expect(a11yReportPathFor("a.b/c.webp")).toBe(a11yReportPath("a.b/c.webp"));
  });
});

describe("captureFullPage with a11y", () => {
  it("is off by default", async () => {
    const page = await browser.newPage({
      viewport: { width: 400, height: 300 },
    });
    try {
      await page.setContent(FIXTURE);
      const out = join(root, "off.png");
      const result = await captureFullPage(page, { path: out });
      expect(result.a11y).toBeNull();
      await expect(stat(a11yReportPath(out))).rejects.toThrow();
    } finally {
      await page.close();
    }
  });

  it("runs axe and writes <capture>.a11y.json with boxes matching the element map", async () => {
    const page = await browser.newPage({
      viewport: { width: 400, height: 300 },
    });
    try {
      await page.setContent(FIXTURE);
      const out = join(root, "on.png");
      const result = await captureFullPage(page, { path: out, a11y: true });
      expect(result.a11yNotice).toBeUndefined();
      const written = a11yReportSchema.parse(
        JSON.parse(await readFile(a11yReportPath(out), "utf8")),
      );
      expect(written).toEqual(result.a11y);
      expect(written.engine?.name).toBe("axe-core");
      const ids = written.violations.map((violation) => violation.id);
      expect(ids).toContain("image-alt");
      expect(ids).toContain("color-contrast");
      const contrast = written.violations.find(
        (violation) => violation.id === "color-contrast",
      )!;
      expect(contrast.impact).toBe("serious");
      expect(contrast.helpUrl).toMatch(/^https:\/\//);
      const node = contrast.nodes.find((item) => item.target === "#faint")!;
      const mapped = result.elements!.elements.find(
        (element) => element.selector === "#faint",
      )!;
      expect(node.box).toEqual(mapped.box);
      // Below the first screenful of a full-page capture.
      expect(node.box!.y).toBeGreaterThan(0.5);
    } finally {
      await page.close();
    }
  });

  it("skips with a notice, and still captures, when axe-core is missing", async () => {
    const page = await browser.newPage({
      viewport: { width: 400, height: 300 },
    });
    try {
      await page.setContent(FIXTURE);
      const out = join(root, "missing.png");
      const result = await captureFullPage(page, {
        path: out,
        a11y: { loadAxe: async () => null },
      });
      expect(result.image.length).toBeGreaterThan(0);
      expect(result.elements).not.toBeNull();
      expect(result.a11y).toBeNull();
      expect(result.a11yNotice).toBe(AXE_MISSING_NOTICE);
      await expect(stat(a11yReportPath(out))).rejects.toThrow();
    } finally {
      await page.close();
    }
  });
});

describe("loadAxeSource", () => {
  it("returns axe-core's browser source when installed", async () => {
    expect(await loadAxeSource()).toMatch(/axe v4\./);
  });

  it("returns null when axe-core is not installed", async () => {
    const missing = Object.assign(new Error("Cannot find package 'axe-core'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(await loadAxeSource(() => Promise.reject(missing))).toBeNull();
  });

  it("rethrows other load failures", async () => {
    await expect(
      loadAxeSource(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});
