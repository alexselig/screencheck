// AI assist through the reviewer's own GitHub Copilot CLI, the way
// CopilotBridge does it (github.com/alexselig_microsoft/CopilotBridge): one
// non-interactive `copilot -p …` run per request, tool-less, with a timeout.
// No API keys and no bill; a missing or logged-out CLI is a normal state that
// simply hides the assist UI. Off unless `serve --assist` or
// SCREENCHECK_ASSIST=1.
import { spawn as spawnChild } from "node:child_process";

import { createPinNumbers } from "../shared/export";
import {
  PRIORITY_TAGS,
  STATUS_LABELS,
  type FeedbackRecord,
  type PriorityTag,
} from "../shared/feedback";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_SUMMARY_COMMENTS = 300;

export type SpawnResult = { exitCode: number; stdout: string; stderr: string };

// Injectable so tests never start the real CLI. Abort `signal` to stop it.
export type Spawner = (
  bin: string,
  args: string[],
  options: { signal: AbortSignal },
) => Promise<SpawnResult>;

export type AssistErrorCode =
  "ASSIST_UNAVAILABLE" | "ASSIST_TIMEOUT" | "ASSIST_FAILED";

export class AssistError extends Error {
  constructor(
    message: string,
    readonly code: AssistErrorCode,
  ) {
    super(message);
    this.name = "AssistError";
  }
}

export type AssistStatus = {
  available: boolean;
  version?: string;
  error?: string;
};

export type Suggestion = { priority: PriorityTag | null; tags: string[] };

export function assistEnabledFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SCREENCHECK_ASSIST?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// CopilotBridge's buildArgs with tools off: the prompt is one argv entry (no
// shell), and `--available-tools=` with an empty value makes the CLI text-only
// so it cannot read files, edit them or run commands.
export function buildCopilotArgs(prompt: string) {
  return [
    "-p",
    prompt,
    "--silent",
    "--no-color",
    "--log-level",
    "none",
    "--available-tools=",
  ];
}

export const spawnCopilot: Spawner = (bin, args, { signal }) =>
  new Promise((resolve, reject) => {
    const child = spawnChild(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      signal.removeEventListener("abort", onAbort);
      if (killTimer && exitCode !== null) clearTimeout(killTimer);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });

function missingCli(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

// Strips a ```json fence, then falls back to the first {...} in the answer.
function parseJsonLoose(text: string): unknown {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) body = fence[1]!.trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export function parseSuggestion(text: string): Suggestion | null {
  const parsed = parseJsonLoose(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const { priority, tags } = parsed as { priority?: unknown; tags?: unknown };
  const upper = typeof priority === "string" ? priority.toUpperCase() : "";
  const isPriority = (value: string) =>
    (PRIORITY_TAGS as readonly string[]).includes(value.toUpperCase());
  const cleanTags = Array.isArray(tags)
    ? tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag && tag.length <= 32 && !isPriority(tag))
        .slice(0, 5)
    : [];
  return {
    priority: isPriority(upper) ? (upper as PriorityTag) : null,
    tags: cleanTags,
  };
}

const STOP_WORDS = new Set(
  "a an and are as at be but by can for from has have i in is it its of on or so that the this to too too very was we with".split(
    " ",
  ),
);

function words(note: string) {
  return new Set(
    note
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && !STOP_WORDS.has(word))
      .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word)),
  );
}

