// Offline review mode. When the page is opened from a `screencheck bundle`
// (bundle.js sets window.__SCREENCHECK_BUNDLE__), this stands in for the
// server: it answers the same /api routes through a fetch() replacement, so
// feedback-api.ts and the rest of the app run unchanged. Bundled data is
// read-only; comments the reviewer adds live in localStorage until they are
// exported with "Export review" and merged back with `screencheck import`.
import {
  BUNDLE_FORMAT,
  REVIEW_EXPORT_KIND,
  bundleCaptureKey,
  type OfflineBundle,
  type ReviewExport,
} from "../shared/bundle";
import {
  createFeedbackInputSchema,
  feedbackRecordSchema,
  feedbackThread,
  updateFeedbackInputSchema,
  type FeedbackRecord,
} from "../shared/feedback";
import { captureUrl } from "../shared/projects";

declare global {
  interface Window {
    __SCREENCHECK_BUNDLE__?: OfflineBundle;
  }
}

export function readBundle(): OfflineBundle | undefined {
  if (typeof window === "undefined") return undefined;
  const bundle = window.__SCREENCHECK_BUNDLE__;
  return bundle && bundle.format === BUNDLE_FORMAT ? bundle : undefined;
}

// Image sources don't go through fetch, so captures are pointed at the files
// inside the bundle directly.
export function captureSrc(
  projectId: string,
  version: string,
  screenId: string,
) {
  const bundle = readBundle();
  if (!bundle) return captureUrl(projectId, version, screenId);
  return (
    bundle.captures[bundleCaptureKey(version, screenId)] ??
    `captures/${version}/${screenId}`
  );
}

export function offlineStorageKey(bundle: Pick<OfflineBundle, "id">) {
  return `screencheck.offline.v1:${bundle.id}`;
}

export type OfflineApiOptions = {
  storage?: Storage;
  now?: () => Date;
  newId?: () => string;
};

