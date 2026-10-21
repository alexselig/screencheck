// @vitest-environment node
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startServer } from "../src/server/index";

// Static mode must never load Vite; the published package does not ship it.
vi.mock("vite", () => ({
  createServer: () => {
    throw new Error("Vite was loaded in static mode");
  },
}));

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-"));
  const client = join(root, "client");
  await mkdir(join(client, "assets"), { recursive: true });
  await writeFile(join(client, "index.html"), "<!doctype html><p>shell</p>");
  await writeFile(join(client, "assets", "app-abc123.js"), "export {};");
  await writeFile(join(client, "assets", "app-abc123.css"), "p{}");
  await writeFile(join(root, "secret.txt"), "outside the client");
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
    clientRoot: client,
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

// fetch() normalises "..", so traversal probes go through http.request.
function raw(path: string, headers: Record<string, string> = {}) {
  const url = new URL(server.origin);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path, headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("static client mode", () => {
  it("serves the built index for the root and client routes", async () => {
    expect(server.mode).toBe("static");
    for (const path of ["/", "/projects/shop", "/index.html"]) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("shell");
    }
  });

  it("serves fingerprinted assets with their type and a long cache", async () => {
    const script = await fetch(`${server.origin}/assets/app-abc123.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect(await script.text()).toBe("export {};");

    const style = await fetch(`${server.origin}/assets/app-abc123.css`);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const missing = await fetch(`${server.origin}/assets/gone.js`);
    expect(missing.status).toBe(404);
  });

  it("never serves files outside the client folder", async () => {
    for (const path of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/..%5csecret.txt",
    ]) {
      const response = await raw(path);
      expect(response.body).not.toContain("outside the client");
    }
  });

  it("refuses foreign Host headers and non-GET methods", async () => {
    expect((await raw("/", { host: "evil.example" })).status).toBe(403);
    const posted = await fetch(`${server.origin}/`, { method: "POST" });
    expect(posted.status).toBe(405);
  });

  it("keeps the API and health check working", async () => {
    expect(await (await fetch(`${server.origin}/healthz`)).json()).toEqual({
      ok: true,
    });
    const projects = await fetch(`${server.origin}/api/projects`);
    expect(projects.status).toBe(200);
    expect((await projects.json()).projects).toEqual([]);
    const unknown = await fetch(`${server.origin}/api/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
  });
});
