import { LOOPBACK_HOST } from "../server/origin";
import { resolveOrigin } from "../server/runtime";
import type { ScreenApproval } from "../shared/approvals";
import type { ScreenCaption } from "../shared/captions";
import type { FeedbackReply } from "../shared/feedback";
import type { ProjectList } from "../shared/projects";
import { elementMapSchema, type ElementMap } from "../shared/elements";
import { captureUrl, elementMapUrl } from "../shared/projects";

export const NOT_RUNNING_MESSAGE =
  "ScreenCheck isn't running — start it with `npm run dev` (or `screencheck serve`).";

const LOOPBACK_HOSTNAMES = new Set([LOOPBACK_HOST, "localhost", "[::1]"]);

// A feedback record as the API returns it. Typed loosely on purpose: fields
// added later (a `thread` array, an `element` match, new statuses) pass
// through untouched instead of being dropped by a strict parse.
export type ApiFeedback = {
  id: string;
  projectId: string;
  screenId: string;
  version: string;
  x: number;
  y: number;
  note: string;
  tags: string[];
  status: string;
  reply?: FeedbackReply;
  thread?: unknown[];
  element?: unknown;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

export class ToolError extends Error {}

export class ApiError extends ToolError {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// The MCP server only ever talks to a ScreenCheck on this machine.
export function assertLoopbackOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ToolError(`Not a valid ScreenCheck URL: ${origin}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new ToolError(
      `Refusing to talk to ${url.origin}: ScreenCheck only runs on loopback (127.0.0.1, localhost or [::1]).`,
    );
  }
  return url.origin;
}

function describeIssues(body: Record<string, unknown>) {
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const messages = issues
    .map((issue) => (issue as { message?: unknown }).message)
    .filter((message): message is string => typeof message === "string");
  return messages.length ? ` (${messages.join("; ")})` : "";
}

export type ApiClientOptions = {
  origin?: string;
  fetchImpl?: typeof fetch;
};

export function createApiClient({
  origin: explicit,
  fetchImpl = fetch,
}: ApiClientOptions = {}) {
  // Resolved on every call, so the MCP server can start before ScreenCheck
  // and follows it if it restarts on another port.
  function origin() {
    return assertLoopbackOrigin(resolveOrigin(explicit));
  }

  async function send(path: string, init?: RequestInit) {
    const base = origin();
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: init?.method
          ? { "content-type": "application/json", origin: base }
          : undefined,
      });
    } catch {
      throw new ToolError(NOT_RUNNING_MESSAGE);
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const message =
        typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new ApiError(
        response.status,
        `${message}${describeIssues(body)}`,
        body,
      );
    }
    return body as T;
  }

  const feedbackPath = (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/feedback`;

  return {
    origin,
    listProjects: () => json<ProjectList>("/api/projects"),
    async listFeedback(projectId: string) {
      return (await json<{ feedback: ApiFeedback[] }>(feedbackPath(projectId)))
        .feedback;
    },
    async patchFeedback(
      projectId: string,
      id: string,
      expectedUpdatedAt: string,
      patch: Record<string, unknown>,
    ) {
      return (
        await json<{ feedback: ApiFeedback }>(
          `${feedbackPath(projectId)}/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ expectedUpdatedAt, patch }),
          },
        )
      ).feedback;
    },
    async listApprovals(projectId: string) {
      return (
        await json<{ approvals: ScreenApproval[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/approvals`,
        )
      ).approvals;
    },
    async listCaptions(projectId: string) {
      return (
        await json<{ captions: ScreenCaption[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/captions`,
        )
      ).captions;
    },
    // Null when the capture has no element map (older captures, or a map
    // that fails the schema); the pin then simply names no element.
    async elementMap(
      projectId: string,
      version: string,
      screenId: string,
    ): Promise<ElementMap | null> {
      const response = await send(elementMapUrl(projectId, version, screenId));
      if (!response.ok) return null;
      const parsed = elementMapSchema.safeParse(
        await response.json().catch(() => null),
      );
      return parsed.success ? parsed.data : null;
    },
    // Null when the version has no capture for this screen.
    async capture(projectId: string, version: string, screenId: string) {
      const response = await send(captureUrl(projectId, version, screenId));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ApiError(response.status, `HTTP ${response.status}`);
      }
      return {
        type: response.headers.get("content-type") ?? "",
        data: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
