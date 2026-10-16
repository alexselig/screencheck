import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { createPinNumbers } from "../../shared/export";
import { ElementLine } from "./element-line";
import {
  FEEDBACK_STATUSES,
  STATUS_LABELS,
  PRIORITY_TAGS,
  feedbackThread,
  migrateLegacyTags,
  normalizeTags,
  normalizedCoordinateSchema,
  priorityTag,
  type CreateFeedbackInput,
  type FeedbackMessage,
  type FeedbackRecord,
  type FeedbackStatus,
  type UpdateFeedbackInput,
} from "../../shared/feedback";
import type { ReviewScreen } from "../../shared/manifest";
import { z } from "zod";

type Pin = { x: number; y: number };

const recoveryEntrySchema = z.preprocess(
  migrateLegacyTags,
  z.object({
    kind: z.enum(["create", "update"]),
    screenId: z.string().min(1),
    version: z.string().min(1),
    feedbackId: z.string().optional(),
    x: normalizedCoordinateSchema.optional(),
    y: normalizedCoordinateSchema.optional(),
    note: z.string(),
    tags: z.array(z.string()),
  }),
);

type RecoveryEntry = z.infer<typeof recoveryEntrySchema>;

type RecoveryEntries = Record<string, RecoveryEntry>;

type EditorState = {
  note: string;
  tags: string[];
  status: FeedbackStatus;
};

const EMPTY_EDITOR: EditorState = {
  note: "",
  tags: ["P1"],
  status: "OPEN",
};

// The pane is chunked by status, then by priority tag; empty chunks are hidden.
const STATUS_SECTIONS = FEEDBACK_STATUSES.map((status) => ({
  status,
  label: STATUS_LABELS[status],
}));

function isPriority(tag: string) {
  return (PRIORITY_TAGS as readonly string[]).includes(tag);
}

function sameTags(left: readonly string[], right: readonly string[]) {
  return left.join("\0") === right.join("\0");
}

const RECOVERY_PREFIX = "screencheck.feedback-recovery.v1:";
const COLLAPSED_STATUSES_KEY = "screencheck:collapsed-feedback-statuses";
const NOTE_SAVE_DELAY_MS = 500;
const shortcutLabel =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘A"
    : "Ctrl+A";

function recoveryStorageKey(projectId: string) {
  return `${RECOVERY_PREFIX}${projectId}`;
}

function createRecoveryKey(version: string, screenId: string) {
  return `create:${version}:${screenId}`;
}

function updateRecoveryKey(id: string) {
  return `update:${id}`;
}

function readCollapsedStatuses(): FeedbackStatus[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_STATUSES_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((status): status is FeedbackStatus =>
      (FEEDBACK_STATUSES as readonly unknown[]).includes(status),
    );
  } catch {
    return [];
  }
}

function writeCollapsedStatuses(statuses: readonly FeedbackStatus[]) {
  window.localStorage.setItem(COLLAPSED_STATUSES_KEY, JSON.stringify(statuses));
}

function readRecoveryEntries(projectId: string): RecoveryEntries {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(recoveryStorageKey(projectId));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Drop malformed entries one by one so a single bad draft cannot break
    // the editor or hide the others.
    const entries: RecoveryEntries = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = recoveryEntrySchema.safeParse(value);
      if (entry.success) entries[key] = entry.data;
    }
    return entries;
  } catch {
    return {};
  }
}

function recoveryPin(entry: RecoveryEntry | undefined): Pin | null {
  return entry?.kind === "create" &&
    typeof entry.x === "number" &&
    typeof entry.y === "number"
    ? { x: entry.x, y: entry.y }
    : null;
}

function writeRecovery(
  projectId: string,
  key: string,
  entry: RecoveryEntry | null,
) {
  const entries = readRecoveryEntries(projectId);
  if (entry) entries[key] = entry;
  else delete entries[key];
  const storageKey = recoveryStorageKey(projectId);
  if (Object.keys(entries).length === 0) {
    window.localStorage.removeItem(storageKey);
  } else {
    window.localStorage.setItem(storageKey, JSON.stringify(entries));
  }
}

// Shared by canvas pins and comment cards so a number reads as the same
// object in both places.
const REPLY_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// One message in a comment's thread: the agent's reply or the reviewer's
// answer, with the status change it made. Cards show the latest one; the
// editor shows them all.
function MessageNote({ message }: { message: FeedbackMessage }) {
  const label = message.role === "agent" ? "Reply" : "Reviewer";
  return (
    <span
      className={`feedback-reply role-${message.role}`}
      data-testid="feedback-reply"
    >
      <span className="feedback-reply-meta">
        {label}
        {message.author === label ? "" : ` · ${message.author}`} ·{" "}
        <time dateTime={message.at}>
          {REPLY_TIME.format(new Date(message.at))}
        </time>
        {message.status ? (
          <span
            className={`feedback-status-chip status-${message.status.toLowerCase()}`}
          >
            {STATUS_LABELS[message.status]}
          </span>
        ) : null}
      </span>
      <span className="feedback-reply-note">{message.note}</span>
    </span>
  );
}

