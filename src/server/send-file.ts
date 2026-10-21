import { once } from "node:events";
import type { ReadStream } from "node:fs";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

// API responses (JSON and images) may only be read by the app itself, so
// another site can't probe which projects and screens exist with <img> tags.
export const API_HEADERS = {
  "cross-origin-resource-policy": "same-origin",
} as const;

// The UI has Approve, Verify and Delete buttons; no other page may frame it.
export const PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
} as const;

// Sends a file without letting a read error take the server down. Returns
// false when the file could not be opened (nothing has been sent yet), so the
// caller can answer 404. Errors after the headers just end the response, and
// an aborted request closes the file.
export async function streamFile(
  response: ServerResponse,
  stream: ReadStream,
  headers: OutgoingHttpHeaders,
  { head = false }: { head?: boolean } = {},
): Promise<boolean> {
  try {
    await once(stream, "ready");
  } catch {
    stream.destroy();
    return false;
  }
  response.writeHead(200, headers);
  if (head) {
    stream.destroy();
    response.end();
    return true;
  }
  await pipeline(stream, response).catch(() => {
    response.destroy();
  });
  return true;
}
