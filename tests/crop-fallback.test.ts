// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { SHARP_HINT, toWebp } from "../src/cli/capture";
import { renderPinImage } from "../src/mcp/crop";
import { decodePng } from "../src/mcp/png";

const RUST = [0xc2, 0x41, 0x0c];

function pixel(
  image: { width: number; data: Uint8Array },
  x: number,
  y: number,
) {
  const at = (y * image.width + x) * 3;
  return [...image.data.subarray(at, at + 3)];
}

async function gradient(width: number, height: number, channels: 1 | 3 | 4) {
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels;
      raw[at] = x % 256;
      if (channels >= 3) {
        raw[at + 1] = y % 256;
        raw[at + 2] = 128;
      }
      if (channels === 4) raw[at + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe("pin images without sharp (pr-18)", () => {
  it("crops a PNG around the pin and circles it, like the sharp path", async () => {
    for (const channels of [1, 3, 4] as const) {
      const capture = await gradient(1600, 1200, channels);
      const pin = { x: 0.75, y: 0.5 };
      const [withSharp, fallback] = await Promise.all([
        renderPinImage(capture, pin, { sharp }),
        renderPinImage(capture, pin, { sharp: null }),
      ]);
      expect(fallback).toMatchObject({
        mimeType: "image/png",
        marked: true,
        region: withSharp.region,
        capture: withSharp.capture,
        width: withSharp.width,
        height: withSharp.height,
        pin: withSharp.pin,
      });
      const decoded = decodePng(fallback.data)!;
      expect(decoded).toMatchObject({ width: 800, height: 600 });
      expect(pixel(decoded, fallback.pin.x, fallback.pin.y)).toEqual(RUST);
      // Away from the ring the crop shows the capture: x = 800 + 10 there.
      const away = pixel(decoded, 10, 10);
      expect(away[0]).toBe((withSharp.region.left + 10) % 256);
    }
  });

  it("scales a whole capture down", async () => {
    const capture = await gradient(1600, 1200, 3);
    const image = await renderPinImage(
      capture,
      { x: 0.1, y: 0.1 },
      { full: true, sharp: null },
    );
    expect(image).toMatchObject({
      marked: true,
      width: 800,
      height: 600,
      pin: { x: 80, y: 60 },
    });
    expect(await sharp(image.data).metadata()).toMatchObject({
      format: "png",
      width: 800,
      height: 600,
    });
  });

  it("returns other formats as stored, with the pin position", async () => {
    const capture = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#fff" },
    })
      .webp()
      .toBuffer();
    const image = await renderPinImage(
      capture,
      { x: 0.5, y: 0.5 },
      { sharp: null },
    );
    expect(image).toMatchObject({
      mimeType: "image/webp",
      marked: false,
      capture: { width: 400, height: 300 },
      pin: { x: 200, y: 150 },
    });
    expect(image.data).toBe(capture);
  });

  it("explains how to save WebP when sharp is missing", async () => {
    const missing = Object.assign(new Error("Cannot find package 'sharp'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(
      toWebp(new Uint8Array(), () => Promise.reject(missing)),
    ).rejects.toThrow(SHARP_HINT);
  });
});
