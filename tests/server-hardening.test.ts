// @vitest-environment node
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleApi } from "../src/server/api";
import { startServer } from "../src/server/index";
import type { ProjectCatalog } from "../src/server/projects";
import {
  createFeedbackStorage,
  StoreError,
  type FeedbackStorage,
} from "../src/server/storage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-harden-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function apiServer(storage: FeedbackStorage, catalog?: ProjectCatalog) {
  let port = 0;
  const server: Server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }
    await handleApi(request, response, { storage, port, catalog });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function realProject() {
  const captures = join(root, "captures", "v1");
  await mkdir(captures, { recursive: true });
  await mkdir(join(root, "projects"));
  await writeFile(join(captures, "home.png"), "first");
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [
        {
          id: "home",
          ordinal: 1,
          title: "Home",
          description: "Home.",
          group: "Main",
          capturePath: join(captures, "home.png"),
          viewport: { width: 1440, height: 1000 },
        },
      ],
    }),
  );
  return captures;
}

describe("streaming files (be-4)", () => {
  it("answers 404 when the capture vanishes before it is opened, and keeps serving", async () => {
    const missing = join(root, "gone.png");
    const catalog = {
      capture: async () => ({
        type: "image/png",
        etag: '"1-1"',
        open: () => createReadStream(missing),
      }),
    } as unknown as ProjectCatalog;
    const api = await apiServer(
      createFeedbackStorage({ dataRoot: join(root, "data") }),
      catalog,
    );
    try {
      const response = await fetch(
        `${api.origin}/api/projects/demo/captures/v1/home`,
      );
      expect(response.status).toBe(404);
      expect((await fetch(`${api.origin}/healthz`)).status).toBe(200);
    } finally {
      await api.close();
    }
  });
});

describe("headers (be-6) and capture revalidation (be-11)", () => {
  it("sends CORP on the API, ETag + no-cache on captures, and 304 when unchanged", async () => {
    const captures = await realProject();
    const client = join(root, "client");
    await mkdir(client);
    await writeFile(join(client, "index.html"), "<!doctype html>");
    const server = await startServer({
      port: 0,
      dataRoot: join(root, "feedback"),
      projectsRoot: join(root, "projects"),
      clientRoot: client,
    });
    try {
      const page = await fetch(`${server.origin}/`);
      expect(page.headers.get("content-security-policy")).toBe(
        "frame-ancestors 'none'",
      );
      expect(page.headers.get("x-frame-options")).toBe("DENY");

      const list = await fetch(`${server.origin}/api/projects`);
      expect(list.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );

      const url = `${server.origin}/api/projects/demo/captures/v1/home`;
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("first");
      expect(first.headers.get("cache-control")).toBe("no-cache");
      expect(first.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      const etag = first.headers.get("etag")!;
      expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);

      const again = await fetch(url, { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);

      await writeFile(join(captures, "home.png"), "second!");
      const later = new Date(Date.now() + 5000);
      await utimes(join(captures, "home.png"), later, later);
      const changed = await fetch(url, { headers: { "if-none-match": etag } });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe("second!");
      expect(changed.headers.get("etag")).not.toBe(etag);

      await unlink(join(captures, "home.png"));
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(`${server.origin}/healthz`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("error mapping (be-16)", () => {
  it("answers 400 for malformed escapes and invalid project ids", async () => {
    const api = await apiServer(
      createFeedbackStorage({ dataRoot: join(root, "data") }),
    );
    try {
      for (const path of [
        "/api/projects/%E0/feedback",
        "/api/projects/demo/feedback/%E0%A4%A",
        "/api/projects/%E0/approvals",
        "/api/projects/%E0/captions",
      ]) {
        const response = await fetch(`${api.origin}${path}`);
        expect(response.status, path).toBe(400);
        expect((await response.json()).error).toBe("Bad request path.");
      }
      const bad = await fetch(`${api.origin}/api/projects/a%20b/feedback`);
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("Invalid project id");
    } finally {
      await api.close();
    }
  });

  it("logs storage failures but returns only a safe message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createFeedbackStorage({ dataRoot: join(root, "data") });
    const api = await apiServer({
      ...storage,
      inspectFeedback: async () => {
        throw new Error("EACCES: permission denied, open '/Users/x/secret'");
      },
      listApprovals: async () => {
        throw new StoreError("approvals.json is damaged.", "/Users/x/a.json");
      },
    });
    try {
      const raw = await fetch(`${api.origin}/api/projects/demo/feedback`);
      expect(raw.status).toBe(500);
      const body = await raw.json();
      expect(body.error).toBe(
        "Storage failed; see the ScreenCheck server log.",
      );
      expect(JSON.stringify(body)).not.toContain("/Users/x");

      const store = await fetch(`${api.origin}/api/projects/demo/approvals`);
      expect(store.status).toBe(500);
      expect((await store.json()).error).toBe("approvals.json is damaged.");
      const log = logged.mock.calls.flat().map(String).join("\n");
      expect(log).toContain("/Users/x/secret");
      expect(log).toContain("/Users/x/a.json");
    } finally {
      await api.close();
    }
  });
});
