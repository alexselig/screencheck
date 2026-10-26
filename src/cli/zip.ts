// A minimal zip writer and reader: enough for offline review bundles without
// a dependency. Entries are deflated when that makes them smaller and stored
// otherwise. No zip64, encryption or multi-disk archives.
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer | string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
// Bit 11: names are UTF-8.
const UTF8_FLAG = 0x0800;
const MAX_32 = 0xffffffff;

function assertSafeName(name: string) {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe zip entry name: "${name}"`);
  }
}

// DOS date/time for "now"; zip has no time zone, so local time is customary.
function dosStamp(date: Date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

export function writeZip(entries: ZipEntry[], date = new Date()): Buffer {
  const { time, day } = dosStamp(date);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertSafeName(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const data =
      typeof entry.data === "string"
        ? Buffer.from(entry.data, "utf8")
        : entry.data;
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    if (offset > MAX_32 || body.length > MAX_32 || data.length > MAX_32) {
      throw new Error("Bundle is too large for a zip without zip64.");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(useDeflate ? DEFLATED : STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(useDeflate ? DEFLATED : STORED, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // Extra, comment, disk, internal attributes: all zero.
    // External attributes: a regular file, rw-r--r--.
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Reads every file entry (directories are skipped) through the central
// directory, checking each CRC.
export function readZip(zip: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let index = zip.length - 22; index >= 0; index -= 1) {
    if (zip.readUInt32LE(index) === END_OF_CENTRAL) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file (no end of central directory).");
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error("Corrupt zip file (bad central directory).");
    }
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`Corrupt zip file (bad local header for ${name}).`);
    }
    const start =
      localOffset +
      30 +
      zip.readUInt16LE(localOffset + 26) +
      zip.readUInt16LE(localOffset + 28);
    const body = zip.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === STORED) data = Buffer.from(body);
    else if (method === DEFLATED) data = inflateRawSync(body);
    else throw new Error(`Unsupported zip compression for ${name}.`);
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`Corrupt zip file (checksum mismatch for ${name}).`);
    }
    entries.set(name, data);
  }
  return entries;
}
