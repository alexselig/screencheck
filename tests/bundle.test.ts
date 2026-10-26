// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUNDLE_USAGE,
  IMPORT_USAGE,
  runBundle,
  runImport,
} from "../src/cli/bundle";
import { HELP, main } from "../src/cli/index";
import { readZip, writeZip } from "../src/cli/zip";
import { createOfflineApi } from "../src/client/offline-api";
import { startServer } from "../src/server/index";
import { createFeedbackStorage } from "../src/server/storage";
import type { OfflineBundle } from "../src/shared/bundle";
import type { FeedbackRecord } from "../src/shared/feedback";

let root: string;
let viewer: string;
let log: string[];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const UUID2 = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e";

const screen = (id: string, ordinal: number) => ({
  id,
  ordinal,
  title: id,
  group: "Main",
  viewport: { width: 1440, height: 1000 },
  capturePath: `${id}.png`,
});

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-bundle-"));
  log = [];
  viewer = join(root, "viewer");
  await mkdir(join(viewer, "fonts"), { recursive: true });
  await writeFile(join(viewer, "viewer.js"), "/* viewer */");
  await writeFile(join(viewer, "viewer.css"), "/* css */");
  await writeFile(join(viewer, "fonts", "a.woff2"), "font");
  for (const version of ["v1", "v2"]) {
    const dir = join(root, "captures", version);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "home.png"), PNG);
  }
  await writeFile(join(root, "captures", "v2", "cart.png"), PNG);
  await writeFile(
    join(root, "captures", "v2", "home.elements.json"),
    JSON.stringify({
      version: 1,
      capture: { width: 1440, height: 1000 },
      elements: [],
    }),
  );
  await mkdir(join(root, "projects"));
  await writeFile(
    join(root, "projects", "shop.json"),
    JSON.stringify({
      id: "shop",
      name: "Shop",
      versions: [
        { id: "v1", captureRoot: join(root, "captures", "v1") },
        { id: "v2", captureRoot: join(root, "captures", "v2") },
      ],
      screens: [screen("home", 1), screen("cart", 2)],
    }),
  );
  const storage = createFeedbackStorage({ dataRoot: join(root, "feedback") });
  for (const version of ["v1", "v2"]) {
    await storage.createFeedback("shop", {
      clientMutationId: crypto.randomUUID(),
      screenId: "home",
      version,
      x: 0.5,
      y: 0.5,
      note: `Comment on ${version}`,
    });
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = () => ({ SCREENCHECK_HOME: root });
const io = () => ({
  log: (line: string) => log.push(line),
  env: env(),
  cwd: root,
  viewerRoot: viewer,
  readRuntime: () => null,
});

function bundleFrom(entries: Map<string, Buffer>, folder: string) {
  const script = entries.get(`${folder}/bundle.js`)!.toString("utf8");
  const prefix = "window.__SCREENCHECK_BUNDLE__ = ";
  expect(script.startsWith(prefix)).toBe(true);
  return JSON.parse(
    script.slice(prefix.length).replace(/;\s*$/, ""),
  ) as OfflineBundle;
}

async function feedbackOnDisk() {
  return createFeedbackStorage({
    dataRoot: join(root, "feedback"),
  }).listFeedback("shop");
}

describe("screencheck bundle (#13)", () => {
  it("writes captures, feedback, registration and a static viewer", async () => {
    const out = join(root, "out.zip");
    expect(
      await runBundle(
        ["--project", "shop", "--version", "v2", "--out", out],
        io(),
      ),
    ).toBe(0);
    const entries = readZip(await readFile(out));
    const folder = "shop-v2";
    expect([...entries.keys()].sort()).toEqual(
      [
        "README.txt",
        "bundle.js",
        "captures/v2/cart.png",
        "captures/v2/home.png",
        "feedback.json",
        "index.html",
        "registration.json",
        "viewer/fonts/a.woff2",
        "viewer/viewer.css",
        "viewer/viewer.js",
      ].map((name) => `${folder}/${name}`),
    );
    const html = entries.get(`${folder}/index.html`)!.toString("utf8");
    // Classic scripts only: module scripts don't run from file://.
    expect(html).toContain('<script src="bundle.js"></script>');
    expect(html).toContain('<script src="viewer/viewer.js"></script>');
    expect(html).toContain('href="viewer/viewer.css"');
    expect(html).not.toContain('type="module"');
    expect(html.indexOf("bundle.js")).toBeLessThan(html.indexOf("viewer.js"));
    expect(entries.get(`${folder}/captures/v2/home.png`)!.equals(PNG)).toBe(
      true,
    );

    const bundle = bundleFrom(entries, folder);
    expect(bundle.format).toBe(1);
    expect(bundle.project.versions).toEqual(["v2"]);
    expect(bundle.project.screens.map((s) => [s.id, s.hasCapture])).toEqual([
      ["home", true],
      ["cart", true],
    ]);
    expect(bundle.feedback.map((r) => r.note)).toEqual(["Comment on v2"]);
    expect(bundle.captures).toEqual({
      "v2/home": "captures/v2/home.png",
      "v2/cart": "captures/v2/cart.png",
    });
    expect(Object.keys(bundle.elements)).toEqual(["v2/home"]);

    const feedback = JSON.parse(
      entries.get(`${folder}/feedback.json`)!.toString("utf8"),
    );
    expect(feedback.feedback).toHaveLength(1);
    const registration = entries
      .get(`${folder}/registration.json`)!
      .toString("utf8");
    // No local paths leave the machine.
    expect(registration).not.toContain(root);
    expect(JSON.parse(registration)).toMatchObject({
      id: "shop",
      versions: ["v2"],
    });
    expect(log.join("\n")).toContain(out);
  });

  it("bundles several versions, defaulting to the latest", async () => {
    expect(await runBundle(["--project", "shop"], io())).toBe(0);
    const latest = readZip(
      await readFile(join(root, "shop-v2.screencheck.zip")),
    );
    expect(bundleFrom(latest, "shop-v2").project.versions).toEqual(["v2"]);

    expect(
      await runBundle(
        ["--project", "shop", "--version", "v2", "--version", "v1"],
        io(),
      ),
    ).toBe(0);
    const both = readZip(
      await readFile(join(root, "shop-v1_v2.screencheck.zip")),
    );
    const bundle = bundleFrom(both, "shop-v1_v2");
    // Registration order, not argument order.
    expect(bundle.project.versions).toEqual(["v1", "v2"]);
    expect(bundle.feedback).toHaveLength(2);
    expect(both.has("shop-v1_v2/captures/v1/home.png")).toBe(true);
  });

  it("explains a wrong project, version or missing viewer", async () => {
    await expect(runBundle(["--project", "nope"], io())).rejects.toThrow(
      /Unknown project "nope".*shop/,
    );
    await expect(
      runBundle(["--project", "shop", "--version", "v9"], io()),
    ).rejects.toThrow(/no version "v9".*v1, v2/);
    await expect(runBundle([], io())).rejects.toThrow(/--project/);
    await expect(
      runBundle(["--project", "shop"], {
        ...io(),
        viewerRoot: join(root, "x"),
      }),
    ).rejects.toThrow(/npm run build/);
  });

  it("is wired into the CLI", async () => {
    expect(HELP).toContain("bundle");
    expect(HELP).toContain("import");
    const out: string[] = [];
    expect(await main(["bundle", "--help"], { log: (l) => out.push(l) })).toBe(
      0,
    );
    expect(await main(["import", "--help"], { log: (l) => out.push(l) })).toBe(
      0,
    );
    expect(out).toEqual([BUNDLE_USAGE, IMPORT_USAGE]);
  });
});

async function reviewerComments(ids: string[]) {
  await runBundle(["--project", "shop"], io());
  const entries = readZip(
    await readFile(join(root, "shop-v2.screencheck.zip")),
  );
  const bundle = bundleFrom(entries, "shop-v2");
  const store = new Map<string, string>();
  const api = createOfflineApi(bundle, {
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as Storage,
  });
  for (const id of ids) {
    const response = await api.fetch("/api/projects/shop/feedback", {
      method: "POST",
      body: JSON.stringify({
        clientMutationId: id,
        screenId: "home",
        version: "v2",
        x: 0.2,
        y: 0.3,
        note: `Offline ${id.slice(-1)}`,
      }),
    });
    expect(response.status).toBe(201);
  }
  return api.exportReview();
}

describe("screencheck import (#13)", () => {
  it("merges a reviewer's export and skips it on re-import", async () => {
    const review = await reviewerComments([UUID, UUID2]);
    const file = join(root, "review.json");
    await writeFile(file, JSON.stringify(review));

    expect(await runImport([file], io())).toBe(0);
    expect(log.at(-1)).toMatch(/Imported 2 comments into shop/);
    const notes = (await feedbackOnDisk()).map((r) => r.note);
    expect(notes).toEqual([
      "Comment on v1",
      "Comment on v2",
      "Offline d",
      "Offline e",
    ]);

    expect(await runImport([file], io())).toBe(0);
    expect(log.at(-1)).toMatch(
      /Imported 0 comments into shop \(2 already there\)/,
    );
    expect(await feedbackOnDisk()).toHaveLength(4);
  });

  it("reads review files out of a zip, and refuses unregistered projects", async () => {
    const review = await reviewerComments([UUID]);
    const zip = join(root, "reply.zip");
    await writeFile(
      zip,
      writeZip([
        { name: "from-pm/shop-review.json", data: JSON.stringify(review) },
        { name: "from-pm/notes.txt", data: "thanks" },
      ]),
    );
    expect(await runImport([zip], io())).toBe(0);
    expect((await feedbackOnDisk()).map((r) => r.id)).toContain(UUID);

    // A bundle's own feedback.json is already on disk, so it dedupes away.
    expect(await runImport([join(root, "shop-v2.screencheck.zip")], io())).toBe(
      0,
    );
    expect(log.at(-1)).toMatch(
      /Imported 0 comments into shop \(1 already there\)/,
    );

    const other = join(root, "other.json");
    await writeFile(other, JSON.stringify({ ...review, projectId: "ghost" }));
    await expect(runImport([other], io())).rejects.toThrow(/Unknown project/);
    await writeFile(other, "[]");
    await expect(runImport([other], io())).rejects.toThrow(/--project/);
    await writeFile(other, "{nope");
    await expect(runImport([other], io())).rejects.toThrow(/not a review/i);
  });

  it("goes through the running server's import endpoint when there is one", async () => {
    const clientRoot = join(root, "client");
    await mkdir(clientRoot);
    await writeFile(join(clientRoot, "index.html"), "<!doctype html>");
    const server = await startServer({
      port: 0,
      dataRoot: join(root, "feedback"),
      projectsRoot: join(root, "projects"),
      clientRoot,
    });
    try {
      const review = await reviewerComments([UUID]);
      const file = join(root, "review.json");
      await writeFile(file, JSON.stringify(review));
      expect(
        await runImport([file], {
          ...io(),
          readRuntime: () => ({
            origin: server.origin,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            dataRoot: join(root, "feedback"),
            projectsRoot: join(root, "projects"),
          }),
        }),
      ).toBe(0);
      expect(log.join("\n")).toContain(server.origin);
      const response = await fetch(
        `${server.origin}/api/projects/shop/feedback`,
      );
      const { feedback } = (await response.json()) as {
        feedback: FeedbackRecord[];
      };
      expect(feedback.map((r) => r.id)).toContain(UUID);
    } finally {
      await server.close();
    }
  });
});
