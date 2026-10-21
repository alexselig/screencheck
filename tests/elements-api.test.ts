// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

const MAP = {
  version: 1,
  capture: { width: 1440, height: 2400 },
  elements: [
    {
      box: { x: 0.7, y: 0.92, w: 0.2, h: 0.05 },
      tag: "button",
      role: "button",
      name: "Continue to vehicle",
      selector: "footer > button",
      source: { file: "src/booking/Footer.tsx", line: 42 },
    },
  ],
};

const screen = (id: string, ordinal: number, capturePath: string) => ({
  id,
  ordinal,
  title: id,
  description: `The ${id} screen.`,
  group: "Main",
  capturePath,
  viewport: { width: 1440, height: 1000 },
});

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-elements-"));
  const captures = join(root, "captures", "v1");
  await mkdir(join(root, "projects"));
  await mkdir(captures, { recursive: true });
  await writeFile(join(captures, "home.png"), "png");
  await writeFile(join(captures, "home.elements.json"), JSON.stringify(MAP));
  await writeFile(join(captures, "bare.png"), "png");
  await writeFile(join(captures, "broken.png"), "png");
  await writeFile(
    join(captures, "broken.elements.json"),
    JSON.stringify({ ...MAP, elements: [{ tag: "div" }] }),
  );
  await writeFile(join(captures, "garbled.png"), "png");
  await writeFile(join(captures, "garbled.elements.json"), "{nope");
  // A map that resolves outside the captureRoot through a symlink.
  await writeFile(join(root, "secret.elements.json"), JSON.stringify(MAP));
  await writeFile(join(captures, "linked.png"), "png");
  await symlink(
    join(root, "secret.elements.json"),
    join(captures, "linked.elements.json"),
  );
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [
        screen("home", 1, join(captures, "home.png")),
        screen("bare", 2, join(captures, "bare.png")),
        screen("broken", 3, join(captures, "broken.png")),
        screen("garbled", 4, join(captures, "garbled.png")),
        screen("linked", 5, join(captures, "linked.png")),
        // Declared outside the root: falls back to `secret.png` inside it.
        screen("away", 6, join(root, "secret.png")),
      ],
    }),
  );
  server = await startServer({
    port: 0,
    dataRoot: join(root, "feedback"),
    projectsRoot: join(root, "projects"),
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const get = (route: string) =>
  fetch(`${server.origin}/api/projects/demo/elements/${route}`);

describe("element map route", () => {
  it("serves the map stored beside a screen's capture", async () => {
    const response = await get("v1/home");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual(MAP);
  });

  it("answers 404 when a screen has no map", async () => {
    for (const route of ["v1/bare", "v1/nope", "v9/home"]) {
      const response = await get(route);
      expect(response.status).toBe(404);
      expect((await response.json()).error).toMatch(/not found/i);
    }
    expect(
      (await fetch(`${server.origin}/api/projects/other/elements/v1/home`))
        .status,
    ).toBe(404);
  });

  it("never reads a map from outside the captureRoot", async () => {
    expect((await get("v1/linked")).status).toBe(404);
    expect((await get("v1/away")).status).toBe(404);
    const encoded = await get(`v1/${encodeURIComponent("../../secret")}`);
    expect(encoded.status).toBe(404);
  });

  it("reports a malformed map as a server error", async () => {
    const broken = await get("v1/broken");
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toMatch(/malformed/i);
    const garbled = await get("v1/garbled");
    expect(garbled.status).toBe(500);
    expect((await garbled.json()).error).toMatch(/not valid JSON/);
  });

  it("is read-only", async () => {
    const response = await fetch(
      `${server.origin}/api/projects/demo/elements/v1/home`,
      { method: "DELETE", headers: { origin: server.origin } },
    );
    expect(response.status).toBe(405);
  });
});

describe("dev mode (Vite) page headers (be-6)", () => {
  it("forbids framing the app", async () => {
    const page = await fetch(`${server.origin}/`);
    expect(page.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });
});
