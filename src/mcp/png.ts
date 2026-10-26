// A small PNG codec for when the optional sharp package isn't installed: enough
// to crop a capture, scale it down and draw the pin ring. Handles the 8-bit,
// non-interlaced grey, RGB and RGBA images browsers and Playwright write;
// anything else returns null and the caller falls back to the raw capture.
import { deflateSync, inflateSync } from "node:zlib";

export type Raster = {
  width: number;
  height: number;
  // RGB, 3 bytes per pixel.
  data: Uint8Array;
};

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decodes to RGB, compositing any alpha onto white.
export function decodePng(bytes: Buffer): Raster | null {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9]!;
      const interlace = body[12];
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || interlace !== 0 || !channels) return null;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || !channels || !idat.length) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]!;
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[row - stride + x]! : 0;
      const upLeft =
        y > 0 && x >= channels ? pixels[row - stride + x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * channels;
    const grey = channels <= 2;
    const alpha =
      channels === 2 || channels === 4 ? pixels[at + channels - 1]! / 255 : 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[at + (grey ? 0 : channel)]!;
      data[index * 3 + channel] = Math.round(value * alpha + 255 * (1 - alpha));
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng({ width, height, data }: Raster) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Crops `region` and scales it to width x height, averaging the source
// pixels each output pixel covers.
export function cropAndScale(
  source: Raster,
  region: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): Raster {
  const data = new Uint8Array(width * height * 3);
  const xScale = region.width / width;
  const yScale = region.height / height;
  for (let y = 0; y < height; y += 1) {
    const top = region.top + Math.floor(y * yScale);
    const bottom = Math.max(top + 1, region.top + Math.floor((y + 1) * yScale));
    for (let x = 0; x < width; x += 1) {
      const left = region.left + Math.floor(x * xScale);
      const right = Math.max(
        left + 1,
        region.left + Math.floor((x + 1) * xScale),
      );
      const sum = [0, 0, 0];
      let count = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const at = (sy * source.width + sx) * 3;
          sum[0]! += source.data[at]!;
          sum[1]! += source.data[at + 1]!;
          sum[2]! += source.data[at + 2]!;
          count += 1;
        }
      }
      const out = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        data[out + channel] = Math.round(sum[channel]! / count);
      }
    }
  }
  return { width, height, data };
}

const RUST = [0xc2, 0x41, 0x0c];
const WHITE = [0xff, 0xff, 0xff];

// The same mark as the sharp path: a rust ring with a white halo and a dot.
export function drawPinRing(image: Raster, x: number, y: number) {
  const radius = 22;
  const reach = radius + 5;
  for (
    let py = Math.max(0, y - reach);
    py <= Math.min(image.height - 1, y + reach);
    py += 1
  ) {
    for (
      let px = Math.max(0, x - reach);
      px <= Math.min(image.width - 1, x + reach);
      px += 1
    ) {
      const distance = Math.hypot(px - x, py - y);
      const ring = Math.abs(distance - radius);
      const color =
        ring <= 2.5 || distance <= 5
          ? RUST
          : ring <= 4.5 || distance <= 7
            ? WHITE
            : null;
      if (color) image.data.set(color, (py * image.width + px) * 3);
    }
  }
}

// Outlines a box pin's region: a 3px rust frame with a 1px white edge either
// side, so it reads on dark and light captures alike.
export function drawBoxOutline(
  image: Raster,
  box: { left: number; top: number; width: number; height: number },
) {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const reach = 2;
  for (
    let py = Math.max(0, box.top - reach);
    py <= Math.min(image.height - 1, bottom + reach);
    py += 1
  ) {
    for (
      let px = Math.max(0, box.left - reach);
      px <= Math.min(image.width - 1, right + reach);
      px += 1
    ) {
      // Distance to the rectangle's edge, inside or out.
      const inside = Math.min(
        px - box.left,
        right - px,
        py - box.top,
        bottom - py,
      );
      const edge =
        inside >= 0
          ? inside
          : Math.max(box.left - px, px - right, box.top - py, py - bottom);
      const color = edge <= 1 ? RUST : edge <= 2 ? WHITE : null;
      if (color) image.data.set(color, (py * image.width + px) * 3);
    }
  }
}
