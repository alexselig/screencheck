// @vitest-environment node
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCaptureComparer } from "../src/server/changed";
import { startServer } from "../src/server/index";
import { createProjectCatalog } from "../src/server/projects";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-changed-"));
  await mkdir(join(root, "projects"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const screen = (id: string, ordinal: number) => ({
  id,
  ordinal,
  title: id,
  group: "Main",
  viewport: { width: 1440, height: 1000 },
  capturePath: `${id}.png`,
});

async function captures(folder: string, files: Record<string, string>) {
  const dir = join(root, "captures", folder);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.png`), body);
  }
  return dir;
}

describe("changed since the previous build", () => {
  it("flags each version whose capture differs from the same size one build back", async () => {
    const v41 = await captures("41-1440", {
      home: "home one",
      cart: "cart same",
      about: "about A",
    });
    const v42 = await captures("42-1440", {
      home: "home two!",
      cart: "cart same",
      // Same size, different bytes: needs the hash, not just the length.
      about: "about B",
    });
    const v42phone = await captures("42-390", { home: "phone" });
    await writeFile(
      join(root, "projects", "shop.json"),
      JSON.stringify({
        id: "shop",
        name: "Shop",
        versions: [
          { id: "b41-1440", revision: "b41", label: "1440", captureRoot: v41 },
          {
            id: "b42-390",
            revision: "b42",
            label: "390",
            captureRoot: v42phone,
          },
          { id: "b42-1440", revision: "b42", label: "1440", captureRoot: v42 },
        ],
        screens: [
          screen("home", 1),
          screen("cart", 2),
          screen("about", 3),
          screen("gone", 4),
        ],
      }),
    );
    const catalog = createProjectCatalog({
      projectsRoot: join(root, "projects"),
    });
    const { projects } = await catalog.list();
    const changed = Object.fromEntries(
      projects[0]!.screens.map((item) => [item.id, item.changed]),
    );
    // No 390 in build 41, so the phone size has nothing to compare against.
    expect(changed).toEqual({
      home: ["b42-1440"],
      cart: undefined,
      about: ["b42-1440"],
      gone: undefined,
    });
  });

  it("is served by /api/projects", async () => {
    const one = await captures("1", { home: "one" });
    const two = await captures("2", { home: "two" });
    await writeFile(
      join(root, "projects", "shop.json"),
      JSON.stringify({
        id: "shop",
        name: "Shop",
        versions: [
          { id: "build-41", captureRoot: one },
          { id: "build-42", captureRoot: two },
        ],
        screens: [screen("home", 1)],
      }),
    );
    const server = await startServer({
      port: 0,
      dataRoot: join(root, "feedback"),
      projectsRoot: join(root, "projects"),
    });
    try {
      const body = await (await fetch(`${server.origin}/api/projects`)).json();
      expect(body.projects[0].screens[0].changed).toEqual(["build-42"]);
    } finally {
      await server.close();
    }
  });

  it("hashes each file once until it changes", async () => {
    const dir = await captures("x", { a: "same", b: "same", c: "diff" });
    const read = vi.fn();
    const differ = createCaptureComparer({ onHash: read });
    expect(await differ(join(dir, "a.png"), join(dir, "b.png"))).toBe(false);
    expect(await differ(join(dir, "a.png"), join(dir, "b.png"))).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    // A different length never needs a hash.
    expect(await differ(join(dir, "a.png"), join(dir, "missing.png"))).toBe(
      null,
    );
    await writeFile(join(dir, "b.png"), "diff");
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, "b.png"), later, later);
    expect(await differ(join(dir, "a.png"), join(dir, "b.png"))).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
