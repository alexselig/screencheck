import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { elementMapSchema, resolvePinElement } from "../shared/elements";
import { toPinElement } from "../shared/reanchor";
import { carryOpenFeedback } from "./carry";
import {
  a11yReportSchema,
  setSuggestionDismissalInputSchema,
} from "../shared/a11y";
import {
  assertMutationOrigin,
  isLoopbackHostHeader,
  loopbackOrigins,
} from "./origin";
import type { ProjectCatalog } from "./projects";
import { handleAssist, type AssistService } from "./assist-routes";
import { setApprovalInputSchema } from "../shared/approvals";
import { setCaptionInputSchema } from "../shared/captions";
import { ACTOR_HEADER, REVIEWER_ACTOR } from "../shared/feedback";
import { API_HEADERS, streamFile } from "./send-file";
import { handleThumbnail, type ThumbnailCache } from "./thumbnails";
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

const THUMBNAIL_ROUTE =
  /^\/api\/projects\/([^/]+)\/thumbnails\/([^/]+)\/([^/]+)\/?$/;

const A11Y_ROUTE = /^\/api\/projects\/([^/]+)\/a11y\/([^/]+)\/([^/]+)\/?$/;

const SUGGESTIONS_ROUTE = /^\/api\/projects\/([^/]+)\/suggestions\/?$/;

const APPROVALS_ROUTE = /^\/api\/projects\/([^/]+)\/approvals\/?$/;

const CAPTIONS_ROUTE = /^\/api\/projects\/([^/]+)\/captions\/?$/;

// Records the element under a new pin, from its capture's element map, so
// the pin can be found again on another size or a later build.
async function withPinElement(
  catalog: ProjectCatalog | undefined,
  projectId: string,
  body: unknown,
) {
  if (!catalog || typeof body !== "object" || body === null) return body;
  const input = body as Record<string, unknown>;
  if (
    input.element !== undefined ||
    typeof input.version !== "string" ||
    typeof input.screenId !== "string" ||
    typeof input.x !== "number" ||
    typeof input.y !== "number"
  ) {
    return body;
  }
  try {
    const text = await catalog.elements(
      projectId,
      input.version,
      input.screenId,
    );
    if (text === null) return body;
    const map = elementMapSchema.safeParse(JSON.parse(text));
    if (!map.success) return body;
    const element = resolvePinElement(map.data, {
      x: input.x,
      y: input.y,
      box: input.box,
    });
    return element
      ? { ...input, element: toPinElement(element, map.data.capture) }
      : body;
  } catch {
    return body;
  }
}

export type ApiOptions = {
  storage: FeedbackStorage;
  port: number;
  catalog?: ProjectCatalog;
  // AI assist (#14); undefined means it is off.
  assist?: AssistService;
  // The screen index thumbnail cache; the route is off without it.
  thumbs?: ThumbnailCache;
};

// Returns false when the request is not an API route, so the caller can fall
// through to the static/Vite handler.
export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  { storage, port, catalog, assist, thumbs }: ApiOptions,
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
    if (
      url.pathname === "/api/assist" ||
      url.pathname.startsWith("/api/assist/")
    ) {
      const handled = await handleAssist(request, url.pathname, {
        assist,
        storage,
        assertOrigin() {
          try {
            assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
          } catch (error) {
            throw new HttpError(403, (error as Error).message);
          }
        },
        readBody: () => readJsonBody(request),
        fail: (status, message) => new HttpError(status, message),
      });
      sendJson(response, handled.status, handled.body);
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
    const thumbnail = THUMBNAIL_ROUTE.exec(url.pathname);
    if (thumbnail && catalog && thumbs) {
      const [projectId, version, screenId] = thumbnail
        .slice(1)
        .map((part) => decodePart(part!));
      const ids = {
        projectId: projectId!,
        version: version!,
        screenId: screenId!,
      };
      await handleThumbnail(request, response, ids, url.searchParams.get("w"), {
        cache: thumbs,
        source: async (target) =>
          (
            await catalog.capture(
              target.projectId,
              target.version,
              target.screenId,
            )
          )?.source ?? null,
        requireRegistered: (target) =>
          requireRegistered(target.projectId, {
            version: target.version,
            screenId: target.screenId,
          }),
        assertOrigin() {
          try {
            assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
          } catch (error) {
            throw new HttpError(403, (error as Error).message);
          }
        },
        fail: (status, message) => new HttpError(status, message),
        headers: API_HEADERS,
      });
      return true;
    }
    // JSON files stored beside a capture: element maps and a11y reports.
    for (const sidecar of [
      {
        route: ELEMENTS_ROUTE,
        read: catalog?.elements,
        schema: elementMapSchema as z.ZodType,
        label: "Element map",
      },
      {
        route: A11Y_ROUTE,
        read: catalog?.a11y,
        schema: a11yReportSchema as z.ZodType,
        label: "Accessibility report",
      },
    ]) {
      const match = sidecar.route.exec(url.pathname);
      if (!match || !sidecar.read) continue;
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed.");
      const [projectId, version, screenId] = match
        .slice(1)
        .map((part) => decodePart(part!));
      const text = await sidecar.read(projectId!, version!, screenId!);
      if (text === null)
        throw new HttpError(404, `${sidecar.label} not found.`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(500, `${sidecar.label} is not valid JSON.`);
      }
      const data = sidecar.schema.safeParse(parsed);
      if (!data.success) {
        throw new HttpError(
          500,
          `${sidecar.label} is malformed: ${data.error.issues[0]?.path.join(".") || "root"} ${data.error.issues[0]?.message ?? ""}`.trim(),
        );
      }
      sendJson(response, 200, data.data);
      return true;
    }
    const suggestions = SUGGESTIONS_ROUTE.exec(url.pathname);
    if (suggestions) {
      const projectId = decodePart(suggestions[1]!);
      if (request.method === "GET") {
        await requireRegistered(projectId);
        sendJson(response, 200, {
          dismissed: await storage.listDismissedSuggestions(projectId),
        });
      } else if (request.method === "PUT") {
        try {
          assertMutationOrigin(request.headers.origin, loopbackOrigins(port));
        } catch (error) {
          throw new HttpError(403, (error as Error).message);
        }
        assertReviewer(request.headers, "dismiss or promote a suggestion");
        const input = setSuggestionDismissalInputSchema.parse(
          await readJsonBody(request),
        );
        await requireRegistered(projectId, input);
        sendJson(response, 200, {
          dismissed: await storage.setSuggestionDismissal(projectId, input),
        });
      } else {
        throw new HttpError(405, "Method not allowed.");
      }
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
      if (catalog) {
        try {
          await carryOpenFeedback(storage, catalog, projectId);
        } catch (error) {
          // Carrying is a convenience; the comments still load where they are.
          console.error(
            "ScreenCheck: carrying comments forward failed:",
            error,
          );
        }
      }
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
      const created = await storage.createFeedback(
        projectId,
        (await withPinElement(catalog, projectId, body)) as never,
      );
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
