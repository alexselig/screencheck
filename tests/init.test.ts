// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli/index";
import { imageSize } from "../src/cli/image-size";
import { titleFromFile } from "../src/cli/init";
import { createProjectCatalog } from "../src/server/projects";

let root: string;
let projects: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-init-"));
  projects = join(root, "projects");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function image(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#ffffff" },
  });
}

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    env: {},
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("image size", () => {
  it("reads PNG, JPEG and WebP headers", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const bytes = await image(321, 123).toFormat(format).toBuffer();
      expect(imageSize(bytes)).toEqual({ width: 321, height: 123 });
    }
    const lossless = await image(40, 30).webp({ lossless: true }).toBuffer();
    expect(imageSize(lossless)).toEqual({ width: 40, height: 30 });
    const alpha = await sharp({
      create: { width: 50, height: 20, channels: 4, background: "#ff000080" },
    })
      .webp()
      .toBuffer();
    expect(imageSize(alpha)).toEqual({ width: 50, height: 20 });
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });

  it("turns file names into titles", () => {
    expect(titleFromFile("03_order-history.png")).toBe("Order history");
    expect(titleFromFile("checkout.webp")).toBe("Checkout");
    expect(titleFromFile("404.png")).toBe("404");
  });
});

describe("screencheck init and add", () => {
  it("registers one version per subfolder with sensible defaults", async () => {
    const captures = join(root, "captures");
    await mkdir(join(captures, "build-1"), { recursive: true });
    await mkdir(join(captures, "build-2"), { recursive: true });
    await image(1440, 900)
      .png()
      .toFile(join(captures, "build-1", "01-home.png"));
    await image(1440, 2000)
      .png()
      .toFile(join(captures, "build-1", "02-checkout.png"));
    await image(1440, 900)
      .png()
      .toFile(join(captures, "build-2", "01-home.png"));
    await image(390, 844)
      .jpeg()
      .toFile(join(captures, "build-2", "03-receipt.jpg"));

    const run = await cli(
      "init",
      "shop",
      "--captures",
      captures,
      "--name",
      "Shop",
      "--projects",
      projects,
    );
    expect(run).toMatchObject({ code: 0 });
    expect(run.out).toContain(
      "Registered shop: 3 screens in build-1, build-2.",
    );

    const saved = JSON.parse(
      await readFile(join(projects, "shop.json"), "utf8"),
    );
    expect(saved.versions).toEqual([
      { id: "build-1", captureRoot: join(captures, "build-1") },
      { id: "build-2", captureRoot: join(captures, "build-2") },
    ]);
    expect(saved.screens[2]).toEqual({
      id: "03-receipt",
      ordinal: 3,
      title: "Receipt",
      group: "Screens",
      description: "Receipt",
      capturePath: "03-receipt.jpg",
      viewport: { width: 390, height: 844 },
    });

    const list = await createProjectCatalog({ projectsRoot: projects }).list();
    expect(list.problems).toEqual([
      // The latest build has no checkout capture; the registry says so.
      'shop: screen "02-checkout" capture 02-checkout.png not found in version build-2.',
    ]);
    expect(list.projects[0]).toMatchObject({
      id: "shop",
      versions: ["build-1", "build-2"],
    });
    expect(list.projects[0]!.screens.map((screen) => screen.title)).toEqual([
      "Home",
      "Checkout",
      "Receipt",
    ]);

    expect(
      (
        await cli(
          "init",
          "shop",
          "--captures",
          captures,
          "--projects",
          projects,
        )
      ).err,
    ).toContain("already exists");
  });

  it("treats a flat folder as v1 and adds later versions", async () => {
    const flat = join(root, "flat");
    await mkdir(flat);
    await image(800, 600).webp().toFile(join(flat, "landing.webp"));
    expect(
      (await cli("init", "try", "--captures", flat, "--projects", projects))
        .code,
    ).toBe(0);

    const next = join(root, "Next Build");
    await mkdir(next);
    await image(800, 600).webp().toFile(join(next, "landing.webp"));
    await image(800, 1200).webp().toFile(join(next, "settings.webp"));
    const added = await cli("add", "try", next, "--projects", projects);
    expect(added.out).toBe(
      "Added version next-build to try with 1 new screen.",
    );

    const saved = JSON.parse(
      await readFile(join(projects, "try.json"), "utf8"),
    );
    expect(saved.versions.map((version: { id: string }) => version.id)).toEqual(
      ["v1", "next-build"],
    );
    expect(saved.screens.map((screen: { id: string }) => screen.id)).toEqual([
      "landing",
      "settings",
    ]);
    expect(
      (await cli("add", "try", next, "--projects", projects)).err,
    ).toContain('already has a version "next-build"');
    expect(
      (await cli("add", "nope", next, "--projects", projects)).err,
    ).toContain("isn't registered");
  });

  it("rejects bad ids and empty folders", async () => {
    expect(
      (await cli("init", "My Shop", "--captures", root, "--projects", projects))
        .err,
    ).toContain('Invalid project id "My Shop"');
    expect(
      (await cli("init", "empty", "--captures", root, "--projects", projects))
        .err,
    ).toContain("No PNG, JPEG or WebP captures");
  });
});
