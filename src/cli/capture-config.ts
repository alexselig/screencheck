// `screencheck capture --config screencheck.config.mjs`: capture every screen
// of a project at every viewport and register the result, so nobody writes
// capture scripts or registration JSON by hand.
//
// One run = one revision (`version` in the config, or --version). Each
// viewport becomes its own version, `<revision>-<width>`, carrying an
// explicit `revision`, `label` and `viewport`, captured into
// `<outDir>/<revision>/<width>/<screen id>.png` with its element map beside.
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { createThumbnailCache, defaultThumbsRoot } from "../server/thumbnails";
import { DEFAULT_GROUP } from "../shared/manifest";
import { formatIssuePath } from "../shared/zod-format";
import {
  type ConfigCaptureJob,
  imageType,
  loadPlaywright,
  shoot,
} from "./capture";
import {
  PROJECT_ID,
  projectsRoot,
  type Registration,
  type Screen,
  writeRegistration,
} from "./init";

type Page = import("playwright").Page;

export type SetupContext = { viewport: number; screen: string };
export type Setup = (page: Page, context: SetupContext) => Promise<unknown>;

// A file or folder name, never a path: "build-43", "checkout".
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const segment = (what: string) =>
  z
    .string()
    .regex(
      SEGMENT,
      `${what} must be letters, digits, ".", "_" or "-" (up to 64), starting with a letter or digit`,
    );

const stepSchema = z.union(
  [
    z.strictObject({ goto: z.string().min(1) }),
    z.strictObject({ click: z.string().min(1) }),
    z.strictObject({ fill: z.string().min(1), value: z.string() }),
    z.strictObject({ press: z.string().min(1) }),
    z.strictObject({ waitFor: z.string().min(1) }),
    z.strictObject({ wait: z.number().int().nonnegative() }),
  ],
  {
    error:
      "a step is one of { goto: url }, { click: selector }, { fill: selector, value }, { press: key }, { waitFor: selector } or { wait: ms }",
  },
);

export type Step = z.infer<typeof stepSchema>;

const screenSchema = z.object({
  id: segment("A screen id"),
  title: z.string().trim().min(1),
  url: z.string().min(1),
  // Shown above the capture: what state it shows.
  caption: z.string().trim().min(1).max(500).optional(),
  // The group it sits under in the screen index.
  section: z.string().trim().min(1).optional(),
  steps: z.array(stepSchema).optional(),
  setup: z
    .custom<Setup>((value) => typeof value === "function", {
      message:
        "must be a function (page, { viewport, screen }) => Promise; in a .json config use steps",
    })
    .optional(),
  waitFor: z.string().min(1).optional(),
});

const configSchema = z.object({
  project: z.object({
    id: z
      .string()
      .regex(
        PROJECT_ID,
        "use lowercase letters, digits and dashes (up to 64), starting with a letter or digit",
      ),
    name: z.string().trim().min(1).optional(),
  }),
  baseUrl: z.url().optional(),
  version: segment("version").optional(),
  viewports: z.array(z.number().int().positive()).min(1).default([1440]),
  // Browser window height; captures are full-page whatever it is.
  height: z.number().int().positive().default(1000),
  // Where captures go, relative to the config file.
  outDir: z.string().min(1).default("captures"),
  screens: z.array(screenSchema).min(1),
});

export type CaptureConfig = z.infer<typeof configSchema>;
export type ConfigScreen = CaptureConfig["screens"][number];

function fail(source: string, problems: string[]): never {
  throw new Error(
    problems.map((problem) => `${source}: ${problem}`).join("\n"),
  );
}

export function parseCaptureConfig(
  raw: unknown,
  source: string,
): CaptureConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      source,
      parsed.error.issues.map(
        (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
      ),
    );
  }
  const config = parsed.data;
  const problems: string[] = [];
  const widths = new Set<number>();
  for (const width of config.viewports) {
    if (widths.has(width)) problems.push(`viewports: ${width} is listed twice`);
    widths.add(width);
  }
  const ids = new Set<string>();
  config.screens = config.screens.map((screen, index) => {
    if (ids.has(screen.id)) {
      problems.push(`screens: screen id "${screen.id}" is used twice`);
    }
    ids.add(screen.id);
    let url = screen.url;
    try {
      url = new URL(screen.url, config.baseUrl).href;
    } catch {
      problems.push(
        config.baseUrl
          ? `screens[${index}].url: "${screen.url}" is not a valid URL`
          : `screens[${index}].url: "${screen.url}" is relative; set baseUrl or use a full URL`,
      );
    }
    return { ...screen, url };
  });
  if (problems.length) fail(source, problems);
  return config;
}

const exists = async (file: string) => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

export async function loadCaptureConfig(
  file: string,
  shown = file,
): Promise<CaptureConfig> {
  const extension = path.extname(file).toLowerCase();
  let raw: unknown;
  if (extension === ".json") {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`Can't read ${shown}: ${(error as Error).message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${shown} is not valid JSON: ${(error as Error).message}`,
      );
    }
  } else if ([".mjs", ".js", ".ts", ".mts"].includes(extension)) {
    if (!(await exists(file)))
      throw new Error(`Can't read ${shown}: not found`);
    let loaded: { default?: unknown };
    try {
      loaded = await import(pathToFileURL(path.resolve(file)).href);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
        throw new Error(
          `This Node can't load ${shown} directly. Rename it to screencheck.config.mjs (or use .json).`,
        );
      }
      throw new Error(`Can't load ${shown}: ${(error as Error).message}`);
    }
    raw = loaded.default ?? loaded;
  } else {
    throw new Error(
      `Use a .mjs or .json config (got ${shown}). A .mjs file exports the config as its default export.`,
    );
  }
  return parseCaptureConfig(raw, shown);
}