// Dice coefficient over content words: cheap, local and good enough to flag
// "you said this already" without a model call.
export function similarity(left: string, right: string) {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export const DUPLICATE_THRESHOLD = 0.5;

export function findDuplicates(
  feedback: readonly FeedbackRecord[],
  target: {
    version: string;
    screenId: string;
    note: string;
    excludeId?: string;
  },
) {
  if (words(target.note).size < 2) return [];
  return feedback
    .filter(
      (item) =>
        item.version === target.version &&
        item.screenId === target.screenId &&
        item.id !== target.excludeId,
    )
    .map((item) => ({ id: item.id, score: similarity(target.note, item.note) }))
    .filter((item) => item.score >= DUPLICATE_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
}

const REWRITE_PROMPT = `You help a design reviewer write feedback that a coding agent can act on.
Rewrite the reviewer's note below as one clear, specific, actionable instruction for the agent: say what to change and what "done" looks like. Keep the reviewer's intent and any concrete details (names, numbers, @mentions). Do not invent facts about the design. Reply with ONLY the rewritten instruction as plain text, at most three sentences, no preamble and no quotes.`;

const SUGGEST_PROMPT = `You triage design-review feedback.
Pick a priority for the note below: "P0" (blocks release: broken, unreadable, inaccessible, wrong data), "P1" (should fix this round) or "P2" (polish). Suggest up to three short topic tags (1-2 words each, e.g. "Contrast", "Copy", "Spacing", "Layout", "Accessibility").
Reply with ONLY JSON of the form {"priority":"P1","tags":["Copy"]} — no prose, no explanation, no markdown code fences.`;

const SUMMARY_PROMPT = `You summarise a design-review round for the team.
Write a short markdown summary of the comments below: an opening line with the counts, then the main themes as bullets (cite pins as "#N on <screen>"), the P0s to fix first, and what is fixed and waiting for the reviewer to verify. Use only what the comments say. Reply with ONLY the markdown.`;

function quote(note: string) {
  return `"""\n${note.replaceAll('"""', '"')}\n"""`;
}

export type AssistOptions = {
  bin?: string;
  spawn?: Spawner;
  timeoutMs?: number;
  probeTimeoutMs?: number;
};

export function createAssist({
  bin = process.env.COPILOT_BIN || "copilot",
  spawn = spawnCopilot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
}: AssistOptions = {}) {
  // Rejects with an AssistError; the child is aborted on timeout.
  async function exec(args: string[], limitMs: number) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AssistError(
            `Copilot CLI timed out after ${Math.round(limitMs / 1000)}s.`,
            "ASSIST_TIMEOUT",
          ),
        );
      }, limitMs);
    });
    try {
      return await Promise.race([
        spawn(bin, args, { signal: controller.signal }).catch(
          (error: unknown) => {
            throw new AssistError(
              missingCli(error)
                ? `Copilot CLI not found ("${bin}").`
                : `Could not run the Copilot CLI: ${(error as Error)?.message ?? error}`,
              "ASSIST_UNAVAILABLE",
            );
          },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(prompt: string) {
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new AssistError(
        "Too much text for one assist request.",
        "ASSIST_FAILED",
      );
    }
    const { exitCode, stdout, stderr } = await exec(
      buildCopilotArgs(prompt),
      timeoutMs,
    );
    if (exitCode !== 0) {
      throw new AssistError(
        `Copilot CLI exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 400)}`,
        "ASSIST_FAILED",
      );
    }
    return stdout.trim();
  }

  let cached: { at: number; status: AssistStatus } | null = null;

  return {
    // A cheap `copilot --version` probe. Never throws. A good answer is kept
    // for the server's life; a bad one is retried after 30s so installing or
    // logging in the CLI takes effect without a restart.
    async available(): Promise<AssistStatus> {
      if (
        cached &&
        (cached.status.available || Date.now() - cached.at < 30_000)
      ) {
        return cached.status;
      }
      let status: AssistStatus;
      try {
        const { exitCode, stdout, stderr } = await exec(
          ["--version"],
          probeTimeoutMs,
        );
        status =
          exitCode === 0
            ? {
                available: true,
                version: (stdout || stderr).trim().split("\n")[0] || undefined,
              }
            : {
                available: false,
                error: (stderr || stdout || `exited ${exitCode}`)
                  .trim()
                  .slice(0, 200),
              };
      } catch (error) {
        status = {
          available: false,
          error: error instanceof Error ? error.message : "unavailable",
        };
      }
      cached = { at: Date.now(), status };
      return status;
    },

    async rewrite(note: string) {
      return run(`${REWRITE_PROMPT}\n\nReviewer's note:\n${quote(note)}`);
    },

    async suggest(note: string): Promise<Suggestion> {
      const answer = await run(`${SUGGEST_PROMPT}\n\nNote:\n${quote(note)}`);
      const suggestion = parseSuggestion(answer);
      if (!suggestion) {
        throw new AssistError(
          "Copilot did not return a tag suggestion.",
          "ASSIST_FAILED",
        );
      }
      return suggestion;
    },

    async summary({
      projectId,
      version,
      feedback,
    }: {
      projectId: string;
      version: string;
      feedback: readonly FeedbackRecord[];
    }) {
      const round = feedback.filter((item) => item.version === version);
      const numbers = createPinNumbers(round);
      const lines = round
        .slice(0, MAX_SUMMARY_COMMENTS)
        .map((item) =>
          [
            `- #${numbers.get(item.id) ?? 0} on ${item.screenId}`,
            `[${STATUS_LABELS[item.status]}]`,
            item.tags.length ? `[${item.tags.join(", ")}]` : "",
            item.note.replace(/\s+/g, " ").slice(0, 500),
          ]
            .filter(Boolean)
            .join(" "),
        );
      const body = lines.length ? lines.join("\n") : "(no comments)";
      return run(
        `${SUMMARY_PROMPT}\n\nProject ${projectId}, version ${version}, ${round.length} comment${round.length === 1 ? "" : "s"}:\n${body}`,
      );
    },
  };
}

export type AssistService = ReturnType<typeof createAssist>;
