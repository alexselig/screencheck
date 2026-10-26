// `screencheck bundle`: packs a project's captures, feedback and a static
// viewer into one zip a reviewer opens from index.html, no server needed.
// `screencheck import`: merges the review they export back in, through the
// same import code the server uses (its endpoint when it is running).
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { Readable } from "node:stream";

import { assertLoopbackOrigin } from "../agent-api/client";
import { appHome } from "../server/home";
import { createProjectCatalog } from "../server/projects";
import type { RuntimeInfo } from "../server/runtime";
import { sharedFeedbackStorage } from "../server/storage";
import {
  BUNDLE_FORMAT,
  bundleCaptureKey,
  reviewExportSchema,
  type OfflineBundle,
} from "../shared/bundle";
import { elementMapSchema, type ElementMap } from "../shared/elements";
import { ACTOR_HEADER, REVIEWER_ACTOR } from "../shared/feedback";
import { readZip, writeZip, type ZipEntry } from "./zip";

export const BUNDLE_USAGE = `Usage:
  screencheck bundle --project <id> [--version <id>...] [--out <file>]

Writes <project>-<version>.screencheck.zip: the captures, feedback and
registration for the chosen versions plus a viewer that opens from
index.html with no server. Reviewers add comments in it and send back the
file from "Export review"; merge it with "screencheck import".
  --version <id>  Version to include (repeatable; default the latest)
  --out <file>    Where to write the zip (default in the current folder)
  --data <dir>    Feedback folder (default ~/.screencheck/feedback)
  --projects <dir>  Registrations folder (default ~/.screencheck/projects)`;

export const IMPORT_USAGE = `Usage:
  screencheck import <review.json | bundle.zip> [--project <id>]

Merges a reviewer's comments from an offline bundle back into ScreenCheck.
Accepts the file saved by "Export review", or a zip holding one. Comments
already present (same id) are skipped, so importing twice is safe. Uses the
running server's import endpoint when there is one.
  --project <id>  Project to import into (default: the one in the file)
  --data <dir>    Feedback folder (default ~/.screencheck/feedback)
  --projects <dir>  Registrations folder (default ~/.screencheck/projects)`;

export type BundleIo = {
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  // The built offline viewer (dist/viewer).
  viewerRoot?: string;
  readRuntime?: () => RuntimeInfo | null;
  now?: () => Date;
};

const CAPTURE_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function roots(
  values: { data?: string; projects?: string },
  env: NodeJS.ProcessEnv,
) {
  const home = appHome(undefined, existsSync, env);
  return {
    dataRoot: path.resolve(
      values.data ??
        env.SCREENCHECK_DATA ??
        env.SCREEN_REVIEW_DATA ??
        path.join(home, "feedback"),
    ),
    projectsRoot: path.resolve(
      values.projects ??
        env.SCREENCHECK_PROJECTS ??
        env.SCREEN_REVIEW_PROJECTS ??
        path.join(home, "projects"),
    ),
  };
}

