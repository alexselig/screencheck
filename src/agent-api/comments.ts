// How the CLI and the MCP server describe comments, so an agent sees the same
// pin numbers, labels and wording whichever one it uses.
import type { FeedbackRecord } from "../shared/feedback";
import { priorityTag } from "../shared/feedback";
import { describePinBox, pinBoxOf } from "../shared/pin-box";
import type { PublicProject } from "../shared/projects";
import { ToolError, type ApiFeedback } from "./client";
import { isOpenStatus, statusLabel, toApiStatus } from "./status";

export type Role = "reviewer" | "agent";

export type ThreadMessage = {
  author?: string;
  role?: string;
  note?: string;
  at?: string;
  status?: string;
};

export type LatestMessage = {
  note: string;
  author: string;
  at: string;
  role: Role;
};

export function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function asFeedbackRecords(feedback: ApiFeedback[]) {
  return feedback as unknown as FeedbackRecord[];
}

export function roleLabel(role: string | undefined) {
  return role === "reviewer" ? "Reviewer" : "Agent";
}

// The newest message on a comment: the last thread message once threads
// exist, otherwise the single (agent) reply.
export function latestReply(record: ApiFeedback): LatestMessage | null {
  if (Array.isArray(record.thread) && record.thread.length > 0) {
    const last = record.thread.at(-1) as Record<string, unknown>;
    const note = last.note ?? last.text ?? last.body;
    if (typeof note === "string") {
      return {
        note,
        author: typeof last.author === "string" ? last.author : "",
        at: typeof last.at === "string" ? last.at : "",
        role: last.role === "reviewer" ? "reviewer" : "agent",
      };
    }
  }
  return record.reply ? { ...record.reply, role: "agent" } : null;
}

export function summarize(
  record: ApiFeedback,
  project: PublicProject | null,
  pinNumbers: Map<string, number>,
) {
  const screen = project?.screens.find((item) => item.id === record.screenId);
  const latest = latestReply(record);
  const region = pinBoxOf(record);
  return {
    id: record.id,
    project: project?.id ?? record.projectId,
    version: record.version,
    screen: {
      id: record.screenId,
      title: screen?.title ?? record.screenId,
      ordinal: screen?.ordinal ?? null,
    },
    pin: pinNumbers.get(record.id) ?? 0,
    status: record.status,
    statusLabel: statusLabel(record.status),
    tags: record.tags,
    priority: priorityTag(record.tags),
    note: record.note,
    position: { x: record.x, y: record.y },
    // Box pins: the region drawn; `position` is its centre.
    ...(region ? { region } : {}),
    latestReply: latest,
    // The reviewer spoke last (a reopen with a reason, a follow-up), so the
    // ball is in the agent's court.
    awaitingAgent: latest?.role === "reviewer",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export type Comment = ReturnType<typeof summarize>;

export function screenLabel(comment: Comment) {
  const ordinal =
    comment.screen.ordinal === null
      ? ""
      : `${String(comment.screen.ordinal).padStart(2, "0")} `;
  return `${comment.version} / ${ordinal}${comment.screen.title}`;
}

// `full` keeps the time and the note's line breaks (get_comment, --show).
export function latestLine(latest: LatestMessage, full = false) {
  const when = full && latest.at ? `, ${latest.at}` : "";
  const note = full ? latest.note : oneLine(latest.note);
  return `${roleLabel(latest.role)} (${latest.author || "unknown"}${when}): ${note}`;
}

export function formatComment(comment: Comment) {
  const tags = comment.tags.length ? ` · ${comment.tags.join(", ")}` : "";
  const lines = [
    `Pin ${comment.pin} on ${screenLabel(comment)}${tags} · ${comment.statusLabel} · at (${percent(comment.position.x)}, ${percent(comment.position.y)})${comment.region ? ` · ${describePinBox(comment.region)}` : ""} · id ${comment.id}`,
    `  ${oneLine(comment.note)}`,
  ];
  if (comment.latestReply) lines.push(`  ${latestLine(comment.latestReply)}`);
  return lines.join("\n");
}

export function threadLine(message: ThreadMessage) {
  const status = message.status ? ` -> ${statusLabel(message.status)}` : "";
  return `${roleLabel(message.role)} (${message.author || "unknown"}, ${message.at ?? ""})${status}: ${message.note ?? ""}`;
}

export function pickProject(projects: PublicProject[], id?: string) {
  const ids = projects.map((item) => item.id).join(", ");
  if (id) {
    const project = projects.find((item) => item.id === id);
    if (!project)
      throw new ToolError(`Unknown project "${id}". Projects: ${ids}.`);
    return project;
  }
  if (projects.length === 1) return projects[0]!;
  throw new ToolError(
    projects.length === 0
      ? "No projects are registered."
      : `Several projects are registered; pass project (one of ${ids}).`,
  );
}

export function pickVersion(project: PublicProject, version?: string) {
  if (!version) return undefined;
  if (!project.versions.includes(version)) {
    throw new ToolError(
      `Project ${project.id} has no version "${version}". Versions: ${project.versions.join(", ")}.`,
    );
  }
  return version;
}

// Matches a screen by id, then by its number in the index, then by title.
export function pickScreen(project: PublicProject, value?: string) {
  if (!value) return undefined;
  const wanted = value.trim();
  const screen =
    project.screens.find((item) => item.id === wanted) ??
    (/^\d+$/.test(wanted)
      ? project.screens.find((item) => item.ordinal === Number(wanted))
      : undefined) ??
    project.screens.find(
      (item) => item.title.toLowerCase() === wanted.toLowerCase(),
    );
  if (!screen) {
    throw new ToolError(
      `Project ${project.id} has no screen "${value}". Screens: ${project.screens.map((item) => item.id).join(", ")}.`,
    );
  }
  return screen;
}

export function compareComments(project: PublicProject | null) {
  const versionIndex = (version: string) => {
    const index = project?.versions.indexOf(version) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return (left: Comment, right: Comment) =>
    versionIndex(left.version) - versionIndex(right.version) ||
    (left.screen.ordinal ?? Number.MAX_SAFE_INTEGER) -
      (right.screen.ordinal ?? Number.MAX_SAFE_INTEGER) ||
    left.screen.id.localeCompare(right.screen.id) ||
    left.pin - right.pin;
}

export function parseStatuses(value: string | undefined) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(toApiStatus)
    : undefined;
}

export type CommentFilter = {
  version?: string;
  screenId?: string;
  statuses?: string[];
  tag?: string;
  includeClosed?: boolean;
};

// Open comments (Backlog, In progress) by default; `statuses` overrides that.
export function matchesFilter(item: ApiFeedback, filter: CommentFilter) {
  const tag = filter.tag?.trim().toLowerCase();
  return (
    (!filter.version || item.version === filter.version) &&
    (!filter.screenId || item.screenId === filter.screenId) &&
    (filter.statuses
      ? filter.statuses.includes(item.status)
      : filter.includeClosed || isOpenStatus(item.status)) &&
    (!tag || item.tags.some((value) => value.toLowerCase() === tag))
  );
}