const READ_ONLY =
  "This is an offline review bundle: only comments added here can be changed. Add a new comment instead.";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nextUpdatedAt(now: Date, previous?: string) {
  if (!previous) return now.toISOString();
  const previousTime = new Date(previous).getTime();
  return new Date(Math.max(now.getTime(), previousTime + 1)).toISOString();
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random()}`
  );
}

export function createOfflineApi(
  bundle: OfflineBundle,
  {
    storage = globalThis.localStorage,
    now = () => new Date(),
    newId = randomId,
  }: OfflineApiOptions = {},
) {
  const key = offlineStorageKey(bundle);
  const project = bundle.project;
  const bundledIds = new Set(bundle.feedback.map((record) => record.id));
  const listeners = new Set<() => void>();

  function load(): FeedbackRecord[] {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        const record = feedbackRecordSchema.safeParse(item);
        return record.success ? [record.data] : [];
      });
    } catch {
      return [];
    }
  }

  let local = load();

  function save(next: FeedbackRecord[]) {
    local = next;
    try {
      storage?.setItem(key, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the comments stay in memory until export.
    }
    for (const listener of listeners) listener();
  }

  async function readBody(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<unknown> {
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.text()
          : "";
    return raw ? JSON.parse(raw) : undefined;
  }

  async function handle(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const href =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const parts = new URL(href, "http://offline.invalid").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts[0] !== "api" || parts[1] !== "projects") {
      return json(404, { error: "Not available in an offline bundle." });
    }
    if (parts.length === 2 && method === "GET") {
      return json(200, { projects: [project], problems: [] });
    }
    if (parts[2] !== project.id) {
      return json(404, { error: `Unknown project "${parts[2]}".` });
    }
    const [resource, ...rest] = parts.slice(3);

    if (resource === "approvals" || resource === "captions") {
      if (method !== "GET") return json(403, { error: READ_ONLY });
      return json(200, { [resource]: bundle[resource] });
    }
    if (resource === "elements" && rest.length === 2 && method === "GET") {
      const map = bundle.elements[bundleCaptureKey(rest[0]!, rest[1]!)];
      return map ? json(200, map) : json(404, { error: "No element map." });
    }
    if (resource !== "feedback") return json(404, { error: "Not found." });

    let body: unknown;
    try {
      body = await readBody(input, init);
    } catch {
      return json(400, { error: "Request body is not valid JSON." });
    }

    if (rest.length === 0 && method === "GET") {
      return json(200, { feedback: [...bundle.feedback, ...local] });
    }
    if (rest.length === 0 && method === "POST") {
      const parsed = createFeedbackInputSchema.safeParse(body);
      if (!parsed.success) {
        return json(400, {
          error: "Invalid feedback.",
          issues: parsed.error.issues,
        });
      }
      const input = parsed.data;
      const existing = local.find((item) => item.id === input.clientMutationId);
      if (existing) return json(201, { feedback: existing });
      const timestamp = nextUpdatedAt(now());
      const created = feedbackRecordSchema.parse({
        id: input.clientMutationId,
        projectId: project.id,
        screenId: input.screenId,
        version: input.version,
        x: input.x,
        y: input.y,
        note: input.note,
        tags: input.tags,
        status: input.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      save([...local, created]);
      return json(201, { feedback: created });
    }
    if (rest[0] === "import" && method === "POST") {
      // Only the legacy browser-storage migration calls this; offline there
      // is nothing to migrate into.
      return json(200, { imported: 0, skipped: 0, invalid: 0 });
    }
    const id = rest[0];
    if (!id || rest.length !== 1) return json(404, { error: "Not found." });
    if (bundledIds.has(id)) return json(403, { error: READ_ONLY });
    const index = local.findIndex((item) => item.id === id);
    if (index < 0) return json(404, { error: `No feedback "${id}".` });
    const current = local[index]!;

    if (method === "PATCH") {
      const parsed = updateFeedbackInputSchema.safeParse(body);
      if (!parsed.success) {
        return json(400, {
          error: "Invalid update.",
          issues: parsed.error.issues,
        });
      }
      if (parsed.data.expectedUpdatedAt !== current.updatedAt) {
        return json(409, {
          error: "Feedback changed after it was loaded.",
          current,
        });
      }
      const { reply, message, ...patch } = parsed.data.patch;
      if (reply !== undefined) return json(403, { error: READ_ONLY });
      const updatedAt = nextUpdatedAt(now(), current.updatedAt);
      const thread = [...feedbackThread(current)];
      if (message) {
        thread.push({
          id: newId(),
          role: message.role,
          author:
            message.author ?? (message.role === "agent" ? "Agent" : "Reviewer"),
          note: message.note,
          at: updatedAt,
          ...(patch.status && patch.status !== current.status
            ? { status: patch.status }
            : {}),
        });
      }
      const updated = feedbackRecordSchema.parse({
        ...current,
        ...patch,
        thread,
        updatedAt,
      });
      const next = [...local];
      next[index] = updated;
      save(next);
      return json(200, { feedback: updated });
    }
    if (method === "DELETE") {
      const expected = (body as { expectedUpdatedAt?: unknown } | undefined)
        ?.expectedUpdatedAt;
      if (expected !== current.updatedAt) {
        return json(409, {
          error: "Feedback changed after it was loaded.",
          current,
        });
      }
      save(local.filter((item) => item.id !== id));
      return json(200, { ok: true });
    }
    return json(405, { error: "Method not allowed." });
  }

  return {
    bundle,
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handle(input, init).catch((error: unknown) =>
        json(500, {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    localRecords: () => local,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    exportReview(): ReviewExport {
      return {
        kind: REVIEW_EXPORT_KIND,
        format: 1,
        projectId: project.id,
        bundleId: bundle.id,
        exportedAt: now().toISOString(),
        records: local,
      };
    },
  };
}

export type OfflineApi = ReturnType<typeof createOfflineApi>;

let active: OfflineApi | null = null;

export function activeOfflineApi() {
  return active;
}

// Routes every fetch() on the page through the bundle.
export function installOfflineMode(
  bundle: OfflineBundle,
  options: OfflineApiOptions = {},
) {
  active = createOfflineApi(bundle, options);
  globalThis.fetch = active.fetch as typeof fetch;
  return active;
}