export function pinDotClassName(item: FeedbackRecord, selected: boolean) {
  return [
    "pin-dot",
    `priority-${(priorityTag(item.tags) ?? "none").toLowerCase()}`,
    item.status === "RESOLVED" ? "is-fixed" : "",
    item.status === "VERIFIED" ? "is-verified" : "",
    item.status === "WONT_FIX" ? "is-closed" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function feedbackPinId(id: string) {
  return `feedback-pin-${id}`;
}

function feedbackCommentId(id: string) {
  return `feedback-comment-${id}`;
}

export function FeedbackInspector({
  projectId,
  screens,
  selectedScreenId,
  version,
  feedback,
  draftPin,
  selectedFeedbackId,
  onCancelDraft,
  onRecoverDraft,
  onSelectFeedback,
  onCreate,
  onUpdate,
  onDelete,
  onVisibleFeedbackChange,
  hiddenPinStatuses = [],
  onTogglePinStatus,
  approval,
  ready = true,
  adding = false,
}: {
  projectId: string;
  screens: ReviewScreen[];
  selectedScreenId: string;
  version: string;
  feedback: FeedbackRecord[];
  draftPin: Pin | null;
  selectedFeedbackId: string | null;
  onCancelDraft: () => void;
  onRecoverDraft: (pin: Pin) => void;
  onSelectFeedback: (id: string | null) => void;
  onCreate: (input: CreateFeedbackInput) => Promise<FeedbackRecord>;
  onUpdate: (id: string, input: UpdateFeedbackInput) => Promise<FeedbackRecord>;
  onDelete?: (id: string, expectedUpdatedAt: string) => Promise<void>;
  onVisibleFeedbackChange?: (feedback: FeedbackRecord[]) => void;
  hiddenPinStatuses?: readonly FeedbackStatus[];
  onTogglePinStatus?: (status: FeedbackStatus) => void;
  approval?: { approved: boolean; ready: boolean; onToggle: () => void };
  ready?: boolean;
  adding?: boolean;
}) {
  const initialRecoveries = useMemo(
    () => readRecoveryEntries(projectId),
    [projectId],
  );
  const initialCreateRecovery =
    initialRecoveries[createRecoveryKey(version, selectedScreenId)];
  const [recoveredPin, setRecoveredPin] = useState<Pin | null>(() =>
    recoveryPin(initialCreateRecovery),
  );
  const recoveryScopeRef = useRef(`${version}:${selectedScreenId}`);
  const [editor, setEditor] = useState<EditorState>(() => {
    const selected = feedback.find((item) => item.id === selectedFeedbackId);
    const recovery = draftPin
      ? initialCreateRecovery
      : selected
        ? initialRecoveries[updateRecoveryKey(selected.id)]
        : initialCreateRecovery;
    return recovery
      ? {
          note: recovery.note,
          tags: recovery.tags,
          status: draftPin ? "OPEN" : (selected?.status ?? "OPEN"),
        }
      : selected && !draftPin
        ? {
            note: selected.note,
            tags: selected.tags,
            status: selected.status,
          }
        : EMPTY_EDITOR;
  });
  const [tagDraft, setTagDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  // Verify / Reopen on a collapsed Fixed card. Reopening asks why first.
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  const [reopenDraft, setReopenDraft] = useState("");
  const [cardMessage, setCardMessage] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [confirmingApproval, setConfirmingApproval] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deleteMessage, setDeleteMessage] = useState("");
  const [collapsedStatuses, setCollapsedStatuses] = useState<FeedbackStatus[]>(
    readCollapsedStatuses,
  );
  // Where the open editor sits in the list. It is captured when editing
  // starts and held until the card closes, so retagging, changing status,
  // or a new pin's first save never moves (and remounts) the note box.
  const [heldSlot, setHeldSlot] = useState<{
    key: string;
    status: FeedbackStatus;
    priority: string | null;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorSectionRef = useRef<HTMLElement>(null);
  const previousDraftPinRef = useRef<Pin | null>(null);
  const pendingDraftFocusRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef(0);
  const latestRecordRef = useRef<FeedbackRecord | null>(null);
  const creatingRef = useRef<Promise<FeedbackRecord> | null>(null);
  const adoptedIdRef = useRef<string | null>(null);
  // A comment created in this editing session keeps the create layout (no
  // status picker, no change summary) so the editor does not grow under the
  // reviewer's cursor when the first autosave lands. New comments are Backlog.
  const [freshId, setFreshId] = useState<string | null>(null);
  const editorRef = useRef(editor);
  // ⌘A / Ctrl+A toggles approval; the handler is refreshed every render.
  const approveShortcutRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "a" ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.closest("[role=dialog]"))
      ) {
        return;
      }
      if (!approveShortcutRef.current) return;
      event.preventDefault();
      approveShortcutRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const effectiveDraftPin = draftPin ?? recoveredPin;

  const screenFeedback = useMemo(
    () =>
      feedback.filter(
        (item) =>
          item.screenId === selectedScreenId && item.version === version,
      ),
    [feedback, selectedScreenId, version],
  );
  const pinNumbers = useMemo(() => createPinNumbers(feedback), [feedback]);
  const visibleFeedback = useMemo(
    () =>
      [...screenFeedback].sort(
        (a, b) => (pinNumbers.get(a.id) ?? 0) - (pinNumbers.get(b.id) ?? 0),
      ),
    [pinNumbers, screenFeedback],
  );
  const selectedRecord =
    screenFeedback.find((item) => item.id === selectedFeedbackId) ?? null;
  const visibleSelectedRecord =
    visibleFeedback.find((item) => item.id === selectedFeedbackId) ?? null;

  latestRecordRef.current = effectiveDraftPin ? null : selectedRecord;
  editorRef.current = editor;

  useEffect(() => {
    if (selectedFeedbackId !== freshId) setFreshId(null);
    setConfirmingDeleteId(null);
    setDeleteMessage("");
    setReplyDraft("");
  }, [selectedFeedbackId]);

  useEffect(() => {
    setConfirmingApproval(false);
    setReopeningId(null);
    setCardMessage(null);
  }, [selectedScreenId, version]);

  useEffect(() => {
    onVisibleFeedbackChange?.(visibleFeedback);
  }, [onVisibleFeedbackChange, visibleFeedback]);

  // A recovered draft belongs to one screen and version; re-read it whenever
  // either changes so it never follows the reviewer to another screen.
  useEffect(() => {
    const scope = `${version}:${selectedScreenId}`;
    if (recoveryScopeRef.current === scope) return;
    recoveryScopeRef.current = scope;
    setRecoveredPin(
      recoveryPin(
        readRecoveryEntries(projectId)[
          createRecoveryKey(version, selectedScreenId)
        ],
      ),
    );
  }, [projectId, selectedScreenId, version]);

  useEffect(() => {
    if (recoveredPin) onRecoverDraft(recoveredPin);
  }, [onRecoverDraft, recoveredPin]);

  useEffect(() => {
    if (selectedRecord) openStatus(selectedRecord.status);
  }, [selectedRecord?.id, selectedRecord?.status]);

  useLayoutEffect(() => {
    const previousDraftPin = previousDraftPinRef.current;
    previousDraftPinRef.current = draftPin;
    if (!draftPin || previousDraftPin === draftPin) return;

    const recovery =
      readRecoveryEntries(projectId)[
        createRecoveryKey(version, selectedScreenId)
      ];
    if (!recovery) setEditor({ ...EMPTY_EDITOR });
    pendingDraftFocusRef.current = true;
    openStatus("OPEN");
  }, [draftPin, projectId, selectedScreenId, version]);

  useLayoutEffect(() => {
    if (
      !effectiveDraftPin ||
      collapsedStatuses.includes("OPEN") ||
      !pendingDraftFocusRef.current
    ) {
      return;
    }
    pendingDraftFocusRef.current = false;
    editorSectionRef.current?.scrollIntoView?.({ block: "nearest" });
    textareaRef.current?.focus();
  }, [collapsedStatuses, effectiveDraftPin]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (textareaRef.current === document.activeElement) return;
    const recoveries = readRecoveryEntries(projectId);
    const recovery = effectiveDraftPin
      ? recoveries[createRecoveryKey(version, selectedScreenId)]
      : selectedRecord
        ? recoveries[updateRecoveryKey(selectedRecord.id)]
        : undefined;
    if (recovery) {
      setEditor({
        note: recovery.note,
        tags: recovery.tags,
        status: effectiveDraftPin ? "OPEN" : (selectedRecord?.status ?? "OPEN"),
      });
    } else if (effectiveDraftPin) {
      setEditor({ ...EMPTY_EDITOR });
    } else if (selectedRecord) {
      setEditor({
        note: selectedRecord.note,
        tags: selectedRecord.tags,
        status: selectedRecord.status,
      });
    } else if (!effectiveDraftPin) {
      setEditor(EMPTY_EDITOR);
    }
  }, [effectiveDraftPin, projectId, selectedRecord, selectedScreenId, version]);

  function currentRecoveryKey() {
    return selectedRecord && !effectiveDraftPin
      ? updateRecoveryKey(selectedRecord.id)
      : createRecoveryKey(version, selectedScreenId);
  }

  function setStatusCollapsed(status: FeedbackStatus, collapsed: boolean) {
    setCollapsedStatuses((current) => {
      const next = collapsed
        ? current.includes(status)
          ? current
          : [...current, status]
        : current.filter((item) => item !== status);
      writeCollapsedStatuses(next);
      return next;
    });
  }

  function openStatus(status: FeedbackStatus) {
    setStatusCollapsed(status, false);
  }

  function persistLocal(nextEditor: EditorState) {
    const record = latestRecordRef.current;
    const pin = effectiveDraftPin;
    if (!record && !pin) return;
    writeRecovery(projectId, currentRecoveryKey(), {
      kind: record ? "update" : "create",
      screenId: selectedScreenId,
      version,
      feedbackId: record?.id,
      x: pin?.x,
      y: pin?.y,
      note: nextEditor.note,
      tags: nextEditor.tags,
    });
    setSaveMessage("Unsaved locally");
  }

  async function saveEditor(revision: number, nextEditor: EditorState) {
    let record = latestRecordRef.current;
    const pin = effectiveDraftPin;
    if (!nextEditor.note.trim() || (!record && !pin)) return;
    setSaveMessage("Saving…");
    // A save that fires while the pin is still being created updates that
    // record instead of creating a second one.
    if (!record && creatingRef.current) {
      record = await creatingRef.current.catch(() => null);
    }
    try {
      if (record) {
        const patch: UpdateFeedbackInput["patch"] = {};
        const note = nextEditor.note.trim();
        if (note !== record.note) patch.note = note;
        if (!sameTags(nextEditor.tags, record.tags)) {
          patch.tags = nextEditor.tags;
        }
        if (Object.keys(patch).length === 0) {
          writeRecovery(projectId, updateRecoveryKey(record.id), null);
          setSaveMessage("Saved");
          return;
        }
        const updated = await onUpdate(record.id, {
          expectedUpdatedAt: record.updatedAt,
          patch,
        });
        latestRecordRef.current = updated;
        if (revision === revisionRef.current) {
          writeRecovery(projectId, updateRecoveryKey(record.id), null);
          setSaveMessage("Saved");
          if (textareaRef.current !== document.activeElement) {
            setEditor({
              note: updated.note,
              tags: updated.tags,
              status: updated.status,
            });
          }
        }
      } else if (pin) {
        const creating = onCreate({
          clientMutationId: crypto.randomUUID(),
          screenId: selectedScreenId,
          version,
          x: pin.x,
          y: pin.y,
          note: nextEditor.note.trim(),
          tags: nextEditor.tags,
          status: "OPEN",
        });
        creatingRef.current = creating;
        let created: FeedbackRecord;
        try {
          created = await creating;
        } finally {
          if (creatingRef.current === creating) creatingRef.current = null;
        }
        latestRecordRef.current = created;
        adoptedIdRef.current = created.id;
        setFreshId(created.id);
        // Always adopt the new record, even if the reviewer kept typing, so
        // later saves update it rather than creating a duplicate pin.
        writeRecovery(
          projectId,
          createRecoveryKey(version, selectedScreenId),
          null,
        );
        setRecoveredPin(null);
        onSelectFeedback(created.id);
        onCancelDraft();
        if (revision === revisionRef.current) {
          setSaveMessage("Saved");
        } else {
          writeRecovery(projectId, updateRecoveryKey(created.id), {
            kind: "update",
            screenId: selectedScreenId,
            version,
            feedbackId: created.id,
            note: editorRef.current.note,
            tags: editorRef.current.tags,
          });
        }
      }
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
    }
  }

  function scheduleSave(nextEditor: EditorState) {
    persistLocal(nextEditor);
    const revision = ++revisionRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveEditor(revision, nextEditor);
    }, NOTE_SAVE_DELAY_MS);
  }

  function updateEditor(patch: Partial<Pick<EditorState, "note" | "tags">>) {
    const next = { ...editor, ...patch };
    editorRef.current = next;
    setEditor(next);
    scheduleSave(next);
  }

  async function flushStatus(status: FeedbackStatus) {
    const record = latestRecordRef.current;
    if (!record || status === record.status) return;
    const closesFeedback = status === "RESOLVED" || status === "WONT_FIX";
    const replyNote = replyDraft.trim();
    if (closesFeedback && !replyNote) {
      setSaveMessage("Add a reply before closing this feedback.");
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSaveMessage("Saving…");
    try {
      const updated = await onUpdate(record.id, {
        expectedUpdatedAt: record.updatedAt,
        patch: {
          status,
          ...(replyNote
            ? { message: { note: replyNote, role: "reviewer" as const } }
            : {}),
        },
      });
      latestRecordRef.current = updated;
      if (replyNote) setReplyDraft("");
      setSaveMessage("Saved");
      if (
        editor.note !== updated.note ||
        !sameTags(editor.tags, updated.tags)
      ) {
        scheduleSave({ ...editor, status });
      }
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
    }
  }

  function changeStatus(event: ChangeEvent<HTMLSelectElement>) {
    const status = event.target.value as FeedbackStatus;
    if (
      (status === "RESOLVED" || status === "WONT_FIX") &&
      !replyDraft.trim()
    ) {
      setSaveMessage("Add a reply before closing this feedback.");
      return;
    }
    setEditor((current) => ({ ...current, status }));
    void flushStatus(status);
  }

  // The reviewer's answer in the thread, without changing the status.
  async function sendReply() {
    const record = latestRecordRef.current;
    const note = replyDraft.trim();
    if (!record || !note) return;
    setSaveMessage("Saving…");
    try {
      const updated = await onUpdate(record.id, {
        expectedUpdatedAt: record.updatedAt,
        patch: { message: { note, role: "reviewer" } },
      });
      latestRecordRef.current = updated;
      setReplyDraft("");
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
    }
  }

  async function updateCard(
    item: FeedbackRecord,
    patch: UpdateFeedbackInput["patch"],
  ) {
    setCardMessage({ id: item.id, text: "Saving…" });
    try {
      await onUpdate(item.id, { expectedUpdatedAt: item.updatedAt, patch });
      setCardMessage(null);
      setReopeningId(null);
      setReopenDraft("");
    } catch (error) {
      setCardMessage({
        id: item.id,
        text:
          error instanceof Error
            ? `Retry required: ${error.message}`
            : "Retry required",
      });
    }
  }

  function verifyActions(item: FeedbackRecord) {
    const pin = pinNumbers.get(item.id) ?? 0;
    const reopening = reopeningId === item.id;
    return (
      <div
        aria-label={`Check the fix for pin ${pin}`}
        className="feedback-verify"
        role="group"
      >
        {reopening ? (
          <label>
            Why reopen?
            <textarea
              aria-label={`Why reopen pin ${pin}?`}
              autoFocus
              onChange={(event) => setReopenDraft(event.target.value)}
              placeholder="What still needs to change?"
              value={reopenDraft}
            />
          </label>
        ) : null}
        <div className="feedback-verify-buttons">
          {reopening ? (
            <>
              <button
                className="feedback-reopen-confirm"
                onClick={() => {
                  const note = reopenDraft.trim();
                  void updateCard(item, {
                    status: "OPEN",
                    ...(note
                      ? { message: { note, role: "reviewer" as const } }
                      : {}),
                  });
                }}
                type="button"
              >
                Reopen
              </button>
              <button
                onClick={() => {
                  setReopeningId(null);
                  setCardMessage(null);
                }}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                aria-label={`Verify pin ${pin}`}
                className="feedback-verify-button"
                onClick={() => void updateCard(item, { status: "VERIFIED" })}
                type="button"
              >
                Verify
              </button>
              <button
                aria-label={`Reopen pin ${pin}`}
                onClick={() => {
                  setReopenDraft("");
                  setCardMessage(null);
                  setReopeningId(item.id);
                }}
                type="button"
              >
                Reopen
              </button>
            </>
          )}
        </div>
        {cardMessage?.id === item.id ? (
          <span aria-live="polite" className="feedback-verify-state">
            {cardMessage.text}
          </span>
        ) : null}
      </div>
    );
  }

  function togglePriority(priority: string) {
    const others = editor.tags.filter((tag) => !isPriority(tag));
    updateEditor({
      tags: editor.tags.includes(priority) ? others : [priority, ...others],
    });
  }

  function addTag(raw: string) {
    const tag = raw.replace(/,/g, " ").trim();
    setTagDraft("");
    if (!tag) return;
    const upper = tag.toUpperCase();
    if (isPriority(upper)) {
      if (!editor.tags.includes(upper)) togglePriority(upper);
      return;
    }
    const tags = normalizeTags([...editor.tags, tag]).slice(0, 12);
    if (!sameTags(tags, editor.tags)) updateEditor({ tags });
  }

  function removeTag(tag: string) {
    updateEditor({ tags: editor.tags.filter((item) => item !== tag) });
  }

  function onTagKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(tagDraft);
    } else if (event.key === "Backspace" && !tagDraft) {
      const last = editor.tags.filter((tag) => !isPriority(tag)).at(-1);
      if (last) removeTag(last);
    }
  }

  async function confirmDelete(id: string) {
    const isSelected = latestRecordRef.current?.id === id;
    const record = isSelected
      ? latestRecordRef.current
      : (feedback.find((item) => item.id === id) ?? null);
    if (!record || !onDelete) return;
    if (isSelected && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDeleteMessage("Deleting…");
    try {
      await onDelete(record.id, record.updatedAt);
      writeRecovery(projectId, updateRecoveryKey(record.id), null);
      setConfirmingDeleteId(null);
      setDeleteMessage("");
      setSaveMessage("Deleted");
    } catch (error) {
      setDeleteMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
    }
  }

  function deleteButton(item: FeedbackRecord) {
    if (!onDelete) return null;
    return (
      <button
        aria-expanded={confirmingDeleteId === item.id}
        aria-label={`Delete comment ${pinNumbers.get(item.id) ?? 0}`}
        className="feedback-delete-x"
        onClick={() => {
          setDeleteMessage("");
          setConfirmingDeleteId(item.id);
        }}
        title="Delete comment"
        type="button"
      >
        <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
          <path
            d="M2 2l10 10M12 2 2 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          />
        </svg>
      </button>
    );
  }

  function collapseEditor(item: FeedbackRecord) {
    // Save any pending note edit before the card collapses.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      void saveEditor(revisionRef.current, editor);
    }
    setConfirmingDeleteId(null);
    onSelectFeedback(null);
    document.getElementById(feedbackPinId(item.id))?.focus();
  }

  function collapseButton(item: FeedbackRecord) {
    return (
      <button
        aria-label={`Collapse comment ${pinNumbers.get(item.id) ?? 0}`}
        className="feedback-collapse"
        onClick={() => collapseEditor(item)}
        title="Collapse"
        type="button"
      >
        <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
          <path
            d="M2.5 9.5 7 5l4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          />
        </svg>
      </button>
    );
  }

  function deleteBar(item: FeedbackRecord) {
    if (!onDelete || confirmingDeleteId === item.id) return null;
    return (
      <button
        aria-label={`Delete comment ${pinNumbers.get(item.id) ?? 0}`}
        className="feedback-delete-wide"
        onClick={() => {
          setDeleteMessage("");
          setConfirmingDeleteId(item.id);
        }}
        type="button"
      >
        Delete comment
      </button>
    );
  }

  function deleteConfirm(item: FeedbackRecord) {
    if (confirmingDeleteId !== item.id) return null;
    return (
      <div
        aria-label="Confirm delete"
        className="feedback-delete-confirm"
        role="group"
      >
        <span>Delete pin {pinNumbers.get(item.id) ?? 0} and its comment?</span>
        <button
          className="feedback-delete-button"
          onClick={() => void confirmDelete(item.id)}
          type="button"
        >
          Confirm delete
        </button>
        <button onClick={() => setConfirmingDeleteId(null)} type="button">
          Keep
        </button>
        {deleteMessage ? (
          <span aria-live="polite" role="status">
            {deleteMessage}
          </span>
        ) : null}
      </div>
    );
  }

  function renderItem(item: FeedbackRecord) {
    if (item.id === editingRecord?.id) {
      return (
        <li className="is-editing" key="editor">
          {editorSection}
          {deleteConfirm(item)}
        </li>
      );
    }
    const otherTags = item.tags.filter((tag) => !isPriority(tag));
    const latest = feedbackThread(item).at(-1);
    return (
      <li key={item.id}>
        <button
          aria-controls={feedbackPinId(item.id)}
          aria-pressed={item.id === selectedFeedbackId}
          className={`feedback-comment status-${item.status.toLowerCase()}`}
          id={feedbackCommentId(item.id)}
          onClick={() => {
            onSelectFeedback(item.id);
            document.getElementById(feedbackPinId(item.id))?.focus();
          }}
          type="button"
        >
          <span
            aria-label={`Pin ${pinNumbers.get(item.id) ?? 0}`}
            className={pinDotClassName(item, item.id === selectedFeedbackId)}
          >
            {pinNumbers.get(item.id) ?? 0}
          </span>
          <strong>{item.note}</strong>
          <ElementLine projectId={projectId} pin={item} />
          {otherTags.length ? (
            <span className="feedback-comment-tags">
              {otherTags.map((tag) => (
                <span className="tag-chip tag-custom" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          ) : null}
          {latest ? <MessageNote message={latest} /> : null}
        </button>
        {item.status === "RESOLVED" ? verifyActions(item) : null}
        {deleteButton(item)}
        {deleteConfirm(item)}
      </li>
    );
  }

  // The comment being edited renders as the editor in its own list slot, so it
  // never appears twice (once as a saved card and again in the editor).
  const editingRecord = effectiveDraftPin ? null : visibleSelectedRecord;
  const freshRecord = Boolean(editingRecord && editingRecord.id === freshId);
  const editingThread = editingRecord ? feedbackThread(editingRecord) : [];
  // Fixed but not yet looked at: approving over them takes a second click.
  const unverifiedFixes = visibleFeedback.filter(
    (item) => item.status === "RESOLVED",
  ).length;
  approveShortcutRef.current =
    approval && approval.ready && ready
      ? () => {
          if (
            approval.approved ||
            unverifiedFixes === 0 ||
            confirmingApproval
          ) {
            setConfirmingApproval(false);
            approval.onToggle();
          } else {
            setConfirmingApproval(true);
          }
        }
      : null;
  const slotKey = effectiveDraftPin ? "draft" : (editingRecord?.id ?? null);
  if ((heldSlot?.key ?? null) !== slotKey) {
    if (!slotKey) {
      setHeldSlot(null);
    } else if (heldSlot?.key === "draft" && adoptedIdRef.current === slotKey) {
      setHeldSlot({ ...heldSlot, key: slotKey });
    } else {
      setHeldSlot({
        key: slotKey,
        status: editingRecord?.status ?? "OPEN",
        priority: priorityTag(editingRecord?.tags ?? editor.tags),
      });
    }
  }
  const editorSlot =
    heldSlot && heldSlot.key === slotKey
      ? heldSlot
      : slotKey
        ? {
            key: slotKey,
            status: editingRecord?.status ?? "OPEN",
            priority: priorityTag(editingRecord?.tags ?? editor.tags),
          }
        : null;
  const slotOf = (item: FeedbackRecord) =>
    item.id === editingRecord?.id && editorSlot
      ? editorSlot
      : { status: item.status, priority: priorityTag(item.tags) };
  const editorSection = (
    <section
      className="feedback-editor"
      aria-label="Feedback editor"
      ref={editorSectionRef}
    >
      <header className="feedback-editor-header">
        {editingRecord ? (
          <span
            aria-label={`Pin ${pinNumbers.get(editingRecord.id) ?? 0}`}
            className={pinDotClassName(editingRecord, true)}
          >
            {pinNumbers.get(editingRecord.id) ?? 0}
          </span>
        ) : (
          <span aria-hidden="true" className="pin-dot feedback-pin-draft">
            +
          </span>
        )}
        <span className="feedback-comment-meta">
          {editingRecord
            ? `Editing pin ${pinNumbers.get(editingRecord.id) ?? 0}`
            : "New pin"}
        </span>
        {editingRecord ? collapseButton(editingRecord) : null}
      </header>
      <label>
        Feedback note
        <textarea
          aria-label="Feedback note"
          onChange={(event) => updateEditor({ note: event.target.value })}
          ref={textareaRef}
          value={editor.note}
        />
      </label>
      {editingRecord ? (
        <ElementLine projectId={projectId} pin={editingRecord} />
      ) : null}
      {editingThread.length ? (
        <ol aria-label="Thread" className="feedback-thread">
          {editingThread.map((message) => (
            <li key={message.id}>
              <MessageNote message={message} />
            </li>
          ))}
        </ol>
      ) : null}
      {editingRecord && !freshRecord ? (
        <div className="feedback-reply-compose">
          <label>
            Reply
            <textarea
              aria-label="Reply"
              onChange={(event) => setReplyDraft(event.target.value)}
              placeholder="Answer the agent, or say why the status changes."
              value={replyDraft}
            />
          </label>
          <button
            className="feedback-reply-send"
            disabled={!replyDraft.trim()}
            onClick={() => void sendReply()}
            type="button"
          >
            Reply
          </button>
        </div>
      ) : null}
      <fieldset className="feedback-tags">
        <legend>Tags</legend>
        <div className="feedback-tag-row">
          {PRIORITY_TAGS.map((priority) => (
            <button
              aria-pressed={editor.tags.includes(priority)}
              className={`tag-chip tag-suggested tag-${priority.toLowerCase()}`}
              key={priority}
              onClick={() => togglePriority(priority)}
              type="button"
            >
              {priority}
            </button>
          ))}
          {editor.tags
            .filter((tag) => !isPriority(tag))
            .map((tag) => (
              <span className="tag-chip tag-custom" key={tag}>
                {tag}
                <button
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => removeTag(tag)}
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    height="10"
                    viewBox="0 0 10 10"
                    width="10"
                  >
                    <path
                      d="M1.5 1.5l7 7M8.5 1.5l-7 7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  </svg>
                </button>
              </span>
            ))}
          <input
            aria-label="Add tag"
            className="feedback-tag-input"
            maxLength={32}
            onBlur={() => addTag(tagDraft)}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={onTagKeyDown}
            placeholder="Add tag"
            value={tagDraft}
          />
        </div>
      </fieldset>
      {editingRecord && !freshRecord ? (
        <label>
          Status
          <select
            aria-label="Feedback status"
            onChange={changeStatus}
            value={editor.status}
          >
            {FEEDBACK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <span aria-live="polite" className="feedback-save-state" role="status">
        {saveMessage}
      </span>
      {effectiveDraftPin ? (
        <button
          className="feedback-cancel-button"
          onClick={() => {
            writeRecovery(
              projectId,
              createRecoveryKey(version, selectedScreenId),
              null,
            );
            setRecoveredPin(null);
            setEditor(EMPTY_EDITOR);
            onCancelDraft();
          }}
          type="button"
        >
          Cancel pin
        </button>
      ) : null}
      {editingRecord ? deleteBar(editingRecord) : null}
    </section>
  );

  return (
    <aside className="feedback-panel" aria-label="Feedback inspector">
      <header
        aria-label="Feedback summary"
        className="feedback-inspector-header"
        role="banner"
      >
        <strong>Feedback</strong>
        <span className="feedback-inspector-count">
          {visibleFeedback.length} comment
          {visibleFeedback.length === 1 ? "" : "s"}
        </span>
      </header>

      {visibleFeedback.length === 0 ? (
        <p className="feedback-empty">
          No feedback on this screen yet. Choose Add feedback, then click the
          screen to drop pin 1.
        </p>
      ) : null}

      {STATUS_SECTIONS.map((section) => {
        const items = visibleFeedback.filter(
          (item) => slotOf(item).status === section.status,
        );
        const draftHere =
          effectiveDraftPin && editorSlot?.status === section.status
            ? editorSlot
            : null;
        if (items.length === 0 && !draftHere) return null;
        const draftRow = (
          <li className="is-editing" key="editor">
            {editorSection}
          </li>
        );
        // Comments without a priority tag sit after the P groups, unheaded.
        const untagged = items.filter((item) => !slotOf(item).priority);
        const pinsHidden = hiddenPinStatuses.includes(section.status);
        const collapsed = collapsedStatuses.includes(section.status);
        const bodyId = `feedback-section-${section.status.toLowerCase()}`;
        return (
          <section
            aria-label={section.label}
            className={`feedback-section status-${section.status.toLowerCase()}`}
            key={section.status}
          >
            <div className="feedback-section-title">
              <button
                aria-controls={bodyId}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.label} comments`}
                className="feedback-section-toggle"
                onClick={() => setStatusCollapsed(section.status, !collapsed)}
                type="button"
              >
                <span>{section.label}</span>
                <span className="feedback-count">{items.length}</span>
              </button>
              {onTogglePinStatus ? (
                <button
                  aria-label={`${pinsHidden ? "Show" : "Hide"} ${section.label} pins`}
                  aria-pressed={pinsHidden}
                  className="feedback-section-pins"
                  onClick={() => onTogglePinStatus(section.status)}
                  type="button"
                >
                  {pinsHidden ? "Show pins" : "Hide pins"}
                </button>
              ) : null}
            </div>
            {!collapsed ? (
              <div className="feedback-section-body" id={bodyId}>
                {PRIORITY_TAGS.map((priority) => {
                  const group = items.filter(
                    (item) => slotOf(item).priority === priority,
                  );
                  const withDraft = draftHere?.priority === priority;
                  if (group.length === 0 && !withDraft) return null;
                  return (
                    <div
                      aria-label={`${section.label} ${priority}`}
                      className="feedback-group"
                      key={priority}
                      role="group"
                    >
                      <h4
                        className={`feedback-group-title tag-${priority.toLowerCase()}`}
                      >
                        {priority}
                        <span className="feedback-count">{group.length}</span>
                      </h4>
                      <ol className="feedback-list">
                        {[
                          ...group.map(renderItem),
                          ...(withDraft ? [draftRow] : []),
                        ]}
                      </ol>
                    </div>
                  );
                })}
                {untagged.length || (draftHere && !draftHere.priority) ? (
                  <ol className="feedback-list feedback-list-untagged">
                    {[
                      ...untagged.map(renderItem),
                      ...(draftHere && !draftHere.priority ? [draftRow] : []),
                    ]}
                  </ol>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}

      {approval ? (
        <div className="screen-approval">
          {confirmingApproval && !approval.approved && unverifiedFixes > 0 ? (
            <div
              aria-label="Confirm approval"
              className="screen-approval-confirm"
              role="group"
            >
              <span>
                {unverifiedFixes} fix{unverifiedFixes === 1 ? "" : "es"} not
                verified. Approve anyway?
              </span>
              <button
                className="screen-approval-anyway"
                onClick={() => {
                  setConfirmingApproval(false);
                  approval.onToggle();
                }}
                type="button"
              >
                Approve
              </button>
              <button
                autoFocus
                onClick={() => setConfirmingApproval(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              aria-pressed={approval.approved}
              className="screen-approval-toggle"
              // Wait for feedback too, so unverified fixes are counted.
              disabled={!approval.ready || !ready}
              onClick={() => {
                if (!approval.approved && unverifiedFixes > 0) {
                  setConfirmingApproval(true);
                } else {
                  approval.onToggle();
                }
              }}
              aria-keyshortcuts="Meta+A Control+A"
              title={`${approval.approved ? "Click to unapprove" : "Approve screen"} (${shortcutLabel})`}
              type="button"
            >
              <span aria-hidden="true" className="screen-approval-box">
                {approval.approved ? "✓" : ""}
              </span>
              {approval.approved ? "Screen approved" : "Approve screen"}
              <kbd aria-hidden="true">{shortcutLabel}</kbd>
            </button>
          )}
        </div>
      ) : null}
    </aside>
  );
}
