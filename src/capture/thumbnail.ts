// Screen index thumbnails made at capture time: the first viewport, shot at
// CSS scale and encoded in the page at 400 and 800 px wide. Playwright only
// writes PNG and JPEG, so the browser's own encoder makes the WebP (PNG where
// it has no WebP encoder). No runtime imports, so plain `node` scripts can
// import this file the same way they import full-page.ts.
import type { CapturePage } from "./full-page";

export const CAPTURE_THUMBNAIL_WIDTHS = [400, 800] as const;

export type CapturedThumbnails = Partial<Record<400 | 800, Uint8Array>>;

type Encoded = { width: number; data: string };

// Runs in the page. Decodes the PNG it is given, scales it to each width
// (never up), and answers base64 WebP or PNG bytes per width.
export async function encodeThumbnailsInPage(input: {
  png: string;
  widths: number[];
}): Promise<Encoded[]> {
  const binary = atob(input.png);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/png" }),
  );
  const out: Encoded[] = [];
  try {
    for (const width of input.widths) {
      const scaled = Math.min(width, bitmap.width);
      const height = Math.max(
        1,
        Math.round((bitmap.height * scaled) / bitmap.width),
      );
      const canvas = new OffscreenCanvas(scaled, height);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, scaled, height);
      let blob = await canvas.convertToBlob({
        type: "image/webp",
        quality: 0.82,
      });
      if (blob.type !== "image/webp") {
        blob = await canvas.convertToBlob({ type: "image/png" });
      }
      const view = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let index = 0; index < view.length; index += 0x8000) {
        text += String.fromCharCode(...view.subarray(index, index + 0x8000));
      }
      out.push({ width, data: btoa(text) });
    }
  } finally {
    bitmap.close();
  }
  return out;
}

const fromBase64 = (data: string) =>
  new Uint8Array(Buffer.from(data, "base64"));

// Shoots the current viewport and makes both thumbnails. Answers null when
// the page can't (a fake page in tests, or no OffscreenCanvas), so a capture
// never fails for want of a thumbnail.
export async function captureThumbnails(
  page: CapturePage,
): Promise<CapturedThumbnails | null> {
  try {
    const shot = await page.screenshot({ type: "png", scale: "css" });
    if (!shot || shot.length === 0) return null;
    const input = {
      png: Buffer.from(shot).toString("base64"),
      widths: [...CAPTURE_THUMBNAIL_WIDTHS],
    };
    // A string, with the no-op __name() esbuild runners' keepNames expects.
    const encoded = await page.evaluate<Encoded[] | undefined>(
      `globalThis.__name = globalThis.__name || function (t) { return t; };
      (${encodeThumbnailsInPage.toString()})(${JSON.stringify(input)})`,
    );
    if (!Array.isArray(encoded) || encoded.length === 0) return null;
    const result: CapturedThumbnails = {};
    for (const { width, data } of encoded) {
      if (width === 400 || width === 800) result[width] = fromBase64(data);
    }
    return result;
  } catch {
    return null;
  }
}
