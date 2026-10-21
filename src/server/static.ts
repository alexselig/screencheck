import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { sendJson } from "./api";
import { isLoopbackHostHeader } from "./origin";
import { PAGE_HEADERS, streamFile } from "./send-file";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function fileIn(root: string, relative: string) {
  const candidate = path.resolve(root, `.${path.sep}${relative}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  try {
    const real = await realpath(candidate);
    if (!real.startsWith(`${root}${path.sep}`)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

// Serves the built client. Vite fingerprints everything under /assets/, so
// those files are cached for good; index.html is always revalidated so a new
// build is picked up on the next load.
export async function createStaticHandler(clientRoot: string) {
  const root = await realpath(clientRoot);
  const indexFile = path.join(root, "index.html");

  async function send(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    immutable: boolean,
  ) {
    const type =
      CONTENT_TYPES[path.extname(file).toLowerCase()] ??
      "application/octet-stream";
    const sent = await streamFile(
      response,
      createReadStream(file),
      {
        "cache-control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": type,
        "x-content-type-options": "nosniff",
        ...PAGE_HEADERS,
      },
      { head: request.method === "HEAD" },
    );
    if (!sent) sendJson(response, 404, { error: "not found" });
  }

  return async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    port: number,
  ) {
    if (!isLoopbackHostHeader(request.headers.host, port)) {
      sendJson(response, 403, { error: "Unexpected Host header." });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://placeholder").pathname,
      );
    } catch {
      sendJson(response, 400, { error: "Bad request path." });
      return;
    }
    if (pathname.includes("\0")) {
      sendJson(response, 400, { error: "Bad request path." });
      return;
    }
    const segments = pathname.split(/[/\\]/);
    if (segments.includes("..")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    const file = pathname === "/" ? null : await fileIn(root, pathname);
    if (file) {
      await send(request, response, file, pathname.startsWith("/assets/"));
      return;
    }
    // Missing fingerprinted files are real 404s; anything else is a client
    // route and gets the app shell.
    if (pathname.startsWith("/assets/") || pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    await send(request, response, indexFile, false);
  };
}
