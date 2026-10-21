// Reads the pixel size from a PNG, JPEG or WebP header, so `screencheck init`
// can fill in each screen's viewport without decoding the image.
export type ImageSize = { width: number; height: number };

function png(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpeg(bytes: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers (baseline, progressive, ...) hold the size;
    // C4, C8 and CC are other segments that share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function webp(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30 || bytes.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function imageSize(bytes: Buffer): ImageSize | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return png(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.toString("latin1", 0, 4) === "RIFF") return webp(bytes);
  return null;
}
