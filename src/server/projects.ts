import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { appHome } from "./home";
import { elementMapPathFor } from "../shared/elements";
import { parseScreens, type ReviewScreen } from "../shared/manifest";
import { formatZodError } from "../shared/zod-format";
import type { PublicProject, ProjectList } from "../shared/projects";

export const EXAMPLE_PROJECT: PublicProject = {
  id: "example",
  name: "Example project",
  versions: ["live"],
  screens: [
    {
      id: "landing",
      ordinal: 1,
      title: "Public landing",
      description: "Public sign-in landing page before authentication.",
      group: "Access",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
    {
      id: "bootstrap",
      ordinal: 2,
      title: "Session bootstrap",
      description:
        "Secure-session handoff while Microsoft identity is verified.",
      group: "Access",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
    {
      id: "dashboard",
      ordinal: 3,
      title: "Populated dashboard",
      description:
        "Portfolio dashboard populated with skills and workflow states.",
      group: "Portfolio",
      viewport: { width: 1440, height: 1000 },
      hasCapture: false,
    },
  ],
};

const registrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  versions: z
    .array(z.object({ id: z.string().min(1), captureRoot: z.string().min(1) }))
    .min(1),
  screens: z.unknown(),
});

type Registration = {
  id: string;
  name: string;
  versions: { id: string; captureRoot: string }[];
  screens: ReviewScreen[];
};

const CAPTURE_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function defaultProjectsRoot() {
  return (
    process.env.SCREENCHECK_PROJECTS ??
    process.env.SCREEN_REVIEW_PROJECTS ??
    path.join(appHome(), "projects")
  );
}

type RegistryRead = { registrations: Registration[]; problems: string[] };

type RegistryReader = {
  readFile?: (file: string) => Promise<string>;
};

function issueText(error: unknown) {
  if (error instanceof z.ZodError) return formatZodError(error);
  return error instanceof Error ? error.message.split("\n")[0]! : "unreadable";
}

// Every capture, element map and project list request needs the registry, so
// it is parsed once and reused until a file in the folder is added, removed
// or modified.
function createRegistry({
  readFile: read = (file) => readFile(file, "utf8"),
}: RegistryReader = {}) {
  let cached: { key: string; value: RegistryRead } | null = null;
  return async function readRegistrations(
    projectsRoot: string,
  ): Promise<RegistryRead> {
    let names: string[] = [];
    try {
      names = (await readdir(projectsRoot))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stamps = await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(path.join(projectsRoot, name));
          return `${name}:${info.mtimeMs}:${info.size}`;
        } catch {
          return `${name}:gone`;
        }
      }),
    );
    const key = `${projectsRoot}\n${stamps.join("\n")}`;
    if (cached?.key === key) return cached.value;
    const registrations: Registration[] = [];
    const problems: string[] = [];
    for (const name of names) {
      try {
        const raw = JSON.parse(await read(path.join(projectsRoot, name)));
        const parsed = registrationSchema.parse(raw);
        registrations.push({
          ...parsed,
          screens: parseScreens(parsed.screens),
        });
      } catch (error) {
        problems.push(`${name}: ${issueText(error)}`);
      }
    }
    const value = { registrations, problems };
    cached = { key, value };
    return value;
  };
}

const inside = (root: string, file: string) =>
  file.startsWith(`${root}${path.sep}`);

type CaptureLocation = { file: string | null; problem?: string };

// A capture must live inside its version's captureRoot. A relative
// capturePath is read from the captureRoot (subfolders included); an absolute
// one that points outside the root falls back to the same file name inside
// it, which is how registrations written on another machine keep working.
function locateCapture(
  version: { captureRoot: string },
  screen: ReviewScreen,
): CaptureLocation {
  const root = path.resolve(version.captureRoot);
  const declared = screen.capturePath;
  if (!declared) return { file: path.join(root, `${screen.id}.webp`) };
  if (path.isAbsolute(declared)) {
    const resolved = path.resolve(declared);
    if (inside(root, resolved)) return { file: resolved };
    return { file: path.join(root, path.basename(resolved)) };
  }
  const resolved = path.resolve(root, declared);
  if (inside(root, resolved)) return { file: resolved };
  return {
    file: null,
    problem: `capturePath "${declared}" points outside the captureRoot`,
  };
}

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export type CatalogMiss = { error: string };

