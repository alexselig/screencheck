// The thumbnail cache: small top-of-screen images for the screen index,
// kept under <screencheck home>/thumbs, never inside a capture folder (so
// `init --captures` can't mistake one for a screen). Each image has a
// sidecar naming the source capture's size and mtime; re-capturing a screen
// makes its thumbnails stale and they are made again on the next request.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { appHome } from "./home";
import { streamFile } from "./send-file";
import {
  MAX_THUMBNAIL_BYTES,
  isThumbnailWidth,
  thumbnailType,
  type ThumbnailWidth,
} from "../shared/thumbnails";

export type ThumbnailImageType = "webp" | "png";

// The same stamp the capture route uses for its ETag.
export function sourceKey(size: number, mtimeMs: number) {
  return `${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}`;
}

// Beside feedback/ and projects/: ~/.screencheck/thumbs by default, moved by
// SCREENCHECK_HOME, by SCREENCHECK_DATA (as its sibling) or by
// SCREENCHECK_THUMBS itself.
export function defaultThumbsRoot(
  env: NodeJS.ProcessEnv = process.env,
  dataRoot?: string,
) {
  if (env.SCREENCHECK_THUMBS) return path.resolve(env.SCREENCHECK_THUMBS);
  const data =
    dataRoot ?? env.SCREENCHECK_DATA ?? env.SCREEN_REVIEW_DATA ?? undefined;
  if (data) return path.join(path.dirname(path.resolve(data)), "thumbs");
  return path.join(appHome(undefined, undefined, env), "thumbs");
}

// One safe folder or file name per id. Ids are checked against the catalog
// first; this only keeps odd versions ("..", "a/b") inside the cache.
function segment(value: string) {
  const safe = value.replace(
    /[^A-Za-z0-9._-]/g,
    (character) => `%${character.charCodeAt(0).toString(16)}`,
  );
  return /^\.+$/.test(safe) ? safe.replace(/\./g, "%2e") : safe;
}

export type ThumbnailIds = {
  projectId: string;
  version: string;
  screenId: string;
};

type Sidecar = { source: string; type: ThumbnailImageType };

async function writeAtomically(file: string, bytes: Uint8Array | string) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function createThumbnailCache(root: string) {
  function base(ids: ThumbnailIds, width: ThumbnailWidth) {
    return path.join(
      root,
      segment(ids.projectId),
      segment(ids.version),
      `${segment(ids.screenId)}-${width}`,
    );
  }

  return {
    root,
    // The cached image when it was made from this exact source, else null.
    async read(ids: ThumbnailIds, width: ThumbnailWidth, source: string) {
      const stem = base(ids, width);
      let sidecar: Sidecar;
      try {
        sidecar = JSON.parse(await readFile(`${stem}.json`, "utf8"));
      } catch {
        return null;
      }
      if (sidecar.source !== source) return null;
      if (sidecar.type !== "webp" && sidecar.type !== "png") return null;
      const file = `${stem}.${sidecar.type}`;
      try {
        const info = await stat(file);
        if (!info.isFile()) return null;
        return {
          file,
          type: `image/${sidecar.type}`,
          etag: `"t-${sourceKey(info.size, info.mtimeMs)}"`,
          open: () => createReadStream(file),
        };
      } catch {
        return null;
      }
    },
    async write(
      ids: ThumbnailIds,
      width: ThumbnailWidth,
      bytes: Uint8Array,
      source: string,
    ) {
      const type = thumbnailType(bytes);
      if (!type) throw new Error("A thumbnail must be a WebP or PNG image.");
      const stem = base(ids, width);
      await mkdir(path.dirname(stem), { recursive: true });
      // Image first, then the sidecar that vouches for it.
      await writeAtomically(`${stem}.${type}`, bytes);
      await writeAtomically(
        `${stem}.json`,
        `${JSON.stringify({ source, type } satisfies Sidecar)}\n`,
      );
    },
  };
}

export type ThumbnailCache = ReturnType<typeof createThumbnailCache>;

// Writes thumbnails for a capture that was just saved, keyed by its stamp.
export async function storeCaptureThumbnails(
  cache: ThumbnailCache,
  ids: ThumbnailIds,
  captureFile: string,
  images: Partial<Record<ThumbnailWidth, Uint8Array>>,
) {
  const info = await stat(captureFile);
  const source = sourceKey(info.size, info.mtimeMs);
  for (const [width, bytes] of Object.entries(images)) {
    const w = Number(width);
    if (bytes && isThumbnailWidth(w)) await cache.write(ids, w, bytes, source);
  }
}

export type ThumbnailRouteContext = {
  cache: ThumbnailCache;
  // The capture this thumbnail is made from, or null when there is none.
  source: (ids: ThumbnailIds) => Promise<string | null>;
  requireRegistered: (ids: ThumbnailIds) => Promise<void>;
  assertOrigin: () => void;
  fail: (status: number, message: string) => Error;
  headers: Record<string, string>;
};

async function readImageBody(
  request: IncomingMessage,
  response: ServerResponse,
  fail: ThumbnailRouteContext["fail"],
) {
  const tooBig = () => {
    // Drop the rest and close, so the client gets the answer straight away.
    request.resume();
    response.setHeader("connection", "close");
    return fail(413, "A thumbnail must be at most 256 KB.");
  };
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) {
    throw tooBig();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_THUMBNAIL_BYTES) {
      throw tooBig();
    }
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// GET answers from the cache (404 tells the client to make one); PUT stores
// one the client made.
export async function handleThumbnail(
  request: IncomingMessage,
  response: ServerResponse,
  ids: ThumbnailIds,
  rawWidth: string | null,
  context: ThumbnailRouteContext,
) {
  const { fail } = context;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "PUT") {
    throw fail(405, "Method not allowed.");
  }
  if (method === "PUT") context.assertOrigin();
  const width = Number(rawWidth);
  if (!isThumbnailWidth(width)) {
    throw fail(400, "w must be 400 or 800.");
  }
  await context.requireRegistered(ids);
  const source = await context.source(ids);
  if (!source) throw fail(404, "Capture not found.");

  if (method === "PUT") {
    const bytes = await readImageBody(request, response, fail);
    if (!thumbnailType(bytes)) {
      throw fail(415, "A thumbnail must be a WebP or PNG image.");
    }
    await context.cache.write(ids, width, bytes, source);
    response.writeHead(204, { ...context.headers }).end();
    return;
  }

  const cached = await context.cache.read(ids, width, source);
  if (!cached) throw fail(404, "No thumbnail yet.");
  const headers = {
    "cache-control": "no-cache",
    etag: cached.etag,
    "x-content-type-options": "nosniff",
    ...context.headers,
  };
  if (request.headers["if-none-match"] === cached.etag) {
    response.writeHead(304, headers).end();
    return;
  }
  const sent = await streamFile(response, cached.open(), {
    ...headers,
    "content-type": cached.type,
  });
  if (!sent) throw fail(404, "No thumbnail yet.");
}