async function runSteps(page: Page, steps: Step[]) {
  for (const step of steps) {
    if ("goto" in step) {
      await page.goto(new URL(step.goto, page.url() || undefined).href, {
        waitUntil: "networkidle",
      });
    } else if ("click" in step) await page.click(step.click);
    else if ("fill" in step) await page.fill(step.fill, step.value);
    else if ("press" in step) await page.keyboard.press(step.press);
    else if ("waitFor" in step) await page.waitForSelector(step.waitFor);
    else await page.waitForTimeout(step.wait);
  }
}

const versionId = (revision: string, width: number) => `${revision}-${width}`;

// Adds or replaces this run's versions and screens; everything else in an
// existing registration (hand-written descriptions, other screens and
// versions, extra fields) is kept.
export function mergeRegistration(
  existing: Registration | null,
  config: CaptureConfig,
  run: {
    revision: string;
    screens: ConfigScreen[];
    captureRoot: (width: number) => string;
  },
): Registration {
  const versions = [...(existing?.versions ?? [])];
  for (const width of config.viewports) {
    const entry = {
      id: versionId(run.revision, width),
      revision: run.revision,
      label: String(width),
      viewport: width,
      captureRoot: run.captureRoot(width),
    };
    const at = versions.findIndex((version) => version.id === entry.id);
    if (at === -1) versions.push(entry);
    else versions[at] = { ...versions[at], ...entry };
  }
  const screens: Screen[] = [...(existing?.screens ?? [])];
  let ordinal = Math.max(0, ...screens.map((screen) => screen.ordinal));
  const viewport = {
    width: Math.max(...config.viewports),
    height: config.height,
  };
  for (const screen of run.screens) {
    const at = screens.findIndex((item) => item.id === screen.id);
    const before = at === -1 ? undefined : screens[at];
    const entry: Screen = {
      ...before,
      id: screen.id,
      ordinal: before?.ordinal ?? (ordinal += 1),
      title: screen.title,
      group: screen.section ?? before?.group ?? DEFAULT_GROUP,
      description: screen.caption ?? before?.description ?? screen.title,
      capturePath: `${screen.id}.png`,
      liveUrl: screen.url,
      viewport,
    };
    if (at === -1) screens.push(entry);
    else screens[at] = entry;
  }
  return {
    ...existing,
    id: config.project.id,
    name: config.project.name ?? existing?.name ?? config.project.id,
    versions,
    screens,
  };
}

async function readRegistration(file: string) {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as Registration;
  } catch (error) {
    throw new Error(
      `Can't update ${file}: it is not valid JSON (${(error as Error).message}). Fix or remove it and run again.`,
    );
  }
}

export type ConfigCaptureIo = {
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  playwright?: () => Promise<Pick<typeof import("playwright"), "chromium">>;
};

export async function runConfigCapture(
  job: ConfigCaptureJob,
  {
    log = console.log,
    env = process.env,
    cwd = process.cwd(),
    playwright = () => loadPlaywright(),
  }: ConfigCaptureIo = {},
) {
  const file = path.resolve(cwd, job.config);
  const config = await loadCaptureConfig(file, job.config);
  const revision = job.version ?? config.version;
  if (!revision) {
    throw new Error(
      `Set "version" in ${job.config} or pass --version <id> (for example build-43).`,
    );
  }
  if (!SEGMENT.test(revision)) {
    throw new Error(
      `--version "${revision}" must be letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  const screens = job.screen
    ? config.screens.filter((screen) => screen.id === job.screen)
    : config.screens;
  if (!screens.length) {
    throw new Error(
      `No screen "${job.screen}" in ${job.config}. Screens: ${config.screens.map((screen) => screen.id).join(", ")}.`,
    );
  }
  const outDir = path.resolve(path.dirname(file), config.outDir);
  const captureRoot = (width: number) =>
    path.join(outDir, revision, String(width));

  const thumbs = createThumbnailCache(defaultThumbsRoot(env));
  const { chromium } = await playwright();
  const browser = await chromium.launch();
  try {
    for (const width of config.viewports) {
      for (const screen of screens) {
        const out = path.join(captureRoot(width), `${screen.id}.png`);
        imageType(out);
        const page = await browser.newPage({
          viewport: { width, height: config.height },
        });
        try {
          await page.goto(screen.url, { waitUntil: "networkidle" });
          if (screen.steps) await runSteps(page, screen.steps);
          if (screen.setup) {
            await screen.setup(page, { viewport: width, screen: screen.id });
          }
          if (screen.waitFor) await page.waitForSelector(screen.waitFor);
          const { pinned } = await shoot(page, out, {
            cache: thumbs,
            ids: {
              projectId: config.project.id,
              version: versionId(revision, width),
              screenId: screen.id,
            },
          });
          log(
            `Captured ${screen.id} at ${width}px -> ${path.relative(cwd, out) || out}${pinned.length ? ` (pinned ${pinned.join(", ")})` : ""}`,
          );
        } catch (error) {
          throw new Error(
            `Capturing ${screen.id} at ${width}px: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const registrationFile = path.join(
    projectsRoot(job.projects, env),
    `${config.project.id}.json`,
  );
  const existing = await readRegistration(registrationFile);
  await writeRegistration(
    registrationFile,
    mergeRegistration(existing, config, { revision, screens, captureRoot }),
  );
  const count = screens.length;
  log(
    `${existing ? "Updated" : "Registered"} ${config.project.id}: ${count} screen${count === 1 ? "" : "s"} at ${config.viewports.join(", ")}px in revision ${revision} (${registrationFile}).`,
  );
}
