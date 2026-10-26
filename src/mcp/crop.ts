import type SharpModule from "sharp";

import { imageSize } from "../cli/image-size";
import { pinBoxOf } from "../shared/pin-box";
import {
  cropAndScale,
  decodePng,
  drawBoxOutline,
  drawPinRing,
  encodePng,
} from "./png";

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
// Space kept around a box pin's region, in capture pixels.
export const BOX_PADDING = 48;

type Rect = { left: number; top: number; width: number; height: number };
type Pin = { x: number; y: number; box?: unknown };

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
  // Box pins: the outlined region, in output pixels.
  box?: Rect;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function marker(
  width: number,
  height: number,
  x: number,
  y: number,
  box?: Rect,
) {
  const radius = 22;
  if (box) {
    const rect = `x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none"`;
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect ${rect} stroke="#ffffff" stroke-width="5"/>
      <rect ${rect} stroke="#c2410c" stroke-width="3"/>
    </svg>`,
    );
  }
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
  box?: Rect,
) {
  let region = { left: 0, top: 0, width: captureWidth, height: captureHeight };
  if (!full) {
    // A box pin's crop grows to hold the whole box plus padding.
    const width = Math.min(
      Math.max(CROP_WIDTH, box ? box.width + 2 * BOX_PADDING : 0),
      captureWidth,
    );
    const height = Math.min(
      Math.max(CROP_HEIGHT, box ? box.height + 2 * BOX_PADDING : 0),
      captureHeight,
    );
    const centreX = box ? box.left + box.width / 2 : pinX;
    const centreY = box ? box.top + box.height / 2 : pinY;
    region = {
      left: clamp(Math.round(centreX - width / 2), 0, captureWidth - width),
      top: clamp(Math.round(centreY - height / 2), 0, captureHeight - height),
      width,
      height,
    };
  }
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / region.width,
    full || box ? MAX_FULL_HEIGHT / region.height : 1,
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

// A box pin's region in capture pixels, kept inside the capture.
function boxPixels(pin: Pin, captureWidth: number, captureHeight: number) {
  const box = pinBoxOf(pin);
  if (!box) return undefined;
  const left = clamp(Math.round(box.x * captureWidth), 0, captureWidth - 1);
  const top = clamp(Math.round(box.y * captureHeight), 0, captureHeight - 1);
  const right = clamp(
    Math.round((box.x + box.w) * captureWidth),
    left + 1,
    captureWidth,
  );
  const bottom = clamp(
    Math.round((box.y + box.h) * captureHeight),
    top + 1,
    captureHeight,
  );
  return { left, top, width: right - left, height: bottom - top };
}

// The box in output pixels.
function outputBox(box: Rect | undefined, region: Rect, scale: number) {
  if (!box) return undefined;
  return {
    left: Math.round((box.left - region.left) * scale),
    top: Math.round((box.top - region.top) * scale),
    width: Math.round(box.width * scale),
    height: Math.round(box.height * scale),
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
  pin: Pin,
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
      ...withBox(boxPixels(pin, size.width, size.height)),
    };
  }
  const { pinX, pinY } = pinPixel(pin, decoded.width, decoded.height);
  const boxed = boxPixels(pin, decoded.width, decoded.height);
  const { region, scale, width, height } = regionFor(
    decoded.width,
    decoded.height,
    pinX,
    pinY,
    full,
    boxed,
  );
  const scaled = cropAndScale(decoded, region, width, height);
  const outX = Math.round((pinX - region.left) * scale);
  const outY = Math.round((pinY - region.top) * scale);
  const box = outputBox(boxed, region, scale);
  if (box) drawBoxOutline(scaled, box);
  else drawPinRing(scaled, outX, outY);
  return {
    data: encodePng(scaled),
    mimeType: "image/png",
    marked: true,
    region,
    capture: { width: decoded.width, height: decoded.height },
    width,
    height,
    pin: { x: outX, y: outY },
    ...withBox(box),
  };
}

function withBox(box: Rect | undefined) {
  return box ? { box } : {};
}

// Crops a capture around a pin (x, y in 0..1) and marks the pin with a ring.
// With `full`, returns the whole capture downscaled instead of a crop. A box
// pin's crop holds its whole box plus padding, and the box is outlined.
// `sharp: null` forces the fallback (tests).
export async function renderPinImage(
  capture: Buffer,
  pin: Pin,
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
  const boxed = boxPixels(pin, captureWidth, captureHeight);
  const { region, scale, width, height } = regionFor(
    captureWidth,
    captureHeight,
    pinX,
    pinY,
    full,
    boxed,
  );

  let pipeline = sharp(capture).extract(region).resize(width, height);
  if (full) pipeline = pipeline.flatten({ background: "#ffffff" });
  const scaled = await pipeline.toBuffer();
  const outX = Math.round((pinX - region.left) * scale);
  const outY = Math.round((pinY - region.top) * scale);
  const box = outputBox(boxed, region, scale);
  const marked = sharp(scaled).composite([
    { input: marker(width, height, outX, outY, box), left: 0, top: 0 },
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
    ...withBox(box),
  };
}
