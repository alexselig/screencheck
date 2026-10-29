import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  createFeedbackInputSchema,
  feedbackRecordSchema,
  feedbackThread,
  isOpenFeedback,
  scopeOf,
  updateFeedbackInputSchema,
  type CreateFeedbackInput,
  type FeedbackMessage,
  type FeedbackRecord,
  type UpdateFeedbackInput,
} from "../shared/feedback";
import {
  screenApprovalSchema,
  setApprovalInputSchema,
  type ScreenApproval,
  type SetApprovalInput,
} from "../shared/approvals";
import {
  screenCaptionSchema,
  setCaptionInputSchema,
  type ScreenCaption,
  type SetCaptionInput,
} from "../shared/captions";
import type { PinBox } from "../shared/pin-box";
import type { PinElement } from "../shared/reanchor";
import {
  setSuggestionDismissalInputSchema,
  suggestionDismissalSchema,
  type SetSuggestionDismissalInput,
  type SuggestionDismissal,
} from "../shared/a11y";
import { formatZodError } from "../shared/zod-format";

// One comment carried from `from` to `to`, already re-anchored.
export type CarryMove = {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
  box?: PinBox;
  element?: PinElement;
  checkPlacement: boolean;
};

// The shape of feedback records on disk. v1 files (no `schemaVersion`) hold a
// single `reply` per comment; v2 holds `thread`. Older files are migrated in
// memory on read and only rewritten by the next mutation. `version` stays 1 so
// older builds can still read the envelope.
//
// Additive fields don't bump the schema version: records and thread messages
// are parsed loosely, so an older build keeps fields it doesn't know. Bump it
// only when an existing field changes meaning.
export const FEEDBACK_SCHEMA_VERSION = 2;

const feedbackEnvelopeSchema = z.object({
  version: z.literal(1),
  schemaVersion: z.number().int().min(1).optional(),
  feedback: z.array(feedbackRecordSchema),
});

// Records are validated one at a time, so one bad record never hides the rest.
const rawFeedbackEnvelopeSchema = z.object({
  version: z.literal(1),
  schemaVersion: z.number().int().min(1).optional(),
  feedback: z.array(z.unknown()),
});

export const STORE_FILES = [
  "feedback.json",
  "approvals.json",
  "captions.json",
  "suggestions.json",
] as const;
export type StoreFile = (typeof STORE_FILES)[number];

export const REJECTED_FILE = "feedback.rejected.json";

export function backupPathFor(file: string) {
  return `${file}.bak`;
}

const approvalsEnvelopeSchema = z.object({
  version: z.literal(1),
  approvals: z.array(screenApprovalSchema),
});

const captionsEnvelopeSchema = z.object({
  version: z.literal(1),
  captions: z.array(screenCaptionSchema),
});

// Dismissed (or promoted) accessibility suggestions. A missing file means
// none, so older data needs nothing.
const suggestionsEnvelopeSchema = z.object({
  version: z.literal(1),
  dismissed: z.array(suggestionDismissalSchema),
});

// Approvals live in their own file, so they queue separately from feedback.
function approvalsQueue(projectId: string) {
  return `${projectId}\0approvals`;
}

function captionsQueue(projectId: string) {
  return `${projectId}\0captions`;
}

function suggestionsQueue(projectId: string) {
  return `${projectId}\0suggestions`;
}

type StorageFileSystem = {
  copyFile: typeof copyFile;
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
};

// Errors whose message is safe to show a client: no absolute paths. `file`
// is for the server log.
export class StoreError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export class InvalidProjectIdError extends Error {
  constructor(projectId: string) {
    super(`Invalid project id: ${projectId}`);
    this.name = "InvalidProjectIdError";
  }
}

export type RejectedRecord = {
  index: number;
  id: string | null;
  problem: string;
};

