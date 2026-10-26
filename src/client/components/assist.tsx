import { useEffect, useId, useRef, useState } from "react";

import { PRIORITY_TAGS, normalizeTags } from "../../shared/feedback";
import { assistRequest, useAssist } from "../use-assist";

const DUPLICATE_DELAY_MS = 400;

type Suggestion = { priority: string | null; tags: string[] };

function isPriority(tag: string) {
  return (PRIORITY_TAGS as readonly string[]).includes(tag);
}

// The suggested priority replaces the current one; suggested topic tags are
// added to the reviewer's own.
export function mergeSuggestedTags(
  current: readonly string[],
  suggestion: Suggestion,
) {
  const keep = suggestion.priority
    ? current.filter((tag) => !isPriority(tag))
    : [...current];
  const priority = suggestion.priority ? [suggestion.priority] : [];
  return normalizeTags([...priority, ...keep, ...suggestion.tags]).slice(0, 12);
}

// AI assist in the feedback editor (#14). Every result is a suggestion the
// reviewer accepts or dismisses; nothing changes the comment on its own.
// Renders nothing unless the server has assist on and Copilot answers.
export function AssistEditorTools({
  projectId,
  version,
  screenId,
  editingId,
  note,
  tags,
  pinNumbers,
  onApplyNote,
  onApplyTags,
}: {
  projectId: string;
  version: string;
  screenId: string;
  editingId: string | null;
  note: string;
  tags: readonly string[];
  pinNumbers: ReadonlyMap<string, number>;
  onApplyNote: (note: string) => void;
  onApplyTags: (tags: string[]) => void;
}) {
  const available = useAssist();
  const [busy, setBusy] = useState<"rewrite" | "suggest" | null>(null);
  const [rewrite, setRewrite] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState("");
  const [duplicates, setDuplicates] = useState<string[]>([]);

  // Dropped when the editor moves to another comment.
  useEffect(() => {
    setRewrite(null);
    setSuggestion(null);
    setError("");
  }, [editingId, screenId, version]);

  useEffect(() => {
    if (!available || !note.trim()) {
      setDuplicates([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      assistRequest<{ duplicates?: { id: string }[] }>(
        "duplicates",
        {
          projectId,
          version,
          screenId,
          note,
          ...(editingId ? { id: editingId } : {}),
        },
        controller.signal,
      )
        .then((result) =>
          setDuplicates((result.duplicates ?? []).map((item) => item.id)),
        )
        .catch(() => undefined);
    }, DUPLICATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [available, projectId, version, screenId, editingId, note]);

  if (!available) return null;

  async function ask(kind: "rewrite" | "suggest") {
    setBusy(kind);
    setError("");
    try {
      if (kind === "rewrite") {
        const result = await assistRequest<{ instruction: string }>("rewrite", {
          note,
        });
        setRewrite(result.instruction);
      } else {
        setSuggestion(await assistRequest<Suggestion>("suggest", { note }));
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const duplicateNumbers = duplicates
    .map((id) => pinNumbers.get(id))
    .filter((value): value is number => typeof value === "number");
  const suggestedTags = suggestion
    ? [
        ...(suggestion.priority ? [suggestion.priority] : []),
        ...suggestion.tags,
      ]
    : [];

  return (
    <div className="assist-tools" aria-label="AI assist" role="group">
      <div className="assist-actions">
        <button
          className="assist-link"
          disabled={!note.trim() || busy !== null}
          onClick={() => void ask("rewrite")}
          type="button"
        >
          {busy === "rewrite" ? "Rewriting…" : "Rewrite for agent"}
        </button>
        <button
          className="assist-link"
          disabled={!note.trim() || busy !== null}
          onClick={() => void ask("suggest")}
          type="button"
        >
          {busy === "suggest" ? "Suggesting…" : "Suggest tags"}
        </button>
      </div>
      {duplicateNumbers.length ? (
        <p className="assist-hint" role="status">
          Possible duplicate of{" "}
          {duplicateNumbers.map((value) => `#${value}`).join(", ")}
        </p>
      ) : null}
      {error ? (
        <p className="assist-hint assist-error" role="alert">
          {error}
        </p>
      ) : null}
      {rewrite !== null ? (
        <div className="assist-suggestion">
          <p>{rewrite}</p>
          <div className="assist-actions">
            <button
              aria-label="Use rewrite"
              className="assist-link"
              onClick={() => {
                onApplyNote(rewrite);
                setRewrite(null);
              }}
              type="button"
            >
              Use this
            </button>
            <button
              aria-label="Dismiss rewrite"
              className="assist-link"
              onClick={() => setRewrite(null)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {suggestion ? (
        <div className="assist-suggestion">
          <p>
            {suggestedTags.length ? (
              suggestedTags.map((tag) => (
                <span className="tag-chip tag-custom" key={tag}>
                  {tag}
                </span>
              ))
            ) : (
              <span>No tags to suggest.</span>
            )}
          </p>
          <div className="assist-actions">
            {suggestedTags.length ? (
              <button
                aria-label="Apply tags"
                className="assist-link"
                onClick={() => {
                  onApplyTags(mergeSuggestedTags(tags, suggestion));
                  setSuggestion(null);
                }}
                type="button"
              >
                Apply
              </button>
            ) : null}
            <button
              aria-label="Dismiss tags"
              className="assist-link"
              onClick={() => setSuggestion(null)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// "Summarise round…" in the "…" menu; hidden unless assist is available.
export function SummariseRoundMenuItem({ onOpen }: { onOpen: () => void }) {
  const available = useAssist();
  if (!available) return null;
  return (
    <button onClick={onOpen} role="menuitem" type="button">
      Summarise round…
    </button>
  );
}

export function RoundSummaryDialog({
  projectId,
  version,
  onClose,
}: {
  projectId: string;
  version: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [message, setMessage] = useState("Summarising with Copilot…");

  useEffect(() => {
    let live = true;
    assistRequest<{ markdown: string }>("summary", { projectId, version })
      .then((result) => {
        if (!live) return;
        setMarkdown(result.markdown);
        setMessage("");
      })
      .catch((caught: Error) => live && setMessage(caught.message));
    return () => {
      live = false;
    };
  }, [projectId, version]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => previous?.focus?.();
  }, []);

  async function copy() {
    if (markdown === null) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage("Copied.");
    } catch {
      setMessage("Could not copy; select the text instead.");
    }
  }

  return (
    <div
      className="export-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="export-dialog assist-summary-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={titleId}>Round summary</h2>
        <textarea
          aria-label="Summary markdown"
          className="assist-summary-text"
          readOnly
          value={markdown ?? ""}
        />
        <p aria-live="polite" className="export-summary" role="status">
          {message || `Version ${version} · written by your Copilot`}
        </p>
        <div className="export-dialog-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
          <button
            className="export-download"
            disabled={markdown === null}
            onClick={() => void copy()}
            type="button"
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