// One safe path segment per id, for names inside the zip.
function segment(value: string) {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.+$/.test(safe) ? safe.replace(/\./g, "_") : safe;
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23111111'/%3E%3Ctext x='16' y='25' text-anchor='middle' font-family='Instrument Sans,Helvetica Neue,Arial,sans-serif' font-weight='800' font-size='26' fill='%23fbfaf7'%3ES%3C/text%3E%3C/svg%3E";

// Classic scripts only: browsers refuse module scripts and fetch() on file://.
function indexHtml(title: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · ScreenCheck offline review</title>
    <link rel="icon" type="image/svg+xml" href="${FAVICON}" />
    <link rel="stylesheet" href="viewer/viewer.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="bundle.js"></script>
    <script src="viewer/viewer.js"></script>
  </body>
</html>
`;
}

function readme(name: string, versions: string[]) {
  return `ScreenCheck offline review: ${name} (${versions.join(", ")})

1. Unzip this folder and open index.html in a browser. Nothing to install.
2. Click a screen and add comments. They are kept in this browser.
3. Click "Export review" and send the downloaded .json file back.

The sender merges it with: screencheck import <file.json>
`;
}

export async function runBundle(argv: string[], io: BundleIo = {}) {
  const log = io.log ?? console.log;
  const env = io.env ?? process.env;
  const now = io.now ?? (() => new Date());
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      version: { type: "string", multiple: true },
      out: { type: "string" },
      data: { type: "string" },
      projects: { type: "string" },
    },
  });
  if (!values.project) throw new Error(`Missing --project.\n\n${BUNDLE_USAGE}`);
  const viewerRoot = io.viewerRoot;
  if (!viewerRoot || !existsSync(path.join(viewerRoot, "viewer.js"))) {
    throw new Error(
      `The offline viewer is not built${viewerRoot ? ` (${viewerRoot})` : ""}. Run \`npm run build\` first.`,
    );
  }
  const { dataRoot, projectsRoot } = roots(values, env);
  const catalog = createProjectCatalog({ projectsRoot });
  const { projects } = await catalog.list();
  const project = projects.find((item) => item.id === values.project);
  if (!project) {
    const ids = projects.map((item) => item.id);
    throw new Error(
      `Unknown project "${values.project}". ${ids.length ? `Projects: ${ids.join(", ")}.` : "No projects are registered."}`,
    );
  }
  const wanted = values.version?.length
    ? values.version
    : [project.versions.at(-1)!];
  for (const version of wanted) {
    if (!project.versions.includes(version)) {
      throw new Error(
        `Project ${project.id} has no version "${version}". Versions: ${project.versions.join(", ")}.`,
      );
    }
  }
  const versions = project.versions.filter((id) => wanted.includes(id));
  const latest = versions.at(-1)!;

  const storage = sharedFeedbackStorage(dataRoot);
  const inVersions = (item: { version: string }) =>
    versions.includes(item.version);
  const [feedback, approvals, captions] = await Promise.all([
    storage.listFeedback(project.id),
    storage.listApprovals(project.id),
    storage.listCaptions(project.id),
  ]);

  const files: ZipEntry[] = [];
  const captures: Record<string, string> = {};
  const elements: Record<string, ElementMap> = {};
  for (const version of versions) {
    for (const screen of project.screens) {
      const key = bundleCaptureKey(version, screen.id);
      const capture = await catalog.capture(project.id, version, screen.id);
      if (capture) {
        const name = `captures/${segment(version)}/${segment(screen.id)}.${CAPTURE_EXTENSIONS[capture.type] ?? "img"}`;
        files.push({ name, data: await streamToBuffer(capture.open()) });
        captures[key] = name;
      }
      const text = await catalog.elements(project.id, version, screen.id);
      if (text) {
        try {
          const map = elementMapSchema.safeParse(JSON.parse(text));
          if (map.success) elements[key] = map.data;
        } catch {
          // An unreadable map just means pins name no element.
        }
      }
    }
  }

  const createdAt = now().toISOString();
  const bundledProject = {
    ...project,
    versions,
    ...(project.versionDetails
      ? {
          versionDetails: project.versionDetails.filter((item) =>
            versions.includes(item.id),
          ),
        }
      : {}),
    screens: project.screens.map((screen) => ({
      ...screen,
      hasCapture: Boolean(captures[bundleCaptureKey(latest, screen.id)]),
    })),
  };
  const bundle: OfflineBundle = {
    format: BUNDLE_FORMAT,
    id: `${project.id}-${createdAt.replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
    createdAt,
    project: bundledProject,
    feedback: feedback.filter(inVersions),
    approvals: approvals.filter(inVersions),
    captions: captions.filter(inVersions),
    captures,
    elements,
  };

  const folder = `${segment(project.id)}-${versions.map(segment).join("_")}`;
  const viewerFiles = await filesUnder(viewerRoot);
  const entries: ZipEntry[] = [
    { name: "index.html", data: indexHtml(project.name) },
    {
      name: "bundle.js",
      data: `window.__SCREENCHECK_BUNDLE__ = ${JSON.stringify(bundle)};\n`,
    },
    { name: "README.txt", data: readme(project.name, versions) },
    // The same records and project as plain JSON, for tools and `import`.
    {
      name: "feedback.json",
      data: `${JSON.stringify({ projectId: project.id, feedback: bundle.feedback }, null, 2)}\n`,
    },
    {
      name: "registration.json",
      data: `${JSON.stringify(bundledProject, null, 2)}\n`,
    },
    ...(await Promise.all(
      viewerFiles.map(async (file) => ({
        name: `viewer/${file}`,
        data: await readFile(path.join(viewerRoot, file)),
      })),
    )),
    ...files,
  ].map((entry) => ({ ...entry, name: `${folder}/${entry.name}` }));

  const out = path.resolve(
    io.cwd ?? process.cwd(),
    values.out ?? `${folder}.screencheck.zip`,
  );
  await writeFile(out, writeZip(entries, now()));
  log(
    `Wrote ${out}: ${project.name} ${versions.join(", ")}, ${Object.keys(captures).length} capture${Object.keys(captures).length === 1 ? "" : "s"}, ${bundle.feedback.length} comment${bundle.feedback.length === 1 ? "" : "s"}.`,
  );
  log(
    "Reviewers unzip it and open index.html; merge their export with `screencheck import`.",
  );
  return 0;
}

type ImportBatch = { source: string; projectId?: string; records: unknown[] };

function batchFrom(source: string, value: unknown): ImportBatch | null {
  const review = reviewExportSchema.safeParse(value);
  if (review.success) {
    return {
      source,
      projectId: review.data.projectId,
      records: review.data.records,
    };
  }
  if (Array.isArray(value)) return { source, records: value };
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { feedback?: unknown }).feedback)
  ) {
    const { projectId, feedback } = value as {
      projectId?: unknown;
      feedback: unknown[];
    };
    return {
      source,
      ...(typeof projectId === "string" ? { projectId } : {}),
      records: feedback,
    };
  }
  return null;
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Every review export in a zip, plus a bundle's own feedback.json.
function batchesFromZip(file: string, zip: Buffer): ImportBatch[] {
  const batches: ImportBatch[] = [];
  for (const [name, data] of readZip(zip)) {
    if (!name.endsWith(".json") || name.endsWith("registration.json")) continue;
    const value = parseJson(data.toString("utf8"));
    const isReview = reviewExportSchema.safeParse(value).success;
    if (!isReview && path.posix.basename(name) !== "feedback.json") continue;
    const batch = batchFrom(`${file}:${name}`, value);
    if (batch) batches.push(batch);
  }
  return batches;
}

type ImportResult = { imported: number; skipped: number; invalid: number };

async function importThroughServer(
  origin: string,
  projectId: string,
  records: unknown[],
): Promise<ImportResult> {
  const base = assertLoopbackOrigin(origin);
  const response = await fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/feedback/import`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base,
        // Whoever runs import is the reviewer bringing comments home.
        [ACTOR_HEADER]: REVIEWER_ACTOR,
      },
      body: JSON.stringify({ records }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<ImportResult>;
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return {
    imported: body.imported ?? 0,
    skipped: body.skipped ?? 0,
    invalid: body.invalid ?? 0,
  };
}

