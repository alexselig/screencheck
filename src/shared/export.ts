import {
  describeElement,
  elementMapKey,
  resolvePinElement,
  type ElementMap,
  type MappedElement,
} from "./elements";
import {
  STATUS_LABELS,
  feedbackThread,
  type FeedbackMessage,
  type FeedbackRecord,
} from "./feedback";
import type { ReviewScreen } from "./manifest";

export type FeedbackExportInput = {
  projectId: string;
  screens: ReviewScreen[];
  feedback: FeedbackRecord[];
  // Full record set used for pin numbers, so filtered exports keep the same
  // numbers the reviewer sees on screen. Defaults to `feedback`.
  allFeedback?: FeedbackRecord[];
  // Human-readable description of what the export covers.
  scope?: string;
  // Element maps keyed "version/screenId"; comments then name the element
  // under their pin.
  elements?: Record<string, ElementMap>;
  // Versions in review order, with display labels. When given and the
  // feedback spans more than one, Markdown groups it under a heading per
  // version.
  versions?: { id: string; label: string }[];
};

type ExportFeedback = FeedbackRecord & {
  thread: FeedbackMessage[];
  screenOrdinal: number | null;
  screenTitle: string;
  screenDescription: string | null;
  pinNumber: number;
  element?: MappedElement & { description: string };
};

function feedbackGroupKey(item: FeedbackRecord) {
  return `${item.version}\0${item.screenId}`;
}

function comparePinOrder(left: FeedbackRecord, right: FeedbackRecord) {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function createPinNumbers(feedback: FeedbackRecord[]) {
  const grouped = new Map<string, FeedbackRecord[]>();
  for (const item of feedback) {
    const key = feedbackGroupKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const pinNumbers = new Map<string, number>();
  for (const records of grouped.values()) {
    records
      .sort(comparePinOrder)
      .forEach((item, index) => pinNumbers.set(item.id, index + 1));
  }
  return pinNumbers;
}

function pinElement(input: FeedbackExportInput, item: FeedbackRecord) {
  const map = input.elements?.[elementMapKey(item.version, item.screenId)];
  const element = resolvePinElement(map, item);
  return element
    ? { element: { ...element, description: describeElement(element) } }
    : {};
}

function safeFeedback(input: FeedbackExportInput): ExportFeedback[] {
  const screenById = new Map(
    input.screens.map((screen) => [screen.id, screen]),
  );
  const pinNumbers = createPinNumbers(input.allFeedback ?? input.feedback);
  const versionOrder = new Map(
    (input.versions ?? []).map((version, index) => [version.id, index]),
  );
  const versionRank = (id: string) =>
    versionOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  return input.feedback
    .map((item) => {
      const screen = screenById.get(item.screenId);
      return {
        ...item,
        thread: feedbackThread(item),
        screenOrdinal: screen?.ordinal ?? null,
        screenTitle: screen?.title ?? item.screenId,
        screenDescription: screen?.description ?? null,
        pinNumber: pinNumbers.get(item.id) ?? 0,
        ...pinElement(input, item),
      };
    })
    .sort(
      (left, right) =>
        versionRank(left.version) - versionRank(right.version) ||
        (left.screenOrdinal ?? Number.MAX_SAFE_INTEGER) -
          (right.screenOrdinal ?? Number.MAX_SAFE_INTEGER) ||
        left.screenId.localeCompare(right.screenId) ||
        left.pinNumber - right.pinNumber ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export function serializeJson(input: FeedbackExportInput): string {
  return `${JSON.stringify(
    {
      projectId: input.projectId,
      ...(input.scope ? { scope: input.scope } : {}),
      feedback: safeFeedback(input),
    },
    null,
    2,
  )}\n`;
}

function escapeMarkdown(value: string) {
  return value
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/([\\`*_[\]{}()#+\-!|>])/g, "\\$1")
    .replace(/\r\n?|\n/g, "<br>");
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

// One line per message, oldest first: "Reply" for the agent, "Reviewer" for
// the person, then the status change the message made, if any.
function threadLine(message: FeedbackMessage) {
  const who = message.role === "agent" ? "Reply" : "Reviewer";
  const status = message.status ? ` → ${STATUS_LABELS[message.status]}` : "";
  return `  - ${who} (${escapeMarkdown(message.author)}, ${message.at.slice(0, 16).replace("T", " ")} UTC)${status}: ${escapeMarkdown(message.note)}`;
}

export function serializeMarkdown(input: FeedbackExportInput): string {
  const records = safeFeedback(input);
  const lines = [
    `# ${escapeMarkdown(input.projectId)} Screen Review Feedback`,
    "",
    ...(input.scope ? [`_Scope: ${escapeMarkdown(input.scope)}_`, ""] : []),
  ];
  let currentScreen = "";
  let currentVersion = "";
  const byVersion =
    Boolean(input.versions) &&
    new Set(records.map((item) => item.version)).size > 1;
  const versionLabel = (id: string) =>
    input.versions?.find((version) => version.id === id)?.label ?? id;
  const screenLevel = byVersion ? "###" : "##";

  for (const item of records) {
    if (byVersion && item.version !== currentVersion) {
      if (currentVersion) lines.push("");
      lines.push(
        `## Version ${escapeMarkdown(versionLabel(item.version))}`,
        "",
      );
      currentVersion = item.version;
      currentScreen = "";
    }
    const screenKey = `${item.screenOrdinal ?? "?"}:${item.screenId}`;
    if (screenKey !== currentScreen) {
      if (currentScreen) lines.push("");
      lines.push(
        `${screenLevel} ${item.screenOrdinal === null ? "—" : String(item.screenOrdinal).padStart(2, "0")} · ${escapeMarkdown(item.screenTitle)}`,
        ...(item.screenDescription
          ? [`_Screen: ${escapeMarkdown(item.screenDescription)}_`]
          : []),
        "",
      );
      currentScreen = screenKey;
    }
    const checked =
      item.status === "RESOLVED" ||
      item.status === "VERIFIED" ||
      item.status === "WONT_FIX"
        ? "x"
        : " ";
    lines.push(
      `- [${checked}] **Pin ${item.pinNumber}${item.tags.length ? ` · ${item.tags.join(", ")}` : ""} · ${STATUS_LABELS[item.status]}** (${percent(item.x)}, ${percent(item.y)}): ${escapeMarkdown(item.note)} \`id: ${item.id.replace(/`/g, "")}\``,
      ...(item.element
        ? [`  - Element: ${escapeMarkdown(item.element.description)}`]
        : []),
      ...item.thread.map(threadLine),
    );
  }

  if (records.length === 0) {
    lines.push("No feedback matches the selected filters.");
  }
  return `${lines.join("\n")}\n`;
}
