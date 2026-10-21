// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";
import { createProjectCatalog } from "../src/server/projects";
import { createPinNumbers } from "../src/shared/export";
import type { FeedbackRecord } from "../src/shared/feedback";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sc-catalog-"));
  await mkdir(join(root, "projects"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const screen = (id: string, ordinal: number, capturePath?: string) => ({
  id,
  ordinal,
  title: id,
  description: `The ${id} screen.`,
  group: "Main",
  viewport: { width: 1440, height: 1000 },
  ...(capturePath ? { capturePath } : {}),
});

async function register(body: unknown, name = "shop.json") {
  await writeFile(join(root, "projects", name), JSON.stringify(body));
}

describe("relative capture paths (pr-8)", () => {
  it("reads subfolders of the captureRoot and reports missing or escaping captures", async () => {
    const captures = join(root, "captures", "v1");
    await mkdir(join(captures, "flows"), { recursive: true });
    await writeFile(join(captures, "flows", "checkout.png"), "nested");
    await writeFile(join(captures, "checkout.png"), "wrong one");
    await writeFile(join(root, "captures", "secret.png"), "outside");
    await register({
      id: "shop",
      name: "Shop",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [
        screen("checkout", 1, "flows/checkout.png"),
        screen("cart", 2, "flows/cart.png"),
        screen("escape", 3, "../secret.png"),
      ],
    });
    const catalog = createProjectCatalog({
      projectsRoot: join(root, "projects"),
    });
    const list = await catalog.list();
    const shop = list.projects.find((item) => item.id === "shop")!;
    expect(shop.screens.map((item) => [item.id, item.hasCapture])).toEqual([
      ["checkout", true],
      ["cart", false],
      ["escape", false],
    ]);
    expect(list.problems).toEqual([
      'shop: screen "cart" capture flows/cart.png not found in version v1.',
      'shop: screen "escape" capturePath "../secret.png" points outside the captureRoot.',
    ]);
    expect(JSON.stringify(list)).not.toContain(root);

    const file = await catalog.capture("shop", "v1", "checkout");
    const chunks: Buffer[] = [];
    for await (const chunk of file!.open()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("nested");
    expect(await catalog.capture("shop", "v1", "escape")).toBeNull();
  });
});

describe("registry cache (be-14)", () => {
  it("parses registrations once until a file changes", async () => {
    const captures = join(root, "captures");
    await mkdir(captures);
    await register({
      id: "shop",
      name: "Shop",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [screen("home", 1)],
    });
    let parses = 0;
    const catalog = createProjectCatalog({
      projectsRoot: join(root, "projects"),
      readFile: async (file) => {
        parses += 1;
        return readFile(file, "utf8");
      },
    });
    for (let index = 0; index < 20; index += 1) {
      await catalog.capture("shop", "v1", "home");
    }
    await catalog.list();
    expect(parses).toBe(1);

    await register({
      id: "shop",
      name: "Shop renamed",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: [screen("home", 1)],
    });
    const later = new Date(Date.now() + 5000);
    await utimes(join(root, "projects", "shop.json"), later, later);
    expect((await catalog.list()).projects[0]!.name).toBe("Shop renamed");
    expect(parses).toBe(2);

    await register(
      {
        id: "two",
        name: "Two",
        versions: [{ id: "v1", captureRoot: captures }],
        screens: [screen("a", 1)],
      },
      "two.json",
    );
    expect((await catalog.list()).projects.map((item) => item.id)).toEqual([
      "shop",
      "two",
    ]);
    expect(parses).toBe(4);
  });

  it("stays fast with 200 screens and 5,000 comments", async () => {
    const captures = join(root, "captures");
    await mkdir(captures);
    await register({
      id: "big",
      name: "Big",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: Array.from({ length: 200 }, (_, index) =>
        screen(`s${index}`, index + 1),
      ),
    });
    const catalog = createProjectCatalog({
      projectsRoot: join(root, "projects"),
    });
    await catalog.list();
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) {
      await catalog.capture("big", "v1", `s${index}`);
    }
    const lookups = performance.now() - started;

    const feedback = Array.from({ length: 5000 }, (_, index) => ({
      id: `c${index}`,
      version: "v1",
      screenId: `s${index % 3}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })) as FeedbackRecord[];
    const pinStarted = performance.now();
    const pins = createPinNumbers(feedback);
    const pinning = performance.now() - pinStarted;
    expect(pins.size).toBe(5000);
    expect(pins.get("c4999")).toBe(1667);
    // Generous bounds: these catch a return to O(n²) or per-request parsing,
    // not normal machine-to-machine variation.
    expect(lookups).toBeLessThan(2000);
    expect(pinning).toBeLessThan(250);
  });
});

describe("unregistered projects, versions and screens (be-10, pr-12)", () => {
  it("answers 404 with the valid ids instead of saving data nothing shows", async () => {
    const captures = join(root, "captures");
    await mkdir(captures);
    await register({
      id: "shop",
      name: "Shop",
      versions: [
        { id: "v1", captureRoot: captures },
        { id: "v2", captureRoot: captures },
      ],
      screens: [screen("home", 1), screen("cart", 2)],
    });
    await register(
      {
        id: "try",
        name: "Try",
        versions: [{ id: "v1", captureRoot: captures }],
        screens: [screen("a", 1)],
      },
      "try.json",
    );
    const server = await startServer({
      port: 0,
      dataRoot: join(root, "feedback"),
      projectsRoot: join(root, "projects"),
      clientRoot: root,
    });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${server.origin}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin: server.origin,
          "x-screencheck-actor": "reviewer",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const pin = (version: string, screenId: string) => ({
      clientMutationId: crypto.randomUUID(),
      version,
      screenId,
      x: 0.5,
      y: 0.5,
      note: "Typo test.",
      tags: [],
    });
    try {
      const listed = await send("GET", "/api/projects/shpo/feedback");
      expect(listed.status).toBe(404);
      expect((await listed.json()).error).toBe(
        'Unknown project "shpo". Projects: shop, try.',
      );
      const created = await send(
        "POST",
        "/api/projects/shpo/feedback",
        pin("v1", "home"),
      );
      expect(created.status).toBe(404);
      const version = await send(
        "POST",
        "/api/projects/shop/feedback",
        pin("v9", "home"),
      );
      expect(version.status).toBe(404);
      expect((await version.json()).error).toBe(
        'Project shop has no version "v9". Versions: v1, v2.',
      );
      const screenMiss = await send(
        "POST",
        "/api/projects/shop/feedback",
        pin("v1", "hme"),
      );
      expect((await screenMiss.json()).error).toBe(
        'Project shop has no screen "hme". Screens: home, cart.',
      );
      expect(
        (
          await send("POST", "/api/projects/shpo/feedback/import", {
            records: [],
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send("PUT", "/api/projects/shop/approvals", {
            version: "v1",
            screenId: "nope",
            approved: true,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send("PUT", "/api/projects/shop/captions", {
            version: "v3",
            screenId: "home",
            text: "x",
          })
        ).status,
      ).toBe(404);

      expect(
        (await send("POST", "/api/projects/shop/feedback", pin("v2", "cart")))
          .status,
      ).toBe(201);
      // The placeholder project always works.
      expect(
        (
          await send(
            "POST",
            "/api/projects/example/feedback",
            pin("live", "landing"),
          )
        ).status,
      ).toBe(201);
      expect((await send("GET", "/api/projects/example/feedback")).status).toBe(
        200,
      );
    } finally {
      await server.close();
    }
  });
});
