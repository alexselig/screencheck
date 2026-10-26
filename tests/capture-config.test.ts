// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli/index";
import { parseCaptureArgs } from "../src/cli/capture";
import {
  loadCaptureConfig,
  parseCaptureConfig,
  runConfigCapture,
} from "../src/cli/capture-config";
import { createProjectCatalog } from "../src/server/projects";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), "tests/.feedback-data-config-"));
  env = { SCREENCHECK_HOME: join(dir, "home") };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MAP = { version: 1, capture: { width: 1, height: 1 }, elements: [] };

type Call = string;

// A Playwright stand-in: records what each page did and returns the page's
// viewport width as the "image", so tests can tell captures apart.
function fakePlaywright(calls: Call[] = []) {
  return async () =>
    ({
      chromium: {
        launch: async () => ({
          newPage: async ({
            viewport,
          }: {
            viewport: { width: number; height: number };
          }) => {
            calls.push(`page ${viewport.width}x${viewport.height}`);
            let url = "";
            return {
              goto: async (to: string) => {
                url = to;
                calls.push(`goto ${to}`);
              },
              click: async (selector: string) =>
                calls.push(`click ${selector}`),
              fill: async (selector: string, value: string) =>
                calls.push(`fill ${selector}=${value}`),
              waitForSelector: async (selector: string) =>
                calls.push(`waitFor ${selector}`),
              waitForTimeout: async (ms: number) => calls.push(`wait ${ms}`),
              keyboard: {
                press: async (key: string) => calls.push(`press ${key}`),
              },
              screenshot: async () =>
                new TextEncoder().encode(`IMG ${viewport.width} ${url}`),
              evaluate: async (fn: () => unknown) => {
                if (fn.name === "pinBottomChromeInPage") return { pinned: [] };
                if (fn.name === "collectElementsInPage") return MAP;
                return undefined;
              },
              close: async () => calls.push("close"),
            };
          },
          close: async () => calls.push("browser closed"),
        }),
      },
    }) as never;
}

const CONFIG = {
  project: { id: "shop", name: "Shop" },
  baseUrl: "http://localhost:3000",
  version: "build-43",
  viewports: [390, 1440],
  screens: [
    { id: "home", title: "Home", url: "/" },
    {
      id: "checkout",
      title: "Checkout",
      url: "/checkout",
      caption: "Step 2 of 3, saved card",
      section: "Buy",
      steps: [
        { click: "text=Saved card" },
        { fill: "#email", value: "a@b.test" },
        { waitFor: ".summary" },
      ],
    },
  ],
};

async function writeConfig(config: unknown, name = "screencheck.config.json") {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(config));
  return file;
}

async function registration() {
  return JSON.parse(
    await readFile(join(dir, "home", "projects", "shop.json"), "utf8"),
  );
}

