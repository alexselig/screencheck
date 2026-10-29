// `screencheck capture <url> --out <file>`: one full-page shot through the
// bottom-bar-safe helper. `screencheck capture --config <file>` captures a
// whole project (see capture-config.ts).
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { captureFullPage } from "../capture/full-page";
import { captureThumbnails } from "../capture/thumbnail";
import {
  storeCaptureThumbnails,
  type ThumbnailCache,
  type ThumbnailIds,
} from "../server/thumbnails";
import { elementMapPathFor } from "../shared/elements";

export type CaptureJob = {
  url: string;
  out: string;
  width: number;
  height: number;
  waitFor?: string;
};

// `capture --config`: every screen in a config file at every viewport.
export type ConfigCaptureJob = {
  config: string;
  version?: string;
  screen?: string;
  projects?: string;
};

export const CAPTURE_USAGE = `Usage:
  screencheck capture <url> --out <file> [--width 1440] [--height 1000] [--wait-for <selector>]
  screencheck capture --config <file> [--version <id>] [--screen <id>] [--projects <dir>]

The first form writes one full-page screenshot (.png, .jpg or .webp) with
bottom-anchored bars moved to the end of the page, plus its element map
(<file>.elements.json).

The second reads screencheck.config.mjs (or .json) and captures every screen
at every viewport into one version per width, all sharing the revision
--version (default: the config's "version"), then writes or updates the
project's registration.
  --screen    Re-capture one screen only
  --projects  Registry folder (default $SCREENCHECK_PROJECTS, else
              ~/.screencheck/projects)

Needs Playwright:
  npm i -D playwright && npx playwright install chromium`;

const PLAYWRIGHT_HINT =
  "Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium";

function positiveInt(
  name: string,
  value: string | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive whole number.`);
  }
  return parsed;
}

export function parseCaptureArgs(
  argv: string[],
): CaptureJob | ConfigCaptureJob | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      width: { type: "string" },
      height: { type: "string" },
      "wait-for": { type: "string" },
      config: { type: "string", short: "c" },
      version: { type: "string" },
      screen: { type: "string" },
      projects: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  if (values.config !== undefined) {
    if (positionals.length) {
      throw new Error(
        `capture --config takes no URL (got ${positionals[0]}); the config lists the screens.`,
      );
    }
    for (const flag of ["out", "width", "height", "wait-for"] as const) {
      if (values[flag] !== undefined) {
        throw new Error(
          `--${flag} is for a single capture; with --config, set it in the config file.`,
        );
      }
    }
    return {
      config: values.config,
      ...(values.version ? { version: values.version } : {}),
      ...(values.screen ? { screen: values.screen } : {}),
      ...(values.projects ? { projects: values.projects } : {}),
    };
  }
  for (const flag of ["version", "screen", "projects"] as const) {
    if (values[flag] !== undefined) {
      throw new Error(`--${flag} only works with --config <file>.`);
    }
  }
  const [url, ...extra] = positionals;
  if (!url) throw new Error("capture needs a URL.");
  if (extra.length) throw new Error(`Unexpected argument: ${extra[0]}`);
  if (!values.out) throw new Error("capture needs --out <file>.");
  return {
    url,
    out: values.out,
    width: positiveInt("width", values.width, 1440),
    height: positiveInt("height", values.height, 1000),
    ...(values["wait-for"] ? { waitFor: values["wait-for"] } : {}),
  };
}

export function imageType(file: string) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  if (extension === ".webp") return "webp";
  throw new Error("--out must end in .png, .jpg, .jpeg or .webp.");
}

export async function loadPlaywright(
  load: () => Promise<typeof import("playwright")> = () => import("playwright"),
) {
  try {
    return await load();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(PLAYWRIGHT_HINT);
    }
    throw error;
  }
}

export const SHARP_HINT =
  'Saving WebP needs the optional "sharp" package: run "npm i -g sharp" (or "npm i -D sharp" in your project), or save a PNG with --out <file>.png.';

export async function toWebp(
  png: Uint8Array,
  load: () => Promise<{ default: typeof import("sharp").default }> = () =>
    import("sharp"),
) {
  let sharp: typeof import("sharp").default;
  try {
    sharp = (await load()).default;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(SHARP_HINT);
    }
    throw error;
  }
  return sharp(png).webp({ quality: 90 }).toBuffer();
}

// A re-capture over an existing file is swapped in whole, so the server
// never streams (or a browser caches) a half-written image.
async function writeAtomically(file: string, bytes: Uint8Array) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export type ShotPage = Parameters<typeof captureFullPage>[0];

// One full-page shot of an open page: the image (swapped in whole) and its
// element map beside it, where the server and the inspector look for it.
// With `thumbs`, the screen index thumbnails go to the cache as well, keyed by
// the capture just written so they are fresh.
export async function shoot(
  page: ShotPage,
  out: string,
  thumbs?: { cache: ThumbnailCache; ids: ThumbnailIds },
) {
  const type = imageType(out);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  const { image, pinned } = await captureFullPage(page, {
    type: type === "jpeg" ? "jpeg" : "png",
    elements: { path: elementMapPathFor(out) },
  });
  const bytes = type === "webp" ? await toWebp(image) : image;
  await writeAtomically(out, bytes);
  if (thumbs) {
    const images = await captureThumbnails(page);
    if (images) {
      await storeCaptureThumbnails(thumbs.cache, thumbs.ids, out, images).catch(
        () => undefined,
      );
    }
  }
  return { pinned };
}

export async function runCapture(
  job: CaptureJob,
  {
    log = console.log,
    playwright = () => loadPlaywright(),
  }: {
    log?: (line: string) => void;
    playwright?: () => Promise<Pick<typeof import("playwright"), "chromium">>;
  } = {},
) {
  imageType(job.out);
  const { chromium } = await playwright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
    });
    await page.goto(job.url, { waitUntil: "networkidle" });
    if (job.waitFor) await page.waitForSelector(job.waitFor);
    const { pinned } = await shoot(page, job.out);
    log(
      `Captured ${job.url} -> ${job.out}${pinned.length ? ` (pinned ${pinned.join(", ")})` : ""}`,
    );
  } finally {
    await browser.close();
  }
}
