import { z } from "zod";

// Priority lives in tags: suggested P0-P2, plus any free-text tag.
export const PRIORITY_TAGS = ["P0", "P1", "P2"] as const;
export type PriorityTag = (typeof PRIORITY_TAGS)[number];

const LEGACY_PRIORITY_TAGS: Record<string, PriorityTag> = {
  BLOCKING: "P0",
  IMPORTANT: "P1",
  POLISH: "P2",
};

export const FEEDBACK_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "VERIFIED",
  "WONT_FIX",
] as const;

export const feedbackTagSchema = z.string().trim().min(1).max(32);
export const feedbackTagsSchema = z
  .array(feedbackTagSchema)
  .max(12)
  .transform(normalizeTags);
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);

// One vocabulary for the status picker, the pane sections and exports.
export const STATUS_LABELS: Record<(typeof FEEDBACK_STATUSES)[number], string> =
  {
    OPEN: "Backlog",
    IN_PROGRESS: "In progress",
    RESOLVED: "Fixed",
    VERIFIED: "Verified",
    WONT_FIX: "Won't fix",
  };
export const REPLY_MAX_LENGTH = 2000;
export const THREAD_MAX_MESSAGES = 500;

// Only a person sets Verified. The browser client sends this header on every
// mutation; agents, scripts and the MCP server do not.
export const ACTOR_HEADER = "x-screencheck-actor";
export const REVIEWER_ACTOR = "reviewer";

// The fixer's answer to a comment (usually an agent): what was done, or why not.
export const replyInputSchema = z.object({
  note: z.string().trim().min(1).max(REPLY_MAX_LENGTH),
  author: z.string().trim().min(1).max(64).optional().default("Agent"),
});
export const feedbackReplySchema = z.object({
  note: z.string().trim().min(1).max(REPLY_MAX_LENGTH),
  author: z.string().trim().min(1).max(64),
  at: z.iso.datetime(),
});

export const MESSAGE_ROLES = ["reviewer", "agent"] as const;
export const messageRoleSchema = z.enum(MESSAGE_ROLES);

// One entry in a comment's conversation. `status` is the status change the
// message was sent with, if any. Loose, like the record: fields a newer build
// added survive a rewrite by this one.
export const feedbackMessageSchema = z.looseObject({
  id: z.string().min(1),
  author: z.string().trim().min(1).max(64),
  role: messageRoleSchema,
  note: z.string().trim().min(1).max(REPLY_MAX_LENGTH),
  at: z.iso.datetime(),
  status: feedbackStatusSchema.optional(),
});

// A message posted through the API; the server stamps `id` and `at`.
export const messageInputSchema = z.object({
  note: z.string().trim().min(1).max(REPLY_MAX_LENGTH),
  author: z.string().trim().min(1).max(64).optional(),
  role: messageRoleSchema.optional().default("reviewer"),
});

// The id given to a pre-thread `reply` when it becomes the first message.
export const LEGACY_REPLY_MESSAGE_ID = "legacy-reply";

export const normalizedCoordinateSchema = z.number().finite().min(0).max(1);

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const upper = tag.toUpperCase();
    const value = (PRIORITY_TAGS as readonly string[]).includes(upper)
      ? upper
      : tag;
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    result.push(value);
  }
  return result;
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

// Records saved before tags existed carry `priority` and `category`; read them
// as tags so nothing on disk has to be rewritten up front.
export function migrateLegacyTags(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tags)) return record;
  const { priority, category, ...rest } = record;
  const tags: string[] = [];
  if (typeof priority === "string" && LEGACY_PRIORITY_TAGS[priority]) {
    tags.push(LEGACY_PRIORITY_TAGS[priority]);
  }
  if (typeof category === "string" && category) tags.push(titleCase(category));
  return { ...rest, tags };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Records saved before threads existed carry a single `reply`; read it as the
// first (agent) message so nothing on disk has to be rewritten up front.
export function migrateLegacyThread(value: unknown): unknown {
  if (!isRecordObject(value) || Array.isArray(value.thread)) return value;
  const reply = value.reply;
  const thread = isRecordObject(reply)
    ? [
        {
          id: LEGACY_REPLY_MESSAGE_ID,
          role: "agent",
          author: reply.author,
          note: reply.note,
          at: reply.at,
        },
      ]
    : [];
  return { ...value, thread };
}

function migrateLegacyRecord(value: unknown): unknown {
  return migrateLegacyThread(migrateLegacyTags(value));
}

