import { afterEach, describe, expect, it } from "vitest";

import {
  captureSrc,
  createOfflineApi,
  installOfflineMode,
  offlineStorageKey,
} from "../src/client/offline-api";
import {
  fetchApprovals,
  fetchFeedback,
  fetchProjects,
  patchFeedback,
  postFeedback,
  putApproval,
  removeFeedback,
  FeedbackApiError,
} from "../src/client/feedback-api";
import { fetchElementMap } from "../src/client/element-map-api";
import { reviewExportSchema, type OfflineBundle } from "../src/shared/bundle";
import type { FeedbackRecord } from "../src/shared/feedback";

const bundled: FeedbackRecord = {
  id: "existing-1",
  projectId: "shop",
  screenId: "home",
  version: "v2",
  x: 0.5,
  y: 0.5,
  note: "Logo is blurry",
  tags: [],
  status: "OPEN",
  thread: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function bundle(): OfflineBundle {
  return {
    format: 1,
    id: "shop-20261026",
    createdAt: "2026-10-26T00:00:00.000Z",
    project: {
      id: "shop",
      name: "Shop",
      versions: ["v2"],
      screens: [
        {
          id: "home",
          ordinal: 1,
          title: "Home",
          group: "Main",
          viewport: { width: 1440, height: 1000 },
          hasCapture: true,
        },
      ],
    },
    feedback: [bundled],
    approvals: [],
    captions: [],
    captures: { "v2/home": "captures/v2/home.png" },
    elements: {
      "v2/home": {
        version: 1,
        capture: { width: 1440, height: 1000 },
        elements: [],
      },
    },
  };
}

const UUID = "4f0f3c55-8f61-4a43-9d47-3e9a3d0c1a01";
const UUID2 = "4f0f3c55-8f61-4a43-9d47-3e9a3d0c1a02";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 26, 12, 0, tick++));

async function call(
  api: ReturnType<typeof createOfflineApi>,
  method: string,
  url: string,
  body?: unknown,
) {
  const response = await api.fetch(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.__SCREENCHECK_BUNDLE__;
});

