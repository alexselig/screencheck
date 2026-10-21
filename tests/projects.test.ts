// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";
import { createProjectCatalog } from "../src/server/projects";

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

async function register(name: string, body: unknown) {
  await writeFile(join(root, "projects", name), JSON.stringify(body));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "srw-projects-"));
  await mkdir(join(root, "projects"));
  await mkdir(join(root, "captures", "v1"), { recursive: true });
  await writeFile(join(root, "captures", "v1", "home.webp"), "RIFFfakewebp");
  await writeFile(join(root, "secret.webp"), "outside");
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

const screenBase = {
  ordinal: 1,
  title: "Home",
  description: "Registered home screen state.",
  group: "Main",
  viewport: { width: 1440, height: 2400 },
};

describe("project catalog", () => {
  it("lists nothing and names the projects folder when nothing is registered", async () => {
    const body = await (await fetch(`${server.origin}/api/projects`)).json();
    expect(body).toEqual({
      projects: [],
      problems: [],
      projectsRoot: join(root, "projects"),
    });
  });

  it("keeps the example project listed while it holds feedback", async () => {
    const catalog = createProjectCatalog({
      projectsRoot: join(root, "projects"),
      hasFeedback: async (id) => id === "example",
    });
    const list = await catalog.list();
    expect(list.projects.map((item) => item.id)).toEqual(["example"]);
    expect(list.projectsRoot).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/Microsoft|skills and workflow/);
  });

  it("passes a version's explicit revision and label to the browser", async () => {
    await register("demo.json", {
      id: "demo",
      name: "Demo",
      versions: [
        {
          id: "r1-wide",
          revision: "r1",
          label: "1440",
          captureRoot: join(root, "captures", "v1"),
        },
        { id: "r1-narrow", revision: "r1", label: "390", captureRoot: root },
      ],
      screens: [{ ...screenBase, id: "home" }],
    });
    const body = await (await fetch(`${server.origin}/api/projects`)).json();
    const demo = body.projects.find(
      (item: { id: string }) => item.id === "demo",
    );
    expect(demo.versions).toEqual(["r1-wide", "r1-narrow"]);
    expect(demo.versionDetails).toEqual([
      { id: "r1-wide", revision: "r1", label: "1440" },
      { id: "r1-narrow", revision: "r1", label: "390" },
    ]);
  });

  it("lists registered screens without exposing local paths and serves captures", async () => {
    await register("demo.json", {
      id: "demo",
      name: "Demo",
      proxy: { injectedHeaders: { "x-secret": { environment: "SECRET" } } },
      versions: [{ id: "v1", captureRoot: join(root, "captures", "v1") }],
      screens: [
        {
          ...screenBase,
          id: "home",
          capturePath: join(root, "captures", "v1", "home.webp"),
        },
        {
          ...screenBase,
          id: "away",
          ordinal: 2,
          capturePath: join(root, "secret.webp"),
        },
      ],
    });
    const response = await fetch(`${server.origin}/api/projects`);
    const text = await response.text();
    expect(text).not.toContain(root);
    expect(text).not.toContain("x-secret");
    const { projects } = JSON.parse(text);
    expect(projects).toHaveLength(1);
    expect(
      projects[0].screens.map(
        (item: { hasCapture: boolean }) => item.hasCapture,
      ),
    ).toEqual([true, false]);

    const capture = await fetch(
      `${server.origin}/api/projects/demo/captures/v1/home`,
    );
    expect(capture.status).toBe(200);
    expect(capture.headers.get("content-type")).toBe("image/webp");
    expect(await capture.text()).toBe("RIFFfakewebp");

    // A capture path outside the version's folder is never served.
    const escaped = await fetch(
      `${server.origin}/api/projects/demo/captures/v1/away`,
    );
    expect(escaped.status).toBe(404);
  });

  it("reports a broken registration instead of failing the list", async () => {
    await writeFile(join(root, "projects", "broken.json"), "{not json");
    const body = await (await fetch(`${server.origin}/api/projects`)).json();
    expect(body.problems[0]).toMatch(/^broken\.json:/);
    expect(body.projects).toEqual([]);
  });
});
