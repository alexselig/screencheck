import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { elementMapSchema } from "../shared/elements";
import {
  assertMutationOrigin,
  isLoopbackHostHeader,
  loopbackOrigins,
} from "./origin";
import type { ProjectCatalog } from "./projects";
import { setApprovalInputSchema } from "../shared/approvals";
import { setCaptionInputSchema } from "../shared/captions";
import { ACTOR_HEADER, REVIEWER_ACTOR } from "../shared/feedback";
import { API_HEADERS, streamFile } from "./send-file";
import {
  FeedbackConflictError,
  FeedbackNotFoundError,
  FeedbackQuarantineError,
  InvalidProjectIdError,
  StoreError,
  type FeedbackStorage,
} from "./storage";

const MAX_BODY_BYTES = 1024 * 1024;

const deleteBodySchema = z.object({ expectedUpdatedAt: z.iso.datetime() });
const importBodySchema = z.object({ records: z.array(z.unknown()) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...API_HEADERS,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

// Route parameters are percent-decoded; a malformed escape is the client's
// mistake, not a server failure.
function decodePart(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, "Bad request path.");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send feedback as application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is larger than 1 MB.");
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function isVerified(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "VERIFIED"
  );
}

// Verified means a person looked at the fix, so only the ScreenCheck UI (which
// sends the reviewer actor header) may set it. Agents get a clear 403.
export function assertMaySetVerified(
  headers: IncomingMessage["headers"],
  records: unknown[],
) {
  if (!records.some(isVerified)) return;
  const actor = headers[ACTOR_HEADER];
  if (actor === REVIEWER_ACTOR) return;
  throw new HttpError(
    403,
    `Only a reviewer can mark feedback Verified. Agents should set Fixed and let the reviewer verify it in ScreenCheck (requests that set Verified must carry ${ACTOR_HEADER}: ${REVIEWER_ACTOR}).`,
  );
}

// Approving a screen is the reviewer's call, like Verified.
function assertReviewer(headers: IncomingMessage["headers"], action: string) {
  if (headers[ACTOR_HEADER] === REVIEWER_ACTOR) return;
  throw new HttpError(
    403,
    `Only a reviewer can ${action} in ScreenCheck (requests must carry ${ACTOR_HEADER}: ${REVIEWER_ACTOR}).`,
  );
}

function stringField(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

const ROUTE =
  /^\/api\/projects\/([^/]+)\/feedback(?:\/(import)|\/([^/]+))?\/?$/;

const CAPTURE_ROUTE =
  /^\/api\/projects\/([^/]+)\/captures\/([^/]+)\/([^/]+)\/?$/;

const ELEMENTS_ROUTE =
  /^\/api\/projects\/([^/]+)\/elements\/([^/]+)\/([^/]+)\/?$/;

const APPROVALS_ROUTE = /^\/api\/projects\/([^/]+)\/approvals\/?$/;

const CAPTIONS_ROUTE = /^\/api\/projects\/([^/]+)\/captions\/?$/;

export type ApiOptions = {
  storage: FeedbackStorage;
  port: number;
  catalog?: ProjectCatalog;
};

// Returns false when the request is not an API route, so the caller can fall
// through to the static/Vite handler.
export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  { storage, port, catalog }: ApiOptions,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://placeholder");
  if (!url.pathname.startsWith("/api/")) return false;

  // With a catalog, writes for an unregistered project, version or screen are
  // refused instead of creating data nothing will ever show (a typo in a
  // script or agent would otherwise look like success).
  async function requireRegistered(
    projectId: string,
    target: { version?: string; screenId?: string } = {},
  ) {
    const miss = await catalog?.resolve(projectId, target);
    if (miss) throw new HttpError(404, miss.error);
  }

  try {
    if (!isLoopbackHostHeader(request.headers.host, port)) {
      throw new HttpError(403, "Unexpected Host header.");
    }
    if (url.pathname === "/api/projects" && catalog) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed.");
      sendJson(response, 200, await catalog.list());
      return true;
    }
    const capture = CAPTURE_ROUTE.exec(url.pathname);
    if (capture && catalog) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed.");
      const [projectId, version, screenId] = capture
        .slice(1)
        .map((part) => decodePart(part!));
      const file = await catalog.capture(projectId!, version!, screenId!);
      if (!file) throw new HttpError(404, "Capture not found.");
      const headers = {
        "cache-control": "no-cache",
        etag: file.etag,
        "x-content-type-options": "nosniff",
        ...API_HEADERS,
      };
      if (request.headers["if-none-match"] === file.etag) {
        response.writeHead(304, headers).end();
        return true;
      }
      const sent = await streamFile(response, file.open(), {
        ...headers,
        "content-type": file.type,
      });
      if (!sent) throw new HttpError(404, "Capture not found.");
      return true;
    }
    const elements = ELEMENTS_ROUTE.exec(url.pathname);
    if (elements && catalog) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed.");
      const [projectId, version, screenId] = elements
        .slice(1)
        .map((part) => decodePart(part!));
      const text = await catalog.elements(projectId!, version!, screenId!);
      if (text === null) throw new HttpError(404, "Element map not found.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(500, "Element map is not valid JSON.");
      }
      const map = elementMapSchema.safeParse(parsed);
      if (!map.success) {
        throw new HttpError(
          500,
          `Element map is malformed: ${map.error.issues[0]?.path.join(".") || "root"} ${map.error.issues[0]?.message ?? ""}`.trim(),
        );
      }
      sendJson(response, 200, map.data);
      return true;
    }
    const approvals = APPROVALS_ROUTE.exec(url.pathname);
    if (approvals) {
      const projectId = decodePart(approvals[1]!);
      if (request.method === "GET") {
        await requireRegistered(projectId);
        sendJson(response, 200, {
          approvals: await storage.listApprovals(projectId),
        });
      } else if (request.method === "PUT") {
        try {
          assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
        } catch (error) {
          throw new HttpError(403, (error as Error).message);
        }
        assertReviewer(request.headers, "approve a screen");
        const input = setApprovalInputSchema.parse(await readJsonBody(request));
        await requireRegistered(projectId, input);
        if (input.approved && !input.override) {
          const unverified = (await storage.listFeedback(projectId)).filter(
            (item) =>
              item.version === input.version &&
              item.screenId === input.screenId &&
              item.status === "RESOLVED",
          ).length;
          if (unverified > 0) {
            sendJson(response, 409, {
              error: `${unverified} fix${unverified === 1 ? " is" : "es are"} not verified on this screen yet. Verify ${unverified === 1 ? "it" : "them"} first, or send override: true to approve anyway.`,
              unverified,
            });
            return true;
          }
        }
        sendJson(response, 200, {
          approvals: await storage.setApproval(projectId, input),
        });
      } else {
        throw new HttpError(405, "Method not allowed.");
      }
      return true;
    }
    const captions = CAPTIONS_ROUTE.exec(url.pathname);
    if (captions) {
      const projectId = decodePart(captions[1]!);
      if (request.method === "GET") {
        await requireRegistered(projectId);
        sendJson(response, 200, {
          captions: await storage.listCaptions(projectId),
        });
      } else if (request.method === "PUT") {
        try {
          assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
        } catch (error) {
          throw new HttpError(403, (error as Error).message);
        }
        const input = setCaptionInputSchema.parse(await readJsonBody(request));
        await requireRegistered(projectId, input);
        sendJson(response, 200, {
          captions: await storage.setCaption(projectId, input),
        });
      } else {
        throw new HttpError(405, "Method not allowed.");
      }
      return true;
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) throw new HttpError(404, "Not found.");
    const projectId = decodePart(match[1]!);
    const isImport = match[2] === "import";
    const id = match[3] ? decodePart(match[3]) : undefined;
    const method = request.method ?? "GET";

    if (method !== "GET") {
      try {
        assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
      } catch (error) {
        throw new HttpError(403, (error as Error).message);
      }
    }
    await requireRegistered(projectId);

    if (!id && !isImport && method === "GET") {
      const { feedback, rejected } = await storage.inspectFeedback(projectId);
      sendJson(response, 200, {
        feedback,
        ...(rejected.length
          ? {
              problems: [
                new FeedbackQuarantineError(projectId, rejected).message,
              ],
            }
          : {}),
      });
    } else if (!id && !isImport && method === "POST") {
      const body = await readJsonBody(request);
      assertMaySetVerified(request.headers, [body]);
      await requireRegistered(projectId, {
        version: stringField(body, "version"),
        screenId: stringField(body, "screenId"),
      });
      const created = await storage.createFeedback(projectId, body as never);
      sendJson(response, 201, { feedback: created });
    } else if (isImport && method === "POST") {
      const body = importBodySchema.parse(await readJsonBody(request));
      assertMaySetVerified(request.headers, body.records);
      sendJson(
        response,
        200,
        await storage.importFeedback(projectId, body.records),
      );
    } else if (id && method === "PATCH") {
      const body = await readJsonBody(request);
      assertMaySetVerified(request.headers, [
        typeof body === "object" && body !== null && "patch" in body
          ? body.patch
          : undefined,
      ]);
      const updated = await storage.updateFeedback(
        projectId,
        id,
        body as never,
      );
      sendJson(response, 200, { feedback: updated });
    } else if (id && method === "DELETE") {
      const body = deleteBodySchema.parse(await readJsonBody(request));
      await storage.deleteFeedback(projectId, id, body.expectedUpdatedAt);
      sendJson(response, 200, { deleted: id });
    } else {
      throw new HttpError(405, "Method not allowed.");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
    } else if (error instanceof z.ZodError) {
      sendJson(response, 400, {
        error: "Invalid feedback.",
        issues: error.issues,
      });
    } else if (error instanceof FeedbackConflictError) {
      sendJson(response, 409, { error: error.message, current: error.current });
    } else if (error instanceof FeedbackQuarantineError) {
      sendJson(response, 409, { error: error.message });
    } else if (error instanceof FeedbackNotFoundError) {
      sendJson(response, 404, { error: error.message });
    } else if (error instanceof InvalidProjectIdError) {
      sendJson(response, 400, { error: error.message });
    } else if (error instanceof StoreError) {
      console.error(`ScreenCheck: ${error.message} (${error.file})`);
      sendJson(response, 500, { error: error.message });
    } else {
      // Raw errors can carry absolute paths; the details go to the log.
      console.error("ScreenCheck: request failed:", error);
      sendJson(response, 500, {
        error: "Storage failed; see the ScreenCheck server log.",
      });
    }
  }
  return true;
}
