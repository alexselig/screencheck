import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

type Fingerprint = { size: number; mtimeMs: number; hash?: string };

// Says whether two captures differ, cheaply: different lengths differ
// without reading; same-length files are hashed once and the hash is kept
// until the file's size or mtime changes. null when either file is missing.
export function createCaptureComparer({
  onHash,
}: { onHash?: (file: string) => void } = {}) {
  const cache = new Map<string, Fingerprint>();

  async function fingerprint(file: string) {
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      const cached = cache.get(file);
      if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) {
        return cached;
      }
      const fresh: Fingerprint = { size: info.size, mtimeMs: info.mtimeMs };
      cache.set(file, fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function hashOf(file: string, print: Fingerprint) {
    if (!print.hash) {
      onHash?.(file);
      print.hash = createHash("sha1")
        .update(await readFile(file))
        .digest("hex");
    }
    return print.hash;
  }

  return async function differ(
    left: string,
    right: string,
  ): Promise<boolean | null> {
    const [a, b] = await Promise.all([fingerprint(left), fingerprint(right)]);
    if (!a || !b) return null;
    if (a.size !== b.size) return true;
    try {
      return (await hashOf(left, a)) !== (await hashOf(right, b));
    } catch {
      return null;
    }
  };
}
