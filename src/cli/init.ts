// Registers a project from a folder of captures, so nobody has to hand-write
// the registration JSON:
//
//   screencheck init shop --captures ./captures   (one version per subfolder)
//   screencheck add shop ./captures/build-43      (one more version)
import { existsSync } from "node:fs";
import {
  readdir,
  readFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { appHome } from "../server/home";
import { DEFAULT_GROUP, parseScreens } from "../shared/manifest";
import { imageSize } from "./image-size";

export const INIT_USAGE = `Usage:
  screencheck init <project-id> --captures <dir> [--name <name>] [--force] [--projects <dir>]

Scans <dir> for PNG, JPEG and WebP captures and writes the project's
registration. Each subfolder with images becomes a version (named after the
folder); a folder of images with no subfolders becomes version "v1". Each
image becomes a screen: title from the file name, group "${DEFAULT_GROUP}",
viewport from the image size. Edit the JSON afterwards to add descriptions.
  --name      Display name (default: the id)
  --force     Replace an existing registration
  --projects  Registry folder (default $SCREENCHECK_PROJECTS, else
              ~/.screencheck/projects)`;

export const ADD_USAGE = `Usage:
  screencheck add <project-id> <dir> [--version <id>] [--projects <dir>]

Adds <dir> as a new version of a registered project (version id defaults to
the folder name). Images whose screen isn't registered yet become new screens.`;

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE = /\.(png|jpe?g|webp)$/i;

type Screen = {
  id: string;
  ordinal: number;
  title: string;
  group: string;
  description: string;
  capturePath: string;
  viewport: { width: number; height: number };
};

type Registration = {
  id: string;
  name: string;
  versions: { id: string; captureRoot: string }[];
  screens: Screen[];
  [key: string]: unknown;
};

export type InitIo = {
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

function projectsRoot(option: string | undefined, env: NodeJS.ProcessEnv) {
  return path.resolve(
    option ??
      env.SCREENCHECK_PROJECTS ??
      env.SCREEN_REVIEW_PROJECTS ??
      path.join(appHome(undefined, existsSync, env), "projects"),
  );
}

export function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "03_order-history.png" -> "Order history".
export function titleFromFile(file: string) {
  const words = path
    .basename(file, path.extname(file))
    .replace(/^\d+[\s._-]+/, "")
    .replace(/[\s._-]+/g, " ")
    .trim();
  const text = words || path.basename(file, path.extname(file));
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

async function images(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

async function screensFrom(
  dir: string,
  files: string[],
  existing: Screen[],
): Promise<Screen[]> {
  const ids = new Set(existing.map((screen) => screen.id));
  let ordinal = Math.max(0, ...existing.map((screen) => screen.ordinal));
  const added: Screen[] = [];
  for (const file of files) {
    const id = slug(path.basename(file, path.extname(file)));
    if (!id || ids.has(id)) continue;
    const size = imageSize(await readFile(path.join(dir, file)));
    if (!size) throw new Error(`Can't read the image size of ${file}.`);
    const title = titleFromFile(file);
    ids.add(id);
    ordinal += 1;
    added.push({
      id,
      ordinal,
      title,
      group: DEFAULT_GROUP,
      description: title,
      capturePath: file,
      viewport: size,
    });
  }
  return added;
}

async function versionsIn(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const versions: { id: string; dir: string; files: string[] }[] = [];
  for (const folder of folders) {
    const dir = path.join(root, folder);
    const files = await images(dir);
    if (files.length) versions.push({ id: slug(folder) || folder, dir, files });
  }
  if (versions.length) return versions;
  const files = await images(root);
  return files.length ? [{ id: "v1", dir: root, files }] : [];
}

async function writeRegistration(file: string, registration: Registration) {
  parseScreens(registration.screens);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(registration, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function checkId(id: string | undefined, usage: string) {
  if (!id) throw new Error(usage);
  if (!PROJECT_ID.test(id)) {
    throw new Error(
      `Invalid project id "${id}": use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.`,
    );
  }
  return id;
}

export async function runInit(argv: string[], io: InitIo = {}) {
  const log = io.log ?? console.log;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      captures: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean" },
      projects: { type: "string" },
    },
  });
  const id = checkId(positionals[0], INIT_USAGE);
  if (!values.captures)
    throw new Error(`--captures is required.\n${INIT_USAGE}`);
  const root = path.resolve(cwd, values.captures);
  const file = path.join(projectsRoot(values.projects, env), `${id}.json`);
  if (existsSync(file) && !values.force) {
    throw new Error(
      `${file} already exists. Use --force to replace it, or "screencheck add ${id} <dir>" to add a version.`,
    );
  }
  const versions = await versionsIn(root);
  if (!versions.length) {
    throw new Error(`No PNG, JPEG or WebP captures in ${root}.`);
  }
  let screens: Screen[] = [];
  for (const version of versions) {
    screens = [
      ...screens,
      ...(await screensFrom(version.dir, version.files, screens)),
    ];
  }
  await writeRegistration(file, {
    id,
    name: values.name ?? id,
    versions: versions.map((version) => ({
      id: version.id,
      captureRoot: version.dir,
    })),
    screens,
  });
  log(
    `Registered ${id}: ${screens.length} screen${screens.length === 1 ? "" : "s"} in ${versions.map((version) => version.id).join(", ")}.`,
  );
  log(`Wrote ${file}. Edit it to add descriptions and groups.`);
  return 0;
}

export async function runAdd(argv: string[], io: InitIo = {}) {
  const log = io.log ?? console.log;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      projects: { type: "string" },
    },
  });
  const id = checkId(positionals[0], ADD_USAGE);
  if (!positionals[1]) throw new Error(ADD_USAGE);
  const dir = path.resolve(cwd, positionals[1]);
  const file = path.join(projectsRoot(values.projects, env), `${id}.json`);
  let registration: Registration;
  try {
    registration = JSON.parse(await readFile(file, "utf8")) as Registration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Project ${id} isn't registered (${file}). Run "screencheck init ${id} --captures <dir>" first.`,
      );
    }
    throw error;
  }
  const versionId = values.version ?? (slug(path.basename(dir)) || "v1");
  if (registration.versions.some((version) => version.id === versionId)) {
    throw new Error(
      `Project ${id} already has a version "${versionId}". Pass --version <id>.`,
    );
  }
  const files = await images(dir);
  if (!files.length)
    throw new Error(`No PNG, JPEG or WebP captures in ${dir}.`);
  const added = await screensFrom(dir, files, registration.screens ?? []);
  await writeRegistration(file, {
    ...registration,
    versions: [...registration.versions, { id: versionId, captureRoot: dir }],
    screens: [...(registration.screens ?? []), ...added],
  });
  log(
    `Added version ${versionId} to ${id}${added.length ? ` with ${added.length} new screen${added.length === 1 ? "" : "s"}` : ""}.`,
  );
  return 0;
}
