// Files review comments as GitHub issues through the `gh` CLI, and closes the
// loop the other way: when an issue is closed, its comment moves to Fixed.
//
//   screencheck issues --project shop --repo owner/name [--per screen] [--dry-run]
//   screencheck issues sync --project shop [--dry-run]
//
// GitHub has no API for attaching an image to an issue, and `gh issue create`
// can't upload one. The crop around each pin is written to
// ~/.screencheck/issue-crops/<project>/<comment>.png and the issue body names
// that path next to a link that opens the screen in ScreenCheck.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiFeedback,
} from "../agent-api/client";
import {
  asFeedbackRecords,
  matchesFilter,
  oneLine,
  parseStatuses,
  pickVersion,
  threadLine,
  type ThreadMessage,
} from "../agent-api/comments";
import { patchWithRetry, StatusChangedError } from "../agent-api/patch";
import { isOpenStatus, statusLabel } from "../agent-api/status";
import { appHome } from "../server/home";
import type { RuntimeInfo } from "../server/runtime";
import { createPinNumbers } from "../shared/export";
import { priorityTag, type IssueLink } from "../shared/feedback";
import type { PublicProject } from "../shared/projects";
import { replyOrigin } from "./reply";

export type GhResult = { code: number; stdout: string; stderr: string };
// Runs `gh <args>` with `input` on stdin. Injected in tests so they never
// reach GitHub.
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

export type IssuesOptions = {
  project?: string;
  repo?: string;
  version?: string;
  per?: string;
  status?: string;
  label?: string;
  author?: string;
  url?: string;
  port?: string;
  sync?: boolean;
  "dry-run"?: boolean;
  help?: boolean;
};

export type IssuesIo = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  readRuntime?: () => RuntimeInfo | null;
  gh?: GhRunner;
};

type Out = (...lines: string[]) => void;

const FLAGS = new Set(["sync", "dry-run", "help"]);
const DEFAULT_LABEL = "screencheck";
const TITLE_NOTE_LENGTH = 72;

export const ISSUES_USAGE = `Usage:
  screencheck issues --project <id> --repo <owner/name> [--version <v>] [--per comment|screen] [--status open] [--label screencheck] [--dry-run]
  screencheck issues sync --project <id> [--version <v>] [--dry-run]
Files comments as GitHub issues through the gh CLI (run "gh auth login"
first): one issue per comment, or with --per screen one per screen listing
its comments. Each issue names the screen, version and size, priority, tags,
note and thread, links back to the screen in ScreenCheck, and points at a
crop around the pin saved in ~/.screencheck/issue-crops/<project>/ (gh can't
upload images). The issue is stored on the comment, so a re-run skips it.
--status picks comments (default open = Backlog and In progress; or e.g.
fixed,wont-fix, or all). --label "" files without a label.
sync (or --sync) asks GitHub about each linked open comment and moves it to
Fixed, with "Closed in owner/name#N" in its thread, once the issue is
closed. It never sets Verified; that stays the reviewer's call.
--dry-run prints what would happen and changes nothing.
Options: --url <origin> or --port <n> (as for reply).`;

