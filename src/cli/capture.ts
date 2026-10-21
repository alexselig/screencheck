// `screencheck capture <url> --out <file>`: one full-page shot through the
// bottom-bar-safe helper. Options are parsed into a plain object so a config
// file of many shots can feed runCapture later.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { captureFullPage } from "../capture/full-page";
import { elementMapPathFor } from "../shared/elements";

export type CaptureJob = {
  url: string;
  out: string;
  width: number;
  height: number;
  waitFor?: string;
};

export const CAPTURE_USAGE = `Usage:
  screencheck capture <url> --out <file> [--width 1440] [--height 1000] [--wait-for <selector>]

Writes a full-page screenshot (.png, .jpg or .webp) with bottom-anchored bars
moved to the end of the page. Needs Playwright:
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

export function parseCaptureArgs(argv: string[]): CaptureJob | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      width: { type: "string" },
      height: { type: "string" },
      "wait-for": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
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

function imageType(file: string) {
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
  const type = imageType(job.out);
  const { chromium } = await playwright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
    });
    await page.goto(job.url, { waitUntil: "networkidle" });
    if (job.waitFor) await page.waitForSelector(job.waitFor);
    await mkdir(path.dirname(path.resolve(job.out)), { recursive: true });
    // The element map goes beside the capture, where the server and the
    // inspector look for it.
    const { image, pinned } = await captureFullPage(page, {
      type: type === "jpeg" ? "jpeg" : "png",
      elements: { path: elementMapPathFor(job.out) },
    });
    const bytes = type === "webp" ? await toWebp(image) : image;
    await writeAtomically(job.out, bytes);
    log(
      `Captured ${job.url} -> ${job.out}${pinned.length ? ` (pinned ${pinned.join(", ")})` : ""}`,
    );
  } finally {
    await browser.close();
  }
}