// Some records in feedback.json are invalid. Reads still return the valid
// ones; writes wait until the bad records are repaired or quarantined, so
// nothing is dropped by a rewrite.
export class FeedbackQuarantineError extends Error {
  constructor(
    projectId: string,
    readonly rejected: RejectedRecord[],
  ) {
    super(
      `${rejected.length} record${rejected.length === 1 ? "" : "s"} in ${projectId}/feedback.json ${rejected.length === 1 ? "is" : "are"} invalid (${rejected.map(describeRejected).join("; ")}). Repair ${rejected.length === 1 ? "it" : "them"}, or run \`screencheck doctor ${projectId} --quarantine\` to move ${rejected.length === 1 ? "it" : "them"} to ${REJECTED_FILE}; changes are refused until then.`,
    );
    this.name = "FeedbackQuarantineError";
  }
}

export function describeRejected(item: RejectedRecord) {
  return `feedback[${item.index}]${item.id ? ` (id ${item.id})` : ""}: ${item.problem}`;
}

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// Opening or syncing a directory isn't supported everywhere (Windows refuses
// both); the rename has already happened, so skip the extra durability step.
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EISDIR",
  "EPERM",
  "EACCES",
  "EINVAL",
  "ENOTSUP",
]);

export class FeedbackConflictError extends Error {
  readonly current: FeedbackRecord;

  constructor(message: string, current: FeedbackRecord) {
    super(message);
    this.name = "FeedbackConflictError";
    this.current = current;
  }
}