export function parseIssuesArgs(argv: string[]): IssuesOptions {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "sync") {
      options.sync = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (FLAGS.has(key)) {
      options[key] = true;
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${key} needs a value.`);
      }
      options[key] = value;
      index += 1;
    }
  }
  return options as IssuesOptions;
}

export const defaultGh: GhRunner = (args, input) =>
  new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      resolve({
        code: 127,
        stdout,
        stderr:
          error.code === "ENOENT"
            ? "gh not found. Install the GitHub CLI (https://cli.github.com) and run gh auth login."
            : error.message,
      }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

async function gh(run: GhRunner, args: string[], input?: string) {
  const result = await run(args, input);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return result.stdout;
}

export function issueRef(issue: IssueLink) {
  return `${issue.repo}#${issue.number}`;
}

// `gh issue create` prints the new issue's URL.
export function parseIssueUrl(output: string) {
  const url = output
    .trim()
    .split(/\s+/)
    .find((part) => /\/issues\/\d+$/.test(part));
  if (!url) throw new Error(`gh did not print an issue URL: ${output.trim()}`);
  return { number: Number(/\/issues\/(\d+)$/.exec(url)![1]), url };
}

function parseRepo(value: string | undefined) {
  if (!value) throw new Error("--repo owner/name is required.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
    throw new Error(`--repo must be owner/name, not "${value}".`);
  }
  return value;
}

function linkOf(item: ApiFeedback): IssueLink | null {
  const issue = item.issue as Partial<IssueLink> | undefined;
  return issue &&
    typeof issue.repo === "string" &&
    typeof issue.number === "number"
    ? { repo: issue.repo, number: issue.number, url: String(issue.url ?? "") }
    : null;
}

async function findProject(api: ApiClient, id: string) {
  try {
    const { projects } = await api.listProjects();
    return projects.find((item) => item.id === id) ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function reviewLink(
  origin: string,
  projectId: string,
  version: string,
  screenId: string,
) {
  const params = new URLSearchParams({
    project: projectId,
    version,
    screen: screenId,
  });
  return `${origin}/#${params}`;
}

type Group<T> = { version: string; screenId: string; items: T[] };

// Comments grouped by version and screen, in version then screen order.
export function groupByScreen<
  T extends Pick<ApiFeedback, "version" | "screenId">,
>(items: T[], project: PublicProject | null): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const key = `${item.version}\u0000${item.screenId}`;
    let group = groups.get(key);
    if (!group) {
      group = { version: item.version, screenId: item.screenId, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  const versionRank = (id: string) => {
    const at = project?.versions.indexOf(id) ?? -1;
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const screenRank = (id: string) =>
    project?.screens.find((screen) => screen.id === id)?.ordinal ??
    Number.MAX_SAFE_INTEGER;
  return [...groups.values()].sort(
    (left, right) =>
      versionRank(left.version) - versionRank(right.version) ||
      screenRank(left.screenId) - screenRank(right.screenId),
  );
}

export type IssueComment = {
  pin: number;
  record: ApiFeedback;
  // Where the crop around the pin was (or, on a dry run, would be) saved.
  crop: string | null;
};

export type IssueBodyInput = {
  origin: string;
  project: PublicProject | null;
  projectId: string;
  version: string;
  screenId: string;
  comments: IssueComment[];
};

function screenTitle(project: PublicProject | null, screenId: string) {
  const screen = project?.screens.find((item) => item.id === screenId);
  if (!screen) return screenId;
  return `${String(screen.ordinal).padStart(2, "0")} ${screen.title}`;
}

function sizeOf(
  project: PublicProject | null,
  version: string,
  screenId: string,
) {
  const label = project?.versionDetails?.find(
    (item) => item.id === version,
  )?.label;
  const viewport = project?.screens.find(
    (item) => item.id === screenId,
  )?.viewport;
  const parts = [
    label,
    viewport ? `${viewport.width}×${viewport.height}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function renderIssueBody({
  origin,
  project,
  projectId,
  version,
  screenId,
  comments,
}: IssueBodyInput) {
  const size = sizeOf(project, version, screenId);
  const lines = [
    `**Screen:** ${screenTitle(project, screenId)} · **Version:** \`${version}\`${size ? ` · **Size:** ${size}` : ""}`,
    `**Open in ScreenCheck:** ${reviewLink(origin, projectId, version, screenId)}`,
  ];
  for (const { pin, record, crop } of comments) {
    const priority = priorityTag(record.tags);
    const tags = record.tags.filter((tag) => tag !== priority);
    lines.push(
      "",
      `<!-- screencheck:${record.id} -->`,
      `### Pin ${pin}${priority ? ` · ${priority}` : ""} · ${statusLabel(record.status)}`,
    );
    if (tags.length) {
      lines.push(`Tags: ${tags.map((tag) => `\`${tag}\``).join(", ")}`);
    }
    lines.push("", record.note);
    const thread = Array.isArray(record.thread)
      ? (record.thread as ThreadMessage[])
      : [];
    if (thread.length) {
      lines.push("", "**Thread**");
      for (const message of thread) lines.push(`- ${threadLine(message)}`);
    }
    if (crop) {
      lines.push(
        "",
        `Crop around the pin (local file, gh can't upload images): \`${crop}\``,
      );
    }
    lines.push("", `<sub>ScreenCheck comment \`${record.id}\`</sub>`);
  }
  return lines.join("\n");
}

function issueTitle(
  project: PublicProject | null,
  group: Group<IssueComment>,
  per: "comment" | "screen",
) {
  const screen =
    project?.screens.find((item) => item.id === group.screenId)?.title ??
    group.screenId;
  if (per === "screen") {
    const count = group.items.length;
    return `[ScreenCheck] ${screen} (${group.version}): ${count} comment${count === 1 ? "" : "s"}`;
  }
  const { record, pin } = group.items[0]!;
  const note = oneLine(record.note);
  const short =
    note.length > TITLE_NOTE_LENGTH
      ? `${note.slice(0, TITLE_NOTE_LENGTH - 1)}…`
      : note;
  return `[ScreenCheck] ${screen} · pin ${pin}: ${short}`;
}

function statusFilter(value: string | undefined) {
  const wanted = value?.trim().toLowerCase();
  if (!wanted || wanted === "open") return { statuses: undefined };
  if (wanted === "all") return { statuses: undefined, includeClosed: true };
  return { statuses: parseStatuses(value) };
}

async function saveCrop(
  api: ApiClient,
  projectId: string,
  record: ApiFeedback,
  directory: string,
) {
  const capture = await api
    .capture(projectId, record.version, record.screenId)
    .catch(() => null);
  if (!capture) return null;
  const { renderPinImage } = await import("../mcp/crop");
  const image = await renderPinImage(capture.data, record).catch(() => null);
  if (!image) return null;
  const extension = image.mimeType.split("/")[1]!.replace("jpeg", "jpg");
  const file = join(directory, `${record.id}.${extension}`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, image.data);
  return file;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function createIssues(
  api: ApiClient,
  options: IssuesOptions,
  projectId: string,
  io: { log: Out; gh: GhRunner; env: NodeJS.ProcessEnv },
) {
  const repo = parseRepo(options.repo);
  const per = options.per ?? "comment";
  if (per !== "comment" && per !== "screen") {
    throw new Error(`--per must be comment or screen, not "${per}".`);
  }
  const dryRun = Boolean(options["dry-run"]);
  const label = options.label ?? DEFAULT_LABEL;
  const feedback = await api.listFeedback(projectId);
  const project = await findProject(api, projectId);
  const numbers = createPinNumbers(asFeedbackRecords(feedback));
  const chosen = feedback.filter((item) =>
    matchesFilter(item, {
      version: project
        ? pickVersion(project, options.version)
        : options.version,
      ...statusFilter(options.status),
    }),
  );
  const linked = chosen.filter((item) => linkOf(item));
  const pending = chosen.filter((item) => !linkOf(item));
  const cropDir = join(
    appHome(undefined, existsSync, io.env),
    "issue-crops",
    projectId,
  );

  const groups = groupByScreen(pending, project).flatMap((group) =>
    per === "screen"
      ? [group]
      : group.items.map((item) => ({ ...group, items: [item] })),
  );

  if (dryRun) {
    io.log(
      `Dry run: would create ${plural(groups.length, "issue")} on ${repo}${linked.length ? `; ${linked.length} already linked` : ""}.`,
    );
  } else if (groups.length && label) {
    // Fails harmlessly when the label already exists.
    await io.gh([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      "1d4ed8",
      "--description",
      "Filed from ScreenCheck",
    ]);
  }

  const origin = api.origin();
  for (const group of groups) {
    const comments: IssueComment[] = [];
    for (const record of group.items) {
      comments.push({
        pin: numbers.get(record.id) ?? 0,
        record,
        crop: dryRun
          ? join(cropDir, `${record.id}.png`)
          : await saveCrop(api, projectId, record, cropDir),
      });
    }
    const filed = { ...group, items: comments };
    const title = issueTitle(project, filed, per);
    const body = renderIssueBody({
      origin,
      project,
      projectId,
      version: group.version,
      screenId: group.screenId,
      comments,
    });
    if (dryRun) {
      io.log("", `# ${title}`, body);
      continue;
    }
    const args = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      "-",
    ];
    if (label) args.push("--label", label);
    const created = parseIssueUrl(await gh(io.gh, args, body));
    const issue: IssueLink = { repo, ...created };
    for (const record of group.items) {
      await patchWithRetry(api, projectId, record, { issue });
    }
    io.log(`${issueRef(issue)} ${created.url} ← ${title}`);
  }
  if (!dryRun) {
    io.log(
      `Created ${plural(groups.length, "issue")} on ${repo}; ${linked.length} already linked.`,
    );
  }
  return 0;
}

async function syncIssues(
  api: ApiClient,
  options: IssuesOptions,
  projectId: string,
  io: { log: Out; gh: GhRunner },
) {
  const dryRun = Boolean(options["dry-run"]);
  const feedback = await api.listFeedback(projectId);
  const project = options.version ? await findProject(api, projectId) : null;
  const version = project
    ? pickVersion(project, options.version)
    : options.version;
  // Fixed, Verified and Won't fix are settled; only open comments can move.
  const watched = feedback.filter(
    (item) =>
      linkOf(item) &&
      isOpenStatus(item.status) &&
      (!version || item.version === version),
  );
  const states = new Map<string, string | Error>();
  let moved = 0;
  let failed = 0;
  for (const item of watched) {
    const issue = linkOf(item)!;
    const ref = issueRef(issue);
    if (!states.has(ref)) {
      try {
        const output = await gh(io.gh, [
          "issue",
          "view",
          String(issue.number),
          "--repo",
          issue.repo,
          "--json",
          "state",
        ]);
        const state = (JSON.parse(output) as { state?: unknown }).state;
        states.set(ref, String(state ?? "").toUpperCase());
      } catch (error) {
        states.set(ref, error as Error);
      }
    }
    const state = states.get(ref)!;
    if (state instanceof Error) {
      failed += 1;
      io.log(`${item.id}: could not read ${ref}: ${state.message}`);
      continue;
    }
    if (state !== "CLOSED") continue;
    if (dryRun) {
      io.log(`Would move ${item.id} to Fixed (${ref} is closed).`);
      moved += 1;
      continue;
    }
    try {
      await patchWithRetry(api, projectId, item, {
        status: "RESOLVED",
        reply: { note: `Closed in ${ref}`, author: options.author ?? "GitHub" },
      });
      moved += 1;
      io.log(`${item.id} → Fixed (${ref} closed).`);
    } catch (error) {
      if (!(error instanceof StatusChangedError)) throw error;
      failed += 1;
      io.log(error.message);
    }
  }
  const checked = `checked ${plural(states.size, "issue")}`;
  io.log(
    dryRun
      ? `Dry run: would move ${plural(moved, "comment")} to Fixed; ${checked}.`
      : `${plural(moved, "comment")} moved to Fixed; ${checked}.`,
  );
  return failed ? 1 : 0;
}

export async function runIssues(
  argv: string[],
  {
    fetch: fetchImpl = fetch,
    env = process.env,
    log = console.log,
    readRuntime,
    gh: run = defaultGh,
  }: IssuesIo = {},
) {
  const options = parseIssuesArgs(argv);
  if (options.help || !options.project) {
    log(ISSUES_USAGE);
    return options.help ? 0 : 1;
  }
  const api = createApiClient({
    origin: replyOrigin(options, env, readRuntime),
    fetchImpl,
  });
  const logLines: Out = (...lines) => lines.forEach((line) => log(line));
  if (options.sync) {
    return syncIssues(api, options, options.project, {
      log: logLines,
      gh: run,
    });
  }
  return createIssues(api, options, options.project, {
    log: logLines,
    gh: run,
    env,
  });
}
