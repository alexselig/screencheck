import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { vi } from "vitest";
import { z } from "zod";

import {
  FeedbackConflictError,
  FeedbackNotFoundError,
  createFeedbackStorage,
} from "../../src/server/storage";
import { EXAMPLE_PROJECT } from "../../src/server/projects";

const ROUTE = /^\/api\/projects\/([^/]+)\/feedback(?:\/(import)|\/([^/]+))?$/;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Routes the client's relative /api calls to a real storage instance on disk.
export async function installFakeFeedbackApi(
  project: typeof EXAMPLE_PROJECT = EXAMPLE_PROJECT,
) {
  const root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const storage = createFeedbackStorage({ dataRoot: root });
  const requests: { method: string; path: string }[] = [];
  let failNext: { status: number; error: string; path?: RegExp } | null = null;
  let gate: Promise<void> | null = null;
  // Accessibility reports by "version/screenId"; none unless a test adds one.
  const a11yReports = new Map<string, unknown>();
  const dismissalWrites: unknown[] = [];

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url, "http://127.0.0.1").pathname;
    // The project list is not feedback traffic; keep it out of failNext/hold.
    if (path === "/api/projects") {
      return reply(200, { projects: [project], problems: [] });
    }
    // Element maps are optional reads; the example project has none.
    if (/^\/api\/projects\/[^/]+\/elements\//.test(path)) {
      return reply(404, { error: "Element map not found." });
    }
    const a11yMatch = /^\/api\/projects\/[^/]+\/a11y\/([^/]+)\/([^/]+)$/.exec(
      path,
    );
    if (a11yMatch) {
      const report = a11yReports.get(
        `${decodeURIComponent(a11yMatch[1]!)}/${decodeURIComponent(a11yMatch[2]!)}`,
      );
      return report
        ? reply(200, report)
        : reply(404, { error: "Accessibility report not found." });
    }
    const suggestionsMatch = /^\/api\/projects\/([^/]+)\/suggestions$/.exec(
      path,
    );
    if (suggestionsMatch) {
      const projectId = decodeURIComponent(suggestionsMatch[1]!);
      if (method === "PUT") {
        if (failNext?.path?.test(path)) {
          const failure = failNext;
          failNext = null;
          return reply(failure.status, { error: failure.error });
        }
        const input = JSON.parse(String(init.body));
        dismissalWrites.push(input);
        return reply(200, {
          dismissed: await storage.setSuggestionDismissal(projectId, input),
        });
      }
      return reply(200, {
        dismissed: await storage.listDismissedSuggestions(projectId),
      });
    }
    requests.push({ method, path });
    if (gate) await gate;
    if (failNext && (failNext.path ?? /\/feedback/).test(path)) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { error: failure.error });
    }
    const approvalsMatch = /^\/api\/projects\/([^/]+)\/approvals\/?$/.exec(
      path,
    );
    if (approvalsMatch) {
      const projectId = decodeURIComponent(approvalsMatch[1]!);
      try {
        if (method === "GET") {
          return reply(200, {
            approvals: await storage.listApprovals(projectId),
          });
        }
        if (method === "PUT") {
          const input = JSON.parse(String(init.body));
          return reply(200, {
            approvals: await storage.setApproval(projectId, input),
          });
        }
        return reply(405, { error: "Method not allowed." });
      } catch (error) {
        return reply(500, { error: (error as Error).message });
      }
    }
    const captionsMatch = /^\/api\/projects\/([^/]+)\/captions\/?$/.exec(path);
    if (captionsMatch) {
      const projectId = decodeURIComponent(captionsMatch[1]!);
      try {
        if (method === "GET") {
          return reply(200, {
            captions: await storage.listCaptions(projectId),
          });
        }
        if (method === "PUT") {
          const input = JSON.parse(String(init.body));
          return reply(200, {
            captions: await storage.setCaption(projectId, input),
          });
        }
        return reply(405, { error: "Method not allowed." });
      } catch (error) {
        return reply(500, { error: (error as Error).message });
      }
    }
    const match = ROUTE.exec(path);
    if (!match) return reply(404, { error: "Not found." });
    const projectId = decodeURIComponent(match[1]!);
    const id = match[3] ? decodeURIComponent(match[3]) : undefined;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    try {
      if (match[2] === "import") {
        return reply(
          200,
          await storage.importFeedback(projectId, body.records),
        );
      }
      if (!id && method === "GET") {
        return reply(200, { feedback: await storage.listFeedback(projectId) });
      }
      if (!id && method === "POST") {
        return reply(201, {
          feedback: await storage.createFeedback(projectId, body),
        });
      }
      if (id && method === "PATCH") {
        // Mirror the server: only the reviewer's browser may set Verified.
        const actor = new Headers(init.headers).get("x-screencheck-actor");
        if (body?.patch?.status === "VERIFIED" && actor !== "reviewer") {
          return reply(403, {
            error: "Only a reviewer can mark feedback Verified.",
          });
        }
        return reply(200, {
          feedback: await storage.updateFeedback(projectId, id, body),
        });
      }
      if (id && method === "DELETE") {
        await storage.deleteFeedback(projectId, id, body.expectedUpdatedAt);
        return reply(200, { deleted: id });
      }
      return reply(405, { error: "Method not allowed." });
    } catch (error) {
      if (error instanceof FeedbackConflictError) {
        return reply(409, { error: error.message, current: error.current });
      }
      if (error instanceof FeedbackNotFoundError) {
        return reply(404, { error: error.message });
      }
      if (error instanceof z.ZodError) return reply(400, { error: "Invalid." });
      return reply(500, { error: (error as Error).message });
    }
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    root,
    storage,
    requests,
    dismissalWrites,
    setA11yReport(version: string, screenId: string, report: unknown) {
      a11yReports.set(`${version}/${screenId}`, report);
    },
    // Fails the next feedback request, or the next request matching path.
    failNext(status: number, error: string, path?: RegExp) {
      failNext = { status, error, path };
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    async dispose() {
      vi.unstubAllGlobals();
      // A late write can land while removing; retry instead of failing on ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}
