// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleApi } from "../src/server/api";
import { createFeedbackStorage } from "../src/server/storage";

let server: Server;
let root: string;
let base: string;
let origin: string;

const input = {
  clientMutationId: "22222222-2222-4222-8222-222222222222",
  screenId: "landing",
  version: "live",
  x: 0.5,
  y: 0.5,
  note: "Tighten the hero.",
  tags: ["P2"],
};

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const storage = createFeedbackStorage({ dataRoot: root });
  let port = 0;
  server = createServer(async (request, response) => {
    if (!(await handleApi(request, response, { storage, port }))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/projects/demo/feedback`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function send(method: string, url: string, body?: unknown, headers = {}) {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("feedback API", () => {
  it("creates, lists, updates and deletes feedback on disk", async () => {
    const created = await send("POST", base, input);
    expect(created.status).toBe(201);
    const { feedback } = await created.json();

    const listed = await (await fetch(base)).json();
    expect(listed.feedback).toEqual([feedback]);
    const onDisk = JSON.parse(
      await readFile(join(root, "demo", "feedback.json"), "utf8"),
    );
    expect(onDisk.feedback).toHaveLength(1);

    const patched = await send("PATCH", `${base}/${feedback.id}`, {
      expectedUpdatedAt: feedback.updatedAt,
      patch: {
        status: "RESOLVED",
        reply: { note: "Completed the requested change.", author: "Agent" },
      },
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json()).feedback;

    const stale = await send("PATCH", `${base}/${feedback.id}`, {
      expectedUpdatedAt: feedback.updatedAt,
      patch: { note: "Old" },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toEqual(updated);

    const deleted = await send("DELETE", `${base}/${feedback.id}`, {
      expectedUpdatedAt: updated.updatedAt,
    });
    expect(deleted.status).toBe(200);
    expect((await (await fetch(base)).json()).feedback).toEqual([]);
  });

  it("rejects mutations from another origin or with no origin", async () => {
    const foreign = await send("POST", base, input, {
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    const missing = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(missing.status).toBe(403);
    expect((await (await fetch(base)).json()).feedback).toEqual([]);
  });

  it("rejects non-JSON bodies, invalid input and unknown records", async () => {
    expect(
      (await send("POST", base, input, { "content-type": "text/plain" }))
        .status,
    ).toBe(415);
    expect((await send("POST", base, { ...input, x: 4 })).status).toBe(400);
    expect(
      (
        await send("PATCH", `${base}/missing`, {
          expectedUpdatedAt: "2026-10-05T20:00:00.000Z",
          patch: { note: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("reports a corrupt store instead of serving an empty list", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "feedback.json"), "{not json");
    const response = await fetch(base);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/invalid JSON/);
    expect((await send("POST", base, input)).status).toBe(500);
    expect(await readFile(join(root, "demo", "feedback.json"), "utf8")).toBe(
      "{not json",
    );
  });

  it("imports legacy records once, keeping ids and reporting invalid ones", async () => {
    const legacy = {
      id: "legacy-1",
      projectId: "example",
      screenId: "landing",
      version: "live",
      x: 0.2,
      y: 0.3,
      note: "From the browser",
      tags: ["P1"],
      status: "OPEN",
      createdAt: "2026-10-05T19:00:00.000Z",
      updatedAt: "2026-10-05T19:00:00.000Z",
    };
    const first = await send("POST", `${base}/import`, {
      records: [legacy, { id: "broken" }],
    });
    expect(await first.json()).toEqual({ imported: 1, skipped: 0, invalid: 1 });
    const again = await send("POST", `${base}/import`, { records: [legacy] });
    expect(await again.json()).toEqual({ imported: 0, skipped: 1, invalid: 0 });
    const listed = (await (await fetch(base)).json()).feedback;
    expect(listed).toEqual([{ ...legacy, projectId: "demo", thread: [] }]);
  });
});

describe("loopback host header", () => {
  it("accepts only the loopback host names on the bound port", async () => {
    const { isLoopbackHostHeader } = await import("../src/server/origin");
    expect(isLoopbackHostHeader("127.0.0.1:4173", 4173)).toBe(true);
    expect(isLoopbackHostHeader("localhost:4173", 4173)).toBe(true);
    expect(isLoopbackHostHeader("evil.example:4173", 4173)).toBe(false);
    expect(isLoopbackHostHeader(undefined, 4173)).toBe(false);
  });
});

describe("feedback API with an invalid record", () => {
  it("lists the valid records with a problem and refuses writes with 409", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    const good = {
      id: "good",
      projectId: "demo",
      screenId: "landing",
      version: "live",
      x: 0.5,
      y: 0.5,
      note: "Fine",
      tags: [],
      status: "OPEN",
      createdAt: "2026-10-05T20:00:00.000Z",
      updatedAt: "2026-10-05T20:00:00.000Z",
    };
    await writeFile(
      join(root, "demo", "feedback.json"),
      JSON.stringify({
        version: 1,
        feedback: [good, { ...good, id: "bad", status: "NOPE" }],
      }),
    );
    const listed = await (await fetch(base)).json();
    expect(listed.feedback.map((item: { id: string }) => item.id)).toEqual([
      "good",
    ]);
    expect(listed.problems[0]).toMatch(/feedback\[1\] \(id bad\): status/);
    const created = await send("POST", base, input);
    expect(created.status).toBe(409);
    expect((await created.json()).error).toMatch(/--quarantine/);
  });
});
