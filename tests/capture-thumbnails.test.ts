// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureFullPage } from "../src/capture/full-page";
import { captureThumbnails } from "../src/capture/thumbnail";
import { shoot } from "../src/cli/capture";
import { createThumbnailCache } from "../src/server/thumbnails";
import { thumbnailType } from "../src/shared/thumbnails";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

const HTML = `<!doctype html><html><head><style>
  html, body { margin: 0; }
  header { height: 200px; background: rgb(27, 111, 168); }
  main { height: 3000px; background: #fff; }
</style></head><body><header></header><main></main></body></html>`;

// Width and height of a PNG or WebP (VP8/VP8L/VP8X) from its header.
function dimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (thumbnailType(bytes) === "png") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
  if (chunk === "VP8X") {
    return {
      width: 1 + (view.getUint32(24, true) & 0xffffff),
      height: 1 + (view.getUint32(27, true) & 0xffffff),
    };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return {
    width: view.getUint16(26, true) & 0x3fff,
    height: view.getUint16(28, true) & 0x3fff,
  };
}

describe("capture-time thumbnails", () => {
  it("makes 400 and 800 px thumbnails of the first viewport", async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    try {
      await page.setContent(HTML);
      await captureFullPage(page, { elements: false });
      const thumbs = await captureThumbnails(page);
      expect(thumbs).not.toBeNull();
      for (const width of [400, 800] as const) {
        const bytes = thumbs![width]!;
        // Chromium encodes WebP; other browsers may fall back to PNG.
        expect(thumbnailType(bytes)).toBe("webp");
        expect(bytes.length).toBeLessThan(256 * 1024);
        // The top viewport at CSS scale, not the whole tall page.
        expect(dimensions(bytes)).toEqual({
          width,
          height: Math.round((900 * width) / 1440),
        });
      }
    } finally {
      await page.close();
    }
  });

  it("never scales a narrow screen up", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    try {
      await page.setContent(HTML);
      const thumbs = await captureThumbnails(page);
      expect(dimensions(thumbs![400]!).width).toBe(390);
      expect(dimensions(thumbs![800]!).width).toBe(390);
    } finally {
      await page.close();
    }
  });

  it("answers null from a page that can't make them", async () => {
    const fake = {
      evaluate: async () => undefined as never,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    };
    expect(await captureThumbnails(fake)).toBeNull();
  });

  it("writes them to the cache, not beside the capture", async () => {
    const root = await mkdtemp(join(process.cwd(), "tests/.thumbs-capture-"));
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await page.setContent(HTML);
      const out = join(root, "shots", "home.png");
      const cache = createThumbnailCache(join(root, "thumbs"));
      const ids = { projectId: "demo", version: "v1", screenId: "home" };
      await shoot(page, out, { cache, ids });
      expect((await readdir(join(root, "shots"))).sort()).toEqual([
        "home.elements.json",
        "home.png",
      ]);
      const { stat } = await import("node:fs/promises");
      const info = await stat(out);
      const { sourceKey } = await import("../src/server/thumbnails");
      const source = sourceKey(info.size, info.mtimeMs);
      expect(await cache.read(ids, 400, source)).not.toBeNull();
      expect(await cache.read(ids, 800, source)).not.toBeNull();
      // A re-capture leaves them stale until the next shoot.
      await writeFile(out, "different bytes");
      const later = await stat(out);
      expect(
        await cache.read(ids, 400, sourceKey(later.size, later.mtimeMs)),
      ).toBeNull();
    } finally {
      await page.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