describe("capture config parsing", () => {
  it("fills in defaults and resolves URLs against baseUrl", () => {
    const config = parseCaptureConfig(
      { ...CONFIG, viewports: undefined },
      "screencheck.config.json",
    );
    expect(config.viewports).toEqual([1440]);
    expect(config.height).toBe(1000);
    expect(config.screens.map((screen) => screen.url)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/checkout",
    ]);
  });

  it("names the file and the field in every problem", () => {
    const bad = (value: unknown) => () =>
      parseCaptureConfig(value, "screencheck.config.json");
    expect(bad({ ...CONFIG, project: { id: "Bad Id" } })).toThrow(
      /screencheck\.config\.json: project\.id/,
    );
    expect(bad({ ...CONFIG, viewports: [390, 0] })).toThrow(/viewports\[1\]/);
    expect(bad({ ...CONFIG, viewports: [] })).toThrow(/viewports/);
    expect(bad({ ...CONFIG, viewports: [390, 390] })).toThrow(
      /viewports: 390 is listed twice/,
    );
    expect(bad({ ...CONFIG, screens: [] })).toThrow(/screens/);
    expect(bad({ ...CONFIG, screens: [{ id: "home", url: "/" }] })).toThrow(
      /screens\[0\]\.title/,
    );
    expect(
      bad({
        ...CONFIG,
        screens: [CONFIG.screens[0], CONFIG.screens[0]],
      }),
    ).toThrow(/screen id "home" is used twice/);
    expect(
      bad({ ...CONFIG, screens: [{ id: "../x", title: "X", url: "/" }] }),
    ).toThrow(/screens\[0\]\.id/);
    expect(
      bad({
        ...CONFIG,
        screens: [{ id: "x", title: "X", url: "/", steps: [{ tap: "a" }] }],
      }),
    ).toThrow(/screens\[0\]\.steps\[0\]/);
    expect(
      bad({ ...CONFIG, baseUrl: undefined, screens: [CONFIG.screens[0]] }),
    ).toThrow(/screens\[0\]\.url: "\/" is relative; set baseUrl/);
    expect(
      bad({
        ...CONFIG,
        screens: [{ id: "x", title: "X", url: "/", setup: "nope" }],
      }),
    ).toThrow(/screens\[0\]\.setup/);
    expect(bad({ ...CONFIG, version: "a/b" })).toThrow(/version/);
    expect(bad([])).toThrow(/screencheck\.config\.json/);
  });

  it("loads .json and .mjs configs, and explains unsupported files", async () => {
    const json = await writeConfig(CONFIG);
    expect((await loadCaptureConfig(json)).project.id).toBe("shop");

    const mjs = join(dir, "screencheck.config.mjs");
    await writeFile(
      mjs,
      `export default { project: { id: "shop" }, baseUrl: "http://x.test",
        screens: [{ id: "a", title: "A", url: "/a", setup: async (page) => page.click("b") }] };`,
    );
    const loaded = await loadCaptureConfig(mjs);
    expect(typeof loaded.screens[0]!.setup).toBe("function");

    const yaml = join(dir, "screencheck.config.yaml");
    await writeFile(yaml, "x");
    await expect(loadCaptureConfig(yaml)).rejects.toThrow(/\.mjs or \.json/);
    await expect(loadCaptureConfig(join(dir, "missing.json"))).rejects.toThrow(
      /Can't read .*missing\.json/,
    );
    await writeFile(join(dir, "broken.json"), "{");
    await expect(loadCaptureConfig(join(dir, "broken.json"))).rejects.toThrow(
      /broken\.json is not valid JSON/,
    );
  });

  it("accepts the bundled example config", async () => {
    const config = await loadCaptureConfig(
      join(process.cwd(), "examples", "screencheck.config.mjs"),
    );
    expect(config.viewports).toEqual([390, 768, 1440]);
    expect(config.screens.map((screen) => screen.id)).toContain("checkout");
  });

  it("parses --config, --version and --screen; plain capture keeps its meaning", () => {
    expect(
      parseCaptureArgs([
        "--config",
        "screencheck.config.mjs",
        "--version",
        "build-44",
        "--screen",
        "home",
      ]),
    ).toEqual({
      config: "screencheck.config.mjs",
      version: "build-44",
      screen: "home",
    });
    expect(parseCaptureArgs(["http://x.test", "--out", "a.png"])).toEqual({
      url: "http://x.test",
      out: "a.png",
      width: 1440,
      height: 1000,
    });
    expect(() =>
      parseCaptureArgs(["http://x.test", "--config", "c.json"]),
    ).toThrow(/URL/);
    expect(() =>
      parseCaptureArgs(["--config", "c.json", "-o", "a.png"]),
    ).toThrow(/--out/);
    expect(() =>
      parseCaptureArgs(["http://x.test", "-o", "a.png", "--screen", "a"]),
    ).toThrow(/--screen.*--config/);
  });
});

