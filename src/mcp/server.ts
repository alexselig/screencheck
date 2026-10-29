import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { version as VERSION } from "../../package.json";
import { isApproved } from "../shared/approvals";
import { captionFor } from "../shared/captions";
import {
  describeElement,
  elementMapKey,
  resolvePinElement,
  type ElementMap,
} from "../shared/elements";
import {
  PRIORITY_TAGS,
  priorityTag,
  REPLY_MAX_LENGTH,
} from "../shared/feedback";
import { createPinNumbers, serializeMarkdown } from "../shared/export";
import {
  formatRelease,
  GATE_PRIORITIES,
  summarizeRelease,
} from "../shared/release";
import { mentionsName, normalizeMention } from "../shared/mentions";
import type { PublicProject, PublicScreen } from "../shared/projects";
import {
  createApiClient,
  ToolError,
  type ApiClient,
  type ApiFeedback,
} from "../agent-api/client";
import {
  asFeedbackRecords,
  compareComments,
  formatComment,
  latestLine,
  pickProject,
  pickScreen,
  pickVersion,
  screenLabel,
  summarize,
  threadLine,
  type Comment,
  type ThreadMessage,
} from "../agent-api/comments";
import { patchWithRetry } from "../agent-api/patch";
import {
  isClosingStatus,
  isOpenStatus,
  isReviewerOnlyStatus,
  statusLabel,
  toApiStatus,
} from "../agent-api/status";
import { versionModel } from "../client/versions";
import { type Capture, recaptureScreen } from "../cli/recapture";
import { renderPinImage } from "./crop";

export type McpServerOptions = {
  origin?: string;
  fetchImpl?: typeof fetch;
  author?: string;
  // For reply's recapture: where the capture config is looked up (the
  // folder the MCP server was started in) and the capture to run.
  cwd?: string;
  recapture?: Capture;
};

const INSTRUCTIONS = `ScreenCheck holds design-review feedback: numbered pins on screen captures, each with a note, tags (P0/P1/P2 priority plus free text) and a status.
Typical loop: list_feedback to see open comments, get_comment for the note and a crop of the capture around the pin, fix the code, then reply with what you did and status "fixed" (or "wont-fix" with the reason).
Each comment's latest message is labelled Reviewer or Agent; awaitingAgent means the reviewer spoke last (for example, reopened a fix with a reason).
Reviewers can address you with @agent in a note or reply; list_feedback with mentions "agent" finds those comments.
Only a reviewer can verify a fix or approve a screen.`;

const STATUS_HELP =
  "backlog, in-progress, fixed or wont-fix (API values like RESOLVED also work)";

function textResult(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Every tool reports failures as a tool error the agent can read, never as a
// protocol error.
function guarded<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : "ScreenCheck request failed.",
      );
    }
  };
}

function openByPriority(records: ApiFeedback[]) {
  const counts: Record<string, number> = { total: 0 };
  for (const priority of PRIORITY_TAGS) counts[priority] = 0;
  counts.untagged = 0;
  for (const record of records) {
    if (!isOpenStatus(record.status)) continue;
    counts.total! += 1;
    const priority = priorityTag(record.tags);
    counts[priority ?? "untagged"]! += 1;
  }
  return counts;
}

