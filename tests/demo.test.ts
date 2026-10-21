// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DemoHandle } from "../src/cli/demo";
import { findDemoAssets } from "../src/cli/demo";
import { main } from "../src/cli/index";

let home: string;
const running: DemoHandle[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(process.cwd(), "tests/.feedback-data-demo-"));
});

afterEach(async () => {
  for (const demo of running.splice(0)) await demo.close();
  await rm(home, { recursive: true, force: true });
});

async function runDemo(args: string[] = []) {
  const out: string[] = [];
  let demo: DemoHandle | undefined;
  const code = await main(["demo", "--port", "0", ...args], {
    log: (line) => out.push(line),
    error: (line) => out.push(line),
    env: { SCREENCHECK_DEMO_HOME: home },
    clientRoot: process.cwd(),
    onDemo: (handle) => running.push((demo = handle)),
  });
  expect(code).toBe("running");
  return { demo: demo!, out: out.join("\n") };
}

const get = async (origin: string, route: string) =>
  (await fetch(`${origin}/api${route}`)).json();

describe("screencheck demo", () => {
  it("finds the bundled assets from source", () => {
    expect(existsSync(join(findDemoAssets(), "scenario.json"))).toBe(true);
  });

  it("serves the seeded Tidewater project and prints the agent setup", async () => {
    const { demo, out } = await runDemo();
    expect(demo.seeded).toBe(true);

    const scenario = JSON.parse(
      await readFile(join(findDemoAssets(), "scenario.json"), "utf8"),
    );
    const expected = Object.values(scenario.seed).flat().length;
    const { feedback } = await get(demo.origin, "/projects/tidewater/feedback");
    expect(feedback).toHaveLength(expected);
    expect(
      feedback.some((item: { status: string }) => item.status === "VERIFIED"),
    ).toBe(true);

    const { approvals } = await get(
      demo.origin,
      "/projects/tidewater/approvals",
    );
    expect(approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "build-42", screenId: "sign-in" }),
      ]),
    );

    const { projects } = await get(demo.origin, "/projects");
    const tidewater = projects.find(
      (p: { id: string }) => p.id === "tidewater",
    );
    expect(tidewater.versions).toEqual(["build-41", "build-42"]);
    const image = await fetch(
      `${demo.origin}/api/projects/tidewater/captures/build-42/route`,
    );
    expect(image.status).toBe(200);

    expect(out).toContain(`ScreenCheck demo: ${demo.origin}/`);
    expect(out).toContain(
      `npx screencheck reply --url ${demo.origin} --project tidewater --list`,
    );
    expect(out).toContain(
      JSON.stringify(["-y", "screencheck", "mcp", "--url", demo.origin]),
    );
    // Never recorded as the user's running server.
    expect(existsSync(join(home, "server.json"))).toBe(false);
  });

  it("resumes without reseeding, and --reset starts over", async () => {
    const first = await runDemo();
    const added = await fetch(
      `${first.demo.origin}/api/projects/tidewater/feedback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: first.demo.origin,
        },
        body: JSON.stringify({
          clientMutationId: randomUUID(),
          screenId: "home",
          version: "build-42",
          x: 0.5,
          y: 0.5,
          note: "Mine",
        }),
      },
    );
    expect(added.status).toBe(201);
    const count = (await get(first.demo.origin, "/projects/tidewater/feedback"))
      .feedback.length;
    await running.pop()!.close();

    const again = await runDemo();
    expect(again.demo.seeded).toBe(false);
    expect(again.out).toContain("Resumed where you left off");
    expect(
      (await get(again.demo.origin, "/projects/tidewater/feedback")).feedback,
    ).toHaveLength(count);
    await running.pop()!.close();

    const reset = await runDemo(["--reset"]);
    expect(reset.demo.seeded).toBe(true);
    expect(
      (await get(reset.demo.origin, "/projects/tidewater/feedback")).feedback,
    ).toHaveLength(count - 1);
  });
});
