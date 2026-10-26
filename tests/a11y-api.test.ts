// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";
import { ACTOR_HEADER, REVIEWER_ACTOR } from "../src/shared/feedback";
import { a11yReportUrl } from "../src/shared/projects";

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

const REPORT = {
  version: 1,
  capture: { width: 1440, height: 2400 },
  violations: [
    {
      id: "color-contrast",
      impact: "serious",
      help: "Elements must meet minimum color contrast ratio thresholds",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.14/color-contrast",
      nodes: [{ target: "#faint", box: { x: 0.1, y: 0.5, w: 0.2, h: 0.02 } }],
    },
  ],
};

const screen = (id: string, ordinal: number) => ({
  id,
  ordinal,
  title: id,
  description: `The ${id} screen.`,
  group: "Main",
  capturePath: `${id}.png`,
  viewport: { width: 1440, height: 1000 },
});

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), "tests/.feedback-data-a11y-api-"));
  const captures = join(root, "captures", "v1");
  await mkdir(join(root, "projects"));
  await mkdir(captures, { recursive: true });
  for (const id of ["home", "bare", "broken", "linked"]) {
    await writeFile(join(captures, `${id}.png`), "png");
  }
  await writeFile(join(captures, "home.a11y.json"), JSON.stringify(REPORT));
  await writeFile(
    join(captures, "broken.a11y.json"),
    JSON.stringify({ ...REPORT, violations: [{ id: "x" }] }),
  );
  await writeFile(join(root, "secret.a11y.json"), JSON.stringify(REPORT));
  await symlink(
    join(root, "secret.a11y.json"),
    join(captures, "linked.a11y.json"),
  );
  await writeFile(
    join(root, "projects", "demo.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      versions: [{ id: "v1", captureRoot: captures }],
      screens: ["home", "bare", "broken", "linked"].map((id, index) =>
        screen(id, index + 1),
      ),
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

const get = (screenId: string) =>
  fetch(`${server.origin}${a11yReportUrl("demo", "v1", screenId)}`);

describe("accessibility report route", () => {
  it("serves the report stored beside a screen's capture", async () => {
    const response = await get("home");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPORT);
  });

  it("answers 404 without a report and never reads outside the captureRoot", async () => {
    expect((await get("bare")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
    expect((await get("linked")).status).toBe(404);
  });

  it("reports a malformed report as a server error, and is read-only", async () => {
    const broken = await get("broken");
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toMatch(/malformed/i);
    const write = await fetch(
      `${server.origin}${a11yReportUrl("demo", "v1", "home")}`,
      { method: "DELETE", headers: { origin: server.origin } },
    );
    expect(write.status).toBe(405);
  });
});

describe("suggestion dismissals", () => {
  const url = () => `${server.origin}/api/projects/demo/suggestions`;
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: server.origin,
        [ACTOR_HEADER]: REVIEWER_ACTOR,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const target = {
    version: "v1",
    screenId: "home",
    suggestionId: "color-contrast|#faint",
  };

  it("starts empty when there is no suggestions.json (older data)", async () => {
    const response = await fetch(url());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dismissed: [] });
  });

  it("dismisses, promotes and restores a suggestion in suggestions.json", async () => {
    const dismissed = await put(target);
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).dismissed).toEqual([
      expect.objectContaining({ ...target, dismissedAt: expect.any(String) }),
    ]);
    const promoted = await (
      await put({ ...target, feedbackId: "fb-1" })
    ).json();
    expect(promoted.dismissed).toEqual([
      expect.objectContaining({ ...target, feedbackId: "fb-1" }),
    ]);
    const file = JSON.parse(
      await readFile(
        join(root, "feedback", "demo", "suggestions.json"),
        "utf8",
      ),
    );
    expect(file).toMatchObject({ version: 1, dismissed: [target] });
    // Dismissals don't touch feedback.
    expect(
      await (await fetch(`${server.origin}/api/projects/demo/feedback`)).json(),
    ).toMatchObject({ feedback: [] });

    const restored = await (await put({ ...target, dismissed: false })).json();
    expect(restored.dismissed).toEqual([]);
    expect((await (await fetch(url())).json()).dismissed).toEqual([]);
  });

  it("is a reviewer's call, from the app's own origin, for a registered screen", async () => {
    expect((await put(target, { [ACTOR_HEADER]: "agent" })).status).toBe(403);
    expect((await put(target, { origin: "http://evil.test" })).status).toBe(
      403,
    );
    expect((await put({ ...target, screenId: "nope" })).status).toBe(404);
    expect((await put({ version: "v1" })).status).toBe(400);
  });
});