export function createProjectCatalog({
  projectsRoot = defaultProjectsRoot(),
  hasFeedback = async (_projectId: string) => false,
  readFile: readRegistryFile,
}: {
  projectsRoot?: string;
  hasFeedback?: (projectId: string) => Promise<boolean>;
  // For tests: count how often registrations are actually parsed.
  readFile?: (file: string) => Promise<string>;
} = {}) {
  const readRegistrations = createRegistry(
    readRegistryFile ? { readFile: readRegistryFile } : {},
  );

  async function find(projectId: string, versionId: string, screenId: string) {
    const { registrations } = await readRegistrations(projectsRoot);
    const registration = registrations.find((item) => item.id === projectId);
    const version = registration?.versions.find(
      (item) => item.id === versionId,
    );
    const screen = registration?.screens.find((item) => item.id === screenId);
    if (!version || !screen) return null;
    return { version, screen };
  }

  return {
    projectsRoot,
    async list(): Promise<ProjectList> {
      const read = await readRegistrations(projectsRoot);
      const problems = [...read.problems];
      const projects: PublicProject[] = [];
      for (const registration of read.registrations) {
        const latest = registration.versions.at(-1)!;
        const screenProblems: string[] = [];
        projects.push({
          id: registration.id,
          name: registration.name,
          versions: registration.versions.map((version) => version.id),
          screens: await Promise.all(
            registration.screens.map(async (screen, index) => {
              const located = locateCapture(latest, screen);
              const hasCapture = located.file
                ? await isFile(located.file)
                : false;
              if (located.problem) {
                screenProblems[index] =
                  `${registration.id}: screen "${screen.id}" ${located.problem}.`;
              } else if (screen.capturePath && !hasCapture) {
                // Only the file name: /api/projects never exposes local paths.
                const shown = path.isAbsolute(screen.capturePath)
                  ? path.basename(screen.capturePath)
                  : screen.capturePath;
                screenProblems[index] =
                  `${registration.id}: screen "${screen.id}" capture ${shown} not found in version ${latest.id}.`;
              }
              return {
                id: screen.id,
                ordinal: screen.ordinal,
                title: screen.title,
                ...(screen.description
                  ? { description: screen.description }
                  : {}),
                group: screen.group,
                viewport: screen.viewport,
                ...(screen.liveUrl ? { liveUrl: screen.liveUrl } : {}),
                hasCapture,
              };
            }),
          ),
        });
        problems.push(...screenProblems.filter(Boolean));
      }
      // The placeholder project stays available while it holds feedback, so
      // notes written before any project was registered are never hidden.
      if (projects.length === 0 || (await hasFeedback(EXAMPLE_PROJECT.id))) {
        projects.push(EXAMPLE_PROJECT);
      }
      return { projects, problems };
    },
    // Checks that a project (and optionally a version and screen) is
    // registered. Returns null when it is, or a message listing valid ids.
    // The example placeholder is always accepted.
    async resolve(
      projectId: string,
      target: { version?: string; screenId?: string } = {},
    ): Promise<CatalogMiss | null> {
      if (projectId === EXAMPLE_PROJECT.id) return null;
      const { registrations } = await readRegistrations(projectsRoot);
      const registration = registrations.find((item) => item.id === projectId);
      if (!registration) {
        const ids = registrations.map((item) => item.id);
        return {
          error: `Unknown project "${projectId}". ${ids.length ? `Projects: ${ids.join(", ")}.` : "No projects are registered."}`,
        };
      }
      const versions = registration.versions.map((item) => item.id);
      if (target.version !== undefined && !versions.includes(target.version)) {
        return {
          error: `Project ${projectId} has no version "${target.version}". Versions: ${versions.join(", ")}.`,
        };
      }
      const screens = registration.screens.map((item) => item.id);
      if (target.screenId !== undefined && !screens.includes(target.screenId)) {
        return {
          error: `Project ${projectId} has no screen "${target.screenId}". Screens: ${screens.join(", ")}.`,
        };
      }
      return null;
    },
    async capture(projectId: string, versionId: string, screenId: string) {
      const found = await find(projectId, versionId, screenId);
      if (!found) return null;
      const { file } = locateCapture(found.version, found.screen);
      if (!file) return null;
      const type = CAPTURE_TYPES[path.extname(file).toLowerCase()];
      if (!type || !(await isFile(file))) return null;
      const [realFile, realRoot] = await Promise.all([
        realpath(file),
        realpath(found.version.captureRoot),
      ]);
      if (!inside(realRoot, realFile)) return null;
      const info = await stat(realFile);
      return {
        type,
        // Changes whenever the file is re-captured, so browsers revalidate
        // instead of showing a stale image.
        etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
        open: () => createReadStream(realFile),
      };
    },
    // The element map stored beside a screen's capture, as raw text, or null
    // when there is none (or it would sit outside the captureRoot).
    async elements(projectId: string, versionId: string, screenId: string) {
      const found = await find(projectId, versionId, screenId);
      if (!found) return null;
      const { file: capture } = locateCapture(found.version, found.screen);
      if (!capture) return null;
      const file = elementMapPathFor(capture);
      if (!(await isFile(file))) return null;
      const [realFile, realRoot] = await Promise.all([
        realpath(file),
        realpath(found.version.captureRoot),
      ]);
      if (!inside(realRoot, realFile)) return null;
      return readFile(realFile, "utf8");
    },
  };
}

export type ProjectCatalog = ReturnType<typeof createProjectCatalog>;
