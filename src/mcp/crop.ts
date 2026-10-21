import type SharpModule from "sharp";

import { imageSize } from "../cli/image-size";
import { cropAndScale, decodePng, drawPinRing, encodePng } from "./png";

type Sharp = typeof SharpModule;

// sharp is an optional dependency: `npx screencheck mcp` starts much faster
// without its native binaries. Without it, PNG captures are cropped by a
// small pure-JS path and other formats are returned as stored.
let sharpLoad: Promise<Sharp | null> | undefined;
export function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import("sharp").then(
    (module) => module.default,
    () => null,
  );
  return sharpLoad;
}

export const CROP_WIDTH = 800;
export const CROP_HEIGHT = 600;
export const MAX_IMAGE_WIDTH = 800;
// Long full-page captures are downscaled to fit this height as well.
export const MAX_FULL_HEIGHT = 4000;

export type PinImage = {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  // False when the capture is returned as stored (no sharp, not a PNG the
  // fallback can read): the pin is not drawn and the region is the whole
  // capture.
  marked: boolean;
  // Region of the capture shown, in capture pixels.
  region: { left: number; top: number; width: number; height: number };
  capture: { width: number; height: number };
  // Output size and where the pin sits in it, in output pixels.
  width: number;
  height: number;
  pin: { x: number; y: number };
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function marker(width: number, height: number, x: number, y: number) {
  const radius = 22;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ffffff" stroke-width="9"/>
      <circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#c2410c" stroke-width="5"/>
      <circle cx="${x}" cy="${y}" r="5" fill="#c2410c" stroke="#ffffff" stroke-width="2"/>
    </svg>`,
  );
}

function regionFor(
  captureWidth: number,
  captureHeight: number,
  pinX: number,
  pinY: number,
  full: boolean,
) {
  let region = { left: 0, top: 0, width: captureWidth, height: captureHeight };
  if (!full) {
    const width = Math.min(CROP_WIDTH, captureWidth);
    const height = Math.min(CROP_HEIGHT, captureHeight);
    region = {
      left: clamp(Math.round(pinX - width / 2), 0, captureWidth - width),
      top: clamp(Math.round(pinY - height / 2), 0, captureHeight - height),
      width,
      height,
    };
  }
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / region.width,
    full ? MAX_FULL_HEIGHT / region.height : 1,
  );
  return {
    region,
    scale,
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  };
}

function pinPixel(
  pin: { x: number; y: number },
  captureWidth: number,
  captureHeight: number,
) {
  return {
    pinX: clamp(Math.round(pin.x * captureWidth), 0, captureWidth - 1),
    pinY: clamp(Math.round(pin.y * captureHeight), 0, captureHeight - 1),
  };
}

function storedType(capture: Buffer): PinImage["mimeType"] | null {
  if (capture[0] === 0x89 && capture[1] === 0x50) return "image/png";
  if (capture[0] === 0xff && capture[1] === 0xd8) return "image/jpeg";
  if (capture.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function renderWithoutSharp(
  capture: Buffer,
  pin: { x: number; y: number },
  full: boolean,
): PinImage {
  const decoded = decodePng(capture);
  if (!decoded) {
    const size = imageSize(capture);
    const mimeType = storedType(capture);
    if (!size || !mimeType) throw new Error("Capture has no readable size.");
    const { pinX, pinY } = pinPixel(pin, size.width, size.height);
    return {
      data: capture,
      mimeType,
      marked: false,
      region: { left: 0, top: 0, ...size },
      capture: size,
      width: size.width,
      height: size.height,
      pin: { x: pinX, y: pinY },
    };
  }
  const { pinX, pinY } = pinPixel(pin, decoded.width, decoded.height);
  const { region, scale, width, height } = regionFor(
    decoded.width,
    decoded.height,
    pinX,
    pinY,
    full,
  );
  const scaled = cropAndScale(decoded, region, width, height);
  const outX = Math.round((pinX - region.left) * scale);
  const outY = Math.round((pinY - region.top) * scale);
  drawPinRing(scaled, outX, outY);
  return {
    data: encodePng(scaled),
    mimeType: "image/png",
    marked: true,
    region,
    capture: { width: decoded.width, height: decoded.height },
    width,
    height,
    pin: { x: outX, y: outY },
  };
}

// Crops a capture around a pin (x, y in 0..1) and marks the pin with a ring.
// With `full`, returns the whole capture downscaled instead of a crop.
// `sharp: null` forces the fallback (tests).
export async function renderPinImage(
  capture: Buffer,
  pin: { x: number; y: number },
  {
    full = false,
    sharp: provided,
  }: { full?: boolean; sharp?: Sharp | null } = {},
): Promise<PinImage> {
  const sharp = provided === undefined ? await loadSharp() : provided;
  if (!sharp) return renderWithoutSharp(capture, pin, full);
  const meta = await sharp(capture).metadata();
  const captureWidth = meta.width;
  const captureHeight = meta.height;
  if (!captureWidth || !captureHeight) {
    throw new Error("Capture has no readable size.");
  }
  const { pinX, pinY } = pinPixel(pin, captureWidth, captureHeight);
  const { region, scale, width, height } = regionFor(
    captureWidth,
    captureHeight,
    pinX,
    pinY,
    full,
  );

  let pipeline = sharp(capture).extract(region).resize(width, height);
  if (full) pipeline = pipeline.flatten({ background: "#ffffff" });
  const scaled = await pipeline.toBuffer();
  const outX = Math.round((pinX - region.left) * scale);
  const outY = Math.round((pinY - region.top) * scale);
  const marked = sharp(scaled).composite([
    { input: marker(width, height, outX, outY), left: 0, top: 0 },
  ]);
  const data = full
    ? await marked.jpeg({ quality: 80 }).toBuffer()
    : await marked.png().toBuffer();
  return {
    data,
    mimeType: full ? "image/jpeg" : "image/png",
    marked: true,
    region,
    capture: { width: captureWidth, height: captureHeight },
    width,
    height,
    pin: { x: outX, y: outY },
  };
}
