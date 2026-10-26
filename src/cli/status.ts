// The release gate: where a review round stands, read straight from storage so
// it works in CI with no server running.
//
//   screencheck status --project shop                 # latest revision
//   screencheck status --project shop --revision r2 --json
//   screencheck status --project shop --gate --max-priority P1
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { pickProject } from "../agent-api/comments";
import { appHome } from "../server/home";
import { createProjectCatalog } from "../server/projects";
import { createFeedbackStorage } from "../server/storage";
import {
  formatRelease,
  GATE_PRIORITIES,
  summarizeRelease,
  type GatePriority,
  type ReleaseStatus,
} from "../shared/release";

export const STATUS_USAGE = `Usage:
  screencheck status
  screencheck status [--project <id>] [--version <id> | --revision <id>]
                     [--gate] [--json] [--allow-unapproved]
                     [--max-priority P0|P1|P2|any]

With no options, prints the origin of the running server, or "not running"
(exit 1).

With any option, prints the review round instead, read from
~/.screencheck (SCREENCHECK_HOME) with no server needed: screens and how many
are approved (a screen counts only when every size is approved), open
comments by priority, fixes not yet verified, and what changed since the
previous revision. Defaults to the latest revision of the only project.
  --gate              Exit 1 while a blocking comment is open or a screen is
                      unapproved, listing the reasons; exit 0 otherwise
  --max-priority <p>  Open priorities that block: P0 (default) blocks on P0,
                      P1 on P0 and P1, P2 on any tagged, any on every open one
  --allow-unapproved  Do not block on unapproved screens
  --json              Print the summary as JSON (see README, "Release gate")`;

export type StatusOptions = {
  project?: string;
  version?: string;
  revision?: string;
  gate?: boolean;
  json?: boolean;
  allowUnapproved?: boolean;
  maxPriority?: GatePriority;
};

export function parseStatusArgs(argv: string[]): StatusOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      version: { type: "string" },
      revision: { type: "string" },
      gate: { type: "boolean" },
      json: { type: "boolean" },
      "allow-unapproved": { type: "boolean" },
      "max-priority": { type: "string" },
    },
  });
  if (values.version && values.revision) {
    throw new Error("Pass either --version or --revision, not both.");
  }
  let maxPriority: GatePriority | undefined;
  if (values["max-priority"] !== undefined) {
    const raw = values["max-priority"];
    const wanted = (
      raw.toLowerCase() === "any" ? "any" : raw.toUpperCase()
    ) as GatePriority;
    if (!GATE_PRIORITIES.includes(wanted)) {
      throw new Error(
        `--max-priority must be one of ${GATE_PRIORITIES.join(", ")} (got "${raw}").`,
      );
    }
    maxPriority = wanted;
  }
  const options: StatusOptions = {};
  if (values.project) options.project = values.project;
  if (values.version) options.version = values.version;
  if (values.revision) options.revision = values.revision;
  if (values.gate) options.gate = true;
  if (values.json) options.json = true;
  if (values["allow-unapproved"]) options.allowUnapproved = true;
  if (maxPriority) options.maxPriority = maxPriority;
  return options;
}

function roots(env: NodeJS.ProcessEnv) {
  const home = appHome(undefined, existsSync, env);
  return {
    dataRoot:
      env.SCREENCHECK_DATA ??
      env.SCREEN_REVIEW_DATA ??
      path.join(home, "feedback"),
    projectsRoot:
      env.SCREENCHECK_PROJECTS ??
      env.SCREEN_REVIEW_PROJECTS ??
      path.join(home, "projects"),
  };
}

// Reads the registration, captures, feedback and approvals for one project.
// Read-only: nothing on disk is created or rewritten.
export async function loadReleaseStatus(
  options: StatusOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseStatus> {
  const { dataRoot, projectsRoot } = roots(env);
  const catalog = createProjectCatalog({ projectsRoot });
  const { projects } = await catalog.list();
  const project = pickProject(projects, options.project);
  const storage = createFeedbackStorage({ dataRoot });
  const [feedback, approvals] = await Promise.all([
    storage.listFeedback(project.id),
    storage.listApprovals(project.id),
  ]);
  const captures: Record<string, string[]> = {};
  for (const version of project.versions) {
    const present = await Promise.all(
      project.screens.map(async (screen) =>
        (await catalog.capture(project.id, version, screen.id))
          ? screen.id
          : null,
      ),
    );
    captures[version] = present.filter((id): id is string => id !== null);
  }
  return summarizeRelease({
    project,
    feedback,
    approvals,
    captures,
    target: {
      ...(options.version ? { version: options.version } : {}),
      ...(options.revision ? { revision: options.revision } : {}),
    },
    gate: {
      ...(options.maxPriority ? { maxPriority: options.maxPriority } : {}),
      allowUnapproved: Boolean(options.allowUnapproved),
    },
  });
}

export async function runReleaseStatus(
  argv: string[],
  { log = console.log, env = process.env } = {},
) {
  const options = parseStatusArgs(argv);
  const status = await loadReleaseStatus(options, env);
  log(
    options.json
      ? JSON.stringify(status, null, 2)
      : formatRelease(status, Boolean(options.gate)),
  );
  return options.gate && !status.gate.pass ? 1 : 0;
}