export class FeedbackNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback not found: ${id}`);
    this.name = "FeedbackNotFoundError";
  }
}

export type FeedbackStorageOptions = {
  dataRoot: string;
  now?: () => Date;
  // Ids for new thread messages; random UUIDs unless a test needs fixed ones.
  newId?: () => string;
  fileSystem?: Partial<StorageFileSystem>;
  platform?: NodeJS.Platform;
};

function assertProjectId(projectId: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(projectId)) {
    throw new InvalidProjectIdError(projectId);
  }
}

function sameCreate(
  record: FeedbackRecord,
  input: z.output<typeof createFeedbackInputSchema>,
) {
  return (
    record.screenId === input.screenId &&
    record.version === input.version &&
    record.x === input.x &&
    record.y === input.y &&
    JSON.stringify(record.box ?? null) === JSON.stringify(input.box ?? null) &&
    record.note === input.note &&
    record.tags.join("\0") === input.tags.join("\0") &&
    record.status === input.status &&
    scopeOf(record) === (input.scope ?? "size")
  );
}

function nextUpdatedAt(now: Date, previous?: string) {
  if (!previous) return now.toISOString();
  const previousTime = new Date(previous).getTime();
  return new Date(Math.max(now.getTime(), previousTime + 1)).toISOString();
}

export function createFeedbackStorage(options: FeedbackStorageOptions) {
  const fileSystem: StorageFileSystem = {
    copyFile,
    mkdir,
    open,
    readFile,
    rename,
    unlink,
    ...options.fileSystem,
  };
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const mutationQueues = new Map<string, Promise<void>>();

  function paths(projectId: string) {
    assertProjectId(projectId);
    const directory = join(options.dataRoot, projectId);
    return {
      directory,
      current: join(directory, "feedback.json"),
    };
  }

  async function exists(file: string) {
    try {
      await fileSystem.readFile(file);
      return true;
    } catch {
      return false;
    }
  }

  async function damaged(
    projectId: string,
    file: string,
    fileName: string,
    detail: string,
  ) {
    const backup = (await exists(backupPathFor(file)))
      ? ` A backup of the last good version is in ${fileName}.bak; restore it with \`screencheck doctor ${projectId} --restore\`, or repair the file.`
      : " Restore or repair it.";
    return new StoreError(
      `${fileName} in project "${projectId}" ${detail}.${backup}`,
      file,
    );
  }

  // Valid records plus any that failed validation, each with its index, id
  // and the first problem Zod found.
  async function readState(projectId: string): Promise<{
    feedback: FeedbackRecord[];
    rejected: RejectedRecord[];
    raw: unknown[];
  }> {
    const { current } = paths(projectId);
    let contents: string;
    try {
      contents = await fileSystem.readFile(current, "utf8");
    } catch (error) {
      if (isMissing(error)) return { feedback: [], rejected: [], raw: [] };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw await damaged(
        projectId,
        current,
        "feedback.json",
        "contains invalid JSON",
      );
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "schemaVersion" in parsed &&
      typeof parsed.schemaVersion === "number" &&
      parsed.schemaVersion > FEEDBACK_SCHEMA_VERSION
    ) {
      throw new StoreError(
        `feedback.json in project "${projectId}" was written by a newer ScreenCheck (schema ${parsed.schemaVersion}); update ScreenCheck to read it.`,
        current,
      );
    }
    const envelope = rawFeedbackEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw await damaged(
        projectId,
        current,
        "feedback.json",
        `contains invalid feedback data (${formatZodError(envelope.error)})`,
      );
    }
    const feedback: FeedbackRecord[] = [];
    const rejected: RejectedRecord[] = [];
    envelope.data.feedback.forEach((raw, index) => {
      const result = feedbackRecordSchema.safeParse(raw);
      if (result.success) {
        feedback.push(result.data);
        return;
      }
      const id =
        typeof raw === "object" &&
        raw !== null &&
        "id" in raw &&
        typeof raw.id === "string"
          ? raw.id
          : null;
      rejected.push({
        index,
        id,
        problem: formatZodError(
          new z.ZodError(result.error.issues.slice(0, 1)),
        ),
      });
    });
    return { feedback, rejected, raw: envelope.data.feedback };
  }

  // For mutations: every record must be valid, or the rewrite would drop
  // the invalid ones.
  async function read(projectId: string): Promise<FeedbackRecord[]> {
    const { feedback, rejected } = await readState(projectId);
    if (rejected.length) throw new FeedbackQuarantineError(projectId, rejected);
    return feedback;
  }

  async function syncAndClose(handle: FileHandle) {
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function write(projectId: string, feedback: FeedbackRecord[]) {
    const envelope = feedbackEnvelopeSchema.parse({
      version: 1,
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      feedback,
    });
    await writeAtomically(projectId, "feedback.json", envelope);
  }

  async function syncDirectory(directory: string) {
    if (platform === "win32") return;
    let handle: FileHandle;
    try {
      handle = await fileSystem.open(directory, "r");
    } catch (error) {
      if (
        DIRECTORY_SYNC_UNSUPPORTED.has(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      throw error;
    }
    try {
      await syncAndClose(handle);
    } catch (error) {
      if (
        DIRECTORY_SYNC_UNSUPPORTED.has(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return;
      throw error;
    }
  }

  // Writes a unique temp file (so two processes can never interleave into
  // one), keeps the previous version as `<name>.bak`, then renames into place.
  async function writeAtomically(
    projectId: string,
    fileName: string,
    data: unknown,
  ) {
    const { directory } = paths(projectId);
    const current = join(directory, fileName);
    const next = `${current}.${process.pid}.${randomUUID()}.next`;
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await fileSystem.open(next, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await syncAndClose(handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fileSystem.unlink(next).catch(() => undefined);
      throw error;
    }
    try {
      await fileSystem.copyFile(current, backupPathFor(current));
    } catch (error) {
      if (!isMissing(error)) {
        await fileSystem.unlink(next).catch(() => undefined);
        throw error;
      }
    }
    try {
      await fileSystem.rename(next, current);
    } catch (error) {
      await fileSystem.unlink(next).catch(() => undefined);
      throw error;
    }
    await syncDirectory(directory);
  }

  async function readEnvelope<T>(
    projectId: string,
    fileName: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T | null> {
    const file = join(paths(projectId).directory, fileName);
    let contents: string;
    try {
      contents = await fileSystem.readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw await damaged(projectId, file, fileName, "contains invalid JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw await damaged(
        projectId,
        file,
        fileName,
        `contains invalid ${label} data (${formatZodError(result.error)})`,
      );
    }
    return result.data;
  }

  async function readApprovals(projectId: string): Promise<ScreenApproval[]> {
    const envelope = await readEnvelope(
      projectId,
      "approvals.json",
      approvalsEnvelopeSchema,
      "approval",
    );
    return envelope?.approvals ?? [];
  }

  async function readCaptions(projectId: string): Promise<ScreenCaption[]> {
    const envelope = await readEnvelope(
      projectId,
      "captions.json",
      captionsEnvelopeSchema,
      "caption",
    );
    return envelope?.captions ?? [];
  }

  async function listCaptions(projectId: string) {
    await afterPendingMutation(captionsQueue(projectId));
    return readCaptions(projectId);
  }

  function setCaption(
    projectId: string,
    rawInput: SetCaptionInput,
  ): Promise<ScreenCaption[]> {
    return serializeMutation(captionsQueue(projectId), async () => {
      const input = setCaptionInputSchema.parse(rawInput);
      const captions = await readCaptions(projectId);
      const others = captions.filter(
        (item) =>
          item.version !== input.version || item.screenId !== input.screenId,
      );
      const current = captions.find((item) => !others.includes(item));
      if ((current?.text ?? "") === input.text) return captions;
      const next = input.text
        ? [
            ...others,
            {
              version: input.version,
              screenId: input.screenId,
              text: input.text,
              updatedAt: now().toISOString(),
            },
          ]
        : others;
      await writeAtomically(
        projectId,
        "captions.json",
        captionsEnvelopeSchema.parse({ version: 1, captions: next }),
      );
      return next;
    });
  }

  async function readDismissals(
    projectId: string,
  ): Promise<SuggestionDismissal[]> {
    const envelope = await readEnvelope(
      projectId,
      "suggestions.json",
      suggestionsEnvelopeSchema,
      "suggestion",
    );
    return envelope?.dismissed ?? [];
  }

  async function listDismissedSuggestions(projectId: string) {
    await afterPendingMutation(suggestionsQueue(projectId));
    return readDismissals(projectId);
  }

  function setSuggestionDismissal(
    projectId: string,
    rawInput: SetSuggestionDismissalInput,
  ): Promise<SuggestionDismissal[]> {
    return serializeMutation(suggestionsQueue(projectId), async () => {
      const input = setSuggestionDismissalInputSchema.parse(rawInput);
      const dismissed = await readDismissals(projectId);
      const others = dismissed.filter(
        (item) =>
          item.version !== input.version ||
          item.screenId !== input.screenId ||
          item.suggestionId !== input.suggestionId,
      );
      const current = dismissed.find((item) => !others.includes(item));
      if (
        input.dismissed
          ? current && current.feedbackId === input.feedbackId
          : !current
      ) {
        return dismissed;
      }
      const next = input.dismissed
        ? [
            ...others,
            {
              version: input.version,
              screenId: input.screenId,
              suggestionId: input.suggestionId,
              ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}),
              dismissedAt: now().toISOString(),
            },
          ]
        : others;
      await writeAtomically(
        projectId,
        "suggestions.json",
        suggestionsEnvelopeSchema.parse({ version: 1, dismissed: next }),
      );
      return next;
    });
  }

  async function listApprovals(projectId: string) {
    await afterPendingMutation(approvalsQueue(projectId));
    return readApprovals(projectId);
  }

  function setApproval(
    projectId: string,
    rawInput: SetApprovalInput,
  ): Promise<ScreenApproval[]> {
    return serializeMutation(approvalsQueue(projectId), async () => {
      const input = setApprovalInputSchema.parse(rawInput);
      const approvals = await readApprovals(projectId);
      const others = approvals.filter(
        (item) =>
          item.version !== input.version || item.screenId !== input.screenId,
      );
      const already = approvals.find((item) => !others.includes(item));
      if (input.approved === Boolean(already)) return approvals;
      const next = input.approved
        ? [
            ...others,
            {
              version: input.version,
              screenId: input.screenId,
              approvedAt: now().toISOString(),
            },
          ]
        : others;
      await writeAtomically(
        projectId,
        "approvals.json",
        approvalsEnvelopeSchema.parse({ version: 1, approvals: next }),
      );
      return next;
    });
  }

  async function afterPendingMutation(projectId: string) {
    await mutationQueues.get(projectId);
  }

  function serializeMutation<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = mutationQueues.get(projectId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(projectId, tail);
    void tail.finally(() => {
      if (mutationQueues.get(projectId) === tail) {
        mutationQueues.delete(projectId);
      }
    });
    return result;
  }

  async function listFeedback(projectId: string) {
    await afterPendingMutation(projectId);
    return (await readState(projectId)).feedback;
  }

  // The valid records plus a line for each record that failed validation.
  async function inspectFeedback(projectId: string) {
    await afterPendingMutation(projectId);
    const { feedback, rejected } = await readState(projectId);
    return { feedback, rejected };
  }

  // Moves invalid records into feedback.rejected.json (appending, with the
  // reason and time) and keeps the valid ones in feedback.json.
  function quarantineFeedback(projectId: string): Promise<RejectedRecord[]> {
    return serializeMutation(projectId, async () => {
      const { feedback, rejected, raw } = await readState(projectId);
      if (!rejected.length) return [];
      const file = join(paths(projectId).directory, REJECTED_FILE);
      let previous: unknown[] = [];
      try {
        const existing = JSON.parse(await fileSystem.readFile(file, "utf8"));
        if (Array.isArray(existing?.rejected)) previous = existing.rejected;
      } catch (error) {
        if (!isMissing(error)) {
          throw new StoreError(
            `${REJECTED_FILE} in project "${projectId}" is unreadable; move it aside and try again.`,
            file,
          );
        }
      }
      const rejectedAt = now().toISOString();
      await writeAtomically(projectId, REJECTED_FILE, {
        version: 1,
        rejected: [
          ...previous,
          ...rejected.map((item) => ({
            rejectedAt,
            problem: item.problem,
            record: raw[item.index],
          })),
        ],
      });
      await write(projectId, feedback);
      return rejected;
    });
  }

  function queueFor(projectId: string, fileName: StoreFile) {
    if (fileName === "approvals.json") return approvalsQueue(projectId);
    if (fileName === "captions.json") return captionsQueue(projectId);
    return projectId;
  }

  async function checkFile(projectId: string, fileName: StoreFile) {
    try {
      if (fileName === "feedback.json") {
        const { feedback, rejected } = await readState(projectId);
        return rejected.length
          ? {
              ok: false,
              problem: new FeedbackQuarantineError(projectId, rejected).message,
              count: feedback.length,
            }
          : { ok: true, problem: null, count: feedback.length };
      }
      const count =
        fileName === "approvals.json"
          ? (await readApprovals(projectId)).length
          : (await readCaptions(projectId)).length;
      return { ok: true, problem: null, count };
    } catch (error) {
      return {
        ok: false,
        problem: error instanceof Error ? error.message : String(error),
        count: 0,
      };
    }
  }

  // Health of each store file in a project, and whether a backup exists.
  async function checkStore(projectId: string) {
    const directory = paths(projectId).directory;
    return Promise.all(
      STORE_FILES.map(async (fileName) => ({
        file: fileName,
        ...(await checkFile(projectId, fileName)),
        hasBackup: await exists(backupPathFor(join(directory, fileName))),
      })),
    );
  }

  // Promotes `<name>.bak` over a damaged store file. The damaged file is kept
  // as `<name>.damaged-<time>`. Healthy files are left alone unless `force`.
  function restoreBackup(
    projectId: string,
    fileName: StoreFile,
    { force = false }: { force?: boolean } = {},
  ): Promise<"restored" | "healthy" | "no-backup"> {
    return serializeMutation(queueFor(projectId, fileName), async () => {
      const directory = paths(projectId).directory;
      const current = join(directory, fileName);
      const backup = backupPathFor(current);
      if (!(await exists(backup))) return "no-backup";
      if (!force && (await checkFile(projectId, fileName)).ok) return "healthy";
      if (await exists(current)) {
        const stamp = now().toISOString().replace(/[:.]/g, "-");
        await fileSystem.copyFile(current, `${current}.damaged-${stamp}`);
      }
      const next = `${current}.${process.pid}.${randomUUID()}.next`;
      await fileSystem.copyFile(backup, next);
      await fileSystem.rename(next, current);
      await syncDirectory(directory);
      return "restored";
    });
  }

  function createFeedback(
    projectId: string,
    rawInput: CreateFeedbackInput,
  ): Promise<FeedbackRecord> {
    return serializeMutation(projectId, async () => {
      const input = createFeedbackInputSchema.parse(rawInput);
      const feedback = await read(projectId);
      const existing = feedback.find(
        (item) => item.id === input.clientMutationId,
      );
      if (existing) {
        if (sameCreate(existing, input)) return existing;
        throw new FeedbackConflictError(
          "Feedback mutation id was already used with different content.",
          existing,
        );
      }
      const timestamp = nextUpdatedAt(now());
      const created = feedbackRecordSchema.parse({
        id: input.clientMutationId,
        projectId,
        screenId: input.screenId,
        version: input.version,
        x: input.x,
        y: input.y,
        ...(input.box ? { box: input.box } : {}),
        note: input.note,
        tags: input.tags,
        status: input.status,
        ...(input.author ? { author: input.author } : {}),
        ...(input.scope === "all" ? { scope: "all" } : {}),
        ...(input.element ? { element: input.element } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await write(projectId, [...feedback, created]);
      return created;
    });
  }

  function updateFeedback(
    projectId: string,
    id: string,
    rawInput: UpdateFeedbackInput,
  ): Promise<FeedbackRecord> {
    return serializeMutation(projectId, async () => {
      const input = updateFeedbackInputSchema.parse(rawInput);
      const feedback = await read(projectId);
      const index = feedback.findIndex((item) => item.id === id);
      if (index < 0) throw new FeedbackNotFoundError(id);
      const current = feedback[index]!;
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new FeedbackConflictError(
          "Feedback changed after it was loaded.",
          current,
        );
      }
      const updatedAt = nextUpdatedAt(now(), current.updatedAt);
      const { reply, message, issue, scope, checkPlacement, ...patch } =
        input.patch;
      const statusChange =
        patch.status && patch.status !== current.status
          ? { status: patch.status }
          : {};
      const thread: FeedbackMessage[] = [...feedbackThread(current)];
      if (reply === null) {
        const latest = thread.map((item) => item.role).lastIndexOf("agent");
        if (latest >= 0) thread.splice(latest, 1);
      } else if (reply) {
        thread.push({
          id: newId(),
          role: "agent",
          author: reply.author,
          note: reply.note,
          at: updatedAt,
          ...statusChange,
        });
      } else if (message) {
        thread.push({
          id: newId(),
          role: message.role,
          author:
            message.author ?? (message.role === "agent" ? "Agent" : "Reviewer"),
          note: message.note,
          at: updatedAt,
          ...statusChange,
        });
      }
      const next: Record<string, unknown> = {
        ...current,
        ...patch,
        thread,
        updatedAt,
      };
      delete next.reply;
      if (issue === null) delete next.issue;
      else if (issue) next.issue = issue;
      if (scope === "size") delete next.scope;
      else if (scope) next.scope = scope;
      if (checkPlacement === false) delete next.checkPlacement;
      const updated = feedbackRecordSchema.parse(next);
      const nextFeedback = [...feedback];
      nextFeedback[index] = updated;
      await write(projectId, nextFeedback);
      return updated;
    });
  }

  function deleteFeedback(
    projectId: string,
    id: string,
    expectedUpdatedAt: string,
  ): Promise<void> {
    return serializeMutation(projectId, async () => {
      const feedback = await read(projectId);
      const current = feedback.find((item) => item.id === id);
      if (!current) throw new FeedbackNotFoundError(id);
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new FeedbackConflictError(
          "Feedback changed after it was loaded.",
          current,
        );
      }
      await write(
        projectId,
        feedback.filter((item) => item.id !== id),
      );
    });
  }

  // Moves open comments to a newer version (carry forward). A move applies
  // only while the comment is still open and still on the version it was
  // planned from, so a concurrent edit or a second carry never doubles up.
  function carryFeedback(
    projectId: string,
    moves: readonly CarryMove[],
  ): Promise<FeedbackRecord[]> {
    return serializeMutation(projectId, async () => {
      if (moves.length === 0) return [];
      const feedback = await read(projectId);
      const byId = new Map(moves.map((move) => [move.id, move]));
      const carried: FeedbackRecord[] = [];
      const next = feedback.map((current) => {
        const move = byId.get(current.id);
        if (
          !move ||
          current.version !== move.from ||
          !isOpenFeedback(current)
        ) {
          return current;
        }
        const record: Record<string, unknown> = {
          ...current,
          version: move.to,
          x: move.x,
          y: move.y,
          carriedFrom: [...(current.carriedFrom ?? []), move.from],
          updatedAt: nextUpdatedAt(now(), current.updatedAt),
        };
        delete record.reply;
        if (move.box) record.box = move.box;
        else delete record.box;
        if (move.element) record.element = move.element;
        if (move.checkPlacement) record.checkPlacement = true;
        const updated = feedbackRecordSchema.parse(record);
        carried.push(updated);
        return updated;
      });
      if (carried.length > 0) await write(projectId, next);
      return carried;
    });
  }

  // Merges records saved elsewhere (the old browser adapter) without touching
  // existing records. Invalid records are reported, never dropped silently.
  function importFeedback(
    projectId: string,
    rawRecords: unknown,
  ): Promise<{ imported: number; skipped: number; invalid: number }> {
    return serializeMutation(projectId, async () => {
      z.array(z.unknown()).parse(rawRecords);
      const records = rawRecords as unknown[];
      const feedback = await read(projectId);
      const ids = new Set(feedback.map((item) => item.id));
      const additions: FeedbackRecord[] = [];
      let skipped = 0;
      let invalid = 0;
      for (const raw of records) {
        const parsed = feedbackRecordSchema.safeParse(
          typeof raw === "object" && raw !== null ? { ...raw, projectId } : raw,
        );
        if (!parsed.success) {
          invalid += 1;
        } else if (ids.has(parsed.data.id)) {
          skipped += 1;
        } else {
          ids.add(parsed.data.id);
          additions.push(parsed.data);
        }
      }
      if (additions.length > 0) {
        await write(projectId, [...feedback, ...additions]);
      }
      return { imported: additions.length, skipped, invalid };
    });
  }

  return {
    listFeedback,
    inspectFeedback,
    quarantineFeedback,
    checkStore,
    restoreBackup,
    createFeedback,
    updateFeedback,
    deleteFeedback,
    importFeedback,
    carryFeedback,
    listApprovals,
    setApproval,
    listCaptions,
    setCaption,
    listDismissedSuggestions,
    setSuggestionDismissal,
  };
}

export type FeedbackStorage = ReturnType<typeof createFeedbackStorage>;

// One instance per data root, so every caller in this process shares a single
// mutation queue and the shared temp file can never be written concurrently.
const sharedStorages = new Map<string, FeedbackStorage>();

export function sharedFeedbackStorage(dataRoot: string): FeedbackStorage {
  const key = resolve(dataRoot);
  let storage = sharedStorages.get(key);
  if (!storage) {
    storage = createFeedbackStorage({ dataRoot: key });
    sharedStorages.set(key, storage);
  }
  return storage;
}

export async function listFeedback(dataRoot: string, projectId: string) {
  return sharedFeedbackStorage(dataRoot).listFeedback(projectId);
}

export async function createFeedback(
  dataRoot: string,
  projectId: string,
  input: CreateFeedbackInput,
) {
  return sharedFeedbackStorage(dataRoot).createFeedback(projectId, input);
}

export async function updateFeedback(
  dataRoot: string,
  projectId: string,
  id: string,
  input: UpdateFeedbackInput,
) {
  return sharedFeedbackStorage(dataRoot).updateFeedback(projectId, id, input);
}

export async function deleteFeedback(
  dataRoot: string,
  projectId: string,
  id: string,
  expectedUpdatedAt: string,
) {
  return sharedFeedbackStorage(dataRoot).deleteFeedback(
    projectId,
    id,
    expectedUpdatedAt,
  );
}