function describeOpen(counts: Record<string, number>) {
  const parts = PRIORITY_TAGS.filter((priority) => counts[priority]).map(
    (priority) => `${counts[priority]} ${priority}`,
  );
  return `${counts.total} open${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

// Fixed by an agent but not yet checked by a reviewer.
function unverifiedFixes(feedback: readonly { status: string }[]) {
  return feedback.filter((item) => item.status === "RESOLVED").length;
}

function describeUnverified(count: number) {
  return count ? `, ${count} fixed awaiting verification` : "";
}

function screenInfo(screen: PublicScreen | undefined) {
  return screen
    ? {
        id: screen.id,
        title: screen.title,
        ordinal: screen.ordinal,
        group: screen.group,
      }
    : null;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const api: ApiClient = createApiClient(options);
  const defaultAuthor = options.author ?? "Agent";
  const server = new McpServer(
    { name: "screencheck", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  async function projects() {
    return (await api.listProjects()).projects;
  }

  async function findComment(id: string, projectId?: string) {
    const all = await projects();
    const candidates = projectId ? [pickProject(all, projectId)] : all;
    for (const project of candidates) {
      const feedback = await api.listFeedback(project.id);
      const record = feedback.find((item) => item.id === id);
      if (record) return { project, feedback, record };
    }
    throw new ToolError(
      `No comment with id ${id}${projectId ? ` in project ${projectId}` : ""}. Use list_feedback to find ids.`,
    );
  }

  // Re-reads and retries once if the reviewer edited the comment meanwhile,
  // without overriding a status the reviewer just set.
  function patchComment(
    projectId: string,
    current: ApiFeedback,
    patch: Record<string, unknown>,
  ) {
    return patchWithRetry(api, projectId, current, patch);
  }

  function agentStatus(value: string | undefined) {
    if (value === undefined) return undefined;
    const status = toApiStatus(value);
    if (isReviewerOnlyStatus(status)) {
      throw new ToolError(
        `Only a reviewer can set "${statusLabel(status)}": it records that a person checked the fix on screen. Reply with status "fixed" and say what you changed; the reviewer verifies it.`,
      );
    }
    return status;
  }

  async function updated(projectId: string, record: ApiFeedback) {
    const all = await projects();
    const project = pickProject(all, projectId);
    const feedback = await api.listFeedback(projectId);
    return summarize(
      record,
      project,
      createPinNumbers(asFeedbackRecords(feedback)),
    );
  }

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List ScreenCheck projects with their versions (oldest first, latest last) and screens (id, number, title, group). Each version and screen carries its count of open comments (Backlog or In progress); screen counts cover every version.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const list = await api.listProjects();
      const result = [];
      const lines: string[] = [];
      for (const project of list.projects) {
        const feedback = (await api.listFeedback(project.id)).filter((item) =>
          isOpenStatus(item.status),
        );
        const versions = project.versions.map((id) => ({
          id,
          open: feedback.filter((item) => item.version === id).length,
        }));
        const screens = project.screens.map((screen) => ({
          id: screen.id,
          ordinal: screen.ordinal,
          title: screen.title,
          group: screen.group,
          hasCapture: screen.hasCapture,
          open: feedback.filter((item) => item.screenId === screen.id).length,
        }));
        result.push({
          id: project.id,
          name: project.name,
          open: feedback.length,
          versions,
          screens,
        });
        lines.push(
          `${project.id} (${project.name}): ${feedback.length} open`,
          `  Versions: ${versions.map((item) => `${item.id} (${item.open} open)`).join(", ")}`,
          ...screens.map(
            (screen) =>
              `  ${String(screen.ordinal).padStart(2, "0")} ${screen.title} [${screen.group}] id ${screen.id}: ${screen.open} open`,
          ),
        );
      }
      if (list.problems.length) {
        lines.push(`Problems: ${list.problems.join("; ")}`);
      }
      return textResult(lines.join("\n") || "No projects.", {
        projects: result,
        problems: list.problems,
      });
    }),
  );

  server.registerTool(
    "list_feedback",
    {
      title: "List feedback",
      description:
        "List review comments with their on-screen pin number, screen, status, tags, note, latest reply and pin position (x, y from 0 to 1 across the capture). By default only open comments (Backlog and In progress) are shown. Use the id with get_comment, reply or set_status.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id. Optional when only one project exists."),
        version: z.string().optional().describe("Only this version."),
        screen: z
          .string()
          .optional()
          .describe("Only this screen: its id, its number, or its title."),
        status: z
          .string()
          .optional()
          .describe(
            `Only these statuses, comma-separated: ${STATUS_HELP}, verified. Overrides includeClosed.`,
          ),
        tag: z
          .string()
          .optional()
          .describe("Only comments with this tag, e.g. P0 (case-insensitive)."),
        includeClosed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also list Fixed, Won't fix and other closed comments."),
        mentions: z
          .string()
          .optional()
          .describe(
            'Only comments whose note or thread mentions this name, e.g. "agent" for comments addressed to you with @agent (case-insensitive, leading @ optional).',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const project = pickProject(await projects(), args.project);
      const version = pickVersion(project, args.version);
      const screen = pickScreen(project, args.screen);
      const statuses = args.status
        ? args.status
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .map(toApiStatus)
        : undefined;
      const tag = args.tag?.trim().toLowerCase();
      const feedback = await api.listFeedback(project.id);
      const pinNumbers = createPinNumbers(asFeedbackRecords(feedback));
      const comments = feedback
        .filter(
          (item) =>
            (!version || item.version === version) &&
            (!screen || item.screenId === screen.id) &&
            (statuses
              ? statuses.includes(item.status)
              : args.includeClosed || isOpenStatus(item.status)) &&
            (!tag || item.tags.some((value) => value.toLowerCase() === tag)) &&
            (!args.mentions?.trim() || mentionsName(item, args.mentions)),
        )
        .map((item) => summarize(item, project, pinNumbers))
        .sort(compareComments(project));
      const scope = [
        project.id,
        version,
        screen?.id,
        statuses
          ? statuses.map(statusLabel).join("/")
          : args.includeClosed
            ? "all statuses"
            : "open",
        args.tag,
        args.mentions?.trim() ? `@${normalizeMention(args.mentions)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const text = comments.length
        ? `${comments.length} comment${comments.length === 1 ? "" : "s"} (${scope})\n\n${comments.map(formatComment).join("\n\n")}`
        : `No comments match (${scope}).`;
      return textResult(text, {
        project: project.id,
        filters: {
          version: version ?? null,
          screen: screen?.id ?? null,
          status: statuses ?? null,
          tag: args.tag ?? null,
          includeClosed: args.includeClosed,
        },
        count: comments.length,
        feedback: comments,
      });
    }),
  );

  server.registerTool(
    "get_comment",
    {
      title: "Get comment",
      description:
        "Get one review comment in full: note, tags, status, reply, the screen and its caption (what the capture shows), plus an image of the capture cropped around the pin (about 800x600 capture pixels) with the pin circled. Set fullCapture to get the whole screen, downscaled, instead.",
      inputSchema: {
        id: z.string().min(1).describe("Comment id from list_feedback."),
        project: z
          .string()
          .optional()
          .describe("Project id. Optional; every project is searched."),
        fullCapture: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return the whole capture (downscaled) instead of a crop."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const { project, feedback, record } = await findComment(
        args.id,
        args.project,
      );
      const comment = summarize(
        record,
        project,
        createPinNumbers(asFeedbackRecords(feedback)),
      );
      const screen = project.screens.find(
        (item) => item.id === record.screenId,
      );
      const caption =
        captionFor(
          await api.listCaptions(project.id).catch(() => []),
          record.version,
          record.screenId,
        ) ??
        screen?.description ??
        null;
      const [capture, elementMap] = await Promise.all([
        api.capture(project.id, record.version, record.screenId),
        api
          .elementMap(project.id, record.version, record.screenId)
          .catch(() => null),
      ]);
      const mapped = resolvePinElement(elementMap, record);
      const element = mapped
        ? { ...mapped, description: describeElement(mapped) }
        : null;
      const image = capture
        ? await renderPinImage(capture.data, record, {
            full: args.fullCapture,
          }).catch(() => null)
        : null;

      const lines = [
        formatComment(comment).split("\n")[0]!,
        "",
        `Note: ${record.note}`,
      ];
      if (caption) lines.push(`Screen shows: ${caption}`);
      if (element) lines.push(`Element under the pin: ${element.description}`);
      const thread: ThreadMessage[] = Array.isArray(record.thread)
        ? (record.thread as ThreadMessage[])
        : [];
      if (thread.length) {
        lines.push("Thread:");
        for (const message of thread) lines.push(`  ${threadLine(message)}`);
      } else if (comment.latestReply) {
        lines.push(latestLine(comment.latestReply, true));
      }
      if (image && !image.marked) {
        lines.push(
          `Image: the whole ${image.capture.width}x${image.capture.height} capture as stored, without the pin drawn (install sharp for a crop with the pin circled); the pin is at (${image.pin.x}, ${image.pin.y}).`,
        );
      } else if (image?.box) {
        const { left, top, width, height } = image.box;
        lines.push(
          args.fullCapture
            ? `Image: whole ${image.capture.width}x${image.capture.height} capture at ${image.width}x${image.height}; the region is outlined at (${left}, ${top}), ${width}x${height}.`
            : `Image: ${image.width}x${image.height} crop of the ${image.capture.width}x${image.capture.height} capture from (${image.region.left}, ${image.region.top}); the region is outlined at (${left}, ${top}), ${width}x${height}.`,
        );
      } else if (image) {
        lines.push(
          args.fullCapture
            ? `Image: whole ${image.capture.width}x${image.capture.height} capture at ${image.width}x${image.height}; the pin is circled at (${image.pin.x}, ${image.pin.y}).`
            : `Image: ${image.width}x${image.height} crop of the ${image.capture.width}x${image.capture.height} capture from (${image.region.left}, ${image.region.top}); the pin is circled at (${image.pin.x}, ${image.pin.y}).`,
        );
      } else {
        lines.push(
          capture
            ? "Image: the capture could not be read."
            : `Image: no capture for ${record.version} / ${record.screenId}.`,
        );
      }

      const structured = {
        comment: {
          ...comment,
          reply: record.reply ?? null,
          ...(record.thread !== undefined ? { thread: record.thread } : {}),
          element,
        },
        screen: { ...screenInfo(screen), id: record.screenId, caption },
        image: image
          ? {
              mimeType: image.mimeType,
              marked: image.marked,
              width: image.width,
              height: image.height,
              region: image.region,
              capture: image.capture,
              pin: image.pin,
              ...(image.box ? { box: image.box } : {}),
            }
          : null,
        record,
      };
      const result = textResult(lines.join("\n"), structured);
      if (image) {
        result.content.push({
          type: "image",
          data: image.data.toString("base64"),
          mimeType: image.mimeType,
        });
      }
      return result;
    }),
  );

  server.registerTool(
    "reply",
    {
      title: "Reply to a comment",
      description:
        'Answer a review comment: say what you changed, or why you did not, and optionally move it to a new status in the same call. Use status "fixed" once the change is made, "wont-fix" with the reason, or "in-progress" while working. Only a reviewer can mark a comment verified.',
      inputSchema: {
        id: z.string().min(1).describe("Comment id from list_feedback."),
        note: z
          .string()
          .trim()
          .min(1)
          .max(REPLY_MAX_LENGTH)
          .describe("What was done, or why not. Shown under the comment."),
        status: z.string().optional().describe(`New status: ${STATUS_HELP}.`),
        author: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe(`Name shown on the reply. Defaults to "${defaultAuthor}".`),
        project: z
          .string()
          .optional()
          .describe("Project id. Optional; every project is searched."),
        recapture: z
          .boolean()
          .optional()
          .describe(
            "After replying, capture this comment's screen again with the project's capture config (screencheck.config.mjs in the folder the MCP server runs in), so the reviewer sees before and after. Use with status fixed.",
          ),
        revision: z
          .string()
          .optional()
          .describe(
            "With recapture: the revision to capture into, e.g. build-43. Defaults to the config's version.",
          ),
      },
    },
    guarded(async (args) => {
      const status = agentStatus(args.status);
      const { project, record } = await findComment(args.id, args.project);
      const patch: Record<string, unknown> = {
        reply: { note: args.note, author: args.author ?? defaultAuthor },
      };
      if (status) patch.status = status;
      const saved = await patchComment(project.id, record, patch);
      const comment = await updated(project.id, saved);
      if (!args.recapture) {
        return textResult(`Replied.\n${formatComment(comment)}`, {
          comment,
        });
      }
      const recapture = await recaptureScreen(
        {
          projectId: project.id,
          screenId: record.screenId,
          commentRevision: versionModel(project).revisionOf(record.version),
          ...(args.revision ? { revision: args.revision } : {}),
        },
        {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.recapture ? { recapture: options.recapture } : {}),
        },
      );
      return textResult(
        `Replied.\n${formatComment(comment)}\n${recapture.lines.join("\n")}`,
        { comment, recapture },
      );
    }),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set comment status",
      description:
        'Move a review comment to another status without writing a reply, e.g. "in-progress" when you start on it. Closing a comment (fixed or wont-fix) needs a note, so use reply for that. Only a reviewer can mark a comment verified.',
      inputSchema: {
        id: z.string().min(1).describe("Comment id from list_feedback."),
        status: z.string().min(1).describe(`New status: ${STATUS_HELP}.`),
        project: z
          .string()
          .optional()
          .describe("Project id. Optional; every project is searched."),
      },
    },
    guarded(async (args) => {
      const status = agentStatus(args.status)!;
      if (isClosingStatus(status)) {
        throw new ToolError(
          `Marking a comment ${statusLabel(status)} needs a note saying what was done or why not. Use reply with status "${args.status}" and a note.`,
        );
      }
      const { project, record } = await findComment(args.id, args.project);
      const saved =
        record.status === status
          ? record
          : await patchComment(project.id, record, { status });
      const comment = await updated(project.id, saved);
      return textResult(
        `Status: ${comment.statusLabel}.\n${formatComment(comment)}`,
        { comment },
      );
    }),
  );

  server.registerTool(
    "approval_status",
    {
      title: "Approval status",
      description:
        'Per-screen review state for one version: whether a reviewer approved the screen, and its open comments by priority. Starts with a summary such as "7/9 approved, 3 open (1 P0)". Approving is a reviewer action; agents only read it.',
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id. Optional when only one project exists."),
        version: z
          .string()
          .optional()
          .describe("Version id. Defaults to the latest version."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const project = pickProject(await projects(), args.project);
      const version =
        pickVersion(project, args.version) ?? project.versions.at(-1)!;
      const [approvals, feedback] = await Promise.all([
        api.listApprovals(project.id),
        api.listFeedback(project.id),
      ]);
      const inVersion = feedback.filter((item) => item.version === version);
      const screens = project.screens.map((screen) => ({
        id: screen.id,
        ordinal: screen.ordinal,
        title: screen.title,
        approved: isApproved(approvals, version, screen.id),
        open: openByPriority(
          inVersion.filter((item) => item.screenId === screen.id),
        ),
        unverified: unverifiedFixes(
          inVersion.filter((item) => item.screenId === screen.id),
        ),
      }));
      const approved = screens.filter((screen) => screen.approved).length;
      const totals = openByPriority(inVersion);
      const unverified = unverifiedFixes(inVersion);
      const summary = `${approved}/${screens.length} approved, ${describeOpen(totals)}${describeUnverified(unverified)}`;
      const lines = [
        `${project.id} / ${version}: ${summary}`,
        ...screens.map(
          (screen) =>
            `  ${String(screen.ordinal).padStart(2, "0")} ${screen.title}: ${screen.approved ? "approved" : "not approved"}, ${describeOpen(screen.open)}${describeUnverified(screen.unverified)}`,
        ),
      ];
      return textResult(lines.join("\n"), {
        project: project.id,
        version,
        summary,
        approved,
        total: screens.length,
        open: totals,
        unverified,
        screens,
      });
    }),
  );

  server.registerTool(
    "release_status",
    {
      title: "Release status",
      description:
        "Where a review round stands, the same report as `screencheck status --gate`: screens and how many are approved (a screen counts only when every size in the revision is approved), open comments by priority, fixes not yet verified, what changed since the previous revision, per-size counts, and whether the release gate passes with its reasons. Defaults to the latest revision.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id. Optional when only one project exists."),
        revision: z
          .string()
          .optional()
          .describe("Revision id (all its sizes). Defaults to the latest."),
        version: z
          .string()
          .optional()
          .describe("A single version (one size) instead of a revision."),
        maxPriority: z
          .enum(GATE_PRIORITIES)
          .optional()
          .describe(
            "Open priorities that block the gate: P0 (default), P1 (P0 and P1), P2 (any tagged) or any.",
          ),
        allowUnapproved: z
          .boolean()
          .optional()
          .describe("Do not block the gate on unapproved screens."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      if (args.version && args.revision) {
        throw new ToolError("Pass either version or revision, not both.");
      }
      const project = pickProject(await projects(), args.project);
      const [approvals, feedback] = await Promise.all([
        api.listApprovals(project.id),
        api.listFeedback(project.id),
      ]);
      const captures: Record<string, string[]> = {};
      for (const version of project.versions) {
        const present = await Promise.all(
          project.screens.map(async (screen) =>
            (await api.hasCapture(project.id, version, screen.id))
              ? screen.id
              : null,
          ),
        );
        captures[version] = present.filter((id): id is string => id !== null);
      }
      const status = summarizeRelease({
        project,
        feedback,
        approvals,
        captures,
        target: {
          ...(args.version ? { version: args.version } : {}),
          ...(args.revision ? { revision: args.revision } : {}),
        },
        gate: {
          ...(args.maxPriority ? { maxPriority: args.maxPriority } : {}),
          allowUnapproved: Boolean(args.allowUnapproved),
        },
      });
      return textResult(formatRelease(status, true), status);
    }),
  );

  server.registerResource(
    "feedback-markdown",
    new ResourceTemplate("screencheck://project/{id}/feedback.md", {
      list: async () => {
        try {
          return {
            resources: (await projects()).map((project) => ({
              uri: `screencheck://project/${encodeURIComponent(project.id)}/feedback.md`,
              name: `${project.name} feedback`,
              mimeType: "text/markdown",
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    {
      title: "Feedback export (Markdown)",
      description:
        "Every comment on a project as Markdown, grouped by screen, with pin numbers and ids. Same as the Export dialog.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = decodeURIComponent(String(variables.id));
      const project = pickProject(await projects(), id);
      const feedback = asFeedbackRecords(await api.listFeedback(project.id));
      const elements: Record<string, ElementMap> = {};
      const pairs = new Map(
        feedback.map((item) => [
          elementMapKey(item.version, item.screenId),
          item,
        ]),
      );
      await Promise.all(
        [...pairs].map(async ([key, item]) => {
          const map = await api
            .elementMap(project.id, item.version, item.screenId)
            .catch(() => null);
          if (map) elements[key] = map;
        }),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: serializeMarkdown({
              projectId: project.id,
              screens: project.screens,
              feedback,
              elements,
            }),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "fix_open_feedback",
    {
      title: "Fix open feedback",
      description:
        "Work through the open P0 and P1 comments on a project version, then reply to each.",
      argsSchema: {
        project: z.string().describe("Project id."),
        version: z
          .string()
          .optional()
          .describe("Version id. Defaults to the latest."),
      },
    },
    ({ project, version }) => {
      const target = version
        ? `${project}/${version}`
        : `${project} (latest version)`;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Fix the open P0/P1 comments on ${target} in ScreenCheck, then reply to each.

1. Call list_feedback with project "${project}"${version ? `, version "${version}"` : ""} and tag "P0", then again with tag "P1".
2. For each comment, call get_comment to read the note and look at the crop around the pin.
3. Make the change in the code.
4. Call reply with a short note saying what you changed and status "fixed". If you decide not to change it, reply with status "wont-fix" and the reason.
Do not try to verify or approve anything; the reviewer does that.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

export async function runMcpServer(
  options: { origin?: string; author?: string } = {},
): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