export async function runImport(argv: string[], io: BundleIo = {}) {
  const log = io.log ?? console.log;
  const env = io.env ?? process.env;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      data: { type: "string" },
      projects: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error(`Give one file to import.\n\n${IMPORT_USAGE}`);
  }
  const file = path.resolve(io.cwd ?? process.cwd(), positionals[0]!);
  const raw = await readFile(file);
  const isZip = raw
    .subarray(0, 4)
    .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const batches = isZip
    ? batchesFromZip(file, raw)
    : [batchFrom(file, parseJson(raw.toString("utf8")))].filter(
        (batch): batch is ImportBatch => batch !== null,
      );
  if (!batches.length) {
    throw new Error(
      `${file} is not a review export (or a zip holding one). Use the file saved by "Export review" in an offline bundle.`,
    );
  }

  const { dataRoot, projectsRoot } = roots(values, env);
  const running = (io.readRuntime ?? (() => null))();
  const server =
    running && path.resolve(running.dataRoot) === dataRoot ? running : null;
  const catalog = createProjectCatalog({ projectsRoot });
  for (const batch of batches) {
    const projectId = values.project ?? batch.projectId;
    if (!projectId) {
      throw new Error(
        `${batch.source} does not name a project; pass --project.`,
      );
    }
    let result: ImportResult | null = null;
    let via = dataRoot;
    if (server) {
      try {
        result = await importThroughServer(
          server.origin,
          projectId,
          batch.records,
        );
        via = server.origin;
      } catch (error) {
        // A stale server.json: nothing is listening, so write directly.
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (!result) {
      const miss = await catalog.resolve(projectId);
      if (miss) throw new Error(miss.error);
      result = await sharedFeedbackStorage(dataRoot).importFeedback(
        projectId,
        batch.records,
      );
    }
    const extras = [
      result.skipped ? `${result.skipped} already there` : "",
      result.invalid ? `${result.invalid} invalid` : "",
    ].filter(Boolean);
    log(
      `Imported ${result.imported} comment${result.imported === 1 ? "" : "s"} into ${projectId}${extras.length ? ` (${extras.join(", ")})` : ""} via ${via}.`,
    );
    if (result.invalid) return 1;
  }
  return 0;
}
