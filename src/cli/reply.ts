// Lets an agent close the loop on review comments: list what is open, read one
// in full, then reply (what was done, or why not) and set its status. It talks
// to the server through the same client as the MCP server, so both see the same
// pin numbers, statuses and conflict handling.
//
//   screencheck reply --project shop --list [--status fixed] [--screen 3]
//   screencheck reply --project shop --show --id <id>
//   screencheck reply --project shop --id <id> --status fixed \
//     --note "Moved the footer below the fold." [--author Copilot] [--recapture]
import {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiFeedback,
} from "../agent-api/client";
import {
  asFeedbackRecords,
  compareComments,
  latestLine,
  matchesFilter,
  oneLine,
  parseStatuses,
  pickScreen,
  pickVersion,
  summarize,
  threadLine,
  type ThreadMessage,
} from "../agent-api/comments";
import { patchWithRetry } from "../agent-api/patch";
import {
  isReviewerOnlyStatus,
  statusLabel,
  toApiStatus,
} from "../agent-api/status";
import { versionModel } from "../client/versions";
import { resolveOrigin, type RuntimeInfo } from "../server/runtime";
import { captionFor } from "../shared/captions";
import { describeElement, resolvePinElement } from "../shared/elements";
import { createPinNumbers } from "../shared/export";
import type { PublicProject } from "../shared/projects";
import { type Capture, recaptureScreen } from "./recapture";

export type ReplyOptions = {
  project?: string;
  list?: boolean;
  show?: boolean;
  json?: boolean;
  all?: boolean;
  clear?: boolean;
  help?: boolean;
  recapture?: boolean;
  revision?: string;
  config?: string;
  id?: string;
  note?: string;
  status?: string;
  version?: string;
  screen?: string;
  tag?: string;
  author?: string;
  url?: string;
  port?: string;
};

const AGENT_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "WONT_FIX"];

const FLAGS = new Set([
  "list",
  "show",
  "json",
  "all",
  "clear",
  "help",
  "recapture",
]);

export const REPLY_USAGE = `Usage:
  screencheck reply --project <id> --list [--all] [--status <s,...>] [--version <v>] [--screen <id|number|title>] [--tag <tag>] [--json]
  screencheck reply --project <id> --show --id <feedbackId> [--json]
  screencheck reply --project <id> --id <feedbackId> --note <text> [--status fixed|wont-fix|in-progress|backlog] [--author <name>]
      [--recapture [--revision <id>] [--config <file>]]
  screencheck reply --project <id> --id <feedbackId> --clear
--list shows open comments (Backlog, In progress); --all adds closed ones and
--status picks exact statuses (comma-separated, e.g. fixed,verified).
--show prints the note, what the screen shows, the element under the pin and
the whole thread.
--recapture captures the comment's screen again after replying, with the
project's capture config (screencheck.config.mjs/.js/.json here, or --config),
into the config's version or --revision, so the reviewer sees before and after.
Options: --url <origin> or --port <n> (default $SCREENCHECK_URL, else the
running server in ~/.screencheck/server.json, else http://127.0.0.1:$PORT,
port 4173 if unset)`;

export function parseReplyArgs(argv: string[]): ReplyOptions {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
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
  return options as ReplyOptions;
}

// An agent may set Backlog, In progress, Fixed or Won't fix, by API value or
// any of the friendly names the MCP server accepts.
export function normalizeStatus(value: string | undefined) {
  if (value === undefined) return undefined;
  const status = toApiStatus(value);
  if (isReviewerOnlyStatus(status)) {
    throw new Error(
      `Only a reviewer can mark a comment ${statusLabel(status)}.`,
    );
  }
  if (!AGENT_STATUSES.includes(status)) {
    throw new Error(`Unknown status: ${value}`);
  }
  return status;
}

export type ReplyIo = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  readRuntime?: () => RuntimeInfo | null;
  // For --recapture: where to look for the config, and the capture to run.
  cwd?: string;
  recapture?: Capture;
};

// --url and --port win; otherwise the environment, then the running server.
export function replyOrigin(
  options: Pick<ReplyOptions, "url" | "port">,
  env: NodeJS.ProcessEnv = process.env,
  readRuntime?: () => RuntimeInfo | null,
) {
  if (options.url) return resolveOrigin(options.url, env, readRuntime);
  if (options.port) return `http://127.0.0.1:${options.port}`;
  return resolveOrigin(undefined, env, readRuntime);
}

