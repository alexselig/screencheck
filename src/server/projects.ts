import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { appHome } from "./home";
import { elementMapPathFor } from "../shared/elements";
import { parseScreens, type ReviewScreen } from "../shared/manifest";
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

async function readRegistrations(projectsRoot: string) {
  const registrations: Registration[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(projectsRoot))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    try {
      const raw = JSON.parse(
        await readFile(path.join(projectsRoot, name), "utf8"),
      );
      const parsed = registrationSchema.parse(raw);
      registrations.push({ ...parsed, screens: parseScreens(parsed.screens) });
    } catch (error) {
      problems.push(
        `${name}: ${error instanceof Error ? error.message.split("\n")[0] : "unreadable"}`,
      );
    }
  }
  return { registrations, problems };
}

// A capture must live inside its version's captureRoot; registrations that
// point elsewhere fall back to the same file name inside the root.
function captureFile(version: { captureRoot: string }, screen: ReviewScreen) {
  const root = path.resolve(version.captureRoot);
  const declared = screen.capturePath ? path.resolve(screen.capturePath) : null;
  if (declared && declared.startsWith(`${root}${path.sep}`)) return declared;
  const name = declared ? path.basename(declared) : `${screen.id}.webp`;
  return path.join(root, name);
}

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function createProjectCatalog({
  projectsRoot = defaultProjectsRoot(),
  hasFeedback = async (_projectId: string) => false,
}: {
  projectsRoot?: string;
  hasFeedback?: (projectId: string) => Promise<boolean>;
} = {}) {
  return {
    projectsRoot,
    async list(): Promise<ProjectList> {
      const { registrations, problems } = await readRegistrations(projectsRoot);
      const projects: PublicProject[] = [];
      for (const registration of registrations) {
        const latest = registration.versions.at(-1)!;
        projects.push({
          id: registration.id,
          name: registration.name,
          versions: registration.versions.map((version) => version.id),
          screens: await Promise.all(
            registration.screens.map(async (screen) => ({
              id: screen.id,
              ordinal: screen.ordinal,
              title: screen.title,
              ...(screen.description
                ? { description: screen.description }
                : {}),
              group: screen.group,
              viewport: screen.viewport,
              ...(screen.liveUrl ? { liveUrl: screen.liveUrl } : {}),
              hasCapture: await isFile(captureFile(latest, screen)),
            })),
          ),
        });
      }
      // The placeholder project stays available while it holds feedback, so
      // notes written before any project was registered are never hidden.
      if (projects.length === 0 || (await hasFeedback(EXAMPLE_PROJECT.id))) {
        projects.push(EXAMPLE_PROJECT);
      }
      return { projects, problems };
    },
    async capture(projectId: string, versionId: string, screenId: string) {
      const { registrations } = await readRegistrations(projectsRoot);
      const registration = registrations.find((item) => item.id === projectId);
      const version = registration?.versions.find(
        (item) => item.id === versionId,
      );
      const screen = registration?.screens.find((item) => item.id === screenId);
      if (!version || !screen) return null;
      const file = captureFile(version, screen);
      const type = CAPTURE_TYPES[path.extname(file).toLowerCase()];
      if (!type || !(await isFile(file))) return null;
      const [realFile, realRoot] = await Promise.all([
        realpath(file),
        realpath(version.captureRoot),
      ]);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
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
      const { registrations } = await readRegistrations(projectsRoot);
      const registration = registrations.find((item) => item.id === projectId);
      const version = registration?.versions.find(
        (item) => item.id === versionId,
      );
      const screen = registration?.screens.find((item) => item.id === screenId);
      if (!version || !screen) return null;
      const file = elementMapPathFor(captureFile(version, screen));
      if (!(await isFile(file))) return null;
      const [realFile, realRoot] = await Promise.all([
        realpath(file),
        realpath(version.captureRoot),
      ]);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
      return readFile(realFile, "utf8");
    },
  };
}

export type ProjectCatalog = ReturnType<typeof createProjectCatalog>;