describe("offline review API (#13)", () => {
  it("serves the bundled project, feedback, approvals and element maps", async () => {
    const api = createOfflineApi(bundle(), { storage: memoryStorage() });
    const projects = await call(api, "GET", "/api/projects");
    expect(projects.status).toBe(200);
    expect(projects.body.projects[0].id).toBe("shop");
    expect(projects.body.problems).toEqual([]);
    const feedback = await call(api, "GET", "/api/projects/shop/feedback");
    expect(feedback.body.feedback.map((r: FeedbackRecord) => r.id)).toEqual([
      "existing-1",
    ]);
    expect(
      (await call(api, "GET", "/api/projects/shop/approvals")).body,
    ).toEqual({ approvals: [] });
    expect(
      (await call(api, "GET", "/api/projects/shop/elements/v2/home")).status,
    ).toBe(200);
    expect(
      (await call(api, "GET", "/api/projects/shop/elements/v2/nope")).status,
    ).toBe(404);
    expect(
      (await call(api, "GET", "/api/projects/other/feedback")).status,
    ).toBe(404);
  });

  it("keeps new comments in local storage, idempotently, across reloads", async () => {
    const storage = memoryStorage();
    const api = createOfflineApi(bundle(), { storage, now: clock });
    const input = {
      clientMutationId: UUID,
      screenId: "home",
      version: "v2",
      x: 0.1,
      y: 0.2,
      note: "Button too small",
    };
    const created = await call(
      api,
      "POST",
      "/api/projects/shop/feedback",
      input,
    );
    expect(created.status).toBe(201);
    expect(created.body.feedback).toMatchObject({
      id: UUID,
      projectId: "shop",
      note: "Button too small",
      status: "OPEN",
      tags: [],
    });
    const again = await call(api, "POST", "/api/projects/shop/feedback", input);
    expect(again.status).toBe(201);
    expect(again.body.feedback.id).toBe(UUID);
    expect(api.localRecords()).toHaveLength(1);
    expect(storage.getItem(offlineStorageKey(bundle()))).toContain(UUID);

    const reloaded = createOfflineApi(bundle(), { storage });
    const listed = await call(reloaded, "GET", "/api/projects/shop/feedback");
    expect(listed.body.feedback.map((r: FeedbackRecord) => r.id)).toEqual([
      "existing-1",
      UUID,
    ]);
  });

  it("edits, threads and deletes the reviewer's own comments with conflict checks", async () => {
    const api = createOfflineApi(bundle(), {
      storage: memoryStorage(),
      now: clock,
      newId: () => "message-1",
    });
    const { body } = await call(api, "POST", "/api/projects/shop/feedback", {
      clientMutationId: UUID,
      screenId: "home",
      version: "v2",
      x: 0.1,
      y: 0.2,
      note: "First",
    });
    const record = body.feedback as FeedbackRecord;
    const patched = await call(
      api,
      "PATCH",
      `/api/projects/shop/feedback/${UUID}`,
      {
        expectedUpdatedAt: record.updatedAt,
        patch: { note: "Second", tags: ["Copy"], message: { note: "More" } },
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.feedback).toMatchObject({
      note: "Second",
      tags: ["Copy"],
      thread: [{ id: "message-1", role: "reviewer", note: "More" }],
    });
    expect(patched.body.feedback.updatedAt > record.updatedAt).toBe(true);

    const stale = await call(
      api,
      "PATCH",
      `/api/projects/shop/feedback/${UUID}`,
      { expectedUpdatedAt: record.updatedAt, patch: { note: "Third" } },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.current.note).toBe("Second");

    const invalid = await call(
      api,
      "PATCH",
      `/api/projects/shop/feedback/${UUID}`,
      { expectedUpdatedAt: "nope", patch: {} },
    );
    expect(invalid.status).toBe(400);

    const removed = await call(
      api,
      "DELETE",
      `/api/projects/shop/feedback/${UUID}`,
      { expectedUpdatedAt: patched.body.feedback.updatedAt },
    );
    expect(removed.status).toBe(200);
    expect(api.localRecords()).toEqual([]);
  });

  it("keeps bundled feedback, approvals and captions read-only", async () => {
    const api = createOfflineApi(bundle(), { storage: memoryStorage() });
    const patch = await call(
      api,
      "PATCH",
      "/api/projects/shop/feedback/existing-1",
      { expectedUpdatedAt: bundled.updatedAt, patch: { note: "x" } },
    );
    expect(patch.status).toBe(403);
    expect(patch.body.error).toMatch(/offline/i);
    const remove = await call(
      api,
      "DELETE",
      "/api/projects/shop/feedback/existing-1",
      { expectedUpdatedAt: bundled.updatedAt },
    );
    expect(remove.status).toBe(403);
    for (const route of ["approvals", "captions"]) {
      const put = await call(api, "PUT", `/api/projects/shop/${route}`, {});
      expect(put.status).toBe(403);
    }
    // The legacy-migration import is a no-op offline.
    const imported = await call(
      api,
      "POST",
      "/api/projects/shop/feedback/import",
      { records: [] },
    );
    expect(imported.body).toEqual({ imported: 0, skipped: 0, invalid: 0 });
  });

  it("exports only the reviewer's comments as a review file", async () => {
    const api = createOfflineApi(bundle(), {
      storage: memoryStorage(),
      now: clock,
    });
    let changes = 0;
    const stop = api.subscribe(() => (changes += 1));
    for (const id of [UUID, UUID2]) {
      await call(api, "POST", "/api/projects/shop/feedback", {
        clientMutationId: id,
        screenId: "home",
        version: "v2",
        x: 0.3,
        y: 0.3,
        note: `Note ${id.slice(-1)}`,
      });
    }
    stop();
    expect(changes).toBe(2);
    const exported = reviewExportSchema.parse(api.exportReview());
    expect(exported).toMatchObject({
      kind: "screencheck-review",
      projectId: "shop",
      bundleId: "shop-20261026",
    });
    expect(exported.records.map((r) => (r as FeedbackRecord).id)).toEqual([
      UUID,
      UUID2,
    ]);
  });

  it("is a drop-in for fetch, so the app's API modules work unchanged", async () => {
    const data = bundle();
    window.__SCREENCHECK_BUNDLE__ = data;
    installOfflineMode(data, { storage: memoryStorage(), now: clock });
    expect((await fetchProjects()).projects[0]!.name).toBe("Shop");
    const created = await postFeedback("shop", {
      clientMutationId: UUID,
      screenId: "home",
      version: "v2",
      x: 0.4,
      y: 0.4,
      note: "Via the app",
    });
    const updated = await patchFeedback("shop", UUID, {
      expectedUpdatedAt: created.updatedAt,
      patch: { status: "IN_PROGRESS" },
    });
    expect(updated.status).toBe("IN_PROGRESS");
    expect((await fetchFeedback("shop")).map((r) => r.id)).toEqual([
      "existing-1",
      UUID,
    ]);
    await removeFeedback("shop", UUID, updated.updatedAt);
    expect(await fetchApprovals("shop")).toEqual([]);
    await expect(
      putApproval("shop", { version: "v2", screenId: "home", approved: true }),
    ).rejects.toBeInstanceOf(FeedbackApiError);
    expect(await fetchElementMap("shop", "v2", "home")).not.toBeNull();
  });

  it("points captures at files inside the bundle", () => {
    expect(captureSrc("shop", "v2", "home")).toBe(
      "/api/projects/shop/captures/v2/home",
    );
    window.__SCREENCHECK_BUNDLE__ = bundle();
    expect(captureSrc("shop", "v2", "home")).toBe("captures/v2/home.png");
    expect(captureSrc("shop", "v2", "missing")).toBe("captures/v2/missing");
  });
});