// The project's catalog entry, for screen titles, numbers and versions. Null
// when the server has no catalog (a bare feedback API); ids are used as given.
async function findProject(api: ApiClient, id: string) {
  try {
    const { projects } = await api.listProjects();
    return projects.find((item) => item.id === id) ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function screenFilter(project: PublicProject | null, value?: string) {
  if (!value) return undefined;
  return project ? pickScreen(project, value)!.id : value;
}

function versionFilter(project: PublicProject | null, value?: string) {
  if (!value) return undefined;
  return project ? pickVersion(project, value) : value;
}

async function listComments(
  api: ApiClient,
  options: ReplyOptions,
  projectId: string,
  log: (line: string) => void,
) {
  const feedback = await api.listFeedback(projectId);
  const filtered = Boolean(
    options.version || options.screen || options.tag || options.status,
  );
  const project =
    filtered || options.json ? await findProject(api, projectId) : null;
  const numbers = createPinNumbers(asFeedbackRecords(feedback));
  const shown = feedback.filter((item) =>
    matchesFilter(item, {
      version: versionFilter(project, options.version),
      screenId: screenFilter(project, options.screen),
      statuses: parseStatuses(options.status),
      tag: options.tag,
      includeClosed: options.all,
    }),
  );
  if (options.json) {
    const comments = shown
      .map((item) => summarize(item, project, numbers))
      .sort(compareComments(project));
    log(
      JSON.stringify(
        { project: projectId, count: comments.length, feedback: comments },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const item of shown) {
    log(
      [
        item.id,
        `${item.version}/${item.screenId} pin ${numbers.get(item.id)}${listMarks(item)}`,
        statusLabel(item.status),
        item.tags.join(",") || "-",
        oneLine(item.note),
      ].join("\t"),
    );
  }
  if (!shown.length)
    log(filtered ? "No matching feedback." : "No open feedback.");
  return 0;
}

async function showComment(
  api: ApiClient,
  projectId: string,
  feedback: ApiFeedback[],
  record: ApiFeedback,
  json: boolean | undefined,
  log: (line: string) => void,
) {
  const project = await findProject(api, projectId);
  const comment = summarize(
    record,
    project,
    createPinNumbers(asFeedbackRecords(feedback)),
  );
  const screen = project?.screens.find((item) => item.id === record.screenId);
  const caption =
    captionFor(
      await api.listCaptions(projectId).catch(() => []),
      record.version,
      record.screenId,
    ) ??
    screen?.description ??
    null;
  const mapped = resolvePinElement(
    await api
      .elementMap(projectId, record.version, record.screenId)
      .catch(() => null),
    record,
  );
  const element = mapped
    ? { ...mapped, description: describeElement(mapped) }
    : null;
  const thread: ThreadMessage[] = Array.isArray(record.thread)
    ? (record.thread as ThreadMessage[])
    : [];
  if (json) {
    log(JSON.stringify({ comment, caption, element, thread }, null, 2));
    return 0;
  }
  const lines = [
    `${record.id}  ${record.version}/${record.screenId} pin ${comment.pin} · ${comment.statusLabel}${record.tags.length ? ` · ${record.tags.join(", ")}` : ""}`,
    `Note: ${record.note}`,
  ];
  if (caption) lines.push(`Screen shows: ${caption}`);
  if (element) lines.push(`Element under the pin: ${element.description}`);
  if (thread.length) {
    lines.push("Thread:");
    for (const message of thread) lines.push(`  ${threadLine(message)}`);
  } else if (comment.latestReply) {
    lines.push(latestLine(comment.latestReply, true));
  }
  log(lines.join("\n"));
  return 0;
}

export async function runReply(
  argv: string[],
  {
    fetch: fetchImpl = fetch,
    env = process.env,
    log = console.log,
    readRuntime,
    cwd,
    recapture,
  }: ReplyIo = {},
) {
  const options = parseReplyArgs(argv);
  if (options.help || !options.project) {
    log(REPLY_USAGE);
    return options.help ? 0 : 1;
  }
  if (
    (options.recapture || options.revision) &&
    (options.list || options.show || options.clear)
  ) {
    throw new Error(
      "--recapture goes with a reply (--id <id> --note <text> --status fixed).",
    );
  }
  const api = createApiClient({
    origin: replyOrigin(options, env, readRuntime),
    fetchImpl,
  });
  const projectId = options.project;

  if (options.list) return listComments(api, options, projectId, log);

  if (!options.id) {
    throw new Error(
      `--id is required to ${options.show ? "show a comment" : "reply"}.`,
    );
  }
  const status = options.show ? undefined : normalizeStatus(options.status);
  let patch: Record<string, unknown> | undefined;
  if (options.show) {
    patch = undefined;
  } else if (options.clear) {
    patch = { reply: null };
  } else {
    if (!options.note?.trim()) throw new Error("--note is required to reply.");
    patch = {
      reply: { note: options.note, author: options.author ?? "Agent" },
    };
  }
  if (patch && status) patch.status = status;

  const feedback = await api.listFeedback(projectId);
  const current = feedback.find((item) => item.id === options.id);
  if (!current) throw new Error(`No feedback with id ${options.id}.`);
  if (!patch) {
    return showComment(api, projectId, feedback, current, options.json, log);
  }

  const updated = await patchWithRetry(api, projectId, current, patch);
  log(
    `${options.clear ? "Cleared reply on" : "Replied to"} ${current.id} (${statusLabel(updated.status)}).`,
  );
  if (!options.recapture) return 0;
  const project = await findProject(api, projectId);
  const result = await recaptureScreen(
    {
      projectId,
      screenId: current.screenId,
      commentRevision: project
        ? versionModel(project).revisionOf(current.version)
        : current.version,
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.config ? { config: options.config } : {}),
    },
    { env, ...(cwd ? { cwd } : {}), ...(recapture ? { recapture } : {}) },
  );
  for (const line of result.lines) log(line);
  return result.ok ? 0 : 1;
}

// Flags a plain list line with what --json reports as scope / checkPlacement.
function listMarks(feedback: ApiFeedback): string {
  const item = feedback as { scope?: unknown; checkPlacement?: unknown };
  const marks = [
    item.scope === "all" ? "all sizes" : "",
    item.checkPlacement === true ? "check placement" : "",
  ].filter(Boolean);
  return marks.length ? ` (${marks.join(", ")})` : "";
}
