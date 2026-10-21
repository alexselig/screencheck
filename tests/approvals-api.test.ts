// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleApi } from "../src/server/api";
import { createFeedbackStorage } from "../src/server/storage";

let server: Server;
let root: string;
let base: string;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const storage = createFeedbackStorage({
    dataRoot: root,
    now: () => new Date("2026-10-05T22:00:00.000Z"),
  });
  let port = 0;
  server = createServer(async (request, response) => {
    if (!(await handleApi(request, response, { storage, port }))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/projects/demo/approvals`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const reviewer = { "x-screencheck-actor": "reviewer" };

function put(
  body: unknown,
  headers: Record<string, string> = { origin, ...reviewer },
) {
  return fetch(base, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("screen approvals API", () => {
  it("approves and unapproves a screen in approvals.json", async () => {
    expect((await (await fetch(base)).json()).approvals).toEqual([]);

    const approved = await put({
      version: "v1",
      screenId: "landing",
      approved: true,
    });
    expect(approved.status).toBe(200);
    const record = {
      version: "v1",
      screenId: "landing",
      approvedAt: "2026-10-05T22:00:00.000Z",
    };
    expect((await approved.json()).approvals).toEqual([record]);
    const onDisk = JSON.parse(
      await readFile(join(root, "demo", "approvals.json"), "utf8"),
    );
    expect(onDisk).toEqual({ version: 1, approvals: [record] });

    // Approving twice is a no-op, not a duplicate.
    await put({ version: "v1", screenId: "landing", approved: true });
    expect((await (await fetch(base)).json()).approvals).toHaveLength(1);

    const unapproved = await put({
      version: "v1",
      screenId: "landing",
      approved: false,
    });
    expect((await unapproved.json()).approvals).toEqual([]);
  });

  it("keeps approvals per version", async () => {
    await put({ version: "v1", screenId: "landing", approved: true });
    await put({ version: "v2", screenId: "landing", approved: true });
    await put({ version: "v1", screenId: "landing", approved: false });
    const { approvals } = await (await fetch(base)).json();
    expect(approvals.map((item: { version: string }) => item.version)).toEqual([
      "v2",
    ]);
  });

  it("does not touch feedback.json", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    const feedback = '{"version":1,"feedback":[]}\n';
    await writeFile(join(root, "demo", "feedback.json"), feedback);
    await put({ version: "v1", screenId: "landing", approved: true });
    expect(await readFile(join(root, "demo", "feedback.json"), "utf8")).toBe(
      feedback,
    );
  });

  it("rejects cross-origin writes and bad input", async () => {
    const foreign = await put(
      { version: "v1", screenId: "landing", approved: true },
      { origin: "https://evil.example", ...reviewer },
    );
    expect(foreign.status).toBe(403);
    const bad = await put({ version: "v1", screenId: "", approved: "yes" });
    expect(bad.status).toBe(400);
    expect((await (await fetch(base)).json()).approvals).toEqual([]);
  });

  it("lets only the reviewer approve (be-5)", async () => {
    const agent = await put(
      { version: "v1", screenId: "landing", approved: true },
      { origin },
    );
    expect(agent.status).toBe(403);
    expect((await agent.json()).error).toMatch(/Only a reviewer/);
    const spoofed = await put(
      { version: "v1", screenId: "landing", approved: true },
      { origin, "x-screencheck-actor": "agent" },
    );
    expect(spoofed.status).toBe(403);
    expect((await (await fetch(base)).json()).approvals).toEqual([]);
  });

  it("refuses to approve over unverified fixes unless told to override (be-5)", async () => {
    const feedback = `${origin}/api/projects/demo/feedback`;
    const created = await fetch(feedback, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        clientMutationId: "33333333-3333-4333-8333-333333333333",
        screenId: "landing",
        version: "v1",
        x: 0.5,
        y: 0.5,
        note: "Fix the hero.",
        tags: [],
      }),
    });
    const record = (await created.json()).feedback;
    const fixed = await fetch(`${feedback}/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        expectedUpdatedAt: record.updatedAt,
        patch: {
          status: "RESOLVED",
          reply: { note: "Done.", author: "Agent" },
        },
      }),
    });

    expect(fixed.status).toBe(200);

    const refused = await put({
      version: "v1",
      screenId: "landing",
      approved: true,
    });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.unverified).toBe(1);
    expect(body.error).toMatch(/1 fix is not verified/);
    expect((await (await fetch(base)).json()).approvals).toEqual([]);

    // Other screens and versions are unaffected.
    expect(
      (await put({ version: "v2", screenId: "landing", approved: true }))
        .status,
    ).toBe(200);

    const forced = await put({
      version: "v1",
      screenId: "landing",
      approved: true,
      override: true,
    });
    expect(forced.status).toBe(200);
    expect((await forced.json()).approvals).toHaveLength(2);
  });
});