describe("screencheck capture --config", () => {
  it("captures every screen at every viewport and registers one version per size", async () => {
    const file = await writeConfig(CONFIG);
    const calls: Call[] = [];
    const lines: string[] = [];
    await runConfigCapture(
      { config: file },
      {
        env,
        log: (line) => lines.push(line),
        playwright: fakePlaywright(calls),
      },
    );

    const captures = join(dir, "captures", "build-43");
    for (const width of [390, 1440]) {
      for (const [id, path] of [
        ["home", "/"],
        ["checkout", "/checkout"],
      ]) {
        expect(
          await readFile(join(captures, String(width), `${id}.png`), "utf8"),
        ).toBe(`IMG ${width} http://localhost:3000${path}`);
        expect(
          JSON.parse(
            await readFile(
              join(captures, String(width), `${id}.elements.json`),
              "utf8",
            ),
          ),
        ).toEqual(MAP);
      }
    }
    expect(calls).toContain("click text=Saved card");
    expect(calls).toContain("fill #email=a@b.test");
    expect(calls).toContain("waitFor .summary");
    expect(calls.at(-1)).toBe("browser closed");

    const saved = await registration();
    expect(saved).toMatchObject({ id: "shop", name: "Shop" });
    expect(saved.versions).toEqual([
      {
        id: "build-43-390",
        revision: "build-43",
        label: "390",
        viewport: 390,
        captureRoot: join(captures, "390"),
      },
      {
        id: "build-43-1440",
        revision: "build-43",
        label: "1440",
        viewport: 1440,
        captureRoot: join(captures, "1440"),
      },
    ]);
    expect(saved.screens).toEqual([
      {
        id: "home",
        ordinal: 1,
        title: "Home",
        group: "Screens",
        description: "Home",
        capturePath: "home.png",
        liveUrl: "http://localhost:3000/",
        viewport: { width: 1440, height: 1000 },
      },
      {
        id: "checkout",
        ordinal: 2,
        title: "Checkout",
        group: "Buy",
        description: "Step 2 of 3, saved card",
        capturePath: "checkout.png",
        liveUrl: "http://localhost:3000/checkout",
        viewport: { width: 1440, height: 1000 },
      },
    ]);
    expect(lines.join("\n")).toContain("build-43");

    // The server reads it back and the browser sees the revision grouping.
    const catalog = createProjectCatalog({
      projectsRoot: join(dir, "home", "projects"),
    });
    const { projects, problems } = await catalog.list();
    expect(problems).toEqual([]);
    expect(projects[0]!.versionDetails).toEqual([
      { id: "build-43-390", revision: "build-43", label: "390", viewport: 390 },
      {
        id: "build-43-1440",
        revision: "build-43",
        label: "1440",
        viewport: 1440,
      },
    ]);
    expect(projects[0]!.screens.every((screen) => screen.hasCapture)).toBe(
      true,
    );
  });

  it("adds a new revision beside earlier ones and keeps hand edits", async () => {
    const file = await writeConfig(CONFIG);
    await runConfigCapture(
      { config: file },
      { env, log: () => {}, playwright: fakePlaywright() },
    );
    const edited = await registration();
    edited.screens[0].prepareState = "signed-in";
    edited.screens.push({
      id: "legacy",
      ordinal: 9,
      title: "Legacy",
      group: "Old",
      viewport: { width: 800, height: 600 },
    });
    await writeFile(
      join(dir, "home", "projects", "shop.json"),
      JSON.stringify(edited),
    );

    await runConfigCapture(
      { config: file, version: "build-44" },
      {
        env,
        log: () => {},
        playwright: fakePlaywright(),
      },
    );
    const saved = await registration();
    expect(saved.versions.map((version: { id: string }) => version.id)).toEqual(
      ["build-43-390", "build-43-1440", "build-44-390", "build-44-1440"],
    );
    expect(saved.screens.map((screen: { id: string }) => screen.id)).toEqual([
      "home",
      "checkout",
      "legacy",
    ]);
    expect(saved.screens[0].prepareState).toBe("signed-in");
  });

  it("--screen re-captures one screen and leaves the rest alone", async () => {
    const file = await writeConfig(CONFIG);
    await runConfigCapture(
      { config: file },
      { env, log: () => {}, playwright: fakePlaywright() },
    );
    const before = await registration();
    const home = join(dir, "captures", "build-43", "390", "home.png");
    await writeFile(home, "UNTOUCHED");

    const calls: Call[] = [];
    await runConfigCapture(
      { config: file, screen: "checkout" },
      { env, log: () => {}, playwright: fakePlaywright(calls) },
    );
    expect(calls.filter((call) => call.startsWith("goto"))).toEqual([
      "goto http://localhost:3000/checkout",
      "goto http://localhost:3000/checkout",
    ]);
    expect(await readFile(home, "utf8")).toBe("UNTOUCHED");
    expect(await registration()).toEqual(before);

    await expect(
      runConfigCapture(
        { config: file, screen: "nope" },
        { env, log: () => {}, playwright: fakePlaywright() },
      ),
    ).rejects.toThrow(/No screen "nope".*home, checkout/);
  });

  it("runs an .mjs setup function with the page", async () => {
    const file = join(dir, "screencheck.config.mjs");
    await writeFile(
      file,
      `export default {
        project: { id: "shop" },
        version: "v1",
        outDir: "shots",
        screens: [{ id: "a", title: "A", url: "http://x.test/a",
          setup: async (page, { viewport }) => page.click("#w" + viewport) }],
      };`,
    );
    const calls: Call[] = [];
    await runConfigCapture(
      { config: file },
      { env, log: () => {}, playwright: fakePlaywright(calls) },
    );
    expect(calls).toContain("click #w1440");
    expect(
      await readFile(join(dir, "shots", "v1", "1440", "a.png"), "utf8"),
    ).toContain("IMG 1440");
    expect((await registration()).name).toBe("shop");
  });

  it("needs a version from the config or --version", async () => {
    const file = await writeConfig({ ...CONFIG, version: undefined });
    await expect(
      runConfigCapture(
        { config: file },
        { env, log: () => {}, playwright: fakePlaywright() },
      ),
    ).rejects.toThrow(/--version/);
  });

  it("names the screen and size when a capture fails, and registers nothing", async () => {
    const file = await writeConfig(CONFIG);
    const failing = async () =>
      ({
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              goto: async () => {
                throw new Error("net::ERR_CONNECTION_REFUSED");
              },
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      }) as never;
    await expect(
      runConfigCapture(
        { config: file },
        { env, log: () => {}, playwright: failing },
      ),
    ).rejects.toThrow(/home at 390px: net::ERR_CONNECTION_REFUSED/);
    await expect(registration()).rejects.toThrow();
  });

  it("is reachable from the CLI and reports problems on stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    await mkdir(join(dir, "empty"));
    const file = await writeConfig({ project: { id: "shop" } }, "bad.json");
    expect(
      await main(["capture", "--config", file], {
        env,
        log: (line) => out.push(line),
        error: (line) => err.push(line),
      }),
    ).toBe(1);
    expect(err.join("\n")).toMatch(/bad\.json: screens/);
  });
});