// The on-disk record. Unknown keys pass through, so a field added by a newer
// build (a box pin, a viewport, an anchor) survives when this build rewrites
// the file. API input schemas stay strict.
const feedbackRecordObjectSchema = z.looseObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  screenId: z.string().min(1),
  version: z.string().min(1),
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
  note: z.string().trim().min(1),
  tags: feedbackTagsSchema,
  status: feedbackStatusSchema,
  // Derived from `thread` (the latest agent message) for older clients.
  reply: feedbackReplySchema.optional(),
  // Optional in the type so hand-built records stay valid; parsing always
  // fills it. Read it through `feedbackThread`.
  thread: z.array(feedbackMessageSchema).max(THREAD_MAX_MESSAGES).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const feedbackRecordSchema = z.preprocess(
  migrateLegacyRecord,
  feedbackRecordObjectSchema.transform(withDerivedReply),
);

export const createFeedbackInputSchema = z.object({
  clientMutationId: z.uuid(),
  screenId: z.string().min(1),
  version: z.string().min(1),
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
  note: z.string().trim().min(1),
  tags: feedbackTagsSchema.optional().default([]),
  status: feedbackStatusSchema.optional().default("OPEN"),
});

export const feedbackPatchSchema = z
  .object({
    note: z.string().trim().min(1).optional(),
    tags: feedbackTagsSchema.optional(),
    status: feedbackStatusSchema.optional(),
    // Appends an agent message; null removes the latest agent message.
    reply: replyInputSchema.nullable().optional(),
    // Appends a message (reviewer unless `role` says otherwise).
    message: messageInputSchema.optional(),
  })
  .superRefine((patch, context) => {
    if (patch.reply !== undefined && patch.message !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Send either reply or message, not both.",
      });
    }
    if (
      (patch.status === "RESOLVED" || patch.status === "WONT_FIX") &&
      !patch.reply &&
      !patch.message
    ) {
      context.addIssue({
        code: "custom",
        path: ["reply"],
        message: "A change summary is required when closing feedback.",
      });
    }
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Feedback update must change at least one field.",
  });

export const updateFeedbackInputSchema = z.object({
  expectedUpdatedAt: z.iso.datetime(),
  patch: feedbackPatchSchema,
});

export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;
export type CreateFeedbackInput = z.input<typeof createFeedbackInputSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackInputSchema>;
export type FeedbackReply = z.infer<typeof feedbackReplySchema>;
export type FeedbackPatch = z.infer<typeof feedbackPatchSchema>;
export type FeedbackMessage = z.infer<typeof feedbackMessageSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;

export type FrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function normalizePinCoordinates(
  clientX: number,
  clientY: number,
  frame: FrameRect,
): { x: number; y: number } {
  if (frame.width <= 0 || frame.height <= 0) {
    throw new Error("Feedback frame must have a positive size.");
  }
  const x = (clientX - frame.left) / frame.width;
  const y = (clientY - frame.top) / frame.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error("Feedback pins must be placed inside the review frame.");
  }
  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
  };
}

export function priorityTag(tags: readonly string[]): PriorityTag | null {
  for (const priority of PRIORITY_TAGS) {
    if (tags.includes(priority)) return priority;
  }
  return null;
}

type ThreadSource = {
  reply?: FeedbackReply;
  thread?: FeedbackMessage[];
};

// The conversation on a comment, oldest first. Hand-built records that only
// carry a `reply` read as a one-message thread.
export function feedbackThread(record: ThreadSource): FeedbackMessage[] {
  if (record.thread) return record.thread;
  return record.reply
    ? [
        {
          id: LEGACY_REPLY_MESSAGE_ID,
          role: "agent",
          author: record.reply.author,
          note: record.reply.note,
          at: record.reply.at,
        },
      ]
    : [];
}

// The latest agent message, in the shape of the pre-thread `reply` field.
export function latestAgentReply(
  thread: readonly FeedbackMessage[],
): FeedbackReply | undefined {
  for (let index = thread.length - 1; index >= 0; index -= 1) {
    const message = thread[index]!;
    if (message.role === "agent") {
      return { note: message.note, author: message.author, at: message.at };
    }
  }
  return undefined;
}

function withDerivedReply<
  T extends { reply?: FeedbackReply; thread?: FeedbackMessage[] },
>(record: T): T {
  const thread = record.thread ?? [];
  const { reply: _stale, ...rest } = record;
  const reply = latestAgentReply(thread);
  return { ...rest, thread, ...(reply ? { reply } : {}) } as T;
}

export function isOpenFeedback(feedback: FeedbackRecord): boolean {
  return feedback.status === "OPEN" || feedback.status === "IN_PROGRESS";
}
