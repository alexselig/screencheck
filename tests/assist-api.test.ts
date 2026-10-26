// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleApi } from "../src/server/api";
import { createAssist, type Spawner } from "../src/server/assist";
import { createFeedbackStorage } from "../src/server/storage";

let server: Server | undefined;
let root: string | undefined;
let origin = "";

async function start(spawn?: Spawner, timeoutMs?: number) {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const storage = createFeedbackStorage({ dataRoot: root });
  const assist = spawn ? createAssist({ spawn, timeoutMs }) : undefined;
  let port = 0;
  server = createServer(async (request, response) => {
    if (!(await handleApi(request, response, { storage, port, assist }))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server!.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return storage;
}

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { origin },
) {
  return fetch(`${origin}/api/assist/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function fakeCopilot(answer: string) {
  return vi.fn<Spawner>(async (_bin, args) =>
    args[0] === "--version"
      ? { exitCode: 0, stdout: "1.0.0\n", stderr: "" }
      : { exitCode: 0, stdout: answer, stderr: "" },
  );
}

describe("assist API", () => {
  it("is off by default: status says so and routes refuse", async () => {
    await start();
    const status = await fetch(`${origin}/api/assist`);
    expect(await status.json()).toEqual({ enabled: false, available: false });
    const rewrite = await post("rewrite", { note: "fix it" });
    expect(rewrite.status).toBe(404);
    expect((await rewrite.json()).error).toMatch(/--assist/);
  });

  it("reports availability when enabled", async () => {
    await start(fakeCopilot(""));
    const status = await (await fetch(`${origin}/api/assist`)).json();
    expect(status).toEqual({ enabled: true, available: true });
  });

  it("reports unavailable when the CLI is missing", async () => {
    await start(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const status = await (await fetch(`${origin}/api/assist`)).json();
    expect(status).toEqual({ enabled: true, available: false });
    expect((await post("rewrite", { note: "fix it" })).status).toBe(503);
  });

  it("requires a ScreenCheck Origin on every POST", async () => {
    const spawn = fakeCopilot("ok");
    await start(spawn);
    for (const path of ["rewrite", "suggest", "duplicates", "summary"]) {
      const missing = await post(path, { note: "x" }, {});
      expect(missing.status).toBe(403);
      const evil = await post(
        path,
        { note: "x" },
        { origin: "https://evil.example" },
      );
      expect(evil.status).toBe(403);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rewrites a note", async () => {
    await start(fakeCopilot("Raise the button contrast to 4.5:1."));
    const response = await post("rewrite", { note: "button hard to see" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instruction: "Raise the button contrast to 4.5:1.",
    });
    expect((await post("rewrite", { note: "" })).status).toBe(400);
  });

  it("suggests tags and a priority", async () => {
    await start(fakeCopilot('{"priority":"P0","tags":["Contrast"]}'));
    const response = await post("suggest", { note: "can't read it" });
    expect(await response.json()).toEqual({
      priority: "P0",
      tags: ["Contrast"],
    });
  });

  it("finds likely duplicates on the same screen without calling Copilot", async () => {
    const spawn = fakeCopilot("");
    const storage = await start(spawn);
    const created = await storage.createFeedback("demo", {
      clientMutationId: crypto.randomUUID(),
      version: "v1",
      screenId: "landing",
      x: 0.2,
      y: 0.2,
      note: "Continue button contrast is too low",
    } as never);
    const response = await post("duplicates", {
      projectId: "demo",
      version: "v1",
      screenId: "landing",
      note: "contrast on the continue button is low",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.duplicates.map((item: { id: string }) => item.id)).toEqual([
      created.id,
    ]);
    expect(
      spawn.mock.calls.filter(([, args]) => args[0] !== "--version"),
    ).toEqual([]);
  });

  it("summarises a round as markdown", async () => {
    const spawn = fakeCopilot("## Summary\n- one open");
    const storage = await start(spawn);
    await storage.createFeedback("demo", {
      clientMutationId: crypto.randomUUID(),
      version: "v1",
      screenId: "landing",
      x: 0.2,
      y: 0.2,
      note: "Logo blurry",
    } as never);
    const response = await post("summary", {
      projectId: "demo",
      version: "v1",
    });
    expect(await response.json()).toEqual({
      markdown: "## Summary\n- one open",
    });
    const prompt = spawn.mock.calls.at(-1)![1][1]!;
    expect(prompt).toContain("Logo blurry");
  });

  it("maps a Copilot timeout to 504", async () => {
    await start(
      (_bin, args) =>
        args[0] === "--version"
          ? Promise.resolve({ exitCode: 0, stdout: "1", stderr: "" })
          : new Promise(() => {}),
      20,
    );
    const response = await post("rewrite", { note: "x" });
    expect(response.status).toBe(504);
  });
});

describe("screencheck serve --assist", () => {
  it("turns assist on only when asked", async () => {
    const { main } = await import("../src/cli/index");
    const serve = vi.fn(
      async (_options?: object) => ({ origin: "http://127.0.0.1:1" }) as never,
    );
    const io = {
      log: () => {},
      error: () => {},
      readRuntime: () => null,
      serve,
    };
    expect(await main(["serve", "--port", "0", "--assist"], io)).toBe(
      "running",
    );
    expect(serve).toHaveBeenLastCalledWith(
      expect.objectContaining({ assist: true }),
    );
    await main(["serve", "--port", "0"], io);
    expect(serve.mock.calls.at(-1)![0]).not.toHaveProperty("assist");
  });
});
