import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { createPinNumbers } from "../../shared/export";
import { ElementLine } from "./element-line";
import { SHORTCUTS, type ApproveShortcut } from "../shortcuts";
import { ApprovalBar, type SizeApproval } from "./approval-bar";
import { VerifyActions } from "./verify-actions";
import { PlacementLine, PlacementOk, ScopeChoice } from "./placement-note";
import { pinnedAtOf } from "../all-sizes";
import { MentionText, ReviewerNameField } from "./reviewer-name";
import {
  FEEDBACK_STATUSES,
  STATUS_LABELS,
  PRIORITY_TAGS,
  feedbackThread,
  isOpenFeedback,
  migrateLegacyTags,
  normalizeTags,
  normalizedCoordinateSchema,
  priorityTag,
  scopeOf,
  type CreateFeedbackInput,
  type FeedbackScope,
  type FeedbackMessage,
  type FeedbackRecord,
  type FeedbackStatus,
  type UpdateFeedbackInput,
} from "../../shared/feedback";
import type { ReviewScreen } from "../../shared/manifest";
import { pinBoxSchema, type BoxPin } from "../../shared/pin-box";
import { z } from "zod";

type Pin = BoxPin;

const recoveryEntrySchema = z.preprocess(
  migrateLegacyTags,
  z.object({
    kind: z.enum(["create", "update"]),
    screenId: z.string().min(1),
    version: z.string().min(1),
    feedbackId: z.string().optional(),
    x: normalizedCoordinateSchema.optional(),
    y: normalizedCoordinateSchema.optional(),
    box: pinBoxSchema.optional(),
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

type SaveTarget = {
  record: FeedbackRecord | null;
  pin: Pin | null;
  screenId: string;
  version: string;
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

function sameTarget(left: SaveTarget, right: SaveTarget) {
  return left.record
    ? left.record.id === right.record?.id
    : !right.record && left.pin === right.pin;
}

const RECOVERY_PREFIX = "screencheck.feedback-recovery.v1:";
const COLLAPSED_STATUSES_KEY = "screencheck:collapsed-feedback-statuses";
const NOTE_SAVE_DELAY_MS = 500;

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
    ? { x: entry.x, y: entry.y, ...(entry.box ? { box: entry.box } : {}) }
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
      <span className="feedback-reply-note">
        <MentionText text={message.note} />
      </span>
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
    // An all-sizes comment shown on a size other than the one it was pinned on.
    pinnedAtOf(item) ? "is-other-size" : "",
    item.checkPlacement === true ? "needs-placement" : "",
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
  approveShortcut,
  ready = true,
  adding = false,
  onAddFeedback,
  onSelectScreen,
  multipleSizes = false,
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
  approval?: {
    approved: boolean;
    ready: boolean;
    onToggle: () => void;
    // Set when the screen has several sizes: the toggle approves one size,
    // Approve all sizes the rest.
    sizeLabel?: string;
    sizes?: SizeApproval[];
    onApproveAll?: () => void;
  };
  // Filled with the ⌘A handler for App's shortcut router.
  approveShortcut?: ApproveShortcut;
  ready?: boolean;
  adding?: boolean;
  // The empty state's inline Add feedback and its jump to the next screen.
  onAddFeedback?: () => void;
  onSelectScreen?: (screenId: string) => void;
  // The revision has several sizes: comments may cover all of them.
  multipleSizes?: boolean;
}) {
  const emptyHeadingId = useId();
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
  const asideRef = useRef<HTMLElement>(null);
  // Where focus should land once the DOM catches up after an action removes,
  // moves or disables the focused control. It only applies while focus is
  // lost (on <body>) or still on the control that asked, so it never steals
  // focus the reviewer has moved on purpose.
  const focusRequestRef = useRef<{
    find: () => HTMLElement | null | undefined;
    from: Element | null;
  } | null>(null);
  const applyFocusRequest = useCallback(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      active === request.from ||
      !active.isConnected;
    if (!lost) {
      focusRequestRef.current = null;
      return;
    }
    const target = request.find();
    if (target?.isConnected) {
      focusRequestRef.current = null;
      target.focus();
    }
  }, []);
  const requestFocus = useCallback(
    (find: () => HTMLElement | null | undefined) => {
      focusRequestRef.current = { find, from: document.activeElement };
      // Layout effects apply it after the next render; this catches the case
      // where that render has already happened.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(applyFocusRequest);
      }
    },
    [applyFocusRequest],
  );
  useLayoutEffect(applyFocusRequest);
  const approvalToggleRef = useRef<HTMLButtonElement>(null);
  const refocusApprovalRef = useRef(false);
  // Closing the confirm unmounts the focused button; hand focus back to the
  // toggle that replaces it instead of dropping it on <body>.
  const closeApprovalConfirm = useCallback(() => {
    refocusApprovalRef.current = true;
    setConfirmingApproval(false);
  }, []);
  useLayoutEffect(() => {
    if (confirmingApproval || !refocusApprovalRef.current) return;
    refocusApprovalRef.current = false;
    approvalToggleRef.current?.focus();
  }, [confirmingApproval]);
  const [saveMessage, setSaveMessage] = useState("");
  // Resends the last failed save from the editor, shown as a Retry button.
  const [retrySave, setRetrySave] = useState<{
    kind: "note" | "status" | "reply";
    run: () => void;
  } | null>(null);
  const clearRetry = (kind: "note" | "status" | "reply") =>
    setRetrySave((current) => (current?.kind === kind ? null : current));
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
  // This size / All sizes for the comment being drafted.
  const [draftScope, setDraftScope] = useState<FeedbackScope>("size");
  const draftScopeRef = useRef<FeedbackScope>("size");
  draftScopeRef.current = draftScope;
  const pendingDraftFocusRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef(0);
  const latestRecordRef = useRef<FeedbackRecord | null>(null);
  // Creation in flight and the record it made, per draft pin, so a later save
  // for the same pin updates that record instead of creating a second one.
  const creatingRef = useRef(new WeakMap<Pin, Promise<FeedbackRecord>>());
  const createdRef = useRef(new WeakMap<Pin, FeedbackRecord>());
  const adoptedIdRef = useRef<string | null>(null);
  const draftPinRef = useRef<Pin | null>(null);
  // The scheduled autosave and the comment (or draft pin) it belongs to,
  // captured when the edit was made rather than when the timer fires.
  const pendingSaveRef = useRef<{
    revision: number;
    editor: EditorState;
    target: SaveTarget;
  } | null>(null);
  // A comment created in this editing session keeps the create layout (no
  // status picker, no change summary) so the editor does not grow under the
  // reviewer's cursor when the first autosave lands. New comments are Backlog.
  const [freshId, setFreshId] = useState<string | null>(null);
  const editorRef = useRef(editor);
  // ⌘A / Ctrl+A toggles approval. App's shortcut router calls this ref; the
  // handler is refreshed every render.
  const ownApproveShortcutRef = useRef<(() => void) | null>(null);
  const approveShortcutRef = approveShortcut ?? ownApproveShortcutRef;
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
  draftPinRef.current = effectiveDraftPin;
  editorRef.current = editor;

  useEffect(() => {
    if (selectedFeedbackId !== freshId) setFreshId(null);
    setConfirmingDeleteId(null);
    setDeleteMessage("");
    setReplyDraft("");
    setRetrySave(null);
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

  // Selecting a comment (its pin or its card) opens the editor in place of
  // the card, so move focus into it rather than leaving it on <body>.
  const editingId = effectiveDraftPin
    ? null
    : (visibleSelectedRecord?.id ?? null);
  const previousEditingIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousEditingIdRef.current;
    previousEditingIdRef.current = editingId;
    if (!editingId || previous === editingId) return;
    if (adoptedIdRef.current === editingId) return;
    const active = document.activeElement;
    const fromPinOrCard =
      !active ||
      active === document.body ||
      !active.isConnected ||
      (active instanceof HTMLElement &&
        (active.classList.contains("feedback-pin") ||
          active.classList.contains("feedback-comment")));
    if (fromPinOrCard) {
      editorSectionRef.current?.scrollIntoView?.({ block: "nearest" });
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [editingId]);

  useLayoutEffect(() => {
    const previousDraftPin = previousDraftPinRef.current;
    previousDraftPinRef.current = draftPin;
    if (!draftPin || previousDraftPin === draftPin) return;
    setDraftScope("size");

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

  // A pending note edit is saved as soon as the reviewer moves to another
  // comment, pin, screen or version, and when the panel goes away.
  const flushPendingSaveRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const pending = pendingSaveRef.current;
    if (pending && !isCurrentTarget(pending.target)) {
      flushPendingSaveRef.current();
    }
  }, [selectedFeedbackId, selectedScreenId, version, effectiveDraftPin]);

  useEffect(() => {
    return () => flushPendingSaveRef.current();
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

  function currentTarget(): SaveTarget | null {
    const record = latestRecordRef.current;
    const pin = effectiveDraftPin;
    if (!record && !pin) return null;
    return { record, pin, screenId: selectedScreenId, version };
  }

  // Whether the reviewer is still looking at the comment a save belongs to.
  function isCurrentTarget(target: SaveTarget) {
    const current = latestRecordRef.current;
    if (target.record) return current?.id === target.record.id;
    if (!target.pin) return false;
    if (draftPinRef.current === target.pin) return true;
    const created = createdRef.current.get(target.pin);
    return Boolean(created && current?.id === created.id);
  }

  function targetRecoveryKey(target: SaveTarget) {
    return target.record
      ? updateRecoveryKey(target.record.id)
      : createRecoveryKey(target.version, target.screenId);
  }

  function persistLocal(target: SaveTarget, nextEditor: EditorState) {
    writeRecovery(projectId, targetRecoveryKey(target), {
      kind: target.record ? "update" : "create",
      screenId: target.screenId,
      version: target.version,
      feedbackId: target.record?.id,
      x: target.pin?.x,
      y: target.pin?.y,
      box: target.pin?.box,
      note: nextEditor.note,
      tags: nextEditor.tags,
    });
    setSaveMessage("Unsaved locally");
  }

  function failureMessage(target: SaveTarget, error: unknown) {
    const reason =
      error instanceof Error
        ? `Retry required: ${error.message}`
        : "Retry required";
    if (isCurrentTarget(target)) return reason;
    const pin = target.record ? pinNumbers.get(target.record.id) : undefined;
    return `${pin ? `Pin ${pin}` : "A comment"} was not saved (kept in this browser). ${reason}`;
  }

  async function saveEditor(
    target: SaveTarget,
    revision: number,
    nextEditor: EditorState,
  ) {
    const { pin } = target;
    const showing = () => isCurrentTarget(target);
    if (!nextEditor.note.trim()) {
      // Nothing can be sent; say so instead of leaving "Unsaved locally".
      if (showing()) {
        setSaveMessage(
          target.record ? "A note can't be empty; not saved." : "",
        );
      }
      return;
    }
    if (showing()) setSaveMessage("Saving…");
    clearRetry("note");
    let record = target.record;
    // A save for a pin that is (or was) being created updates that record
    // instead of creating a second one.
    if (!record && pin) {
      record =
        createdRef.current.get(pin) ??
        (await creatingRef.current.get(pin)?.catch(() => null)) ??
        null;
    }
    try {
      if (record) {
        const base =
          latestRecordRef.current?.id === record.id
            ? latestRecordRef.current
            : record;
        const patch: UpdateFeedbackInput["patch"] = {};
        const note = nextEditor.note.trim();
        if (note !== base.note) patch.note = note;
        if (!sameTags(nextEditor.tags, base.tags)) {
          patch.tags = nextEditor.tags;
        }
        if (Object.keys(patch).length === 0) {
          writeRecovery(projectId, updateRecoveryKey(record.id), null);
          if (showing()) setSaveMessage("Saved");
          return;
        }
        const updated = await onUpdate(record.id, {
          expectedUpdatedAt: base.updatedAt,
          patch,
        });
        if (latestRecordRef.current?.id === updated.id) {
          latestRecordRef.current = updated;
        }
        // A save for a comment the reviewer has left is final: its edit was
        // flushed with the last text typed there.
        if (!showing() || revision === revisionRef.current) {
          writeRecovery(projectId, updateRecoveryKey(record.id), null);
        }
        if (showing() && revision === revisionRef.current) {
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
          screenId: target.screenId,
          version: target.version,
          x: pin.x,
          y: pin.y,
          ...(pin.box ? { box: pin.box } : {}),
          ...(multipleSizes && draftScopeRef.current === "all"
            ? { scope: "all" as const }
            : {}),
          note: nextEditor.note.trim(),
          tags: nextEditor.tags,
          status: "OPEN",
        });
        creatingRef.current.set(pin, creating);
        let created: FeedbackRecord;
        try {
          created = await creating;
        } finally {
          creatingRef.current.delete(pin);
        }
        createdRef.current.set(pin, created);
        writeRecovery(
          projectId,
          createRecoveryKey(target.version, target.screenId),
          null,
        );
        // Adopt the new record only while the reviewer is still on its
        // draft; otherwise leave their new selection alone.
        if (draftPinRef.current !== pin) return;
        latestRecordRef.current = created;
        adoptedIdRef.current = created.id;
        setFreshId(created.id);
        setRecoveredPin(null);
        onSelectFeedback(created.id);
        onCancelDraft();
        if (revision === revisionRef.current) {
          setSaveMessage("Saved");
        } else {
          writeRecovery(projectId, updateRecoveryKey(created.id), {
            kind: "update",
            screenId: target.screenId,
            version: target.version,
            feedbackId: created.id,
            note: editorRef.current.note,
            tags: editorRef.current.tags,
          });
        }
      }
    } catch (error) {
      setSaveMessage(failureMessage(target, error));
      setRetrySave({
        kind: "note",
        run: () =>
          void saveEditor(
            target,
            revisionRef.current,
            editorForRetry(target, nextEditor),
          ),
      });
    }
  }

  // A retry for the comment on screen sends what is in the editor now.
  function editorForRetry(target: SaveTarget, saved: EditorState) {
    return isCurrentTarget(target) ? editorRef.current : saved;
  }

  // Sends the scheduled save now, for the comment it was scheduled for.
  function flushPendingSave() {
    const pending = pendingSaveRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingSaveRef.current = null;
    if (!pending) return Promise.resolve();
    return saveEditor(pending.target, pending.revision, pending.editor);
  }
  flushPendingSaveRef.current = () => void flushPendingSave();

  function cancelPendingSave() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingSaveRef.current = null;
  }

  function scheduleSave(nextEditor: EditorState) {
    const target = currentTarget();
    if (!target) return;
    const pending = pendingSaveRef.current;
    // An edit to another comment sends the earlier one first.
    if (pending && !sameTarget(pending.target, target)) void flushPendingSave();
    persistLocal(target, nextEditor);
    const revision = ++revisionRef.current;
    pendingSaveRef.current = { revision, editor: nextEditor, target };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushPendingSave();
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
    // The status goes first; a pending note edit is sent again after it.
    const pending =
      pendingSaveRef.current?.target.record?.id === record.id
        ? pendingSaveRef.current
        : null;
    cancelPendingSave();
    // After the status lands (or fails), the note edit is sent for this
    // comment even if the reviewer has moved on.
    const resendNote = (status?: FeedbackStatus) => {
      const latest = editorRef.current;
      if (latestRecordRef.current?.id === record.id) {
        if (
          pending ||
          latest.note !== latestRecordRef.current.note ||
          !sameTags(latest.tags, latestRecordRef.current.tags)
        ) {
          scheduleSave(status ? { ...latest, status } : latest);
        }
      } else if (pending) {
        void saveEditor(pending.target, pending.revision, pending.editor);
      }
    };
    setEditor((current) => ({ ...current, status }));
    clearRetry("status");
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
      if (latestRecordRef.current?.id === updated.id) {
        latestRecordRef.current = updated;
      }
      if (replyNote) setReplyDraft("");
      setSaveMessage("Saved");
      resendNote(status);
    } catch (error) {
      resendNote();
      // The server still has the old status, so the picker shows it again.
      const current = latestRecordRef.current;
      if (current?.id === record.id) {
        setEditor((editorNow) => ({ ...editorNow, status: current.status }));
        setSaveMessage(
          `Status not changed. ${
            error instanceof Error
              ? `Retry required: ${error.message}`
              : "Retry required"
          }`,
        );
        setRetrySave({ kind: "status", run: () => void flushStatus(status) });
      }
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
    void flushStatus(status);
  }

  // The reviewer's answer in the thread, without changing the status.
  async function sendReply() {
    const record = latestRecordRef.current;
    const note = replyDraft.trim();
    if (!record || !note) return;
    clearRetry("reply");
    setSaveMessage("Saving…");
    try {
      const updated = await onUpdate(record.id, {
        expectedUpdatedAt: record.updatedAt,
        patch: { message: { note, role: "reviewer" } },
      });
      latestRecordRef.current = updated;
      setReplyDraft("");
      setSaveMessage("Saved");
      // The Reply button disables itself once the box is empty.
      requestFocus(() =>
        asideRef.current?.querySelector<HTMLElement>(
          'textarea[aria-label="Reply"]',
        ),
      );
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
      setRetrySave({ kind: "reply", run: () => void sendReply() });
    }
  }

  function sectionToggle(status: FeedbackStatus) {
    return asideRef.current?.querySelector<HTMLElement>(
      `.feedback-section.status-${status.toLowerCase()} .feedback-section-toggle`,
    );
  }

  // The card for a comment, or its section heading when the section is
  // collapsed, so focus follows a comment that moved.
  function focusCard(id: string, status: FeedbackStatus) {
    requestFocus(
      () =>
        document.getElementById(feedbackCommentId(id)) ??
        sectionToggle(status) ??
        asideRef.current,
    );
  }

  async function updateCard(
    item: FeedbackRecord,
    patch: UpdateFeedbackInput["patch"],
  ) {
    setCardMessage({ id: item.id, text: "Saving…" });
    try {
      const updated = await onUpdate(item.id, {
        expectedUpdatedAt: item.updatedAt,
        patch,
      });
      setCardMessage(null);
      setReopeningId(null);
      setReopenDraft("");
      focusCard(updated.id, updated.status);
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

  // A saved comment changes scope at once; a draft sends it on create, or
  // updates the record its first save already made.
  async function changeScope(scope: FeedbackScope) {
    const pin = effectiveDraftPin;
    const record =
      latestRecordRef.current ?? (pin ? createdRef.current.get(pin) : null);
    if (!record) {
      setDraftScope(scope);
      return;
    }
    setSaveMessage("Saving…");
    try {
      const updated = await onUpdate(record.id, {
        expectedUpdatedAt: record.updatedAt,
        patch: { scope },
      });
      if (latestRecordRef.current?.id === updated.id) {
        latestRecordRef.current = updated;
      }
      if (pin) createdRef.current.set(pin, updated);
      setDraftScope(scope);
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? `Retry required: ${error.message}`
          : "Retry required",
      );
    }
  }

  function verifyActions(item: FeedbackRecord) {
    const pin = pinNumbers.get(item.id) ?? 0;
    return (
      <VerifyActions
        message={cardMessage?.id === item.id ? cardMessage.text : undefined}
        onCancelReopen={() => {
          setReopeningId(null);
          setCardMessage(null);
          requestFocus(() =>
            asideRef.current?.querySelector<HTMLElement>(
              `[aria-label="Reopen pin ${pin}"]`,
            ),
          );
        }}
        onConfirmReopen={(note) =>
          void updateCard(item, {
            status: "OPEN",
            message: { note, role: "reviewer" },
          })
        }
        onReopenDraftChange={setReopenDraft}
        onStartReopen={() => {
          setReopenDraft("");
          setCardMessage(null);
          setReopeningId(item.id);
        }}
        onVerify={() => void updateCard(item, { status: "VERIFIED" })}
        pin={pin}
        reopenDraft={reopenDraft}
        reopening={reopeningId === item.id}
        status={item.status}
      />
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
    if (pendingSaveRef.current?.target.record?.id === record.id) {
      cancelPendingSave();
    }
    setDeleteMessage("Deleting…");
    // Focus moves to the next card (or the previous one) once this one goes.
    const rows = [
      ...(asideRef.current?.querySelectorAll<HTMLElement>(
        ".feedback-list > li",
      ) ?? []),
    ];
    const index = rows.findIndex((row) => row.contains(document.activeElement));
    const neighbourId = [rows[index + 1], rows[index - 1]]
      .map((row) => row?.querySelector<HTMLElement>(".feedback-comment")?.id)
      .find(Boolean);
    try {
      await onDelete(record.id, record.updatedAt);
      writeRecovery(projectId, updateRecoveryKey(record.id), null);
      setConfirmingDeleteId(null);
      setDeleteMessage("");
      setSaveMessage("Deleted");
      requestFocus(
        () =>
          (neighbourId ? document.getElementById(neighbourId) : null) ??
          sectionToggle(record.status) ??
          asideRef.current,
      );
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
    void flushPendingSave();
    setConfirmingDeleteId(null);
    onSelectFeedback(null);
    // The pin may be hidden (Fixed and Verified are by default); the card is not.
    focusCard(item.id, item.status);
  }

  // Save pin: send the note now rather than on the next pause, then close
  // the editor so the reviewer sees the pin has been kept.
  async function saveNewPin() {
    if (editingRecord) {
      collapseEditor(editingRecord);
      return;
    }
    const pin = draftPinRef.current;
    await flushPendingSave();
    const created = pin ? createdRef.current.get(pin) : undefined;
    if (!created) return;
    onSelectFeedback(null);
    focusCard(created.id, created.status);
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
        <button
          // The safe choice takes focus, as in the approval confirm.
          autoFocus
          onClick={() => {
            setConfirmingDeleteId(null);
            requestFocus(() =>
              asideRef.current?.querySelector<HTMLElement>(
                `[aria-label="Delete comment ${pinNumbers.get(item.id) ?? 0}"]`,
              ),
            );
          }}
          type="button"
        >
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
          onClick={() => onSelectFeedback(item.id)}
          type="button"
        >
          <span
            aria-label={`Pin ${pinNumbers.get(item.id) ?? 0}`}
            className={pinDotClassName(item, item.id === selectedFeedbackId)}
          >
            {pinNumbers.get(item.id) ?? 0}
          </span>
          <span className="feedback-comment-note">
            <MentionText text={item.note} />
          </span>
          {item.author ? (
            <span className="feedback-comment-byline">
              {item.author} ·{" "}
              <time dateTime={item.createdAt}>
                {REPLY_TIME.format(new Date(item.createdAt))}
              </time>
            </span>
          ) : null}
          <ElementLine projectId={projectId} pin={item} />
          <PlacementLine item={item} />
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
        {item.status === "RESOLVED" || item.status === "VERIFIED"
          ? verifyActions(item)
          : null}
        <PlacementOk
          item={item}
          onConfirm={() => void updateCard(item, { checkPlacement: false })}
          pin={pinNumbers.get(item.id) ?? 0}
        />
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
            if (confirmingApproval) closeApprovalConfirm();
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
  // The open comment keeps its slot, but once its saved status or priority
  // differs from the slot, say where it goes and leave it out of the counts.
  const movingTo =
    editingRecord &&
    editorSlot &&
    (editingRecord.status !== editorSlot.status ||
      priorityTag(editingRecord.tags) !== editorSlot.priority)
      ? [STATUS_LABELS[editingRecord.status], priorityTag(editingRecord.tags)]
          .filter(Boolean)
          .join(" · ")
      : null;
  const counted = (items: FeedbackRecord[]) =>
    movingTo ? items.filter((item) => item.id !== editingRecord?.id) : items;
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
        {movingTo ? (
          <span className="feedback-editor-moves">
            Moves to {movingTo} when closed
          </span>
        ) : null}
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
      <ReviewerNameField />
      <span aria-live="polite" className="feedback-save-state" role="status">
        {saveMessage}
      </span>
      {retrySave ? (
        <button
          className="feedback-retry-button"
          onClick={() => retrySave.run()}
          type="button"
        >
          Retry
        </button>
      ) : null}
      {editingRecord ? (
        <ElementLine projectId={projectId} pin={editingRecord} />
      ) : null}
      {editingRecord ? <PlacementLine item={editingRecord} /> : null}
      {multipleSizes && !(editingRecord && pinnedAtOf(editingRecord)) ? (
        <ScopeChoice
          onChange={changeScope}
          value={editingRecord ? scopeOf(editingRecord) : draftScope}
        />
      ) : null}
      {editingRecord ? (
        <PlacementOk
          item={editingRecord}
          onConfirm={() =>
            void updateCard(editingRecord, { checkPlacement: false })
          }
          pin={pinNumbers.get(editingRecord.id) ?? 0}
        />
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

      {effectiveDraftPin || freshRecord ? (
        <div className="feedback-editor-actions">
          <button
            className="feedback-save-button"
            disabled={!editingRecord && !editor.note.trim()}
            onClick={() => void saveNewPin()}
            type="button"
          >
            Save pin
          </button>
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
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {editingRecord ? deleteBar(editingRecord) : null}
    </section>
  );

  // Open feedback elsewhere in this version, and the next screen that has
  // some, for the empty state.
  const reviewSummary = (() => {
    const open = new Map<string, number>();
    for (const item of feedback) {
      if (item.version === version && isOpenFeedback(item)) {
        open.set(item.screenId, (open.get(item.screenId) ?? 0) + 1);
      }
    }
    if (!open.size) return null;
    const at = screens.findIndex((item) => item.id === selectedScreenId);
    const next = [...screens.slice(at + 1), ...screens.slice(0, at + 1)].find(
      (item) => item.id !== selectedScreenId && open.has(item.id),
    );
    return {
      open: [...open.values()].reduce((sum, count) => sum + count, 0),
      screens: open.size,
      next,
    };
  })();

  return (
    <aside
      aria-label="Feedback inspector"
      className="feedback-panel"
      id="feedback-panel"
      ref={asideRef}
      tabIndex={-1}
    >
      <div className="feedback-inspector-header">
        <strong>Feedback</strong>
        <span className="feedback-inspector-count">
          {visibleFeedback.length} comment
          {visibleFeedback.length === 1 ? "" : "s"}
        </span>
      </div>

      {visibleFeedback.length === 0 && !effectiveDraftPin ? (
        <section aria-labelledby={emptyHeadingId} className="feedback-empty">
          <h3 id={emptyHeadingId}>No feedback yet</h3>
          <p>
            No feedback on this screen yet. Choose Add feedback, then click the
            screen to drop pin 1.
          </p>
          {onAddFeedback ? (
            <button
              aria-label="Add feedback to this screen"
              className="feedback-empty-add"
              disabled={!ready || adding}
              onClick={onAddFeedback}
              type="button"
            >
              Add feedback{" "}
              <kbd aria-hidden="true">{SHORTCUTS.addFeedback.kbd}</kbd>
            </button>
          ) : null}
          {reviewSummary ? (
            <p className="feedback-empty-summary">
              {reviewSummary.open} open across {reviewSummary.screens} screen
              {reviewSummary.screens === 1 ? "" : "s"}
              {reviewSummary.next && onSelectScreen ? (
                <>
                  {" · "}
                  <button
                    className="feedback-empty-next"
                    onClick={() => onSelectScreen(reviewSummary.next!.id)}
                    type="button"
                  >
                    Next: {String(reviewSummary.next.ordinal).padStart(2, "0")}{" "}
                    {reviewSummary.next.title}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </section>
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
                <span className="feedback-count">{counted(items).length}</span>
              </button>
              {onTogglePinStatus ? (
                <button
                  // A fixed name with a pressed state: "Show Fixed pins,
                  // pressed" means they are shown.
                  aria-label={`Show ${section.label} pins`}
                  aria-pressed={!pinsHidden}
                  className="feedback-section-pins"
                  onClick={() => onTogglePinStatus(section.status)}
                  type="button"
                >
                  Show pins
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
                      <h3
                        className={`feedback-group-title tag-${priority.toLowerCase()}`}
                      >
                        {priority}
                        <span className="feedback-count">
                          {counted(group).length}
                        </span>
                      </h3>
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
        <ApprovalBar
          approved={approval.approved}
          confirming={confirmingApproval}
          // Wait for feedback too, so unverified fixes are counted.
          disabled={!approval.ready || !ready}
          onAskConfirm={() => setConfirmingApproval(true)}
          onCloseConfirm={closeApprovalConfirm}
          onToggle={approval.onToggle}
          toggleRef={approvalToggleRef}
          allSizes={approval.sizes}
          onApproveAll={approval.onApproveAll}
          sizeLabel={approval.sizeLabel}
          unverifiedFixes={unverifiedFixes}
        />
      ) : null}
    </aside>
  );
}
